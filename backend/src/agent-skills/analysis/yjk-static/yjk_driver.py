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
import re
import shutil
import sys
import time
import traceback

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
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
    for p in (root, os.path.join(os.path.dirname(SCRIPT_DIR), "runtime"), SCRIPT_DIR):
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


def _safe_float(value: object, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _finite_result_float(value: object, label: str) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError) as error:
        raise RuntimeError(f"YJK result {label} is not numeric") from error
    if not math.isfinite(number):
        raise RuntimeError(f"YJK result {label} is not finite")
    return number


def _signed_max_abs(current: float, candidate: float) -> float:
    return candidate if abs(candidate) > abs(current) else current


def _load_json_file(path: str) -> dict:
    try:
        with open(path, "r", encoding="utf-8") as f:
            payload = json.load(f)
        return payload if isinstance(payload, dict) else {}
    except Exception:
        return {}


def _id_candidates(value: object) -> list[str]:
    if value is None:
        return []
    text = str(value).strip()
    if not text or text.lower() == "none":
        return []
    candidates = [text]
    number = _safe_float(value, None)
    if number is not None and abs(number - round(number)) < 1e-9:
        candidates.append(str(int(round(number))))
    return list(dict.fromkeys(candidates))


def _coord_key(x: object, y: object, z: object, *, scale: float = 1.0) -> tuple[float, float, float]:
    # Keys are millimetres, quantized only for floating-point coordinate noise.
    # Preserve submillimetre geometry instead of rounding it to whole mm.
    return (
        round(_finite_result_float(x, "node coordinate x") * scale, 6),
        round(_finite_result_float(y, "node coordinate y") * scale, 6),
        round(_finite_result_float(z, "node coordinate z") * scale, 6),
    )


def _node_lookup_from_mapping(mapping: dict) -> dict[tuple[float, float, float], str]:
    lookup: dict[tuple[float, float, float], str] = {}
    nodes = mapping.get("nodes", {})
    if not isinstance(nodes, dict):
        return lookup

    for v2_id, item in nodes.items():
        if not isinstance(item, dict):
            continue
        keys = []
        for suffix, scale in (("mm", 1.0), ("m", 1000.0)):
            fields = tuple(f"{axis}_{suffix}" for axis in ("x", "y", "z"))
            if any(field in item for field in fields):
                keys.append(_coord_key(*(item.get(field) for field in fields), scale=scale))
        if not keys or any(key != keys[0] for key in keys):
            raise RuntimeError(f"YJK converter node '{v2_id}' has missing or conflicting coordinates")
        key = keys[0]
        mapped_id = str(item.get("v2_id") or v2_id)
        if key in lookup and lookup[key] != mapped_id:
            raise RuntimeError("YJK coordinate mapping is ambiguous for coincident physical nodes")
        lookup[key] = mapped_id
    return lookup


def _build_result_node_lookup(
    extracted: dict,
    mapping: dict,
    diagnostics: dict | None = None,
) -> dict[str, str]:
    coord_to_v2 = _node_lookup_from_mapping(mapping)
    meta = extracted.get("meta", {})
    # Historical extractor payloads documented XYZ in metres. New payloads
    # state the unit; never try multiple scales based on what happens to match.
    coordinate_unit = meta.get("coordinateUnit", "m") if isinstance(meta, dict) else "m"
    if coordinate_unit not in {"m", "mm"}:
        raise RuntimeError(f"Unsupported YJK result coordinate unit: {coordinate_unit!r}")
    scale = 1000.0 if coordinate_unit == "m" else 1.0
    # The result SDK exports float32 XYZ. Compare against that exact encoding
    # of the authored coordinate, not a model-dependent distance tolerance.
    # Example: 3.6 m reads back as 3.5999999046325684 m.
    import struct
    float32_coordinates = {}
    for coordinates, physical_id in coord_to_v2.items():
        encoded = _coord_key(*(struct.unpack('f', struct.pack('f', value / scale))[0]
                               for value in coordinates), scale=scale)
        if encoded in float32_coordinates and float32_coordinates[encoded] != physical_id:
            raise RuntimeError('YJK float32 coordinates cannot distinguish physical nodes')
        float32_coordinates[encoded] = physical_id
    result_lookup: dict[str, str] = {}
    coord_matches = 0
    unmapped = 0
    for node in extracted.get("nodes", []) if isinstance(extracted.get("nodes"), list) else []:
        if not isinstance(node, dict):
            continue
        result_id = str(node.get("id"))
        key = _coord_key(node.get("x"), node.get("y"), node.get("z"), scale=scale)
        matched = coord_to_v2.get(key) or float32_coordinates.get(key)
        if result_id in result_lookup:
            raise RuntimeError(f"Duplicate YJK result node ID: {result_id}")
        if matched:
            result_lookup[result_id] = matched
            coord_matches += 1
        else:
            result_lookup[result_id] = result_id
            unmapped += 1
    if diagnostics is not None:
        diagnostics["node_id_matches"] = 0
        diagnostics["node_coord_matches"] = coord_matches
        diagnostics["node_unmapped"] = unmapped
        diagnostics["node_id_index_size"] = len(result_lookup)
    return result_lookup


def _element_category(elem_type: object) -> str:
    normalized = str(elem_type or "").lower()
    if normalized == "column":
        return "columns"
    if normalized in ("brace", "braces", "truss"):
        return "braces"
    return "beams"


def _endpoint_key(nodes: object) -> tuple[str, str] | None:
    if not isinstance(nodes, list) or len(nodes) < 2:
        return None
    endpoints = [str(nodes[0]), str(nodes[-1])]
    endpoints.sort()
    return (endpoints[0], endpoints[1])


