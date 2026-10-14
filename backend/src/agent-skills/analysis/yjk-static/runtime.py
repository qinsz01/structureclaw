"""YJK static adapter: one fresh, contained vendor worker per analysis.

YJKS_ROOT/YJK_PATH selects an explicit YJK 8 SDK installation. YJK_PYTHON_BIN
selects its compatible interpreter; YJK_WORK_DIR contains UUID run directories.
The driver uses only a newly owned PID and bounded IPC. Existing user/API
sessions, launchers, installation files and profiles are never controlled.
Native execution is synchronous; every exit closes only this run's Windows job.
"""
from __future__ import annotations

import json
import copy
import math
import os
import re
import subprocess
import uuid
from pathlib import Path
from typing import Any, Dict

from coordinate_semantics import coordinate_contract_metadata, resolve_model_dimension, validate_coordinate_contract
from contracts import AnalysisCapabilityError, EngineNotAvailableError

YJK_LOG_SNIPPET_LIMIT = 2000
YJK_STEP_LIMIT = 8
YJK_DETAIL_STRING_LIMIT = 500
YJK_DETAIL_COLLECTION_LIMIT = 12
YJK_DETAIL_DEPTH_LIMIT = 3
YJK_MESSAGE_DETAIL_KEYS = (
    "returncode",
    "timeoutSeconds",
    "phase",
    "command",
    "error",
    "results_path",
    "windowTitle",
)


def _env_text(key: str, default: str = "") -> str:
    """Read an environment variable as stripped text."""
    value = os.getenv(key)
    if value is None:
        return default
    return str(value).strip()


def _env_int(key: str, default: int) -> int:
    try:
        return int(_env_text(key, str(default)) or str(default))
    except ValueError:
        return default


def _env_flag(key: str) -> bool:
    return _env_text(key).lower() in {"1", "true", "yes", "on"}


def _repo_root() -> Path:
    """Resolve the StructureClaw repository root from this runtime module."""
    return Path(__file__).resolve().parents[5]


def _safe_name(value: Any, fallback: str) -> str:
    """Return a filesystem-safe short name for trace/run identifiers."""
    text = str(value or "").strip()
    if not text:
        return fallback
    safe = re.sub(r"[^A-Za-z0-9_.-]+", "-", text).strip(".-")
    return safe[:80] or fallback


def _write_json(path: Path, payload: Dict[str, Any]) -> None:
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def _read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except FileNotFoundError:
        return ""
    except OSError:
        return ""


def _read_json(path: Path) -> dict | None:
    try:
        with path.open("r", encoding="utf-8") as f:
            data = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None
    return data if isinstance(data, dict) else None


def _tail_text(text: str, limit: int = YJK_LOG_SNIPPET_LIMIT) -> str:
    text = str(text or "").strip()
    if not text:
        return ""
    if len(text) <= limit:
        return text
    omitted = len(text) - limit
    return f"...[truncated {omitted} chars]\n{text[-limit:]}"


def _compact_detail_text(text: str, limit: int = YJK_DETAIL_STRING_LIMIT) -> str:
    text = str(text or "").strip()
    if len(text) <= limit:
        return text
    omitted = len(text) - limit
    marker = f"\n...[truncated {omitted} chars]...\n"
    body_limit = max(0, limit - len(marker))
    head_limit = int(body_limit * 0.35)
    tail_limit = body_limit - head_limit
    return f"{text[:head_limit]}{marker}{text[-tail_limit:]}"


def _sanitize_detail_value(value: Any, depth: int = 0) -> Any:
    if depth >= YJK_DETAIL_DEPTH_LIMIT:
        return "<truncated>"
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return _compact_detail_text(value)
    if isinstance(value, (list, tuple)):
        items = [
            _sanitize_detail_value(item, depth + 1)
            for item in value[:YJK_DETAIL_COLLECTION_LIMIT]
        ]
        omitted = len(value) - YJK_DETAIL_COLLECTION_LIMIT
        if omitted > 0:
            items.append(f"...[truncated {omitted} items]")
        return items
    if isinstance(value, dict):
        items = list(value.items())
        sanitized: Dict[str, Any] = {}
        for key, item in items[:YJK_DETAIL_COLLECTION_LIMIT]:
            sanitized[_compact_detail_text(str(key), 120)] = _sanitize_detail_value(
                item,
                depth + 1,
            )
        omitted = len(items) - YJK_DETAIL_COLLECTION_LIMIT
        if omitted > 0:
            sanitized["_truncated"] = f"{omitted} keys"
        return sanitized
    return _compact_detail_text(str(value))


