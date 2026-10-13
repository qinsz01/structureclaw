"""Explicit PKPM load compilation for isolated native acceptance.

The SDK wire format is preserved with a complete source mapping. Production
preflight still rejects these loads until solver sign/case acceptance passes;
successful save/readback alone must not open that gate.
"""
from __future__ import annotations

import copy
import math
from typing import Any


def _finite(value: Any, field: str) -> float:
    if isinstance(value, bool):
        raise ValueError(f"{field} must be finite")
    value = float(value)
    if not math.isfinite(value):
        raise ValueError(f"{field} must be finite")
    return value


def plan_native_loads(data: dict) -> list[dict]:
    """Return candidate wire records, never infer/round locations or cases."""
    nodes = {str(n["id"]): n for n in data.get("nodes", [])}
    elements = {str(e["id"]): e for e in data.get("elements", [])}
    seen_cases: set[str] = set()
    records = []
    for case in data.get("load_cases", []):
        case_id = str(case["id"])
        if case_id in seen_cases:
            raise ValueError(f"Duplicate load case '{case_id}'")
        seen_cases.add(case_id)
        seen_loads: set[str] = set()
        for index, load in enumerate(case.get("loads", [])):
            if load.get("source") == "story_floor_loads":
                continue  # The separately validated native floor handles this declaration.
            if load.get("reference_frame", "global") != "global":
                raise ValueError("Native local load axes have not been calibrated / 尚未校准局部荷载方向")
            row = {"id": str(load.get("id", f"{case_id}:{index}")), "caseId": case_id,
                   "caseType": case.get("type", "other"), "sourceLoad": copy.deepcopy(load),
                   "acceptance": "native-solver-unverified", "forceUnit": "kN", "momentUnit": "kN.m"}
            if row["id"] in seen_loads:
                raise ValueError(f"Duplicate load id '{row['id']}' in case '{case_id}'")
            seen_loads.add(row["id"])
            if load.get("type") == "nodal":
                node_id = str(load.get("node"))
                if node_id not in nodes:
                    raise ValueError(f"Load references unknown node '{node_id}'")
                components = [_finite(load.get(k, 0), k) for k in ("fx", "fy", "fz", "mx", "my", "mz")]
                # PKPM load UI uses positive vertical gravity. Other component
                # signs remain candidate conventions until six-direction runs.
                components[2] *= -1
                row.update(targetType="node", targetId=node_id, elementKind=-1, nativeValues=components)
            elif load.get("type") in {"distributed", "uniform"}:
                element_id = str(load.get("element"))
                element = elements.get(element_id)
                if element is None or element.get("type") != "beam":
                    raise ValueError("Native line loads require a declared beam")
                a, b = (nodes[str(n)] for n in element["nodes"])
                length = math.dist([_finite(a[k], k) for k in ("x", "y", "z")], [_finite(b[k], k) for k in ("x", "y", "z")])
                if length <= 0:
                    raise ValueError("Native line loads cannot target a zero-length beam")
                if abs(float(a["z"]) - float(b["z"])) > 1e-9:
                    raise ValueError("Native sloping-member load axes require calibration")
                if (_finite(load.get("start", 0), "start") != 0 or
                        not math.isclose(_finite(load.get("end", length), "end"), length, rel_tol=0, abs_tol=1e-9)
                        or load.get("distribution") not in (None, "uniform") or load.get("points")):
                    raise ValueError("Partial/variable native load encoding is not verified; its extent must not change")
                if any(_finite(load.get(k, 0), k) for k in ("wx", "wy", "mx", "my", "mz")):
                    raise ValueError("Only global vertical native beam UDL wire encoding is documented")
                row.update(targetType="beam", targetId=element_id, elementKind=12,
                           nativeValues=[1, -_finite(load.get("wz", 0), "wz"), 0, 0, 0, 0],
                           intervalM=[0, length])
            else:
                raise ValueError(f"Native load type '{load.get('type')}' has no verified wire encoding")
            records.append(row)
    return records


def write_native_loads(api: Any, native_model: Any, records: list[dict], targets: dict[tuple[str, str], Any]) -> dict:
    """Write/read SDK cases and definitions; never mark physical acceptance."""
    cases, written = {}, []
    used_standard: set[int] = set()
    grouped: dict[tuple[str, str], list[tuple[int, int]]] = {}
    for row in records:
        case_id = row["caseId"]
        if case_id not in cases:
            standard = {"dead": 1, "live": 2}.get(row["caseType"])
            if standard is not None and standard not in used_standard:
                used_standard.add(standard)
                cases[case_id] = {"nativeId": standard, "nativeLabel": "DL" if standard == 1 else "LL"}
            else:
                native = api.LoadCaseData()
                native_kind = 1 if row["caseType"] == "dead" else 2
                native.Set(case_id, 18, native_kind)
                native_id = native_model.AddUserLoadCase(native)
                readback = native_model.GetUserLoadCase(native_id)
                if readback.GetName() != case_id or readback.GetType() != 18 or readback.GetKind() != native_kind:
                    raise RuntimeError(f"Native load-case name/type/kind did not survive '{case_id}'")
                cases[case_id] = {"nativeId": native_id, "nativeLabel": readback.GetName(), "nativeType": readback.GetType(), "nativeKind": readback.GetKind()}
        key = (row["targetType"], row["targetId"])
        if key not in targets:
            raise ValueError(f"Native load target is not mapped: {key}")
        definition = api.LoadDefineData(); definition.Set(row["elementKind"], row["nativeValues"])
        native_id = native_model.AddLoadDefine(definition)
        kind, values = native_model.GetLoadDefine(native_id).Get()
        if kind != row["elementKind"] or list(values) != row["nativeValues"]:
            raise RuntimeError(f"Native load definition readback differs for '{row['id']}'")
        grouped.setdefault(key, []).append((cases[case_id]["nativeId"], native_id))
        written.append({**row, "nativeLoadId": native_id, "nativeCaseId": cases[case_id]["nativeId"]})
    for key, assignments in grouped.items():
        member = targets[key]
        existing = member.GetLoad()
        if list(existing[-2]) or list(existing[-1]):
            raise ValueError(f"Native target '{key[1]}' already has loads; acceptance must use a fresh isolated model")
        case_ids, load_ids = map(list, zip(*assignments))
        if key[0] == "node": member.SetLoad(case_ids, load_ids)
        else: member.SetLoad(len(assignments), case_ids, load_ids)
        readback = member.GetLoad()
        if list(readback[-2]) != case_ids or list(readback[-1]) != load_ids:
            raise RuntimeError(f"Native load assignment readback differs for '{key[1]}'")
    return {"cases": cases, "loads": written, "acceptance": "sdk-write-readback-only", "formalAnalysisAccepted": False}