def _build_element_lookups(mapping: dict) -> dict[str, dict]:
    by_yjk_id: dict[tuple[str, int, str], str] = {}
    by_endpoint: dict[tuple[str, int, tuple[str, str]], str] = {}
    by_sequence: dict[tuple[str, int, int], str] = {}
    elements = mapping.get("elements", {})
    if not isinstance(elements, dict):
        return {
            "by_yjk_id": by_yjk_id,
            "by_endpoint": by_endpoint,
            "by_sequence": by_sequence,
        }

    for v2_id, item in elements.items():
        if not isinstance(item, dict):
            continue
        elem_id = str(item.get("v2_id") or v2_id)
        category = ('braces' if item.get('native_geometry_route') == 'ordinary-inclined-column'
                    else _element_category(item.get("type")))
        floor_index = int(round(_safe_float(item.get("floor_index"), 0.0)))
        for field in (
            "yjk_model_id",
            "yjk_member_id",
            "yjk_id",
            "tot_id",
            "original_no",
            "id",
        ):
            for candidate in _id_candidates(item.get(field)):
                by_yjk_id[(category, floor_index, candidate)] = elem_id

        endpoints = _endpoint_key(item.get("nodes"))
        if endpoints is not None and floor_index > 0:
            by_endpoint[(category, floor_index, endpoints)] = elem_id

        fallback = item.get("fallback_match", {})
        if isinstance(fallback, dict):
            sequence = int(round(_safe_float(fallback.get("sequence_in_floor_type"), 0.0)))
            if floor_index > 0 and sequence > 0:
                by_sequence[(category, floor_index, sequence)] = elem_id
    return {
        "by_yjk_id": by_yjk_id,
        "by_endpoint": by_endpoint,
        "by_sequence": by_sequence,
    }


def _member_id_for(
    *,
    category: str,
    raw_member: dict,
    sequence: int,
    lookups: dict[str, dict],
    result_node_lookup: dict[str, str],
    diagnostics: dict | None = None,
) -> tuple[str, str]:
    floor = int(round(_safe_float(raw_member.get("floor"), 0.0)))
    original_floor = int(round(_safe_float(raw_member.get("original_floor"), 0.0)))
    floors = [item for item in (floor, original_floor) if item > 0]
    if category == "beams":
        floors.extend(item + 1 for item in (floor, original_floor) if item > 0)
    if not floors:
        floors = [0]
    floors = list(dict.fromkeys(floors))

    by_yjk_id = lookups.get("by_yjk_id", {})
    for candidate_field in ("tot_id", "id", "original_no"):
        for candidate in _id_candidates(raw_member.get(candidate_field)):
            for floor_key in floors:
                direct = by_yjk_id.get((category, floor_key, candidate))
                if direct:
                    if diagnostics is not None:
                        diagnostics["element_direct_matches"] = diagnostics.get("element_direct_matches", 0) + 1
                    return direct, "direct"

    node_i = raw_member.get("node_i")
    node_j = raw_member.get("node_j")
    endpoint = _endpoint_key([
        result_node_lookup.get(str(node_i), str(node_i)),
        result_node_lookup.get(str(node_j), str(node_j)),
    ])
    if endpoint is not None:
        by_endpoint = lookups.get("by_endpoint", {})
        for floor_key in floors:
            direct = by_endpoint.get((category, floor_key, endpoint))
            if direct:
                if diagnostics is not None:
                    diagnostics["element_endpoint_matches"] = diagnostics.get("element_endpoint_matches", 0) + 1
                return direct, "endpoint"

    raw_sequence = int(round(_safe_float(raw_member.get("sequence"), 0.0))) or sequence
    by_sequence = lookups.get("by_sequence", {})
    for floor_key in floors:
        fallback = by_sequence.get((category, floor_key, raw_sequence))
        if fallback:
            if diagnostics is not None:
                diagnostics["element_sequence_matches"] = diagnostics.get("element_sequence_matches", 0) + 1
            return fallback, "sequence"

    if diagnostics is not None:
        diagnostics["element_unmapped"] = diagnostics.get("element_unmapped", 0) + 1
    member_key = next(
        (str(raw_member.get(field)) for field in ("tot_id", "id", "original_no") if raw_member.get(field) is not None),
        str(raw_sequence),
    )
    return f"{category}:{floors[0]}:{member_key}", "raw"


def _force_from_sections(sections: object) -> dict[str, float]:
    """Map YJK section force rows [Mx, My, Qx, Qy, N, T] to common fields."""
    force = {"N": 0.0, "Vy": 0.0, "Vz": 0.0, "T": 0.0, "My": 0.0, "Mz": 0.0}
    if not isinstance(sections, list):
        force["V"] = 0.0
        force["M"] = 0.0
        return force

    rows = sections
    if sections and all(not isinstance(item, (list, tuple)) for item in sections):
        rows = [sections]

    for row in rows:
        if not isinstance(row, (list, tuple)):
            continue
        if len(row) < 6:
            raise RuntimeError("YJK member-force section returned fewer than six local-force components")
        values = [
            _finite_result_float(item, f"member force[{index}]")
            for index, item in enumerate(row[:6])
        ]
        mx, my, qx, qy, axial, torsion = values[:6]
        force["N"] = _signed_max_abs(force["N"], axial)
        force["Vy"] = _signed_max_abs(force["Vy"], qx)
        force["Vz"] = _signed_max_abs(force["Vz"], qy)
        force["T"] = _signed_max_abs(force["T"], torsion)
        force["My"] = _signed_max_abs(force["My"], my)
        force["Mz"] = _signed_max_abs(force["Mz"], mx)
        force["V"] = max(force.get("V", 0.0), math.hypot(qx, qy))
        force["M"] = max(force.get("M", 0.0), math.hypot(my, mx))

    force.setdefault("V", 0.0)
    force.setdefault("M", 0.0)
    return force


