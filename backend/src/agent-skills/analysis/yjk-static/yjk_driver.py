# -*- coding: utf-8 -*-
"""YJK analysis driver -- subprocess entry point.

Must run under YJK's bundled Python 3.10.  Do NOT add extra CLI
arguments; YJKAPI uses sys.argv[1] for internal state and will
break if unexpected args are present.

Usage (called by runtime.py via subprocess):
    <YJK_PYTHON> yjk_driver.py <model.json> <work_dir>

Reads the V2 model JSON, converts to .ydb, launches an isolated YJK host, runs a
full static analysis, loads extract_results.py inside YJK, reads the
current work_dir/results.json file, and outputs the final result JSON
to stdout.

The sequence below strictly follows the proven three_story_steel_frame.py
pattern from the YJK SDK.
"""
from __future__ import annotations

import json
import math
import os
from pathlib import Path
import re
import shutil
import sys
import time
import traceback

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
# Result mapping lives in sibling modules. Running as a script already puts
# SCRIPT_DIR first on sys.path; this only matters when loaded by file path.
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)
from yjk_result_lookup import (  # noqa: E402,F401
    _accumulate_element_envelope,
    _accumulate_node_envelope,
    _accumulate_reaction_envelope,
    _build_element_lookups,
    _build_result_node_lookup,
    _case_block,
    _case_descriptors,
    _category_element_type,
    _coord_key,
    _element_category,
    _endpoint_key,
    _finite_result_float,
    _force_from_sections,
    _id_candidates,
    _load_json_file,
    _member_id_for,
    _merge_max_force,
    _merge_max_reaction,
    _merge_member_definition,
    _native_case_code,
    _node_lookup_from_mapping,
    _raw_member_definition_lookup,
    _reaction_from_raw,
    _safe_float,
    _signed_max_abs,
)
from yjk_result_mapping import (  # noqa: E402,F401
    _build_analysis_result,
    _build_yjk_design_results,
)

_CURRENT_WORK_DIR: str | None = None
_SDK_PIPE = None
_DLL_HANDLES: list = []
_OWNED_LAUNCHER = None


def _record_step(
    steps: list[dict],
    *,
    phase: str,
    name: str,
    status: str,
    command: str | None = None,
    message: str | None = None,
    started_at: float | None = None,
    **extra: object,
) -> None:
    step: dict = {
        "phase": phase,
        "name": name,
        "status": status,
    }
    if command:
        step["command"] = command
    if message:
        step["message"] = message
    if started_at is not None:
        step["elapsed_ms"] = round((time.monotonic() - started_at) * 1000)
    step.update({k: v for k, v in extra.items() if v is not None})
    steps.append(step)


def _env_text(name: str, default: str = "") -> str:
    value = os.environ.get(name, default)
    if value is None:
        return ""
    return str(value).strip()


def _env_path(name: str, default: str = "") -> str:
    return _env_text(name, default).strip('"')


def _flush_stdio() -> None:
    for stream in (sys.stderr, sys.stdout):
        try:
            stream.flush()
        except Exception:
            pass


def _write_steps_json(work_dir: str | None, steps: list[dict] | None) -> None:
    if not work_dir or steps is None:
        return
    steps_path = os.path.join(work_dir, "steps.json")
    if os.path.exists(steps_path):
        return
    try:
        os.makedirs(work_dir, exist_ok=True)
        with open(steps_path, "w", encoding="utf-8") as f:
            json.dump(steps, f, ensure_ascii=False, indent=2)
            f.write("\n")
    except Exception as exc:
        print(
            f"[yjk_driver] failed to write steps.json: {exc}",
            file=sys.stderr,
            flush=True,
        )


def _finish_after_json(
    *,
    work_dir: str | None,
    steps: list[dict] | None,
    exit_code: int,
    force_exit: bool,
) -> int:
    _write_steps_json(work_dir, steps)
    _flush_stdio()
    if force_exit:
        os._exit(exit_code)
    return exit_code


def _write_driver_output_json(work_dir: str | None, payload: dict) -> None:
    if not work_dir:
        return
    try:
        os.makedirs(work_dir, exist_ok=True)
        output_path = os.path.join(work_dir, "driver-output.json")
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
            f.write("\n")
    except Exception as exc:
        print(
            f"[yjk_driver] failed to write driver-output.json: {exc}",
            file=sys.stderr,
            flush=True,
        )


