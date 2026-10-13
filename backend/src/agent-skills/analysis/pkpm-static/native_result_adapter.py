"""Complete physical frame results from verified native geometry and cuts."""
from __future__ import annotations

import hashlib
import json
import math

from native_frame_stations import map_frame_stations
from native_geometry import read_native_geometry
from native_reactions import recover_support_reactions


def _hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def complete_frame_results(model, result, jws_path):
    settings = result["summary"]["effectiveNativeSettings"]
    if settings.get("verified") is not True or any(settings.get("requested", {}).get(key) is not False
            for key in ("self_weight", "rigid_floor", "rigid_offsets", "construction_stage", "p_delta")):
        raise ValueError("Complete native frame results require verified linear bare-frame settings / 完整杆系结果需要原生线性无楼板设置核对")
    geometry = read_native_geometry(jws_path, model)
    cases = {str(row["id"]): row for row in model["load_cases"]}
    native_labels = {"DL": "dead", "LL": "live"}
    context = {"engine": "pkpm", "engineVersion": "2025R2.5",
               "physicalModelHash": _hash(model),
               "stiffnessHash": _hash({key: model.get(key) for key in ("nodes", "elements", "materials", "sections")}),
               "settingsHash": _hash(result["summary"]["effectiveNativeSettings"]),
               "linearStatic": True, "effectiveSettingsVerified": True, "stationConventionsVerified": True}
    for case_id, case in result["caseResults"].items():
        source = cases.get(case_id)
        if source is None:
            candidates = [row for row in cases.values() if row.get("type") == native_labels.get(case_id)]
            if len(candidates) != 1:
                raise ValueError(f"No unique physical load case for native case '{case_id}' / 原生工况无法唯一映射")
            source = candidates[0]
        nodal = {node_id: [0.] * 6 for node_id in geometry["supports"]}
        for load in source.get("loads", []):
            if load.get("type") == "nodal" and str(load.get("node")) in nodal:
                if load.get("reference_frame", "global") != "global":
                    raise ValueError("Support load must use verified global axes / 支座荷载方向未校准")
                row = nodal[str(load["node"])]
                for index, key in enumerate(("fx", "fy", "fz", "mx", "my", "mz")):
                    row[index] += float(load.get(key, 0))
        reaction = recover_support_reactions(
            **{key: geometry[key] for key in ("nodes", "members", "native_members", "supports")},
            station_rows=case["memberStations"], nodal_loads=nodal, source_case=case_id,
            result_source={"kind": "simultaneous-signed-stations", "caseId": case_id,
                           "geometry": geometry["source"]})
        case["reactionSource"] = reaction["source"]
        case["reactionObjectSources"] = {node: row["source"] for node, row in reaction["reactions"].items()}
        case["reactions"] = {node: {key: value for key, value in row.items() if key != "source"}
                             for node, row in reaction["reactions"].items()}
        for node_id, support in geometry["supports"].items():
            case["displacements"][node_id] = dict.fromkeys(("ux", "uy", "uz", "rx", "ry", "rz"), 0.)
        case["boundaryDisplacementSource"] = {node: {"kind": "prescribed-boundary", "evidence": support["source"]}
                                               for node, support in geometry["supports"].items()}
        if set(case["displacements"]) != set(geometry["nodes"]) or any(
            set(row) != {"ux", "uy", "uz", "rx", "ry", "rz"} for row in case["displacements"].values()):
            raise ValueError("Native physical six-DOF coverage is incomplete / 原生物理节点六自由度结果不完整")
        case["memberStations"] = map_frame_stations(model, geometry, case["memberStations"], active_loads=source.get("loads", []))
        case["forces"] = {}
        for member_id, rows in case["memberStations"].items():
            components = {key: max((row["components"][key] for row in rows), key=abs)
                          for key in ("N", "Vy", "Vz", "T", "My", "Mz")}
            components.update(V=max(math.hypot(row["components"]["Vy"], row["components"]["Vz"]) for row in rows),
                              M=max(math.hypot(row["components"]["My"], row["components"]["Mz"]) for row in rows),
                              referenceFrame="element-local")
            case["forces"][member_id] = components
        case.update(capabilityStatus="complete", missingCapabilities=[],
                    forceSemantics="simultaneous-signed-stations", nativeContext=context,
                    units={"displacement": "m", "rotation": "rad", "force": "kN", "moment": "kN.m"})
    result.update(capabilityStatus="complete", missingCapabilities=[])
    result["summary"].update(reactionResultAvailable=True, rotationResultAvailable=True,
                             nativeGeometryVerification=geometry["source"], nodeCount=len(geometry["nodes"]))
    result["warnings"] = [warning for warning in result["warnings"] if "reactions are unavailable" not in warning]
    selected = next(iter(result["caseResults"].values()))
    for field in ("displacements", "forces", "reactions", "memberStations", "nativeContext", "forceSemantics", "units"):
        result[field] = selected[field]
    return result


def select_result(model, result, selected_ids, combination_id=None):
    from native_results import combine_linear_native_results
    cases = result["caseResults"]
    if not selected_ids or any(key not in cases for key in selected_ids):
        raise ValueError("Requested source results are missing / 缺少指定源工况结果")
    if combination_id:
        definitions = [row for row in model.get("load_combinations", []) if str(row["id"]) == combination_id]
        if len(definitions) != 1:
            raise ValueError("Combination must identify one definition / 组合编号必须唯一")
        selected = combine_linear_native_results(cases, definitions[0]["factors"], cases[selected_ids[0]].get("nativeContext", {}))
        selected["forces"] = {}
        for member_id, rows in selected["memberStations"].items():
            values = {key: max((row["components"][key] for row in rows), key=abs) for key in ("N", "Vy", "Vz", "T", "My", "Mz")}
            values.update(V=max(math.hypot(row["components"]["Vy"], row["components"]["Vz"]) for row in rows),
                          M=max(math.hypot(row["components"]["My"], row["components"]["Mz"]) for row in rows), referenceFrame="element-local")
            selected["forces"][member_id] = values
        result["combinationResults"] = {combination_id: selected}
        selection = {"kind": "combination", "id": combination_id}
    else:
        selected = cases[selected_ids[0]]
        selection = {"kind": "case", "id": selected_ids[0]}
    for field in ("displacements", "forces", "reactions", "memberStations", "nativeContext", "forceSemantics", "units", "missingCapabilities", "capabilityStatus"):
        if field in selected:
            result[field] = selected[field]
    magnitudes = {key: math.hypot(*(row[axis] for axis in ("ux", "uy", "uz"))) for key, row in selected["displacements"].items()}
    node = max(magnitudes, key=magnitudes.get)
    result["summary"].update(maxDisplacement=magnitudes[node], maxDisplacementNode=node, selection=selection)
    result.update(selectedResult=selection, requestedCaseIds=selected_ids, envelope={})
    return result
