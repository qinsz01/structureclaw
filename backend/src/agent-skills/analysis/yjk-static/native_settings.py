"""Explicit YJK scalar settings, applied inside the owned native host.

IDs are from the installed YJK 8 preprocessing SDK. Option identifiers in the
manual (e.g. 60102) are not the integer enum values consumed by SetSParInt.
This module is copied into a private callback directory and must stay standalone.
"""
from __future__ import annotations

import json
import math
import os
from pathlib import Path
import shutil
import struct
import time
import uuid


def compile_settings(model: dict) -> dict:
    """Compile the elastic frame settings; native evidence still gates support."""
    control = model.get("analysis_control") or {}
    if control.get("p_delta") is True or control.get("construction_stage") is True:
        raise ValueError("YJK staged/P-Delta analysis is not calibrated / YJK 施工分阶段及二阶分析尚未校准")
    rigid = control.get("rigid_floor")
    story_values = {story["rigid_diaphragm"] for story in model.get("stories", [])
                    if story.get("rigid_diaphragm") is not None}
    if len(story_values) > 1 or (story_values and rigid is not None and story_values != {rigid}):
        raise ValueError("YJK mixed/conflicting diaphragm settings require per-floor constraints / 楼板约束冲突或需逐层指定")
    if rigid is None and story_values:
        rigid = story_values.pop()
    ints = {"608": 0, "697": 0, "679": 0, "654": 0, "601": 1,
            "630": 0, "696": 0, "2308": 0, "624": 1}
    floats = {str(key): 1.0 for key in (610, 611, 631, 658, 663, 694, 2305, 2306, 2307)}
    if rigid is not None:
        ints["606"] = int(rigid)
    if control.get("rigid_offsets") is not None:
        ints["609"] = ints["650"] = int(control["rigid_offsets"])
    return {"schema": "sclaw-yjk-settings/v1", "parameters": {"int": ints, "float": floats},
            "controls": {**control, "rigid_floor": rigid},
            "assumptions": {"construction": "once-loaded", "sectionStiffness": "gross-input",
                            "automaticSlabGeneration": False,
                            "selfWeight": "selected-native-load-cases"},
            "verification": "pending-native-readback-and-fe-audit"}


def _normal(parameters: dict) -> dict:
    if not isinstance(parameters, dict) or set(parameters) - {"int", "float"}:
        raise ValueError("Invalid native scalar parameter maps")
    result, seen = {"int": {}, "float": {}}, set()
    for kind in result:
        if not isinstance(parameters.get(kind, {}), dict):
            raise ValueError("Invalid native scalar parameter map")
        for key, value in parameters.get(kind, {}).items():
            if type(key) not in (str, int) or not str(key).isdigit() or str(int(key)) != str(key) or not 0 < int(key) < 2**31:
                raise ValueError("Invalid native scalar parameter ID")
            if str(key) in seen:
                raise ValueError("Duplicate native scalar parameter ID")
            seen.add(str(key))
            if kind == "int":
                if type(value) is not int or not -(2**31) <= value < 2**31:
                    raise ValueError("Invalid native int32 parameter")
            else:
                if type(value) not in (float, int) or not math.isfinite(value):
                    raise ValueError("Invalid native float32 parameter")
                try:
                    if not math.isfinite(struct.unpack("f", struct.pack("f", value))[0]):
                        raise ValueError("Invalid native float32 parameter")
                except OverflowError as exc:
                    raise ValueError("Invalid native float32 parameter") from exc
            result[kind][str(key)] = value
    return result


def verify_readback(parameters: dict, readback: dict) -> None:
    for kind, values in _normal(parameters).items():
        for key, expected in values.items():
            actual = readback.get(kind, {}).get(key)
            # Vendor float API is float32: compare that representation, not a
            # broadly relaxed physical tolerance. No int truncation is allowed.
            target = expected if kind == "int" else struct.unpack("f", struct.pack("f", expected))[0]
            if type(actual) not in (int, float) or not math.isfinite(actual) or actual != target:
                raise ValueError(f"Native setting {key} readback mismatch / 原生设置读回不一致: {actual} != {target}")