def _emit_json(payload: dict) -> None:
    """Write the final result JSON to stdout (the ONLY stdout we produce).

    Flush stderr first so any YJKAPI noise that leaked to stdout is
    already written, then write our JSON on its own line.
    """
    sys.stderr.flush()
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _error(
    message: str,
    *,
    phase: str | None = None,
    command: str | None = None,
    steps: list[dict] | None = None,
    summary: dict | None = None,
    detailed: dict | None = None,
) -> None:
    detail = {"error": message}
    if phase:
        detail["phase"] = phase
    if command:
        detail["command"] = command
    if detailed:
        detail.update(detailed)

    summary_payload = {"engine": "yjk-static"}
    if summary:
        summary_payload.update(summary)

    work_dir = str(summary_payload.get("work_dir") or "") or _CURRENT_WORK_DIR
    payload = {
        "status": "error",
        "summary": summary_payload,
        "data": {},
        "detailed": detail,
        "warnings": [message],
        "steps": steps or [],
    }
    _write_driver_output_json(work_dir, payload)
    _emit_json(payload)
    _finish_after_json(
        work_dir=work_dir,
        steps=steps,
        exit_code=1,
        force_exit=work_dir is not None,
    )


def _setup_paths() -> str:
    """Set up sys.path and os.environ["PATH"] for YJK.

    Returns the resolved YJKS_ROOT directory.
    """
    yjks_root = _env_path("YJKS_ROOT") or _env_path("YJK_PATH")
    yjks_exe_env = _env_path("YJKS_EXE")
    if yjks_exe_env and os.path.isfile(yjks_exe_env):
        root = os.path.dirname(os.path.abspath(yjks_exe_env))
    elif os.path.isdir(yjks_root):
        root = yjks_root
    else:
        root = yjks_root

    # Keep DLL directory handles alive for the whole vendor worker lifetime.
    if os.name == "nt" and root:
        _DLL_HANDLES.append(os.add_dll_directory(root))
    # DLL search path
    os.environ["PATH"] = root + os.pathsep + _env_text("PATH")

    # Python import paths: YJKS_ROOT itself (for native wrappers) and
    # the driver's own directory (for yjk_converter).
    protocol_path = str(Path(SCRIPT_DIR).parents[2] / "skill-shared" / "python")
    for p in (root, os.path.join(os.path.dirname(SCRIPT_DIR), "runtime"), protocol_path, SCRIPT_DIR):
        if p and p not in sys.path:
            sys.path.insert(0, p)

    return root


def _find_yjks_exe(root: str) -> str | None:
    for name in ("yjks.exe", "YJKS.exe"):
        p = os.path.join(root, name)
        if os.path.isfile(p):
            return p
    return None


def _env_flag(name: str) -> bool:
    return _env_text(name).lower() in {"1", "true", "yes", "on"}


def _env_float(name: str, default: float) -> float:
    try:
        return float(_env_text(name) or default)
    except ValueError:
        return default