def _reaction_from_raw(raw: dict) -> dict[str, float]:
    reaction = {
        "fx": _finite_result_float(raw.get("Fx", raw.get("fx", raw.get("RX", raw.get("rx")))), "reaction fx"),
        "fy": _finite_result_float(raw.get("Fy", raw.get("fy", raw.get("RY", raw.get("ry")))), "reaction fy"),
        "fz": _finite_result_float(raw.get("Fz", raw.get("fz", raw.get("RZ", raw.get("rz")))), "reaction fz"),
        "mx": _finite_result_float(raw.get("Mx", raw.get("mx")), "reaction mx"),
        "my": _finite_result_float(raw.get("My", raw.get("my")), "reaction my"),
        "mz": _finite_result_float(raw.get("Mz", raw.get("mz")), "reaction mz"),
    }
    reaction["R"] = _safe_float(
        raw.get("R"),
        (reaction["fx"] ** 2 + reaction["fy"] ** 2 + reaction["fz"] ** 2) ** 0.5,
    )
    return reaction


def _merge_max_reaction(target: dict[str, float], candidate: dict[str, float]) -> dict[str, float]:
    merged = dict(target)
    for key in ("fx", "fy", "fz", "mx", "my", "mz"):
        merged[key] = _signed_max_abs(_safe_float(merged.get(key)), _safe_float(candidate.get(key)))
    merged["R"] = max(abs(_safe_float(merged.get("R"))), abs(_safe_float(candidate.get("R"))))
    return merged


def _merge_max_force(target: dict[str, float], candidate: dict[str, float]) -> dict[str, float]:
    merged = dict(target)
    for key in ("N", "Vy", "Vz", "T", "My", "Mz"):
        merged[key] = _signed_max_abs(_safe_float(merged.get(key)), _safe_float(candidate.get(key)))
    for key in ("V", "M"):
        merged[key] = max(abs(_safe_float(merged.get(key))), abs(_safe_float(candidate.get(key))))
    return merged


def _accumulate_node_envelope(
    table: dict[str, dict],
    node_id: str,
    case_name: str,
    disp: dict[str, float],
) -> None:
    mag = (
        _safe_float(disp.get("ux")) ** 2
        + _safe_float(disp.get("uy")) ** 2
        + _safe_float(disp.get("uz")) ** 2
    ) ** 0.5
    item = table.setdefault(str(node_id), {"maxAbsDisplacement": 0.0, "controlCase": ""})
    if mag > _safe_float(item.get("maxAbsDisplacement")):
        item["maxAbsDisplacement"] = mag
        item["controlCase"] = case_name


def _accumulate_element_envelope(
    table: dict[str, dict],
    elem_id: str,
    case_name: str,
    force: dict[str, float],
) -> None:
    item = table.setdefault(
        str(elem_id),
        {
            "maxAbsAxialForce": 0.0,
            "maxAbsShearForce": 0.0,
            "maxAbsMoment": 0.0,
            "controlCaseAxial": "",
            "controlCaseShear": "",
            "controlCaseMoment": "",
        },
    )
    axial = abs(_safe_float(force.get("N")))
    shear = abs(_safe_float(force.get("V")))
    moment = abs(_safe_float(force.get("M")))
    if axial > _safe_float(item.get("maxAbsAxialForce")):
        item["maxAbsAxialForce"] = axial
        item["controlCaseAxial"] = case_name
    if shear > _safe_float(item.get("maxAbsShearForce")):
        item["maxAbsShearForce"] = shear
        item["controlCaseShear"] = case_name
    if moment > _safe_float(item.get("maxAbsMoment")):
        item["maxAbsMoment"] = moment
        item["controlCaseMoment"] = case_name


def _accumulate_reaction_envelope(
    table: dict[str, dict],
    node_id: str,
    case_name: str,
    reaction: dict[str, float],
) -> None:
    item = table.setdefault(
        str(node_id),
        {
            "maxAbsReaction": 0.0,
            "controlCase": "",
            "fx": 0.0,
            "fy": 0.0,
            "fz": 0.0,
            "mx": 0.0,
            "my": 0.0,
            "mz": 0.0,
            "R": 0.0,
        },
    )
    resultant = abs(_safe_float(reaction.get("R")))
    if resultant > _safe_float(item.get("maxAbsReaction")):
        item.update(reaction)
        item["maxAbsReaction"] = resultant
        item["controlCase"] = case_name


def _case_descriptors(extracted: dict, raw_case_keys: set[str]) -> list[dict]:
    meta = extracted.get("meta", {}) if isinstance(extracted.get("meta"), dict) else {}
    raw_cases = extracted.get("load_cases")
    if raw_cases is None:
        raw_cases = meta.get("load_cases")
    descriptors: list[dict] = []
    used_result_keys: set[str] = set()
    claimed_source_keys: set[str] = set()

    if isinstance(raw_cases, list):
        for index, item in enumerate(raw_cases, start=1):
            if isinstance(item, dict):
                case_id = item.get("id")
                old_id = item.get("oldId")
                key = str(item.get("key") or f"lc_{case_id}") if case_id is not None else str(item.get("key") or f"case_{index}")
                label = str(item.get("name") or item.get("expName") or key)
                source_keys = [
                    key,
                    *(f"lc_{value}" for value in _id_candidates(case_id)),
                    *(f"lc_{value}" for value in _id_candidates(old_id)),
                    *_id_candidates(case_id),
                    *_id_candidates(old_id),
                ]
                descriptor = {
                    "result_key": key,
                    "source_keys": list(dict.fromkeys(source_keys)),
                    "label": label,
                    "name": item.get("name"),
                    "expName": item.get("expName"),
                    "kind": item.get("kind"),
                    "id": case_id,
                    "oldId": old_id,
                    "nativeCode": _native_case_code(item),
                }
            else:
                key = f"lc_{item}"
                descriptor = {
                    "result_key": key,
                    "source_keys": [key, str(item)],
                    "label": key,
                    "name": key,
                    "kind": None,
                    "id": item,
                    "oldId": None,
                    "expName": None,
                }

            result_key = str(descriptor["result_key"])
            if result_key in used_result_keys:
                result_key = f"{result_key}_{index}"
                descriptor["result_key"] = result_key
            used_result_keys.add(result_key)
            claimed_source_keys.update(str(value) for value in descriptor["source_keys"])
            descriptors.append(descriptor)

    for raw_key in sorted(raw_case_keys - claimed_source_keys):
        descriptors.append({
            "result_key": raw_key,
            "source_keys": [raw_key],
            "label": raw_key,
            "name": raw_key,
            "kind": None,
            "id": None,
            "oldId": None,
            "expName": None,
        })
    return descriptors