def _scalar(value, kind: str):
    # Official GetSParaInt/GetSParaFlt return strings, unlike the setters.
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        raise ValueError(f"Invalid native {kind} scalar: {value!r}")
    numeric = float(value)
    if not math.isfinite(numeric) or (kind == "int" and not numeric.is_integer()):
        raise ValueError(f"Invalid native {kind} scalar: {value!r}")
    return int(numeric) if kind == "int" else struct.unpack("f", struct.pack("f", numeric))[0]


def apply_and_readback(parameters: dict, api=None) -> dict:
    parameters = _normal(parameters)
    if api is None:
        from YJKAPI import YJKSPrePy_JSCS
        api = YJKSPrePy_JSCS()
    getters = {"int": getattr(api, "GetSParaInt", None) or getattr(api, "GetSParInt", None),
               "float": getattr(api, "GetSParaFlt", None) or getattr(api, "GetSParFloat", None)}
    setters = {"int": getattr(api, "SetSParInt", None), "float": getattr(api, "SetSParFloat", None)}
    if not callable(getattr(api, "SParaSave", None)) or any(
            parameters[kind] and (not callable(getters[kind]) or not callable(setters[kind])) for kind in parameters):
        raise RuntimeError("YJK native setters, getters and save must all be available before writing")
    before = {kind: {} for kind in parameters}
    for kind, values in parameters.items():
        for key in values:
            value = getters[kind](int(key))
            try:
                before[kind][key] = _scalar(value, kind)
            except (ValueError, OverflowError):
                before[kind][key] = {"status": "unset-or-invalid", "raw": repr(value)}
    for kind, values in parameters.items():
        for key, value in values.items():
            setters[kind](int(key), value)
    api.SParaSave()
    readback = {kind: {key: _scalar(getters[kind](int(key)), kind) for key in values}
                for kind, values in parameters.items()}
    verify_readback(parameters, readback)
    return {"schema": "sclaw-yjk-scalar-readback/v1", "passed": True,
            "written": parameters, "before": before, "readback": readback}


def _write(path: Path, value: dict) -> None:
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, allow_nan=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def run_host() -> None:
    directory = Path(__file__).resolve().parent
    request = json.loads((directory / "request.json").read_text(encoding="utf-8"))
    result = {"nonce": request["nonce"], "pid": os.getpid(), "passed": False}
    try:
        if os.getpid() != request["pid"]:
            raise RuntimeError("Native settings callback ran in a different host")
        result["audit"] = apply_and_readback(request["parameters"])
        result["passed"] = True
    except Exception as exc:
        result["error"] = {"type": type(exc).__name__, "message": str(exc)}
    _write(directory / "result.json", result)


def apply_in_host(command, work_dir, pid: int, plan: dict, timeout_s: float = 30) -> dict:
    parameters = _normal(plan["parameters"])
    nonce = uuid.uuid4().hex
    directory = Path(work_dir) / ("native-settings-" + nonce)
    directory.mkdir()
    callback = directory / ("settings_" + nonce + ".py")
    shutil.copyfile(__file__, callback)
    _write(directory / "request.json", {"nonce": nonce, "pid": pid, "parameters": parameters})
    command("yjks_pyload", str(callback), "run_host")
    deadline = time.monotonic() + timeout_s
    while not (directory / "result.json").is_file():
        if time.monotonic() >= deadline:
            raise TimeoutError("YJK settings callback did not return native readback")
        time.sleep(0.1)
    result = json.loads((directory / "result.json").read_text(encoding="utf-8"))
    if result.get("nonce") != nonce or result.get("pid") != pid or result.get("passed") is not True:
        raise RuntimeError("YJK settings identity/readback failed: " + str(result))
    if result.get("audit", {}).get("written") != parameters:
        raise RuntimeError("YJK settings callback wrote a different parameter set")
    verify_readback(parameters, result["audit"]["readback"])
    _write(Path(work_dir) / "native-settings-readback.json", {"plan": plan, **result})
    return result
