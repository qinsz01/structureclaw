"""Explicit YJK scalar settings, applied inside the owned native host.

IDs are from the installed YJK 8 preprocessing SDK. Unlike PKPM's zero-based
enums, this release uses documented option identifiers such as 60102. Native
getter evidence shows the original construction default is 60103; writing 1
produces "all generated", so a scalar readback alone cannot verify semantics.
This module is copied into a private callback directory and must stay standalone.
"""
from __future__ import annotations

import json
import hashlib
import math
import os
from pathlib import Path
import shutil
import struct
import time
import uuid
import re


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
    if rigid is True:
        from native_story_geometry import compile_story_geometry
        geometry = compile_story_geometry(model)
        if any(row["height_offset_mm"] != 0 for row in geometry["nodes"].values()):
            raise ValueError("YJK rigid diaphragms require horizontal natural floors / 刚性楼板要求同一自然层节点位于水平面")
    ints = {"608": 0, "697": 0, "679": 67901, "654": 0, "601": 60102,
            "630": 0, "696": 0, "2308": 0, "624": 1}
    floats = {str(key): 1.0 for key in (610, 611, 631, 658, 663, 694, 2305, 2306, 2307)}
    # Weight comes from the authored section/density and an explicit case, not
    # native defaults or the dimensions of an analysis-only reference carrier.
    floats.update({"801": 0., "803": 0.})
    if rigid is not None:
        ints["606"] = int(rigid)
    if control.get("rigid_offsets") is not None:
        ints["609"] = ints["650"] = int(control["rigid_offsets"])
    return {"schema": "sclaw-yjk-settings/v1", "parameters": {"int": ints, "float": floats},
            "controls": {**control, "rigid_floor": rigid},
            "assumptions": {"construction": "once-loaded", "sectionStiffness": "gross-input",
                            "automaticSlabGeneration": False,
                            "selfWeight": "authored-member-density-area-native-line-loads"},
            "verification": "pending-native-readback-and-fe-audit"}


def audit_rigid_diaphragms(model: dict, fe: dict) -> dict:
    """Check the executed MF constraints against each authored natural floor.

    YJK 8's forced-rigid model uses FM (master type 4), not the ordinary NM
    plate groups. Only in-plane DOFs are constrained; no physical slabs exist.
    The installed ANALYSIS manual describes this MF/MPC model explicitly.
    """
    from native_story_geometry import compile_story_geometry, exact_mm
    geometry = compile_story_geometry(model)
    raw_nodes, positions = {}, {}
    for line in fe.get("sectionsRaw", {}).get("NODE", []):
        tag = line.split()[0]
        fields = dict(re.findall(r"(?:^|\s)(\w+)=([^\s]+)", line))
        raw_nodes[tag] = fields
        try:
            position = tuple(exact_mm(value, "Native diaphragm node") for value in fields["C"].split(","))
        except (KeyError, ValueError) as exc:
            raise ValueError("Invalid native diaphragm node geometry / 原生刚性楼板节点几何无效") from exc
        if fields.get("T") not in {"2", "4"}:
            positions.setdefault(position, []).append(tag)
    groups, failures = {}, []
    for source_id, node in geometry["nodes"].items():
        matches = positions.get(tuple(node[key] for key in ("x_mm", "y_mm", "z_mm")), [])
        if len(matches) != 1:
            failures.append("physical-node-not-unique:" + source_id)
            continue
        native_id = matches[0]
        fields = raw_nodes[native_id]
        master = fields.get("FM")
        if fields.get("NM") != "0":
            failures.append("unexpected-physical-slab-master:" + source_id)
        if node["floor_index"] == 0:
            if master != "0":
                failures.append("base-node-is-diaphragm-slave:" + source_id)
            continue
        group = groups.setdefault(str(node["floor"]), {"masters": set(), "nodes": []})
        group["masters"].add(master)
        group["nodes"].append({"sourceNodeId": source_id, "nativeNodeId": native_id})
        master_node = raw_nodes.get(master, {})
        if master_node.get("T") != "4":
            failures.append("missing-forced-rigid-master:" + source_id)
        elif exact_mm(master_node["C"].split(",")[2], "Master elevation") != node["z_mm"]:
            failures.append("master-floor-height-mismatch:" + source_id)
    if not groups or len({next(iter(row["masters"])) for row in groups.values() if len(row["masters"]) == 1}) != len(groups):
        failures.append("natural-floors-do-not-have-independent-masters")
    for key, row in groups.items():
        if len(row["masters"]) != 1:
            failures.append("floor-master-is-not-unique:" + key)
        row["masters"] = sorted(row["masters"], key=str)
    return {"passed": not failures, "method": "native-MF-in-plane-MPC",
            "groups": groups, "failures": failures, "physicalSlabs": False}