def _native_case_code(case: dict) -> str | None:
    # dsnGetLDCaseExpName preserves the ASCII code even when its legacy
    # Chinese text is decoded incorrectly by the native SDK.
    match = re.match(r"^\s*([+-]?[A-Z][A-Z0-9_]*)\s+--", str(case.get("expName") or ""))
    return match.group(1) if match else None


def _case_block(block: dict, descriptor: dict) -> object:
    for key in descriptor.get("source_keys", []):
        if key in block:
            return block.get(key)
    return []


def _raw_member_definition_lookup(extracted: dict) -> dict[str, dict[tuple[int, str], dict]]:
    lookup: dict[str, dict[tuple[int, str], dict]] = {}
    members = extracted.get("members", {})
    if not isinstance(members, dict):
        return lookup
    for category in ("columns", "beams", "braces"):
        category_lookup: dict[tuple[int, str], dict] = {}
        raw_members = members.get(category, [])
        if not isinstance(raw_members, list):
            continue
        for raw in raw_members:
            if not isinstance(raw, dict):
                continue
            floor = int(round(_safe_float(raw.get("floor"), 0.0)))
            original_floor = int(round(_safe_float(raw.get("original_floor"), 0.0)))
            floors = [item for item in (floor, original_floor) if item > 0] or [0]
            for field in ("tot_id", "id", "original_no", "sequence"):
                for candidate in _id_candidates(raw.get(field)):
                    for floor_key in floors:
                        category_lookup[(floor_key, candidate)] = raw
        lookup[category] = category_lookup
    return lookup


def _merge_member_definition(category_lookup: dict[tuple[int, str], dict], raw_force: dict) -> dict:
    floor = int(round(_safe_float(raw_force.get("floor"), 0.0)))
    original_floor = int(round(_safe_float(raw_force.get("original_floor"), 0.0)))
    floors = [item for item in (floor, original_floor) if item > 0] or [0]
    for field in ("tot_id", "id", "original_no", "sequence"):
        for candidate in _id_candidates(raw_force.get(field)):
            for floor_key in floors:
                raw_member = category_lookup.get((floor_key, candidate))
                if raw_member:
                    merged = dict(raw_member)
                    merged.update(raw_force)
                    return merged
    return raw_force


def _category_element_type(category: str) -> str:
    if category == "columns":
        return "column"
    if category == "braces":
        return "brace"
    return "beam"


def _build_yjk_design_results(
    *,
    extracted: dict,
    member_definition_lookup: dict[str, dict[tuple[int, str], dict]],
    element_lookups: dict[str, dict],
    result_node_lookup: dict[str, str],
    diagnostics: dict,
) -> dict:
    """Preserve mapped native design records without inventing check meanings.

    SDK tuples can include return codes, limits, areas and placeholders (e.g.
    [0, 99, 0, 0]). Their largest number is not a utilization ratio. Neither
    dimensions nor percent encoding can be inferred from numeric magnitude.
    Design schemas and software-generated combinations remain uncalibrated.
    """
    raw_design = extracted.get("member_design", {})
    if not isinstance(raw_design, dict):
        raw_design = {}

    elements: dict[str, dict] = {}
    raw_count = 0
    mapped_count = 0

    for category in ("columns", "beams", "braces"):
        raw_items = raw_design.get(category, [])
        if not isinstance(raw_items, list):
            continue
        category_lookup = member_definition_lookup.get(category, {})
        for sequence, raw_item in enumerate(raw_items, start=1):
            if not isinstance(raw_item, dict):
                continue
            raw_count += 1
            raw_member = _merge_member_definition(category_lookup, raw_item)
            elem_id, match_method = _member_id_for(
                category=category,
                raw_member=raw_member,
                sequence=sequence,
                lookups=element_lookups,
                result_node_lookup=result_node_lookup,
                diagnostics=diagnostics,
            )
            if match_method not in {"direct", "endpoint"}:
                raise RuntimeError(
                    f"YJK design result for {category} member '{raw_item.get('id')}' lacks an exact id or endpoint mapping"
                )
            mapped_count += 1

            if elem_id in elements:
                raise RuntimeError(f"YJK design result repeats mapped physical member '{elem_id}'")
            elements[elem_id] = {
                "elementId": elem_id,
                "elementType": _category_element_type(category),
                "floor": raw_item.get("floor"),
                "yjk": {
                    "category": category,
                    "id": raw_item.get("id"),
                    "totId": raw_item.get("tot_id"),
                    "originalNo": raw_item.get("original_no"),
                    "originalFloor": raw_item.get("original_floor"),
                    "matchMethod": match_method,
                },
                "interpretation": "unverified-native-design-schema",
                "raw": raw_item.get("raw", {}),
            }

    diagnostics["design_raw_members"] = raw_count
    diagnostics["design_mapped_members"] = mapped_count
    diagnostics["design_unmapped_members"] = max(raw_count - mapped_count, 0)

    return {
        "source": "YJKSDsnDataPy",
        "scope": "software-automatic-design",
        "verificationStatus": "unverified",
        "summary": {
            "elementCount": len(elements),
            "rawMemberCount": raw_count,
            "mappedMemberCount": mapped_count,
        },
        "elements": elements,
    }