def _owned_native_processes(parent_pid: int, process_name: str = "yjks.exe") -> list[dict]:
    """Read only direct children; a globally new YJK process is not ownership."""
    import subprocess
    if process_name not in {"yjks.exe", "YjkLauncher.exe"}:
        raise ValueError("Only known native child process names may be queried")
    powershell = os.path.join(_env_text("SystemRoot", r"C:\Windows"),
                              "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    query = (f'Get-CimInstance Win32_Process -Filter "ParentProcessId={int(parent_pid)} '
             f"AND Name='{process_name}'\" | Select-Object ProcessId,ParentProcessId,"
             'ExecutablePath,CommandLine,CreationDate | ConvertTo-Json -Compress')
    result = subprocess.run([powershell, "-NoProfile", "-Command", query],
                            capture_output=True, encoding="utf-8", errors="replace",
                            timeout=20, check=True,
                            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    found = json.loads(result.stdout or "[]")
    return [found] if isinstance(found, dict) else found


def _select_owned_host(found: list[dict], parent_pid: int, executable: str) -> dict:
    if len(found) != 1:
        raise RuntimeError("Exactly one directly owned YJK host is required")
    host = found[0]
    if (int(host.get("ParentProcessId", -1)) != parent_pid
            or int(host.get("ProcessId", -1)) <= 0
            or os.path.normcase(os.path.realpath(str(host.get("ExecutablePath") or "")))
                != os.path.normcase(os.path.realpath(executable))
            or "-yjkscontrol" not in str(host.get("CommandLine") or "").lower()):
        raise RuntimeError("Native YJK process does not match this worker and executable")
    return host


def _windows_session(pid: int) -> int:
    import ctypes
    from ctypes import wintypes
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.ProcessIdToSessionId.argtypes = [wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
    kernel.ProcessIdToSessionId.restype = wintypes.BOOL
    session = wintypes.DWORD()
    if not kernel.ProcessIdToSessionId(pid, ctypes.byref(session)):
        raise ctypes.WinError(ctypes.get_last_error())
    return session.value


def _prepare_owned_launcher(yjks_root: str, steps: list[dict]) -> dict:
    """Initialize authorization only through a new hidden private-root child.

    YJK requires a launcher in the worker's Windows session. The job already
    contains this worker, so both launcher and host terminate with this run.
    Existing launchers are never searched, reinvoked, attached, or closed.
    """
    global _OWNED_LAUNCHER
    import subprocess
    executable = os.path.abspath(os.path.join(yjks_root, "YjkLauncher.exe"))
    if not os.path.isfile(executable):
        raise RuntimeError("Private YJK SDK installation is missing YjkLauncher.exe")
    startup = subprocess.STARTUPINFO()
    startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    startup.wShowWindow = 0
    _OWNED_LAUNCHER = subprocess.Popen(
        [executable], cwd=yjks_root, stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True,
        startupinfo=startup, creationflags=subprocess.CREATE_NO_WINDOW,
    )
    deadline = time.monotonic() + _env_float("YJK_LAUNCHER_STARTUP_TIMEOUT_S", 20)
    observed = None
    while time.monotonic() < deadline:
        if _OWNED_LAUNCHER.poll() is not None:
            raise RuntimeError("Private YJK launcher exited before authorization readiness; "
                               "existing launcher sessions will not be reinvoked")
        found = _owned_native_processes(os.getpid(), "YjkLauncher.exe")
        owned = [row for row in found if int(row.get("ProcessId", -1)) == _OWNED_LAUNCHER.pid]
        if len(owned) == 1:
            row = owned[0]
            if (int(row.get("ParentProcessId", -1)) != os.getpid()
                    or os.path.normcase(os.path.realpath(str(row.get("ExecutablePath") or "")))
                       != os.path.normcase(os.path.realpath(executable))):
                raise RuntimeError("Private launcher ownership/path verification failed")
            if _windows_session(_OWNED_LAUNCHER.pid) != _windows_session(os.getpid()):
                raise RuntimeError("Private launcher is not in this worker's Windows session")
            observed = row
            break
        time.sleep(0.1)
    if observed is None:
        raise TimeoutError("Private YJK launcher did not become an owned process")
    # The independently validated API waits 3 seconds after same-session discovery.
    time.sleep(3)
    if _OWNED_LAUNCHER.poll() is not None:
        raise RuntimeError("Private YJK launcher exited during authorization startup")
    evidence = {"worker_pid": os.getpid(), "native": observed,
                "session": _windows_session(os.getpid()), "startup_settle_s": 3}
    with open(os.path.join(_CURRENT_WORK_DIR, "owned-launcher.json"), "w", encoding="utf-8") as stream:
        json.dump(evidence, stream, ensure_ascii=False, indent=2)
    _record_step(steps, phase="launch", name="Prepare private YJK launcher", status="success",
                 command="YjkLauncher.exe", pid=_OWNED_LAUNCHER.pid,
                 message="New hidden same-session launcher contained in this run's process job")
    return evidence


def _connect_owned_host(yjks_root: str, steps: list[dict]):
    """Create and bind our own host, then use bounded, write-before-notify IPC."""
    global _SDK_PIPE
    from sdk_ipc import SdkPipe, verify_host
    from YJKAPI import ControlConfig, YJKSControl
    executable = _find_yjks_exe(yjks_root)
    if not executable:
        raise RuntimeError("YJK executable is absent from the configured SDK installation")
    verify_host(executable)
    # Most configured machines already have session authorization. Creating a
    # launcher is an explicit diagnostic option, never an automatic retry or
    # a prerequisite that could fail because of the vendor's singleton policy.
    if _env_flag("YJK_PREPARE_OWNED_LAUNCHER"):
        _prepare_owned_launcher(yjks_root, steps)
    started_at = time.monotonic()
    cfg = ControlConfig()
    cfg.Version = _env_text("YJK_VERSION", "8.0.0")
    cfg.Invisible = _env_text("YJK_INVISIBLE", "1") != "0"
    YJKSControl.initConfig(cfg)
    previous_cwd = os.getcwd()
    try:
        os.chdir(yjks_root)
        YJKSControl.RunYJK(executable)
    finally:
        os.chdir(previous_cwd)
    owned = _select_owned_host(_owned_native_processes(os.getpid()), os.getpid(), executable)
    cfg.Pid = int(owned["ProcessId"])
    YJKSControl.initConfig(cfg)
    evidence = {"worker_pid": os.getpid(), "native": owned, "configured_pid": cfg.Pid,
                "protocol": "buffered-yjk8-pid-pipe-v1"}
    with open(os.path.join(_CURRENT_WORK_DIR, "owned-native.json"), "w", encoding="utf-8") as stream:
        json.dump(evidence, stream, ensure_ascii=False, indent=2)
    _SDK_PIPE = SdkPipe(cfg.Pid, connect_timeout_s=_env_float("YJK_STARTUP_TIMEOUT_S", 90),
                        command_timeout_s=_env_float("YJK_COMMAND_TIMEOUT_S", 600))
    _record_step(steps, phase="launch", name="Connect owned YJK host", status="success",
                 command="RunYJK/initConfig(Pid)", pid=cfg.Pid, protocol=evidence["protocol"],
                 started_at=started_at)
    return evidence


def _run_cmd(
    cmd: str,
    arg: str = "",
    callback: str | None = None,
    *,
    phase: str,
    steps: list[dict],
) -> bool:
    """Execute a YJK command and return success status.

    Returns True if the command succeeded, False if YJK is no longer running.
    """
    display_command = cmd if callback is None else f"{cmd}:{callback}"
    print(
        f"[yjk_driver] RunCmd({cmd!r}, {arg!r}, {callback!r})",
        file=sys.stderr,
        flush=True,
    )
    started_at = time.monotonic()
    try:
        if _SDK_PIPE is None:
            raise RuntimeError("YJK has no owned IPC connection")
        if callback is None:
            _SDK_PIPE.command(cmd, arg)
        else:
            _SDK_PIPE.command(cmd, arg, callback)
        _record_step(
            steps,
            phase=phase,
            name=cmd,
            command=display_command,
            status="success",
            started_at=started_at,
        )
        return True
    except Exception as exc:
        print(f"[yjk_driver] ERROR in RunCmd({cmd}): {exc}", file=sys.stderr, flush=True)
        _record_step(
            steps,
            phase=phase,
            name=cmd,
            command=display_command,
            status="error",
            message=str(exc),
            started_at=started_at,
        )
        return False


def _collect_out_files(work_dir: str) -> str:
    """Read .OUT/.out files under work_dir as fallback result text."""
    lines: list[str] = []
    for dirpath, _dirs, files in os.walk(work_dir):
        for f in sorted(files):
            if f.upper().endswith(".OUT"):
                fp = os.path.join(dirpath, f)
                try:
                    text = open(fp, encoding="gbk", errors="replace").read()
                    lines.append(f"=== {f} ===\n{text[:3000]}")
                except Exception:
                    pass
    return "\n\n".join(lines) if lines else "(no .OUT files found)"


def main() -> int:
    global _CURRENT_WORK_DIR

    # -- Parse arguments ------------------------------------------------
    if len(sys.argv) < 3:
        _error("Usage: yjk_driver.py <model.json> <work_dir>", phase="arguments")
        return 1

    model_path = sys.argv[1]
    work_dir = sys.argv[2]
    _CURRENT_WORK_DIR = os.path.abspath(work_dir)

    # A start gate proves the parent contained this worker before any vendor import.
    gate = _env_path("SC_YJK_START_GATE")
    if not gate or os.path.abspath(gate) != os.path.join(_CURRENT_WORK_DIR, "start.gate"):
        _error("YJK driver requires a contained parent start gate", phase="containment")
        return 1
    deadline = time.monotonic() + 30
    while not os.path.isfile(gate):
        if time.monotonic() >= deadline:
            _error("Parent did not enable contained YJK worker", phase="containment")
            return 1
        time.sleep(0.05)
    # NDepend prevents the vendor import from attaching its default control channel.
    sys.argv = [sys.argv[0], "NDepend"]

    yjks_root = _setup_paths()

    try:
        return _run(model_path, work_dir, yjks_root)
    except Exception:
        _error(
            f"Unhandled exception in yjk_driver:\n{traceback.format_exc()}",
            phase="unhandled",
        )
        return 1


def _prepare_axial_gravity(model: dict, work_dir: str, yjks_root: str, steps: list[dict]) -> None:
    """Two owned preparation stages, one solve, immutable physical input."""
    import subprocess
    from yjk_native_axial_weight import compile_input
    from yjk_converter import convert_v2_to_ydb
    from yjk_native_settings import apply_in_host, compile_settings

    def command(name, arg=""):
        if not _run_cmd(name, arg, phase="axial-gravity-preparation", steps=steps):
            raise RuntimeError("YJK axial gravity preparation failed / YJK 轴向自重准备失败: " + name)

    root = Path(work_dir)
    command("yjkSPre_GenData")
    mapping = _load_json_file(str(root/"mapping.json"))
    plan = compile_input(work_dir, model, mapping)
    second = root/"axial-gravity-exchange"
    converted = convert_v2_to_ydb(model, str(second), "axial-gravity.ydb", axial_weight_plan=plan)
    shutil.copy2(converted, root/"axial-gravity.ydb")
    for name in ("mapping.json", "native-load-precision.json", "native-stiffness-plan.json",
                 "native-stiffness-precision.json", "native-settings-readback.json", "owned-native.json"):
        if (root/name).exists():
            shutil.copy2(root/name, root/("geometry-"+name))
        if (second/name).exists():
            shutil.copy2(second/name, root/name)
    final_mapping = _load_json_file(str(root/"mapping.json"))
    final_mapping["ydb_path"] = str(root/"axial-gravity.ydb")
    (root/"mapping.json").write_text(json.dumps(final_mapping, ensure_ascii=False, indent=2), encoding="utf8")

    # SDK8's live ReadFromYJK crashes after GenData; UINew in that host waits
    # on an invisible dialog. Release only our proven preparation process.
    # Both hosts remain inside the runtime's same process job and lease.
    owned = _load_json_file(str(root/"geometry-owned-native.json"))
    pid = int(owned["configured_pid"])
    candidates = _owned_native_processes(os.getpid())
    selected = _select_owned_host(candidates, os.getpid(), _find_yjks_exe(yjks_root))
    if int(selected["ProcessId"]) != pid:
        raise RuntimeError("YJK preparation process ownership changed / YJK 准备进程归属改变")
    _SDK_PIPE.close()
    subprocess.run(["taskkill", "/PID", str(pid), "/F"], check=True, timeout=15,
                   stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, creationflags=subprocess.CREATE_NO_WINDOW)
    _record_step(steps, phase="axial-gravity-preparation", name="Release owned geometry host",
                 status="success", pid=pid, method="verified-owned-pid-within-process-job")
    _connect_owned_host(yjks_root, steps)
    command("UINew", str(root/"axial-gravity.yjk"))
    command("yjk_importydb", str(root/"axial-gravity.ydb"))
    current = _load_json_file(str(root/"owned-native.json"))
    apply_in_host(lambda *args: _run_cmd(*args, phase="axial-gravity-settings", steps=steps),
                  work_dir, int(current["configured_pid"]), compile_settings(model))
    for name in ("yjk_repair", "yjk_save", "yjk_setlayersupport", "yjkspre_genmodrel",
                 "yjktransload_tlplan", "yjktransload_tlvert"):
        command(name)
    command("SetCurrentLabel", "IDSPRE_ROOT")
    command("yjkSPre_GenData")


def _run(model_path: str, work_dir: str, yjks_root: str) -> int:
    global _CURRENT_WORK_DIR

    steps: list[dict] = []
    work_dir = os.path.abspath(work_dir)
    _CURRENT_WORK_DIR = work_dir
    results_path = os.path.join(work_dir, "results.json")
    os.makedirs(work_dir, exist_ok=True)
    os.environ["SC_YJK_WORK_DIR"] = work_dir
    os.environ["SC_YJK_RESULTS_PATH"] = results_path

    # -- Import YJKAPI (requires sys.path set up by _setup_paths) ------
    # Redirect stdout during import so any YJKAPI banner/init messages
    # go to stderr and don't corrupt our JSON output channel.
    _real_stdout = sys.stdout
    sys.stdout = sys.stderr
    started_at = time.monotonic()
    try:
        from YJKAPI import ControlConfig, YJKSControl
    except Exception as exc:
        sys.stdout = _real_stdout
        _record_step(
            steps,
            phase="bootstrap",
            name="Import YJKAPI",
            status="error",
            message=str(exc),
            started_at=started_at,
        )
        _error(
            f"YJKAPI import failed: {exc}",
            phase="bootstrap",
            command="import YJKAPI",
            steps=steps,
            summary={"work_dir": work_dir},
        )
        return 1
    finally:
        sys.stdout = _real_stdout
    _record_step(
        steps,
        phase="bootstrap",
        name="Import YJKAPI",
        status="success",
        started_at=started_at,
    )

    # -- Read V2 model JSON ---------------------------------------------
    with open(model_path, "r", encoding="utf-8") as f:
        model_data = json.load(f)

    project = model_data.get("project")
    project_name = (
        project.get("name", "sc_model") if isinstance(project, dict) else "sc_model"
    ) or "sc_model"
    ydb_filename = f"{project_name}.ydb"

    # -- Phase 1: Convert V2 -> .ydb ------------------------------------
    print("[yjk_driver] Phase 1: V2 -> YDB conversion", file=sys.stderr, flush=True)
    from yjk_converter import convert_v2_to_ydb
    design_request = _load_json_file(os.path.join(work_dir, "native-design-request.json")) if os.path.isfile(
        os.path.join(work_dir, "native-design-request.json")) else None

    started_at = time.monotonic()
    try:
        ydb_path = convert_v2_to_ydb(model_data, work_dir, ydb_filename, design_plan=design_request)
    except Exception as exc:
        _record_step(
            steps,
            phase="conversion",
            name="V2 -> YDB conversion",
            status="error",
            message=str(exc),
            started_at=started_at,
        )
        _error(
            f"V2 -> YDB conversion failed: {exc}",
            phase="conversion",
            steps=steps,
        )
        return 1
    _record_step(
        steps,
        phase="conversion",
        name="V2 -> YDB conversion",
        status="success",
        started_at=started_at,
        ydb_path=ydb_path,
    )
    print(f"[yjk_driver] ydb_path = {ydb_path}", file=sys.stderr, flush=True)

    # -- Phase 2: Launch a unique contained YJK host ---------------------
    try:
        _connect_owned_host(yjks_root, steps)
    except Exception as exc:
        _error(f"YJK owned host connection failed: {exc}", phase="launch",
               command="RunYJK/initConfig(Pid)", steps=steps,
               summary={"work_dir": work_dir})
        return 1

    # -- Phase 3: Open/create project + import ydb ----------------------
    project_dir = os.path.dirname(os.path.abspath(ydb_path))
    yjk_project = os.path.join(project_dir, f"{project_name}.yjk")

    print(f"[yjk_driver] Phase 3: project = {yjk_project}", file=sys.stderr, flush=True)
    if os.path.isfile(yjk_project):
        if not _run_cmd("UIOpen", yjk_project, phase="project", steps=steps):
            _error(
                "YJK crashed while opening project",
                phase="project",
                command="UIOpen",
                steps=steps,
            )
            return 1
    else:
        if not _run_cmd("UINew", yjk_project, phase="project", steps=steps):
            _error(
                "YJK crashed while creating new project",
                phase="project",
                command="UINew",
                steps=steps,
            )
            return 1

    if not _run_cmd("yjk_importydb", ydb_path, phase="project", steps=steps):
        _error(
            "YJK crashed while importing YDB file - the model may have invalid geometry or sections",
            phase="project",
            command="yjk_importydb",
            steps=steps,
        )
        return 1

    # Import may replace project parameters. Write the requested settings in
    # this owned host only after import, and require exact SDK readback.
    if model_data.get("analysis_control"):
        try:
            from yjk_native_settings import apply_in_host, compile_settings
            ownership = _load_json_file(os.path.join(work_dir, "owned-native.json"))
            apply_in_host(lambda *args: _run_cmd(*args, phase="settings", steps=steps),
                          work_dir, int(ownership["configured_pid"]), compile_settings(model_data))
        except Exception as exc:
            _error(f"YJK native settings failed / 原生设置写入或读回失败: {exc}",
                   phase="settings", command="yjk_native_settings", steps=steps)
            return 1

    # -- Phase 4: Model preparation (exact three_story_steel_frame.py) --
    if design_request:
        try:
            from yjk_native_settings import apply_in_host
            ownership = _load_json_file(os.path.join(work_dir, "owned-native.json"))
            apply_in_host(lambda *args: _run_cmd(*args, phase="design-settings", steps=steps),
                          work_dir, int(ownership["configured_pid"]), design_request,
                          receipt_name="native-design-settings-readback.json")
        except Exception as exc:
            _error(f"YJK native design settings failed / 原生设计参数失败: {exc}",
                   phase="design-settings", command="yjk_native_settings", steps=steps)
            return 1
    print("[yjk_driver] Phase 4: model repair / prep", file=sys.stderr, flush=True)
    if not _run_cmd("yjk_repair", phase="model_preparation", steps=steps):
        _error(
            "YJK crashed during model repair",
            phase="model_preparation",
            command="yjk_repair",
            steps=steps,
        )
        return 1
    if not _run_cmd("yjk_save", phase="model_preparation", steps=steps):
        _error(
            "YJK crashed during save",
            phase="model_preparation",
            command="yjk_save",
            steps=steps,
        )
        return 1
    # Rod models contain no physical slabs. Parameter 606 supplies an explicit
    # rigid diaphragm without adding plate stiffness, mass or floor loads.
    if not _run_cmd("yjk_setlayersupport", phase="model_preparation", steps=steps):
        _error(
            "YJK crashed during layer support setup",
            phase="model_preparation",
            command="yjk_setlayersupport",
            steps=steps,
        )
        return 1

    # -- Phase 5: Preprocessing -----------------------------------------
    # Preprocessing steps (genmodrel, transload) are fast and must finish
    # before the model is usable.  The heavy design calculation
    # (yjkdesign_dsncalculating_all) runs in Phase 6 and is synchronous by
    # default so the runtime can return extracted results.
    print("[yjk_driver] Phase 5: preprocessing", file=sys.stderr, flush=True)
    if not _run_cmd("yjkspre_genmodrel", phase="preprocessing", steps=steps):
        _error(
            "YJK crashed during model relation generation",
            phase="preprocessing",
            command="yjkspre_genmodrel",
            steps=steps,
        )
        return 1
    if not _run_cmd("yjktransload_tlplan", phase="preprocessing", steps=steps):
        _error(
            "YJK crashed during plan load transfer",
            phase="preprocessing",
            command="yjktransload_tlplan",
            steps=steps,
        )
        return 1
    if not _run_cmd("yjktransload_tlvert", phase="preprocessing", steps=steps):
        _error(
            "YJK crashed during vertical load transfer",
            phase="preprocessing",
            command="yjktransload_tlvert",
            steps=steps,
        )
        return 1
    if not _run_cmd("SetCurrentLabel", "IDSPRE_ROOT", phase="preprocessing", steps=steps):
        _error(
            "YJK crashed during label switch",
            phase="preprocessing",
            command="SetCurrentLabel",
            steps=steps,
        )
        return 1

    # Automatic rigid lengths are generated by the vendor, never inferred
    # from section dimensions. The optional second import compiles only the
    # axial gravity load vector using those actual lengths.
    axial_gravity = (model_data.get("analysis_control", {}).get("rigid_offsets") is True
                     and model_data.get("analysis_control", {}).get("self_weight") is True)
    if axial_gravity:
        _prepare_axial_gravity(model_data, work_dir, yjks_root, steps)

    # -- Phase 6: Synchronous design calculation ------------------------
    print("[yjk_driver] Phase 6: synchronous calculation", file=sys.stderr, flush=True)
    calculation = "yjkdesign_dsncalculating_cal_design" if axial_gravity else "yjkdesign_dsncalculating_all"
    if not _run_cmd(calculation, phase="analysis", steps=steps):
        _error(
            "YJK crashed or failed during design calculation",
            phase="analysis",
            command=calculation,
            steps=steps,
            summary={"work_dir": work_dir, "yjk_project": yjk_project},
        )
        return 1

    # -- Phase 7: Extract results inside YJK and read work_dir/results.json
    print("[yjk_driver] Phase 7: result extraction", file=sys.stderr, flush=True)
    extract_source = os.path.join(SCRIPT_DIR, "extract_results.py")
    extract_script = os.path.join(work_dir, "extract_results.py")
    started_at = time.monotonic()
    try:
        if os.path.isfile(results_path):
            os.remove(results_path)
        shutil.copyfile(extract_source, extract_script)
    except Exception as exc:
        _record_step(
            steps,
            phase="result_extraction",
            name="Prepare extract_results.py",
            status="error",
            message=str(exc),
            started_at=started_at,
        )
        _error(
            f"Failed to prepare YJK result extractor: {exc}",
            phase="result_extraction",
            command="copy_extract_results",
            steps=steps,
            summary={"work_dir": work_dir, "yjk_project": yjk_project},
        )
        return 1
    _record_step(
        steps,
        phase="result_extraction",
        name="Prepare extract_results.py",
        status="success",
        started_at=started_at,
        script=extract_script,
    )

    if not _run_cmd("yjks_pyload", extract_script, "pyyjks", phase="result_extraction", steps=steps):
        _error(
            "YJK crashed or failed while running extract_results.py",
            phase="result_extraction",
            command="yjks_pyload",
            steps=steps,
            summary={"work_dir": work_dir, "yjk_project": yjk_project},
        )
        return 1

    started_at = time.monotonic()
    try:
        extract_timeout = _env_float("YJK_EXTRACT_TIMEOUT_S", 30.0)
        deadline = time.monotonic() + extract_timeout
        while True:
            try:
                with open(results_path, "r", encoding="utf-8") as f:
                    extracted = json.load(f)
                break
            except (FileNotFoundError, json.JSONDecodeError):
                if time.monotonic() >= deadline:
                    raise
                time.sleep(0.5)
    except Exception as exc:
        _record_step(
            steps,
            phase="result_read",
            name="Read results.json",
            status="error",
            message=str(exc),
            started_at=started_at,
            path=results_path,
        )
        _error(
            f"Failed to read YJK results.json from work_dir: {exc}",
            phase="result_read",
            command="read_results_json",
            steps=steps,
            summary={"work_dir": work_dir, "yjk_project": yjk_project},
            detailed={"results_path": results_path},
        )
        return 1

    if isinstance(extracted, dict) and extracted.get("status") == "error":
        error_message = str(extracted.get("error") or extracted.get("message") or "YJK result extraction failed")
        _record_step(
            steps,
            phase="result_extraction",
            name="extract_results.py",
            status="error",
            message=error_message,
            started_at=started_at,
            path=results_path,
        )
        _error(
            error_message,
            phase=str(extracted.get("phase") or "result_extraction"),
            command=str(extracted.get("command") or "yjks_pyload"),
            steps=steps,
            summary={"work_dir": work_dir, "yjk_project": yjk_project},
            detailed={"results_path": results_path, "extractor": extracted},
        )
        return 1

    _record_step(
        steps,
        phase="result_read",
        name="Read results.json",
        status="success",
        started_at=started_at,
        path=results_path,
    )

    if os.path.isfile(os.path.join(work_dir, "native-stiffness-plan.json")):
        from yjk_native_materials import verify_native_physics
        physics = verify_native_physics(work_dir, model_data, engine_version="YJK8.0.0")
        if physics.get("passed") is not True:
            _error("YJK executed model failed physical input verification / 原生计算模型未通过物理输入核对",
                   phase="physics_verification", command="verify_native_physics", steps=steps,
                   detailed={"physicsAudit": physics, "artifact": os.path.join(work_dir, "native-physics-audit.json")})
            return 1
    mapping = _load_json_file(os.path.join(work_dir, "mapping.json"))
    output = _build_analysis_result(
        source_model=model_data,
        extracted=extracted,
        mapping=mapping,
        ydb_path=ydb_path,
        yjk_project=yjk_project,
        work_dir=work_dir,
        results_path=results_path,
        steps=steps,
    )

    _write_driver_output_json(work_dir, output)
    _emit_json(output)
    print("[yjk_driver] done — calculation and extraction completed", file=sys.stderr, flush=True)
    return _finish_after_json(work_dir=work_dir, steps=steps, exit_code=0, force_exit=True)


if __name__ == "__main__":
    raise SystemExit(main())