def audit_effective_settings(model: dict, fe: dict, receipt: dict, report_text: str,
                             load_audit: dict | None = None, *, member_audit: dict | None = None) -> dict:
    """Require solver-effective evidence, not merely a successful scalar write.

    The load compiler owns selected-case selfweight accounting. It must bind its
    independent audit to this exact FE file before the result can be combined.
    """
    plan = compile_settings(model)
    failures = []
    if receipt.get("passed") is not True or receipt.get("audit", {}).get("written") != plan["parameters"]:
        failures.append("native-scalar-write-not-bound")
    else:
        try:
            verify_readback(plan["parameters"], receipt["audit"]["readback"])
        except (KeyError, ValueError):
            failures.append("native-scalar-readback-mismatch")
    # Report labels vary across YJK8 builds; the value itself must be exact.
    construction = re.findall(r"(?:恒活荷载计算信息|恒荷载计算信息|恒载计算信息)\s*[:：]\s*([^\r\n]+)", report_text)
    if len(construction) != 1 or construction[0].strip() != "一次性加载":
        failures.append("construction-report-is-not-once-loaded")
    controls = plan["controls"]
    for name in ("rigid_offsets",):
        if controls.get(name) is True:
            failures.append("native-enabled-control-not-calibrated:" + name)
    diaphragm = None
    if controls.get("rigid_floor") is True:
        if re.search(r"刚性楼板假定\s*[:：]\s*对所有楼层强制采用刚性楼板假定(?:\s|$)", report_text) is None:
            failures.append("forced-rigid-floor-report-mismatch")
        try:
            diaphragm = audit_rigid_diaphragms(model, fe)
            failures.extend(diaphragm["failures"])
        except ValueError as exc:
            failures.append("native-diaphragm-readback-invalid:" + str(exc))
    if controls.get("rigid_offsets") is False:
        for label in ("考虑梁端刚域", "考虑柱端刚域"):
            if re.search(re.escape(label) + r"\s*[:：]\s*否(?:\s|$)", report_text) is None:
                failures.append("rigid-offset-report-mismatch:" + label)
        verified_inclined = {row["nativeFrameId"] for row in (member_audit or {}).get("members", {}).values()
                            if (row.get("nativeColumnIdentity") or {}).get("passed") is True}
        for tag, frame in fe.get("frames", {}).items():
            omitted_rzl = frame.get("kind") == "BRACE" and frame.get("RZL") is None and tag in verified_inclined
            if frame.get("E") != [0.] * 6 or (frame.get("RZL") != [0.] * 2 and not omitted_rzl):
                failures.append("nonzero-or-missing-native-offset:" + tag)
    if controls.get("rigid_floor") is False:
        for line in fe.get("sectionsRaw", {}).get("NODE", []):
            master = re.search(r"(?:^|\s)NM=([^\s]+)", line)
            if master is None or master[1] != "0":
                failures.append("native-node-diaphragm-or-missing-NM:" + line.split()[0])
    if fe.get("sectionsRaw", {}).get("PLANAR") or fe.get("sectionsRaw", {}).get("PART"):
        failures.append("unexpected-native-floor-elements")
    nonlinear = fe.get("sectionsRaw", {}).get("NONL_CTRL", [])
    if not nonlinear or any(re.search(r"(?:^|\s)GeoNL=0(?:\s|$)", row) is None for row in nonlinear):
        failures.append("native-geometric-nonlinearity-not-explicitly-disabled")
    analysis = fe.get("sectionsRaw", {}).get("ANALYSIS", [])
    scheme = 2 if controls.get("rigid_floor") is True else 1
    if not analysis or any(re.search(rf"(?:^|\s)scheme={scheme}(?:\s|$)", row) is None for row in analysis):
        failures.append("native-linear-scheme-not-verified")
    if not fe.get("frames"):
        failures.append("no-native-frames")
    load_audit = load_audit or {}
    weight_verified = (load_audit.get("selfWeight") is controls.get("self_weight")
                       if "selfWeight" in load_audit else controls.get("self_weight") is False
                       and load_audit.get("selfWeightExcludedFromSourceCases") is True)
    if (load_audit.get("passed") is not True or load_audit.get("feaSha256") != fe.get("sha256")
            or not weight_verified):
        failures.append("selected-load-case-selfweight-not-verified")
    return {"schema": "sclaw-yjk-effective-settings/v1", "passed": not failures,
            "linearStatic": not failures, "feaSha256": fe["sha256"], "failures": failures,
            "controls": controls, "reportSha256": hashlib.sha256(report_text.encode("utf-8")).hexdigest(),
            "loadAudit": load_audit, "diaphragms": diaphragm}


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


def apply_in_host(command, work_dir, pid: int, plan: dict, timeout_s: float = 30,
                  receipt_name: str = "native-settings-readback.json") -> dict:
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
    _write(Path(work_dir) / receipt_name, {"plan": plan, **result})
    return result
