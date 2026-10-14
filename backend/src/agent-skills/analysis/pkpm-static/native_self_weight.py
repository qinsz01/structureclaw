"""Authored member weight through official load definitions, never carrier mass."""
from __future__ import annotations

import hashlib
import math
import sys
from pathlib import Path
from types import SimpleNamespace

_shared = str(Path(__file__).resolve().parents[3] / "skill-shared" / "python")
if _shared not in sys.path:
    sys.path.insert(0, _shared)
from structure_protocol.self_weight import resolve_self_weight
from structure_protocol.section_properties import geometry_properties


def compile_self_weight(model):
    resolved = resolve_self_weight(model)
    output = {**resolved, "method": "authored-member-density-area-native-line-loads", "members": [], "physicalCompilation": []}
    if not resolved["enabled"]:
        return output
    if resolved["direction"] not in ("z", "-z"):
        raise ValueError("PKPM member weight currently requires vertical gravity / PKPM构件自重当前须为竖向重力")
    from native_model_contract import pkpm_section_shape, pkpm_numeric_section_properties
    sections = {str(row["id"]): row for row in model["sections"]}
    materials = {str(row["id"]): row for row in model["materials"]}
    nodes = {str(row["id"]): row for row in model["nodes"]}
    for element in model["elements"]:
        section = sections[str(element["section"])]
        props = pkpm_numeric_section_properties(section)
        if props is None:
            shape = pkpm_section_shape(section)
            if shape is None:
                raise ValueError("Selfweight requires verified section area / 自重需要可核对的截面面积")
            values = dict.fromkeys(("H", "B", "T", "d", "d2", "tw", "tf", "tf2", "B2", "r"))
            values.update(shape)
            values["kind"] = {"Rectangle": "rectangular", "Box": "box", "Tube": "pipe", "Circle": "circular"}.get(shape["kind"], shape["kind"])
            values["d"] = shape.get("D")
            props = geometry_properties(SimpleNamespace(**values))
        density = materials[str(element["material"])].get("rho")
        area = props["A"] if props else None
        a, b = [nodes[str(key)] for key in element["nodes"]]
        length = math.dist([a[k] for k in ("x", "y", "z")], [b[k] for k in ("x", "y", "z")])
        if any(type(v) not in (int, float) or not math.isfinite(v) or v <= 0 for v in (density, area, length)):
            raise ValueError("Selfweight requires positive density, area and length / 自重需要正值密度、面积和长度")
        intensity = density * area * resolved["vectorMps2"][2] / 1000
        output["members"].append({"elementId": str(element["id"]), "materialId": str(element["material"]),
            "sectionId": str(element["section"]), "densityKgM3": density, "areaM2": area, "lengthM": length,
            "intensityKnM": intensity, "intensityVectorKnM": [0., 0., intensity],
            "totalForceKn": intensity * length, "totalForceVectorKn": [0., 0., intensity * length], "elementType": element["type"]})
    output["physicalCompilation"] = [{"physicalElementId": row["elementId"], "startM": 0., "endM": row["lengthM"],
        "intensityVectorKnM": row["intensityVectorKnM"], "sourceSegmentId": row["elementId"]} for row in output["members"]]
    return output


def native_weight_records(model, plan):
    if not plan["enabled"]:
        return []
    case = next(row for row in model["load_cases"] if str(row["id"]) == plan["loadCaseId"])
    return [{"id": "self-weight:" + row["elementId"], "caseId": plan["loadCaseId"], "caseType": case.get("type", "other"),
        "targetType": row["elementType"], "targetId": row["elementId"], "elementKind": 11 if row["elementType"] == "column" else 12,
        # The official column line-load scalar is +global Z; beam gravity is -Z.
        "nativeValues": [1, row["intensityKnM"] * (1 if row["elementType"] == "column" else -1), 0, 0, 0, 0],
        "sourceLoad": {"kind": "authored-member-self-weight", **row}, "intervalM": [0., row["lengthM"]],
        "forceUnit": "kN", "momentUnit": "kN.m"} for row in plan["members"]]


def verify_weight_results(model, plan, cases, directory):
    """Check official signed cuts conserve the requested per-member line loads."""
    if not plan["enabled"]:
        return None
    members = {row["elementId"]: row for row in plan["members"]}
    source_cases = {str(row["id"]): row for row in model["load_cases"]}
    if plan["loadCaseId"] not in cases:
        raise ValueError("Native selfweight source case was not verified / 未核对原生自重工况")
    for case_id, case in cases.items():
        for identity, weight in members.items():
            rows = case["memberStations"][identity]
            offset = case.get("nativeContext", {}).get("effectiveRigidOffsets", {}).get("members", {}).get(identity)
            domain = [offset["elasticStartM"], offset["elasticEndM"]] if offset and offset["nativeStationDomain"] == "elastic-span" else [0., weight["lengthM"]]
            if len(rows) < 2 or rows[0]["positionM"] != domain[0] or not math.isclose(rows[-1]["positionM"], domain[1], abs_tol=1e-8):
                raise ValueError("Native selfweight cuts do not cover the physical member / 原生自重截面未覆盖完整构件")
            expected = list(weight["totalForceVectorKn"] if case_id == plan["loadCaseId"] else [0.] * 3)
            for load in source_cases[case_id].get("loads", []):
                if str(load.get("element")) == identity:
                    if load.get("type") not in ("uniform", "distributed") or load.get("reference_frame", "global") != "global":
                        raise ValueError("Selfweight audit requires explicit uniform member loads / 自重核对需要明确均布构件荷载")
                    for index, key in enumerate(("wx", "wy", "wz")):
                        expected[index] += float(load.get(key, 0)) * weight["lengthM"]
            for start, end in zip(rows, rows[1:]):
                delta = [(end["components"][key] - start["components"][key]) * sign for key, sign in (("N", -1), ("Vy", 1), ("Vz", 1))]
                actual = [sum(delta[j] * start["localAxes"][j][i] for j in range(3)) for i in range(3)]
                interval = (end["positionM"] - start["positionM"]) / weight["lengthM"]
                if interval <= 0 or any(not math.isclose(a, e * interval, rel_tol=1e-5, abs_tol=1e-5) for a, e in zip(actual, expected)):
                    raise ValueError(f"Native member weight/case differs: {case_id}/{identity} / 原生构件自重或工况不符")
    directory = Path(directory)
    return {"verified": True, "sourceFeaSha256": hashlib.sha256((directory / "DATA.SAT").read_bytes()).hexdigest(),
        "selfWeight": plan, "verification": "official-load-definitions-and-signed-cut-equilibrium",
        "artifacts": [{"path": name, "sha256": hashlib.sha256((directory / name).read_bytes()).hexdigest()}
                      for name in ("WMASS.OUT", "DATA.SAT", "GOUJIAN.OUT")]}