def _message_detail_summary(detail: Dict[str, Any] | None) -> Dict[str, Any]:
    if not isinstance(detail, dict):
        return {}
    return {
        key: _sanitize_detail_value(detail[key])
        for key in YJK_MESSAGE_DETAIL_KEYS
        if key in detail
    }


def _summarize_steps(output: dict | None, limit: int = YJK_STEP_LIMIT) -> list[str]:
    if not isinstance(output, dict):
        return []
    steps = output.get("steps")
    if not isinstance(steps, list):
        return []
    lines: list[str] = []
    for step in steps[-limit:]:
        if not isinstance(step, dict):
            continue
        name = str(step.get("name") or "step")
        parts = [name]
        for key in ("phase", "status", "command", "message"):
            value = step.get(key)
            if value:
                parts.append(f"{key}={value}")
        lines.append("- " + "; ".join(parts))
    return lines


def _raise_yjk_runtime_error(
    headline: str,
    *,
    work_dir: Path,
    stdout_path: Path | None = None,
    stderr_path: Path | None = None,
    driver_output_path: Path | None = None,
    stdout: str = "",
    stderr: str = "",
    output: dict | None = None,
    detail: Dict[str, Any] | None = None,
    extra_paths: Dict[str, Path] | None = None,
) -> None:
    stdout_tail = _tail_text(stdout)
    stderr_tail = _tail_text(stderr)
    steps_tail = _summarize_steps(output)
    safe_detail = _sanitize_detail_value(detail) if detail else None
    message_detail = _message_detail_summary(
        safe_detail if isinstance(safe_detail, dict) else None,
    )
    run_meta_path = work_dir / "run-meta.json"
    driver_result_path = work_dir / "driver-result.json"

    paths: Dict[str, Path] = {
        "workDir": work_dir,
        "runMetaPath": run_meta_path,
        "driverResultPath": driver_result_path,
    }
    if driver_output_path is not None:
        paths["driverOutputPath"] = driver_output_path
    if stdout_path is not None:
        paths["stdoutPath"] = stdout_path
    if stderr_path is not None:
        paths["stderrPath"] = stderr_path
    if extra_paths:
        paths.update(extra_paths)

    lines = [headline, "", "Artifact feedback:"]
    for label, path in paths.items():
        lines.append(f"- {label}: {path}")
    if message_detail:
        lines.append(f"- detail: {json.dumps(message_detail, ensure_ascii=False)}")
    if steps_tail:
        lines.extend(["", "Recent driver steps:", *steps_tail])
    if stderr_tail:
        lines.extend(["", "driver stderr tail:", stderr_tail])
    if stdout_tail:
        lines.extend(["", "driver stdout tail:", stdout_tail])

    meta: Dict[str, Any] = {label: str(path) for label, path in paths.items()}
    if stdout_tail:
        meta["stdoutTail"] = stdout_tail
    if stderr_tail:
        meta["stderrTail"] = stderr_tail
    if steps_tail:
        meta["stepsTail"] = steps_tail
    if safe_detail:
        meta["yjkErrorDetail"] = safe_detail

    error = RuntimeError("\n".join(lines))
    setattr(error, "meta", meta)
    if safe_detail:
        setattr(error, "detail", safe_detail)
    raise error


def _yjk_install_root() -> str:
    """Resolve install root: ``YJK_PATH`` if set, else ``YJKS_ROOT``."""
    configured = _env_text("YJK_PATH") or _env_text("YJKS_ROOT")
    if configured:
        return configured
    return ""