def _build_analysis_result(
    *,
    extracted: dict,
    mapping: dict,
    ydb_path: str,
    yjk_project: str,
    work_dir: str,
    results_path: str,
    steps: list[dict],
    source_model: dict | None = None,
) -> dict:
    """Normalize raw YJK result JSON into the app's analysis result shape."""
    meta = extracted.get("meta", {}) if isinstance(extracted.get("meta"), dict) else {}
    native_fe_model = None
    source_elements = {}
    source_load_cases = {}
    native_context = {}
    station_errors = {}
    fe_path = os.path.join(work_dir, "fea.dat")
    input_path = os.path.join(work_dir, "input.json")
    if os.path.isfile(fe_path) and (source_model is not None or os.path.isfile(input_path)):
        from native_fe import parse_fe
        from yjk_native_stations import member_geometry, map_stations, station_envelope, StationConventionUnavailable
        import hashlib
        native_fe_model = parse_fe(fe_path)
        if source_model is None:
            with open(input_path, encoding="utf-8-sig") as stream:
                source_model = json.load(stream)
        source_elements = {str(row["id"]): row for row in source_model.get("elements", [])}
        source_load_cases = {str(row["id"]): row for row in source_model.get("load_cases", [])}
        native_context = {"engine": "yjk", "stationConventionsVerified": False,
                          "artifacts": [{"path": "fea.dat", "sha256": native_fe_model["sha256"]}]}
        context_path = os.path.join(work_dir, "native-physics-context.json")
        if os.path.isfile(context_path):
            with open(context_path, encoding="utf-8-sig") as stream:
                native_context = json.load(stream)
            model_hash = hashlib.sha256(json.dumps(source_model, sort_keys=True, separators=(",", ":"),
                                                   ensure_ascii=False, allow_nan=False).encode("utf-8")).hexdigest()
            if (native_context.get("physicalModelHash") != model_hash
                    or {"path": "fea.dat", "sha256": native_fe_model["sha256"]} not in native_context.get("artifacts", [])):
                raise RuntimeError("YJK native physics context is not bound to the executed model and FE artifact")
    diagnostics: dict[str, int] = {}
    result_node_lookup = _build_result_node_lookup(extracted, mapping, diagnostics)
    element_lookups = _build_element_lookups(mapping)
    member_definition_lookup = _raw_member_definition_lookup(extracted)
    design_results = _build_yjk_design_results(
        extracted=extracted,
        member_definition_lookup=member_definition_lookup,
        element_lookups=element_lookups,
        result_node_lookup=result_node_lookup,
        diagnostics=diagnostics,
    )
    expected_nodes = {
        str(item.get("v2_id") or node_id)
        for node_id, item in mapping.get("nodes", {}).items()
        if isinstance(item, dict)
    } if isinstance(mapping.get("nodes"), dict) else set()
    expected_elements = {
        str(item.get("v2_id") or element_id)
        for element_id, item in mapping.get("elements", {}).items()
        if isinstance(item, dict)
    } if isinstance(mapping.get("elements"), dict) else set()
    if not mapping or not expected_nodes or not expected_elements:
        raise RuntimeError("YJK result normalization requires a complete converter mapping")

    displacements: dict[str, dict[str, float]] = {}
    forces: dict[str, dict[str, float]] = {}
    reactions: dict[str, dict[str, float]] = {}
    case_results: dict[str, dict] = {}
    node_displacement_envelope: dict[str, dict] = {}
    element_force_envelope: dict[str, dict] = {}
    node_reaction_envelope: dict[str, dict] = {}

    node_disp_cases = extracted.get("node_disp", {})
    if not isinstance(node_disp_cases, dict):
        node_disp_cases = {}
    node_reaction_cases = extracted.get("node_reactions", {})
    if not isinstance(node_reaction_cases, dict):
        node_reaction_cases = {}
    member_force_blocks = extracted.get("member_forces", {})
    if not isinstance(member_force_blocks, dict):
        member_force_blocks = {}

    raw_case_keys = set(node_disp_cases.keys())
    raw_case_keys.update(node_reaction_cases.keys())
    for block in member_force_blocks.values():
        if isinstance(block, dict):
            raw_case_keys.update(block.keys())

    case_descriptors = _case_descriptors(extracted, raw_case_keys)
    source_case_mappings = mapping.get("load_cases") or []
    if source_case_mappings:
        bound_cases = []
        for source_case in source_case_mappings:
            native_name = str(source_case["nativeName"])
            matches = [case for case in case_descriptors
                       if native_name in {str(case.get("nativeCode")), str(case.get("name"))}]
            if len(matches) != 1:
                raise RuntimeError(f"YJK source case '{source_case['sourceCaseId']}' does not map uniquely to '{native_name}'")
            native = matches[0]
            bound_cases.append({**native, "native_result_key": native["result_key"],
                                "result_key": str(source_case["sourceCaseId"]), "nativeCase": dict(native),
                                "sourceCaseId": str(source_case["sourceCaseId"]), "label": str(source_case["sourceCaseId"])})
        if len({case["result_key"] for case in bound_cases}) != len(bound_cases):
            raise RuntimeError("YJK source case mapping contains duplicate identities")
        case_descriptors = bound_cases
    selection_text = os.environ.get("SC_YJK_SELECTED_CASE")
    if selection_text:
        selection = json.loads(selection_text)
        labels = set(selection["labels"])
        selected = [case for case in case_descriptors if labels & {str(case.get(field)) for field in ("result_key", "name", "expName", "label", "nativeCode")}]
        if len(selected) != 1:
            raise RuntimeError(f"YJK requested case '{selection['id']}' does not map uniquely to a native case by label")
        case_descriptors = [{**selected[0], "native_result_key": selected[0].get("native_result_key", selected[0]["result_key"]), "result_key": str(selection["id"])}]
    displacement_rows_seen = 0
    nonzero_displacement_rows = 0
    force_rows_seen = 0
    reaction_rows_seen = 0

    for descriptor in case_descriptors:
        case_name = str(descriptor["result_key"])
        case_disps: dict[str, dict[str, float]] = {}
        raw_disps = _case_block(node_disp_cases, descriptor)
        if isinstance(raw_disps, list):
            for raw_disp in raw_disps:
                if not isinstance(raw_disp, dict):
                    continue
                displacement_rows_seen += 1
                raw_node_id = str(raw_disp.get("id"))
                node_id = result_node_lookup.get(raw_node_id, raw_node_id)
                if node_id in case_disps:
                    raise RuntimeError(f"YJK case '{case_name}' repeats displacement node '{node_id}'")
                # YJK extracted translations are already expressed in metres.
                disp = {
                    axis: _finite_result_float(raw_disp.get(axis), f"node {raw_node_id} displacement {axis}")
                    for axis in ("ux", "uy", "uz", "rx", "ry", "rz")
                }
                case_disps[node_id] = disp
                _accumulate_node_envelope(node_displacement_envelope, node_id, case_name, disp)

                mag = (
                    disp["ux"] ** 2
                    + disp["uy"] ** 2
                    + disp["uz"] ** 2
                ) ** 0.5
                if mag > 0:
                    nonzero_displacement_rows += 1
                previous = displacements.get(node_id)
                previous_mag = -1.0
                if previous:
                    previous_mag = (
                        previous["ux"] ** 2 + previous["uy"] ** 2 + previous["uz"] ** 2
                    ) ** 0.5
                if previous is None or mag > previous_mag:
                    displacements[node_id] = disp

        case_forces: dict[str, dict[str, float]] = {}
        case_stations: dict[str, list[dict]] = {}
        calibrated_elements = set()
        for category in ("columns", "beams", "braces"):
            block = member_force_blocks.get(category, {})
            raw_forces = _case_block(block, descriptor) if isinstance(block, dict) else []
            if not isinstance(raw_forces, list):
                continue
            sequence_by_floor: dict[int, int] = {}
            for raw_force in sorted(
                (item for item in raw_forces if isinstance(item, dict)),
                key=lambda item: (
                    int(round(_safe_float(item.get("floor"), 0.0))),
                    _safe_float(item.get("id"), 0.0),
                ),
            ):
                sections = raw_force.get("sections")
                if not isinstance(sections, list) or not sections:
                    continue
                force_rows_seen += 1
                category_member_lookup = member_definition_lookup.get(category, {})
                raw_force = _merge_member_definition(category_member_lookup, raw_force)
                floor = int(round(_safe_float(raw_force.get("floor"), 0.0)))
                sequence_by_floor[floor] = sequence_by_floor.get(floor, 0) + 1
                elem_id, match_method = _member_id_for(
                    category=category,
                    raw_member=raw_force,
                    sequence=sequence_by_floor[floor],
                    lookups=element_lookups,
                    result_node_lookup=result_node_lookup,
                    diagnostics=diagnostics,
                )
                if match_method not in {"direct", "endpoint"}:
                    raise RuntimeError(
                        f"YJK force result for {category} member '{raw_force.get('id')}' lacks an exact id or endpoint mapping"
                    )
                force = _force_from_sections(sections)
                rows = sections if any(isinstance(row, (list, tuple)) for row in sections) else [sections]
                case_stations[elem_id] = [
                    {
                        "nativeStationIndex": index,
                        "nativeComponents": [_finite_result_float(value, "native section force") for value in row],
                        "nativeComponentOrder": ["Mx", "My", "Qx", "Qy", "N", "T"],
                        "referenceFrame": "element-local",
                        "source": "YJKSDsnDataPy",
                        "endpointConvention": "unverified",
                        "nativeEndpoints": [
                            result_node_lookup.get(str(raw_force.get(field)), str(raw_force.get(field)))
                            for field in ("node_i", "node_j")
                        ],
                    }
                    for index, row in enumerate(rows)
                    if isinstance(row, (list, tuple))
                ]
                if native_fe_model is not None and elem_id in source_elements:
                    try:
                        if raw_force.get("option") != 1:
                            raise StationConventionUnavailable("Adjusted native forces are not simultaneous solver output")
                        source_element = {**mapping["elements"][elem_id],
                                          "rotation_angle": source_elements[elem_id].get("rotation_angle", 0)}
                        geometry = member_geometry(native_fe_model, raw_force, source_element,
                                                   result_node_lookup, mapping["nodes"],
                                                   metadata=source_model.get("metadata") or {})
                        authored_case = source_load_cases.get(str(descriptor.get("sourceCaseId", case_name)), {})
                        geometry["discontinuities"] = [float(load["position"]) for load in authored_case.get("loads", [])
                                                       if load.get("element") == elem_id and load.get("position") is not None]
                        canonical_stations = map_stations(rows, geometry)
                        case_stations[elem_id] = canonical_stations
                        force = station_envelope(canonical_stations)
                        calibrated_elements.add(elem_id)
                    except StationConventionUnavailable as exc:
                        station_errors[elem_id] = str(exc)
                if elem_id in case_forces:
                    raise RuntimeError(f"YJK case '{case_name}' repeats member '{elem_id}'")
                case_forces[elem_id] = force
                forces[elem_id] = _merge_max_force(forces.get(elem_id, {}), force)
                _accumulate_element_envelope(element_force_envelope, elem_id, case_name, force)

        case_reactions: dict[str, dict[str, float]] = {}
        raw_reactions = _case_block(node_reaction_cases, descriptor)
        if isinstance(raw_reactions, list):
            for raw_reaction in raw_reactions:
                if not isinstance(raw_reaction, dict):
                    continue
                reaction_rows_seen += 1
                raw_node_id = str(raw_reaction.get("id", raw_reaction.get("node_id")))
                node_id = result_node_lookup.get(raw_node_id, raw_node_id)
                reaction = _reaction_from_raw(raw_reaction)
                if node_id in case_reactions:
                    raise RuntimeError(f"YJK case '{case_name}' repeats reaction node '{node_id}'")
                case_reactions[node_id] = reaction

        for label, actual, expected in (
            ("displacement nodes", set(case_disps), expected_nodes),
            ("reaction nodes", set(case_reactions), expected_nodes),
            ("force elements", set(case_forces), expected_elements),
        ):
            if actual != expected:
                raise RuntimeError(
                    f"YJK case '{case_name}' {label} do not exactly cover the converted model"
                )

        case_flags = []
        # Native EXA/EYA readback can return six zero reaction values despite
        # nonzero prescribed-force member response. Retain those rows only in
        # raw_results; they are not verified zero support reactions.
        if (
            descriptor.get("nativeCode") in {"EXA", "EYA"}
            and any(value != 0 for force in case_forces.values() for value in force.values())
            and not any(value != 0 for reaction in case_reactions.values() for value in reaction.values())
        ):
            case_flags.append("YJK_PRESCRIBED_FORCE_REACTIONS_UNVERIFIED")
            case_reactions = {}
        for node_id, reaction in case_reactions.items():
            reactions[node_id] = _merge_max_reaction(reactions.get(node_id, {}), reaction)
            _accumulate_reaction_envelope(node_reaction_envelope, node_id, case_name, reaction)

        stations_verified = calibrated_elements == expected_elements
        # Modal SRSS/CQC component maxima are not simultaneous signed static
        # vectors even when they have the same station/component array shape.
        static_vectors = descriptor.get("nativeCode") not in {"EX", "EY"}
        case_context = {**native_context, "stationConventionsVerified": stations_verified}
        case_results[case_name] = {
            "status": "partial" if case_flags else "success",
            "flags": case_flags,
            "completeness": {
                "nodeDisplacements": "available",
                "nodeReactions": "unverified" if case_flags else "available",
                "memberStationValues": "available",
                "memberStationCoordinates": "available" if stations_verified else "unverified",
                "memberLocalAxes": "available" if stations_verified else "unverified",
            },
            "key": case_name,
            "label": descriptor.get("label"),
            "name": descriptor.get("name"),
            "expName": descriptor.get("expName"),
            "kind": descriptor.get("kind"),
            "id": descriptor.get("id"),
            "oldId": descriptor.get("oldId"),
            "nativeResultKey": descriptor.get("native_result_key", case_name),
            "nativeCode": descriptor.get("nativeCode"),
            "nativeCase": descriptor.get("nativeCase"),
            "displacements": case_disps,
            "forces": {
                element_id: {**force, "referenceFrame": "element-local"}
                for element_id, force in case_forces.items()
            },
            "reactions": case_reactions,
            "envelope": {},
            "memberStations": case_stations,
            "nativeContext": case_context,
            "units": {"displacement": "m", "rotation": "rad", "force": "kN", "moment": "kN.m"},
            "forceSemantics": ("simultaneous-signed-stations" if stations_verified and static_vectors
                               else "native-response-spectrum-components" if not static_vectors
                               else "signed-component-envelope; memberStations retain native station vectors"),
            "forceSummarySemantics": "signed-component-envelope",
        }

    max_disp = 0.0
    max_disp_node: str | None = None
    for node_id, item in node_displacement_envelope.items():
        value = _safe_float(item.get("maxAbsDisplacement"))
        if value > max_disp:
            max_disp = value
            max_disp_node = node_id

    max_axial = max_shear = max_moment = 0.0
    control_axial = control_shear = control_moment = ""
    for elem_id, item in element_force_envelope.items():
        axial = _safe_float(item.get("maxAbsAxialForce"))
        shear = _safe_float(item.get("maxAbsShearForce"))
        moment = _safe_float(item.get("maxAbsMoment"))
        if axial > max_axial:
            max_axial = axial
            control_axial = elem_id
        if shear > max_shear:
            max_shear = shear
            control_shear = elem_id
        if moment > max_moment:
            max_moment = moment
            control_moment = elem_id

    max_reaction = 0.0
    control_reaction = ""
    for node_id, item in node_reaction_envelope.items():
        reaction = _safe_float(item.get("maxAbsReaction"))
        if reaction > max_reaction:
            max_reaction = reaction
            control_reaction = node_id

    envelope = {
        "maxAbsDisplacement": max_disp,
        "controlNodeDisplacement": max_disp_node,
        "maxAbsAxialForce": max_axial,
        "maxAbsShearForce": max_shear,
        "maxAbsMoment": max_moment,
        "maxAbsReaction": max_reaction,
        "controlElementAxialForce": control_axial or None,
        "controlElementShearForce": control_shear or None,
        "controlElementMoment": control_moment or None,
        "controlNodeReaction": control_reaction or None,
    }
    if max_disp_node:
        envelope[f"node:{max_disp_node}:maxAbsDisplacement"] = max_disp
    if not reactions:
        # No validated reaction rows is different from a computed zero maximum.
        envelope.pop("maxAbsReaction", None)
        envelope.pop("controlNodeReaction", None)

    if force_rows_seen == 0 or displacement_rows_seen == 0 or reaction_rows_seen == 0:
        raise RuntimeError("YJK result extraction did not return complete force, displacement, and reaction rows")
    if diagnostics.get("node_unmapped", 0) > 0 or diagnostics.get("element_unmapped", 0) > 0:
        raise RuntimeError("YJK result extraction contains node or member rows that cannot be mapped exactly")
    for label, actual, expected in (
        ("displacement nodes", set(displacements), expected_nodes),
        ("reaction nodes", set(reactions), expected_nodes if any(case["reactions"] for case in case_results.values()) else set()),
        ("force elements", set(forces), expected_elements),
    ):
        if actual != expected:
            missing = sorted(expected - actual)
            unexpected = sorted(actual - expected)
            raise RuntimeError(
                f"YJK {label} do not exactly cover the converted model "
                f"(missing={missing[:5]}, unexpected={unexpected[:5]})"
            )

    warnings: list[str] = []
    for case_name, case in case_results.items():
        if case["flags"]:
            warnings.append(
                f"YJK case '{case_name}' prescribed-force reactions are unverified; "
                "zero native rows were preserved only in raw results."
            )
    members = extracted.get("members", {})
    if not isinstance(members, dict) or all(not members.get(category) for category in ("columns", "beams", "braces")):
        warnings.append("YJK raw members were empty; element result mapping used force rows and fallbacks.")
    if force_rows_seen == 0:
        warnings.append("YJK raw member_forces were empty; top-level forces and element envelopes are empty.")
    if displacement_rows_seen == 0:
        warnings.append("YJK raw node_disp was empty; displacement envelopes are empty.")
    elif nonzero_displacement_rows == 0:
        warnings.append("YJK raw node_disp values were all zero; check whether the extractor returned solved displacements.")
    if reaction_rows_seen == 0:
        warnings.append("YJK raw node_reactions were empty; reaction envelopes are empty.")
    if diagnostics.get("node_coord_matches", 0) > 0:
        warnings.append(
            f"YJK node mapping matched declared-unit coordinates for {diagnostics.get('node_coord_matches', 0)} result nodes."
        )
    if diagnostics.get("node_unmapped", 0) > 0:
        warnings.append(
            f"YJK node mapping left {diagnostics.get('node_unmapped', 0)} result nodes on raw ids."
        )
    if diagnostics.get("element_endpoint_matches", 0) > 0:
        warnings.append(
            f"YJK element mapping used endpoint fallback for {diagnostics.get('element_endpoint_matches', 0)} force rows."
        )
    if diagnostics.get("element_sequence_matches", 0) > 0:
        warnings.append(
            f"YJK element mapping used sequence fallback for {diagnostics.get('element_sequence_matches', 0)} force rows."
        )
    if diagnostics.get("element_unmapped", 0) > 0:
        warnings.append(
            f"YJK element mapping left {diagnostics.get('element_unmapped', 0)} force rows on raw ids."
        )

    return {
        "status": "success",
        "analysisMode": "yjk-static",
        "resultCompleteness": {
            "nodeScope": "physical-member-endpoints",
            "caseFlags": {key: case["flags"] for key, case in case_results.items() if case["flags"]},
            "memberStationCoordinates": "available" if all(case["nativeContext"]["stationConventionsVerified"] for case in case_results.values()) else "unverified",
            "memberLocalAxes": "available" if all(case["nativeContext"]["stationConventionsVerified"] for case in case_results.values()) else "unverified",
            "stationMappingIssues": station_errors,
        },
        "displacements": displacements,
        "forces": {
            key: {**value, "referenceFrame": "element-local"}
            for key, value in forces.items()
        },
        "reactions": reactions,
        "envelope": envelope,
        "summary": {
            "engine": "yjk-static",
            "mode": "sync",
            "ydb_path": ydb_path,
            "yjk_project": yjk_project,
            "work_dir": work_dir,
            "results_path": results_path,
            "nodeCount": len(displacements),
            "elementCount": len(forces),
            "reactionNodeCount": len(reactions),
            "designElementCount": design_results["summary"]["elementCount"],
            "maxDisplacement": max_disp,
            "maxDisplacementNode": max_disp_node,
            "floors_analyzed": meta.get("n_floors"),
            "n_floors": meta.get("n_floors"),
            "n_nodes": meta.get("n_nodes"),
            "load_cases": extracted.get("load_cases", meta.get("load_cases")),
        },
        "data": extracted,
        "detailed": {
            "message": "YJK static analysis completed and results were extracted.",
            "yjk_project": yjk_project,
            "results_path": results_path,
            "extraction": extracted,
            "mapping": mapping,
            "normalization": diagnostics,
        },
        "yjk_detailed": {
            "raw_results": extracted,
            "mapping": mapping,
            "floor_stats": extracted.get("floor_stats", []),
            "members": extracted.get("members", {}),
            "member_design": extracted.get("member_design", {}),
        },
        "caseResults": case_results,
        "designResults": design_results,
        "envelopeTables": {
            "nodeDisplacement": node_displacement_envelope,
            "elementForce": element_force_envelope,
            "nodeReaction": node_reaction_envelope,
        },
        "warnings": warnings,
        "steps": steps,
    }


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

    started_at = time.monotonic()
    try:
        ydb_path = convert_v2_to_ydb(model_data, work_dir, ydb_filename)
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
    # A rod model with explicit flexible-floor control has no authored slab.
    # Creating automatic slabs here would add unrequested stiffness and mass.
    form_slabs = (model_data.get("analysis_control") or {}).get("rigid_floor") is not False
    if form_slabs and not _run_cmd("yjk_formslab_alllayer", phase="model_preparation", steps=steps):
        _error(
            "YJK crashed during slab formation",
            phase="model_preparation",
            command="yjk_formslab_alllayer",
            steps=steps,
        )
        return 1
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

    # -- Phase 6: Synchronous design calculation ------------------------
    print("[yjk_driver] Phase 6: synchronous calculation", file=sys.stderr, flush=True)
    if not _run_cmd("yjkdesign_dsncalculating_all", phase="analysis", steps=steps):
        _error(
            "YJK crashed or failed during design calculation",
            phase="analysis",
            command="yjkdesign_dsncalculating_all",
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