def _resolve_yjk_python() -> str:
    """Return the path to YJK's bundled Python 3.10 executable."""
    explicit = _env_text("YJK_PYTHON_BIN")
    if explicit and Path(explicit).is_file():
        return explicit

    root = _yjk_install_root()
    if not root:
        raise EngineNotAvailableError(
            engine="yjk",
            reason="YJK install root not set (set YJKS_ROOT or YJK_PATH)",
        )
    if not Path(root).is_dir():
        raise EngineNotAvailableError(
            engine="yjk",
            reason=f"YJK install directory does not exist: {root}",
        )

    python_exe = next(
        (
            candidate
            for candidate in (
                Path(root) / "Python310" / "python.exe",
                Path(root) / "python310" / "python.exe",
            )
            if candidate.is_file()
        ),
        None,
    )
    if python_exe is None:
        raise EngineNotAvailableError(
            engine="yjk",
            reason=f"YJK Python 3.10 not found under {root}",
        )
    return str(python_exe)


def _resolve_work_dir(parameters: Dict[str, Any]) -> Path:
    """Return a per-run subdirectory under YJK_WORK_DIR.

    YJK_WORK_DIR can be set by the user so that generated project files,
    .OUT results, and logs land in a known, reviewable location. When unset,
    files are written under ``~/.structureclaw/analysis/yjk``.
    """
    base = _env_text("YJK_WORK_DIR")
    if not base:
        base = str(Path.home() / ".structureclaw" / "analysis" / "yjk")

    trace_id = _safe_name(parameters.get("traceId"), f"run-{uuid.uuid4().hex[:8]}")
    project_name = f"sc_{trace_id[:32]}_{uuid.uuid4().hex[:12]}"
    work = Path(base) / project_name
    work.mkdir(parents=True, exist_ok=False)
    return work


def _extract_last_json(text: str) -> dict | None:
    """Extract the last complete JSON object from text.

    YJK's Python runtime may print non-JSON lines (copyright banners,
    init messages) to stdout before our _emit_json() call, and yjks.exe may
    keep appending progress text after the driver JSON.  Decode any complete
    driver-shaped JSON object embedded in the stream and ignore trailing text.
    """
    # Fast path: the whole string is valid JSON
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            return parsed
    except json.JSONDecodeError:
        pass

    decoder = json.JSONDecoder()
    fallback: dict | None = None
    for match in re.finditer(r"\{", text):
        try:
            parsed, _ = decoder.raw_decode(text[match.start():])
        except json.JSONDecodeError:
            continue
        if not isinstance(parsed, dict):
            continue
        if fallback is None:
            fallback = parsed
        if "status" not in parsed:
            continue
        if "analysisMode" in parsed or "summary" in parsed or "detailed" in parsed:
            return parsed
        fallback = parsed
    if fallback is not None and "status" in fallback:
        return fallback
    return None


def _ensure_v2_model(model_dict: dict) -> dict:
    """Apply only the shared schema/coordinate migration.

    YJK-specific stories, materials, sections, or element roles are never
    guessed here: an invented building definition would be executable but
    would not represent the source model.
    """
    from structure_protocol.migrations import ensure_v2_dict
    return ensure_v2_dict(model_dict)


# Kept as a compatibility name for callers; validation is shared with conversion.
from model_contract import validate_building_model as _validate_yjk_grid_conversion_scope


def _result_selection(model: dict, parameters: dict) -> tuple[list[str], dict | None]:
    available = {str(case['id']) for case in model.get('load_cases', [])}
    requested = parameters.get('loadCaseIds')
    if requested is not None and (not isinstance(requested, list) or not requested
            or any(not isinstance(key, str) or key not in available for key in requested)
            or len(set(requested)) != len(requested)):
        raise ValueError('YJK requires unique existing source case IDs / 必须选择存在且不重复的源工况')
    combination_id = parameters.get('loadCombinationId')
    combination = None
    if combination_id is not None:
        if requested:
            raise ValueError('Select load cases or one combination / 工况与组合不得混选')
        matches = [row for row in model.get('load_combinations', []) if row.get('id') == combination_id]
        if len(matches) != 1 or not matches[0].get('factors') or set(matches[0]['factors']) - available:
            raise ValueError('YJK combination requires existing source cases / 组合必须引用存在的源工况')
        combination = matches[0]
        requested = list(combination['factors'])
    return requested or [str(case['id']) for case in model.get('load_cases', [])], combination


def _select_verified_results(output: dict, selected_ids: list[str], combination: dict | None) -> dict:
    """Publish an explicit source selection; retain every solved native case."""
    from native_results import combine_linear_native_results, require_verified_linear_context
    from yjk_native_stations import station_envelope
    cases = output.get('caseResults', {})
    if not selected_ids or any(key not in cases for key in selected_ids):
        raise ValueError('YJK requested source results are missing / 缺少指定源工况结果')
    for key in selected_ids:
        row = cases[key]
        require_verified_linear_context(row.get('nativeContext', {}))
        if row.get('status') != 'success' or row.get('forceSemantics') != 'simultaneous-signed-stations':
            raise ValueError(f'YJK source case {key} is incomplete / 源工况结果不完整')
    result = copy.deepcopy(output)
    if combination:
        selected = combine_linear_native_results(cases, combination['factors'], cases[selected_ids[0]]['nativeContext'])
        selected['forces'] = {key: {**station_envelope(rows), 'referenceFrame': 'element-local'}
                              for key, rows in selected['memberStations'].items()}
        result['combinationResults'] = {str(combination['id']): selected}
        selection = {'kind': 'combination', 'id': combination['id']}
    else:
        selected = cases[selected_ids[0]]
        selection = {'kind': 'case', 'id': selected_ids[0]}
    for field in ('displacements', 'forces', 'reactions', 'memberStations', 'nativeContext',
                  'units', 'forceSemantics', 'missingCapabilities', 'capabilityStatus'):
        if field in selected:
            result[field] = copy.deepcopy(selected[field])
    # Compatibility summary is the selected vector, never the across-case envelope.
    magnitudes = {key: math.hypot(*(row[axis] for axis in ('ux', 'uy', 'uz')))
                  for key, row in selected['displacements'].items()}
    node = max(magnitudes, key=magnitudes.get)
    result['summary'] = {**result.get('summary', {}), 'maxDisplacement': magnitudes[node],
                         'maxDisplacementNode': node, 'selection': selection}
    result['selectedResult'] = selection
    result['requestedCaseIds'] = selected_ids
    result['envelope'] = {}  # Across-case envelopes remain explicitly in envelopeTables.
    native_design = result.pop('designResults', None)
    result.pop('utilizationByElement', None)
    if native_design is not None:
        result['nativeDesignResults'] = {'scope': 'software-automatic-design-combinations',
            'boundToSelectedResult': False, 'verification': 'native-design-metrics-not-calibrated',
            'data': native_design}
    for field in ('maxDesignUtilization', 'controllingDesignElement', 'designElementCount'):
        result['summary'].pop(field, None)
    return result


def run_analysis(model: Dict[str, Any], parameters: Dict[str, Any]) -> Dict[str, Any]:
    """Entry point called by the analysis registry.

    Parameters
    ----------
    model : dict
        Deserialized StructureModelV2 payload (raw dict).
    parameters : dict
        Analysis parameters forwarded from the API request.

    Returns
    -------
    dict
        AnalysisResult-shaped dict with status / summary / detailed / warnings.
    """
    parameters = parameters or {}
    forbidden = [name for name in ("YJK_ATTACH_EXISTING", "YJK_USE_LAUNCHER",
                 "YJK_START_ONLY", "YJK_ASYNC_CALC", "YJK_ASYNC_START_ONLY") if _env_flag(name)]
    if forbidden:
        raise AnalysisCapabilityError(engine="yjk", capability="owned-synchronous-native-run",
                                      reason="Existing-session attachment and detached runs are not supported: "
                                             + ", ".join(forbidden))
    model_dict = model.model_dump(mode="json", exclude_unset=True) if hasattr(model, "model_dump") else model
    model_dict = _ensure_v2_model(model_dict)
    from commercial_context import project_commercial_model, attach_native_design_context
    authored_model = copy.deepcopy(model_dict)
    projection = project_commercial_model(authored_model, "yjk")
    model_dict = projection["analysisModel"]
    from yjk_native_design import compile_design_request, NativeDesignError
    design_plan = compile_design_request(parameters.get("design"), authored_model)
    validate_coordinate_contract(model_dict)
    if resolve_model_dimension(model_dict) != "3d":
        raise AnalysisCapabilityError(
            engine="yjk",
            capability="canonical-3d-building-model",
            reason=(
                "The YJK grid converter currently supports canonical 3-D building models only; "
                "it will not synthesize a fictitious plan axis for a 2-D X-Z model"
            ),
        )
    try:
        from yjk_native_materials import normalize_material, compile_stiffness_plan
        model_dict = {**copy.deepcopy(model_dict), 'materials': [normalize_material(row) for row in model_dict['materials']]}
        requested_cases, combination = _result_selection(model_dict, parameters)
        design_representation_plan = compile_stiffness_plan(model_dict)
        if design_plan and any(row["sectionRepresentation"]["method"] == "native-reference-carrier"
                               for row in design_representation_plan["members"].values()):
            raise NativeDesignError("Native design needs actual section geometry; elastic reference carriers cannot be designed / 原生设计缺少实际截面几何，不能校核弹性参考载体", "ANALYSIS_INPUT_REQUIRED")
        if design_plan and any(row["materialBaseline"]["representation"] == "elastic-reference-material"
                               for row in design_representation_plan["members"].values()):
            raise NativeDesignError("Native design material grade is not mapped / 原生设计材料牌号尚未映射", "ENGINE_INPUT_UNSUPPORTED")
        # Physical distances along a slope need not be decimal millimetres.
        # Audit native serialization after these loads become mesh-node loads.
        _validate_yjk_grid_conversion_scope(model_dict, native_load_precision=False)
        from member_mesh import compile_member_mesh
        source_model = model_dict
        model_dict, mesh_receipt = compile_member_mesh(source_model)
        if design_plan and mesh_receipt:
            raise ValueError("Native member design requires unsegmented physical members; interior-load design mapping is pending / 原生构件设计须保留物理构件，跨内荷载设计映射尚待接通")
        _validate_yjk_grid_conversion_scope(model_dict)
    except NativeDesignError:
        raise
    except ValueError as error:
        if getattr(error, "error_code", None):
            raise
        raise AnalysisCapabilityError(engine="yjk", capability="native-model-contract", reason=str(error)) from error
    yjk_python = _resolve_yjk_python()
    work_dir = _resolve_work_dir(parameters)
    timeout = _env_int("YJK_TIMEOUT_S", 600)

    # Write the canonical V2 model JSON to the YJK work directory.
    model_path = work_dir / "model.json"
    model_path.write_text(json.dumps(model_dict, ensure_ascii=False), encoding="utf-8")
    _write_json(work_dir / "source-model.json", authored_model)
    _write_json(work_dir / "model-projection.json", {key: value for key, value in projection.items() if key != "analysisModel"})
    if design_plan:
        _write_json(work_dir / "native-design-request.json", design_plan)
    if mesh_receipt is not None:
        _write_json(work_dir / 'physical-model.json', source_model)
        _write_json(work_dir / 'physical-mesh.json', mesh_receipt)

    # Locate the driver script (sibling of this file)
    driver_path = Path(__file__).resolve().parent / "yjk_driver.py"
    if not driver_path.is_file():
        raise RuntimeError(f"YJK driver script not found: {driver_path}")

    trace_id = parameters.get("traceId")
    run_meta = {
        "traceId": trace_id,
        "workDir": str(work_dir),
        "modelPath": str(model_path),
        "driverPath": str(driver_path),
        "yjkPython": yjk_python,
        "timeoutSeconds": timeout,
    }
    _write_json(work_dir / "run-meta.json", run_meta)

    # Build environment for the subprocess.
    # Ensure both YJKS_ROOT and YJK_PATH are set for SDK scripts / driver.
    env = os.environ.copy()
    env.pop("SC_YJK_SELECTED_CASE", None)
    root = _yjk_install_root()
    if root:
        env["YJKS_ROOT"] = root
        env["YJK_PATH"] = root
    env["YJK_INVISIBLE"] = _env_text("YJK_INVISIBLE", "1")
    # Do not pass obsolete launcher/GUI-control options to the contained worker.
    for key in tuple(env):
        if key.startswith("YJK_LAUNCHER_") or key in {
            "YJK_USE_LAUNCHER", "YJK_ATTACH_EXISTING", "YJK_ATTACH_PID",
            "YJK_START_ONLY", "YJK_ASYNC_CALC", "YJK_ASYNC_START_ONLY",
            "YJK_CLOSE_AFTER_RUN", "YJK_AUTO_IPC_DELAY_S", "YJK_AUTO_IPC_FOCUS_DELAY_S",
            "YJK_SKIP_AUTO_IPC",
        }:
            env.pop(key, None)

    run_meta["yjkEnv"] = {
        key: env.get(key, "")
        for key in (
            "YJKS_ROOT",
            "YJK_PATH",
            "YJKS_EXE",
            "YJK_PYTHON_BIN",
            "YJK_WORK_DIR",
            "YJK_VERSION",
            "YJK_TIMEOUT_S",
            "YJK_INVISIBLE",
            "YJK_STARTUP_TIMEOUT_S",
            "YJK_COMMAND_TIMEOUT_S",
        )
    }
    _write_json(work_dir / "run-meta.json", run_meta)

    warnings: list[str] = []

    # Launch the driver under YJK's Python 3.10.  Keep stdout/stderr file-backed
    # instead of pipe-backed: yjks.exe is a GUI child process that can inherit
    # pipe handles and keep subprocess.run(capture_output=True) waiting for EOF
    # even after yjk_driver.py has emitted the final JSON and exited.
    stdout_path = work_dir / "driver.stdout.txt"
    stderr_path = work_dir / "driver.stderr.txt"
    driver_output_path = work_dir / "driver-output.json"
    from windows_job import run_contained_driver
    cleanup_result: dict | None = None
    try:
        with stdout_path.open("w", encoding="utf-8") as stdout_file, stderr_path.open(
            "w",
            encoding="utf-8",
        ) as stderr_file:
            try:
                returncode = run_contained_driver(
                    [yjk_python, str(driver_path), str(model_path), str(work_dir)],
                    work_dir=work_dir, env=env, stdout=stdout_file, stderr=stderr_file,
                    timeout=timeout,
                )
            except subprocess.TimeoutExpired:
                cleanup_result = _read_json(work_dir / "yjk-cleanup.json")
                stdout = _read_text(stdout_path)
                stderr = _read_text(stderr_path)
                _write_json(
                    work_dir / "driver-timeout.json",
                    {
                        **run_meta,
                        "timeoutSeconds": timeout,
                        "returncode": (cleanup_result or {}).get("returncode"),
                        "stdout": stdout,
                        "stderr": stderr,
                        "yjkCleanup": cleanup_result,
                    },
                )
                _raise_yjk_runtime_error(
                    f"YJK analysis timed out after {timeout}s",
                    work_dir=work_dir,
                    stdout_path=stdout_path,
                    stderr_path=stderr_path,
                    driver_output_path=driver_output_path,
                    stdout=stdout,
                    stderr=stderr,
                    detail={
                        "timeoutSeconds": timeout,
                        "returncode": (cleanup_result or {}).get("returncode"),
                    },
                    extra_paths={
                        "driverTimeoutPath": work_dir / "driver-timeout.json",
                    },
                )
    except FileNotFoundError as exc:
        raise RuntimeError(f"Cannot launch YJK Python: {exc}")

    cleanup_result = _read_json(work_dir / "yjk-cleanup.json")

    stdout = _read_text(stdout_path)
    stderr = _read_text(stderr_path)
    _write_json(
        work_dir / "driver-result.json",
        {
            **run_meta,
            "returncode": returncode,
            "stdout": stdout,
            "stderr": stderr,
            "driverOutputPath": str(driver_output_path),
            "yjkCleanup": cleanup_result,
        },
    )

    # Parse stdout as JSON result.
    # The driver writes only ONE JSON blob to stdout; all progress/debug
    # output goes to stderr so the user can see it in the backend log.
    stdout = stdout.strip()
    stderr = stderr.strip()

    if stderr:
        import logging
        logging.getLogger("yjk-runtime").info("YJK driver stderr:\n%s", stderr)

    # Prefer the driver-written UTF-8 output file. Stdout is kept only as a
    # compatibility fallback because YJK/YJKS may interleave progress text and
    # append more bytes after the JSON object.
    output = _read_json(driver_output_path)

    if returncode != 0 and not stdout and output is None:
        _raise_yjk_runtime_error(
            f"YJK driver exited with code {returncode}.",
            work_dir=work_dir,
            stdout_path=stdout_path,
            stderr_path=stderr_path,
            driver_output_path=driver_output_path,
            stdout=stdout,
            stderr=stderr,
            detail={"returncode": returncode},
        )

    if not stdout and output is None:
        _raise_yjk_runtime_error(
            "YJK driver produced no stdout output.",
            work_dir=work_dir,
            stdout_path=stdout_path,
            stderr_path=stderr_path,
            driver_output_path=driver_output_path,
            stdout=stdout,
            stderr=stderr,
            detail={"returncode": returncode},
        )

    output = output or _extract_last_json(stdout)
    if output is None:
        _raise_yjk_runtime_error(
            "YJK driver output is not valid JSON.",
            work_dir=work_dir,
            stdout_path=stdout_path,
            stderr_path=stderr_path,
            driver_output_path=driver_output_path,
            stdout=stdout,
            stderr=stderr,
            detail={"returncode": returncode},
        )

    status = output.get("status", "error")
    if returncode != 0 and status != "error":
        _raise_yjk_runtime_error(
            "YJK worker exited abnormally after producing output; native run rejected.",
            work_dir=work_dir, stdout_path=stdout_path, stderr_path=stderr_path,
            driver_output_path=driver_output_path, stdout=stdout, stderr=stderr,
            output=output, detail={"returncode": returncode},
        )
    if status == "error":
        raw_error_detail = output.get("detailed", {})
        error_detail = raw_error_detail if isinstance(raw_error_detail, dict) else {}
        error_msg = error_detail.get("error", "Unknown YJK error")
        phase = error_detail.get("phase")
        command = error_detail.get("command")
        context = []
        if phase:
            context.append(f"phase={phase}")
        if command:
            context.append(f"command={command}")
        context_text = f" ({', '.join(context)})" if context else ""
        detail = {
            "returncode": returncode,
            "error": error_msg,
            **error_detail,
        }
        _raise_yjk_runtime_error(
            f"YJK analysis failed{context_text}: {error_msg}",
            work_dir=work_dir,
            stdout_path=stdout_path,
            stderr_path=stderr_path,
            driver_output_path=driver_output_path,
            stdout=stdout,
            stderr=stderr,
            output=output,
            detail=detail,
        )

    physics = _read_json(work_dir / 'native-physics-audit.json')
    if not physics or physics.get('passed') is not True:
        _raise_yjk_runtime_error('YJK physical input verification is missing or failed / 原生物理输入核对失败',
                                work_dir=work_dir, output=output,
                                detail={'physicsAudit': physics})
    from member_mesh import restore_physical_results
    output = restore_physical_results(output, mesh_receipt)
    output = _select_verified_results(output, requested_cases, combination)

    # The vendor writes informational startup/debug output to stderr. Preserve
    # it in the run log; successful-result warnings describe engineering issues.
    existing_warnings = output.get("warnings", [])
    if isinstance(existing_warnings, list):
        warnings.extend(existing_warnings)

    result_payload = {
        key: value
        for key, value in output.items()
        if key not in {"status", "warnings"}
    }
    existing_meta = result_payload.get("meta")
    result_payload["meta"] = {
        **(existing_meta if isinstance(existing_meta, dict) else {}),
        **coordinate_contract_metadata(model_dict),
        "lengthUnit": "m",
        "displacementUnit": "m",
        "forceUnit": "kN",
        "momentUnit": "kN.m",
        "traceId": trace_id,
        "workDir": str(work_dir),
        "runMetaPath": str(work_dir / "run-meta.json"),
        "driverResultPath": str(work_dir / "driver-result.json"),
        "driverOutputPath": str(driver_output_path),
    }
    result_payload = attach_native_design_context(result_payload, authored_model, projection,
        native_project=str(Path(result_payload.get("summary", {}).get("ydb_path") or work_dir / "project.ydb").with_suffix(".yjk")), parameters=parameters,
        representation={"analysisOnly": any(
            row["sectionRepresentation"]["method"] == "native-reference-carrier" or
            row["materialBaseline"]["representation"] == "elastic-reference-material"
            for row in design_representation_plan["members"].values()),
            "members": {key: {"section": row["sectionRepresentation"]["method"],
                              "material": row["materialBaseline"]["representation"]}
                        for key, row in design_representation_plan["members"].items()}})
    if design_plan:
        from yjk_native_design import complete_native_design
        result_payload = complete_native_design(result_payload, authored_model, design_plan, work_dir)
    from commercial_context import attach_native_result_set
    result_payload = attach_native_result_set(result_payload, authored_model, parameters, _select_verified_results)
    return {
        "status": output.get("status", "success"),
        **result_payload,
        "warnings": warnings,
    }
