"""Material identity and executed native frame stiffness evidence.

Named grades select a native category; they never replace authored E/G/nu/rho.
The FE audit binds every actual frame to its physical endpoints and checks the
used material/section, including J. Unused native definitions prove nothing.
"""
from __future__ import annotations

import copy
from decimal import Decimal
import hashlib
import json
import math
from pathlib import Path
import re
import struct
import sqlite3
import sys
from contextlib import closing

_skill_dir = str(Path(__file__).resolve().parent)
if _skill_dir not in sys.path:
    sys.path.insert(0, _skill_dir)
from yjk_native_stations import (canonical_axes, cross, dot, executed_section_axes,
                             get_reference_vector, is_native_ordinary_column, StationConventionUnavailable)


def normalize_material(material: dict) -> dict:
    result = copy.deepcopy(material)
    category, legacy = result.get("category"), result.get("type")
    if legacy in ("concrete", "steel", "rebar", "other"):
        if category is not None and legacy != category:
            raise ValueError(f"Material {result.get('id')} category/type conflict / 材料类别冲突")
        category = legacy
    grade, name = result.get("grade"), str(result.get("name", "")).strip()
    if grade is None and re.fullmatch(r"(?:C\d+|Q\d+[A-E]?|HRB\d+)", name):
        grade = name
    if grade:
        expected = "concrete" if re.fullmatch(r"C\d+", grade) else (
            "steel" if re.fullmatch(r"Q\d+[A-E]?", grade) else "rebar" if re.fullmatch(r"HRB\d+", grade) else None)
        if category is not None and expected is not None and category != expected:
            raise ValueError(f"Material {result.get('id')} category/grade conflict / 材料类别与牌号冲突")
        category = category or expected
    if category not in ("concrete", "steel", "rebar", "other"):
        raise ValueError(f"Material {result.get('id')} requires explicit category / 材料类别缺失")
    result.update(category=category, grade=grade)
    result.pop("type", None)
    for key in ("E", "nu", "rho"):
        if type(result.get(key)) not in (int, float) or not math.isfinite(result[key]):
            raise ValueError(f"Material {result.get('id')} invalid {key}")
    if result["E"] <= 0 or result["rho"] <= 0 or not 0 <= result["nu"] <= 0.5:
        raise ValueError(f"Material {result.get('id')} invalid elastic properties")
    if result.get("G") is not None and (type(result["G"]) not in (int, float) or
                                         not math.isfinite(result["G"]) or result["G"] <= 0):
        raise ValueError(f"Material {result.get('id')} invalid G")
    return result


def _hash(value) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"),
                                    ensure_ascii=False, allow_nan=False).encode("utf-8")).hexdigest()


def native_baseline(material: dict) -> dict:
    """Reference material, always checked again in the executed FE model."""
    material = normalize_material(material)
    grade = material.get("grade")
    concrete = {"C30": 30000., "C35": 31500., "C40": 32500.}
    if material["category"] == "concrete":
        native_grade = grade if grade in concrete else "C30"
        E, nu = concrete[native_grade], .25
    elif material["category"] == "steel":
        native_grade = grade if grade in ("Q235", "Q345", "Q355", "Q390", "Q420", "Q460") else "Q355"
        E, nu = 206000., .3
    else:
        raise ValueError(f"YJK elastic baseline for material {material['id']} ({grade}) is unverified / 材料原生刚度基准尚未验证")
    return {"grade": native_grade, "sourceGrade": grade,
            "representation": "elastic-reference-material" if native_grade != grade else "native-grade-with-rigidity-transfer",
            "E": E, "nu": nu, "G": E / (2 * (1 + nu)),
            "verification": "requires-executed-FE-readback"}


def _rectangle_baseline(section: dict) -> dict:
    shape = section.get("shape") or {}
    kind = shape.get("kind") or section.get("type")
    if kind != "rectangular":
        raise ValueError(f"YJK explicit stiffness transfer for section {section['id']} requires calibrated rectangular geometry")
    width = shape.get("B") or section.get("width")
    height = shape.get("H") or section.get("height")
    if type(width) not in (int, float) or type(height) not in (int, float) or min(width, height) <= 0:
        raise ValueError(f"YJK rectangular dimensions are missing: {section['id']}")
    b, h = width / 1000, height / 1000
    wide, narrow = max(b, h), min(b, h)
    # The native rectangle formula is checked against *SECTION for every run.
    return {"A": b * h, "Iy": b * h**3 / 12, "Iz": h * b**3 / 12,
            "J": wide * narrow**3 * (1/3 - .21*narrow/wide*(1 - narrow**4/(12*wide**4))),
            "Asy": 5*b*h/6, "Asz": 5*b*h/6}


def section_representation(section: dict) -> dict:
    """An analysis-only carrier never becomes the authored physical section.

    The six principal elastic properties completely define this first-order
    shear-flexible rod model. A carrier supplies native DOFs; member RF values
    restore the source rigidities. Its dimensions must not enter design checks,
    selfweight, or a physical section table.
    """
    kind = (section.get("shape") or {}).get("kind") or section.get("type")
    if kind == "rectangular":
        return {"method": "native-physical-rectangle", "baseline": _rectangle_baseline(section)}
    properties = section.get("properties") or {}
    keys = ("A", "Iy", "Iz", "J", "Asy", "Asz")
    for key in keys:
        value = properties.get(key)
        if type(value) not in (int, float) or not math.isfinite(value) or value <= 0:
            raise ValueError(f"YJK section {section['id']} requires explicit positive {key} for elastic reference carrier / 数值截面须完整提供六项正值属性")
    carrier = {"id": "analysis-reference-only", "type": "rectangular",
               "shape": {"kind": "rectangular", "B": 400., "H": 600.}}
    return {"method": "native-reference-carrier", "sourceType": section.get("type"),
            "sourceProperties": {key: properties[key] for key in keys},
            "carrier": carrier, "baseline": _rectangle_baseline(carrier),
            "scope": "first-order-elastic-centroidal-principal-axis-rod",
            "physicalGeometryVerified": False,
            "excludedUses": ["physical-section-table", "design-check", "native-selfweight", "nonlinear-analysis"]}


def _require_reference_scope(model: dict):
    control = model.get("analysis_control") or {}
    keys = ("self_weight", "rigid_floor", "rigid_offsets", "construction_stage", "p_delta")
    if any(control.get(key) is not False for key in keys):
        raise ValueError("YJK reference carriers require explicit first-order bare-frame controls and selfweight OFF / 参考载体仅用于显式关闭自重及附加刚度的一阶杆系")
    if any(story.get("rigid_diaphragm") is True for story in model.get("stories", [])):
        raise ValueError("YJK reference carriers do not support rigid diaphragms / 参考载体不支持刚性楼板")


def compile_orientation(model: dict, element: dict, nodes: dict) -> dict:
    """Place the authored width/height axes using the public SDK rotation.

    The MODEL manual defines column Rotation as the section width angle
    from global X. Beam rotation is right-handed about the plan axis directed
    from left to right (from bottom to top for a Y-aligned beam).
    """
    points = [[float(nodes[str(tag)][axis]) for axis in ("x", "y", "z")] for tag in element["nodes"]]
    axes = canonical_axes(*points, float(element.get("rotation_angle") or 0),
        get_reference_vector(model.get("metadata") or {}, str(element["id"])))
    if abs(abs(axes[0][2]) - 1) <= 1e-9:
        angle = math.degrees(math.atan2(axes[1][1], axes[1][0]))
    elif element.get("type") == "beam" or abs(axes[0][2]) <= 1e-9:
        native_x = list(axes[0])
        if native_x[0] < -1e-9 or (abs(native_x[0]) <= 1e-9 and native_x[1] < 0):
            native_x = [-value for value in native_x]
        up = [0., 0., 1.]
        projected = [up[i]-dot(up, native_x)*native_x[i] for i in range(3)]
        angle = math.degrees(math.atan2(dot(native_x, cross(projected, axes[2])), dot(projected, axes[2])))
    else:
        if element.get("type") != "column":
            raise ValueError(f"YJK inclined section orientation requires native calibration: {element['id']}")
        # Native inclined-column (two-node rod) axis points from its first to
        # second endpoint. Its unrotated section height is projected global Z.
        up = [0., 0., 1.]
        projected = [up[i] - dot(up, axes[0]) * axes[0][i] for i in range(3)]
        length = math.sqrt(dot(projected, projected))
        projected = [value / length for value in projected]
        angle = math.degrees(math.atan2(dot(axes[0], cross(projected, axes[2])), dot(projected, axes[2])))
    # Solid rectangular principal axes are unoriented lines; adding 180 degrees
    # changes no geometry, inertia or load direction. Forces still use FE DIR.
    angle %= 180
    if math.isclose(angle, 180, abs_tol=1e-10) or math.isclose(angle, 0, abs_tol=1e-10):
        angle = 0.
    return {"canonicalAxes": axes, "nativeRotationDegrees": angle,
            "orientationBasis": "shared-coordinate-semantics; native-MODEL-section-width-angle"}


def compile_stiffness_plan(model: dict) -> dict:
    """Preserve six authored elastic rigidities via native member coefficients.

    YJK8 SpBarRig order is N,V2,V3,T,M2,M3. The executed RF order is
    N,M3,M2,T,V2,V3 (native probe 20261013-172324-492103). The two shear
    indices follow the bending plane: V2 scales canonical GAsz and V3 GAsy,
    independently distinguished by the unequal-area six-effect calibration.
    No beam/column
    substitution or artificial node is involved. Density stays separate from
    the six stiffness multipliers and is used by explicit selfweight loads.
    """
    mats = {str(row["id"]): normalize_material(row) for row in model["materials"]}
    sections = {str(row["id"]): row for row in model["sections"]}
    nodes = {str(row["id"]): row for row in model["nodes"]}
    entries = {}
    for element in model["elements"]:
        material = mats[str(element["material"])]
        baseline = native_baseline(material)
        section = sections[str(element["section"])]
        representation = section_representation(section)
        if representation["method"] == "native-reference-carrier" or baseline["representation"] == "elastic-reference-material":
            _require_reference_scope(model)
        native_section = representation["baseline"]
        authored_section = {**native_section, **(section.get("properties") or {})}
        if "As" in (section.get("properties") or {}) and "Asy" not in section["properties"]:
            authored_section["Asy"] = section["properties"]["As"]
        E, G = material["E"], material.get("G") or material["E"]/(2*(1+material["nu"]))
        target = {"EA": E*authored_section["A"], "EIy": E*authored_section["Iy"],
                  "EIz": E*authored_section["Iz"], "GJ": G*authored_section["J"],
                  "GAsy": G*authored_section["Asy"], "GAsz": G*authored_section["Asz"]}
        base = {"EA": baseline["E"]*native_section["A"], "EIy": baseline["E"]*native_section["Iy"],
                "EIz": baseline["E"]*native_section["Iz"], "GJ": baseline["G"]*native_section["J"],
                "GAsy": baseline["G"]*native_section["Asy"], "GAsz": baseline["G"]*native_section["Asz"]}
        coefficients = [target[key]/base[key] for key in ("EA", "GAsz", "GAsy", "GJ", "EIz", "EIy")]
        if any(not math.isfinite(value) or value <= 0 for value in coefficients):
            raise ValueError(f"Invalid native stiffness coefficient for {element['id']}")
        entries[str(element["id"])] = {**compile_orientation(model, element, nodes),
            "materialBaseline": baseline, "sectionBaseline": native_section,
            "sectionRepresentation": representation,
            "authoredSection": authored_section, "targetRigidities": target,
            "property": "SpBarRig", "type": 27, "coefficients": coefficients,
            "shapeVal": ",".join(format(value, ".17g") for value in coefficients) + ",",
            "expectedRF": [coefficients[index] for index in (0, 5, 4, 3, 1, 2)]}
    return {"schema": "sclaw-yjk-stiffness-plan/v1", "physicalModelHash": _hash(model), "members": entries,
            "verification": "pending-native-execution-and-rigidity-audit"}


def assign_member_stiffness(data_func, native_id: int, entry: dict):
    """Public SDK property setter; its return is not proof of effective stiffness."""
    return data_func.property_arrange(native_id, entry["property"], entry["type"], entry["shapeVal"])


def repair_exchange_precision(ydb_path, work_dir, elements: dict, plan: dict) -> dict:
    """Correct only the SDK's two-decimal serialization in a fresh exchange YDB.

    Type 27 is required by the native parser; type 8 was experimentally ignored.
    This edits our generated input before import, never a saved native project,
    solver data, result, installed API file or shared service. Execution and saved
    native model readback remain required after this lossless encoding repair.
    """
    root, path = Path(work_dir).resolve(), Path(ydb_path).resolve()
    if path.parent != root or path.suffix.lower() != ".ydb" or not path.is_file():
        raise ValueError("Stiffness precision repair requires this run's existing exchange YDB")
    if any(root.glob("*.ymd")):
        raise ValueError("Stiffness precision repair must precede native import")
    if set(elements) != set(plan.get("members", {})):
        raise ValueError("Stiffness precision repair has incomplete physical member mapping")
    before_hash = hashlib.sha256(path.read_bytes()).hexdigest()
    changes, native_ids = [], set()
    with closing(sqlite3.connect(path.as_uri() + "?mode=rw", uri=True)) as db:
        with db:
            # Validate every target before changing even one row.
            for identifier, entry in plan["members"].items():
                native_id = elements[identifier].get("yjk_model_id")
                if type(native_id) is not int or native_id <= 0 or native_id in native_ids:
                    raise ValueError("Stiffness precision repair has ambiguous native member IDs")
                native_ids.add(native_id)
                rows = db.execute("SELECT Type,ShapeVal FROM tblProperty WHERE ID=? AND Name='SpBarRig'", (native_id,)).fetchall()
                if len(rows) != 1 or rows[0][0] != 27:
                    raise ValueError(f"Missing or wrong typed native stiffness property for {identifier}")
                original = rows[0][1]
                actual = [float(token) for token in original.split(",") if token.strip()]
                expected = entry["coefficients"]
                if len(actual) != 6 or any(not math.isfinite(a) or abs(a-b) > .005001 for a, b in zip(actual, expected)):
                    raise ValueError(f"Native exchange stiffness differs beyond the SDK serialization defect: {identifier}")
                changes.append({"member": identifier, "nativeId": native_id, "before": original,
                                "after": entry["shapeVal"], "type": 27})
            count = db.execute("SELECT COUNT(*) FROM tblProperty WHERE Name='SpBarRig'").fetchone()[0]
            if count != len(changes):
                raise ValueError("Unexpected native exchange stiffness properties")
            for row in changes:
                db.execute("UPDATE tblProperty SET ShapeVal=? WHERE ID=? AND Name='SpBarRig' AND Type=27",
                           (row["after"], row["nativeId"]))
            for row in changes:
                actual = db.execute("SELECT Type,ShapeVal FROM tblProperty WHERE ID=? AND Name='SpBarRig'",
                                    (row["nativeId"],)).fetchone()
                if actual != (27, row["after"]):
                    raise ValueError("Native exchange precise stiffness write/readback failed")
    result = {"schema": "sclaw-yjk-exchange-precision/v1", "passed": True,
              "physicalModelHash": plan["physicalModelHash"], "changes": changes,
              "beforeSha256": before_hash, "afterSha256": hashlib.sha256(path.read_bytes()).hexdigest(),
              "scope": "generated-exchange-input; only tblProperty.SpBarRig.ShapeVal"}
    (root / "native-stiffness-precision.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return result


def _rounding_match(expected: float, token: str) -> bool:
    """Only the precision explicitly serialized by fea.dat may be lost.

    Avoid using a low-precision material record to accept a different authored
    constant: E and nu are exact decimal identifiers and are checked directly.
    This helper is reserved for derived geometric section properties.
    """
    actual = Decimal(token)
    authored = Decimal(str(expected))
    resolution = Decimal(10) ** actual.as_tuple().exponent
    # YJK strips trailing zeroes; "0.1" does not permit a +/-0.05 change.
    # The executed section writer retains at least six significant digits.
    tolerance = min(abs(resolution) / 2, abs(actual) * Decimal("0.000005"))
    return abs(authored - actual) <= tolerance


def audit_inclined_column_identity(frame: dict, native_member: dict | None) -> dict:
    """Native storage as a rod is acceptable only for a classified rigid column."""
    evidence = (native_member or {}).get("native_geometry") or {}
    kind, truss = evidence.get("brace_kind"), evidence.get("is_truss")
    passed = (frame.get("kind") == "BRACE" and is_native_ordinary_column(native_member)
              and frame.get("R") == [0.] * 6 and frame.get("E") == [0.] * 6)
    return {"passed": passed, "requiredPhysicalRole": "column", "nativeStorage": frame.get("kind"),
            "nativeColumnKind": evidence.get("brace_column_kind"), "nativeKind": kind,
            "isTruss": truss, "endReleases": frame.get("R"),
            "source": "YJKSDsnDataPy.dsnGetBraceKind + YJKSPrePy.IsBraceTruss + executed FE R"}


def audit_frames(model: dict, fe: dict, stiffness_plan: dict | None = None,
                 native_members: dict | None = None) -> dict:
    """Compare native used properties with authored fields; return all failures."""
    if fe.get("unit") != [0, 0, 0]:
        raise ValueError("YJK FE units must be the verified kN/m convention")
    materials = {str(row["id"]): normalize_material(row) for row in model.get("materials", [])}
    sections = {str(row["id"]): row for row in model.get("sections", [])}
    nodes = {str(row["id"]): tuple(float(row[key]) for key in ("x", "y", "z"))
             for row in model.get("nodes", [])}
    frames = fe.get("frames", {})
    failures, members, used = [], {}, set()
    if stiffness_plan is not None and stiffness_plan.get("physicalModelHash") != _hash(model):
        raise ValueError("YJK stiffness plan belongs to a different physical model")
    for element in model.get("elements", []):
        identifier = str(element["id"])
        endpoints = [nodes[str(key)] for key in element["nodes"]]
        if len(endpoints) != 2:
            failures.append({"member": identifier, "field": "nodes", "reason": "not-a-frame"})
            continue
        matches = []
        for tag, frame in frames.items():
            points = [fe["nodes"].get(key) for key in frame.get("nodes", [])]
            if len(points) == 2 and all(point is not None for point in points) and any(
                    all(math.dist(a, b) <= 1e-7 for a, b in zip(points, order))
                    for order in (endpoints, endpoints[::-1])):
                matches.append(tag)
        if len(matches) != 1 or matches[0] in used:
            failures.append({"member": identifier, "field": "nativeFrame", "reason": "missing-or-ambiguous", "matches": matches})
            continue
        tag = matches[0]
        used.add(tag)
        frame = frames[tag]
        column_identity = None
        if frame.get("kind") == "BRACE":
            column_identity = audit_inclined_column_identity(frame, (native_members or {}).get(tag))
            if element.get("type") != "column" or not column_identity["passed"]:
                failures.append({"member": identifier, "field": "nativeColumnIdentity", **column_identity})
        material, section = materials[str(element["material"])], sections[str(element["section"])]
        mp = fe.get("materials", {}).get(frame.get("materialId"), {}).get("P", [])
        sp = fe.get("sections", {}).get(frame.get("sectionId"), {})
        if len(mp) < 2 or len(sp.get("P", [])) < 4:
            failures.append({"member": identifier, "field": "material/section", "reason": "missing-native-properties"})
            continue
        native = {"E": mp[0] / 1000, "nu": mp[1], "G": mp[0] / (2000 * (1 + mp[1]))}
        expected = {"E": material["E"], "nu": material["nu"],
                    "G": material.get("G") or material["E"] / (2 * (1 + material["nu"]))}
        entry = (stiffness_plan or {}).get("members", {}).get(identifier)
        if stiffness_plan is not None and not entry:
            failures.append({"member": identifier, "field": "stiffnessPlan", "reason": "missing-member"})
        baseline_expected = {key: entry["materialBaseline"][key] for key in ("E", "nu", "G")} if entry else expected
        for key, value in baseline_expected.items():
            if not math.isclose(native[key], value, rel_tol=1e-10, abs_tol=1e-12):
                failures.append({"member": identifier, "field": key, "expected": value, "actual": native[key]})
        # P = A,I2,I3,J,As2,As3; the shear plane indices map to Asz,Asy.
        # Assignment of I2/I3 to canonical local axes
        # is separately calibrated; comparing an unordered pair cannot certify it.
        raw_tokens = sp.get("raw", {}).get("P", "").split(",")
        props = entry["sectionBaseline"] if entry else section.get("properties") or {}
        section_actual = dict(zip(("A", "Iy", "Iz", "J", "Asz", "Asy"), sp["P"]))
        for index, key in enumerate(("A", "Iy", "Iz", "J")):
            if key not in props:
                failures.append({"member": identifier, "field": key, "reason": "missing-authored-property"})
            elif len(raw_tokens) <= index or not _rounding_match(props[key], raw_tokens[index]):
                failures.append({"member": identifier, "field": key, "expected": props[key], "actual": section_actual[key]})
        actual_rigidities = None
        axes_audit = None
        if entry:
            try:
                native_axes = executed_section_axes(frame, [fe["nodes"][key] for key in frame["nodes"]],
                                                     (native_members or {}).get(tag))
                desired_axes = entry["canonicalAxes"]
                axes_audit = {"authored": desired_axes, "native": native_axes,
                              "verified": all(abs(abs(dot(a, b)) - 1) <= 1e-9
                                              for a, b in zip(desired_axes, native_axes))}
                if not axes_audit["verified"]:
                    failures.append({"member": identifier, "field": "sectionAxes", **axes_audit})
            except (StationConventionUnavailable, KeyError, ValueError) as exc:
                failures.append({"member": identifier, "field": "sectionAxes", "reason": str(exc)})
            rf = frame.get("RF", [])
            rf_tokens = frame.get("raw", {}).get("RF", "").split(",")
            if len(rf) != 6 or len(rf_tokens) != 6 or any(
                    not _rounding_match(struct.unpack("f", struct.pack("f", value))[0], token)
                    for value, token in zip(entry["expectedRF"], rf_tokens)):
                failures.append({"member": identifier, "field": "RF", "expected": entry["expectedRF"], "actual": rf})
            elif len(sp["P"]) < 6:
                failures.append({"member": identifier, "field": "shearAreas", "reason": "missing-native-properties"})
            else:
                actual_rigidities = {
                    "EA": native["E"]*sp["P"][0]*rf[0], "EIy": native["E"]*sp["P"][1]*rf[1],
                    "EIz": native["E"]*sp["P"][2]*rf[2], "GJ": native["G"]*sp["P"][3]*rf[3],
                    "GAsy": native["G"]*sp["P"][5]*rf[5], "GAsz": native["G"]*sp["P"][4]*rf[4]}
                # These checks propagate native text precision, not a numerical
                # response tolerance. Individual material, section and RF checks
                # above independently forbid a wrong field compensating another.
                for key, value in entry["targetRigidities"].items():
                    if not math.isclose(actual_rigidities[key], value, rel_tol=1.1e-5, abs_tol=0):
                        failures.append({"member": identifier, "field": key, "expected": value, "actual": actual_rigidities[key]})
        elif frame.get("RF") != [1., 1., 1., 1., 1., 1.]:
            failures.append({"member": identifier, "field": "RF", "expected": [1.] * 6, "actual": frame.get("RF")})
        members[identifier] = {"nativeFrameId": tag, "materialId": str(element["material"]),
                               "sectionId": str(element["section"]), "authored": expected,
                               "nativeMaterial": native, "nativeSection": section_actual,
                               "materialRepresentation": entry.get("materialBaseline") if entry else None,
                               "sectionRepresentation": entry.get("sectionRepresentation") if entry else None,
                               "RF": frame.get("RF"), "sourceDensityKgM3": material["rho"],
                               "transferMethod": "native-six-component-rigidity" if entry else "direct-native-properties",
                               "densityUse": "load-audit-required; not inferred from zero FE material density",
                               "effectiveRigidities": actual_rigidities,
                               "sectionAxes": axes_audit,
                               "nativeColumnIdentity": column_identity,
                               "rigidityUnits": {"EA": "MPa.m2", "EIy": "MPa.m4", "EIz": "MPa.m4",
                                                 "GJ": "MPa.m4", "GAsy": "MPa.m2", "GAsz": "MPa.m2"}}
    if set(frames) != used:
        failures.append({"field": "frames", "reason": "extra-native-frames", "nativeIds": sorted(set(frames) - used)})
    return {"schema": "sclaw-yjk-frame-physics-audit/v1", "passed": bool(members) and not failures,
            "members": members, "failures": failures,
            "artifact": {"path": "fea.dat", "sha256": fe["sha256"]},
            "scope": "used-frame-elastic-material-and-section-properties"}


def physics_context(model: dict, fe: dict, material_audit: dict, settings_audit: dict,
                    *, engine_version: str, effective_settings_audit: dict | None = None) -> dict:
    """Identity for native result combinations, with incomplete evidence false.

    Scalar JSCS readback alone does not prove effective physics. A separate FE
    and load audit must certify constraints, stiffness and selected-case gravity.
    Station conventions are owned by the result adapter, not this module.
    """
    effective = effective_settings_audit or {}
    settings_ok = (settings_audit.get("passed") is True and effective.get("passed") is True
                   and effective.get("feaSha256") == fe.get("sha256"))
    materials_ok = (material_audit.get("passed") is True and
                    material_audit.get("artifact", {}).get("sha256") == fe.get("sha256"))
    return {"engine": "yjk", "engineVersion": engine_version, "physicalModelHash": _hash(model),
            "stiffnessHash": _hash({"materials": fe.get("materials"), "sections": fe.get("sections"),
                                    "frames": fe.get("frames"), "constraints": fe.get("sectionsRaw", {}).get("CONSTRAINT")}),
            "settingsHash": _hash({"settings": settings_audit.get("audit", {}).get("readback"),
                                  "effective": effective}),
            "linearStatic": settings_ok and effective.get("linearStatic") is True,
            "effectiveSettingsVerified": settings_ok and materials_ok,
            "materialsVerified": materials_ok, "stationConventionsVerified": False,
            "elasticRepresentations": {key: {
                "section": value.get("sectionRepresentation"),
                "material": value.get("materialRepresentation")}
                for key, value in material_audit.get("members", {}).items()},
            "sourceFeaSha256": fe["sha256"],
            "artifacts": [{"path": "fea.dat", "sha256": fe["sha256"]}],
            "verification": "verified" if settings_ok and materials_ok else "incomplete"}


def verify_native_physics(work_dir, model: dict, *, engine_version: str) -> dict:
    """One production audit entry, preserving diagnostics on every rejection.

    Return ``passed`` only after the executed loads, six elastic rigidities and
    effective settings agree. This does not certify station signs, which the
    independent results adapter adds after its own calibration.
    """
    from native_fe import parse_fe
    from native_load_audit import audit_loads
    from yjk_native_settings import audit_effective_settings
    root = Path(work_dir)
    output = {"schema": "sclaw-yjk-native-physics/v1", "passed": False, "failures": []}
    fe, material_audit, receipt, effective = None, {}, {}, {}
    try:
        fe = parse_fe(root / "fea.dat")
        plan = json.loads((root / "native-stiffness-plan.json").read_text(encoding="utf-8"))
        mapping = json.loads((root / "mapping.json").read_text(encoding="utf-8"))
        receipt = json.loads((root / "native-settings-readback.json").read_text(encoding="utf-8"))
        results = json.loads((root / "results.json").read_text(encoding="utf-8"))
        native_members = {str(row.get("tot_id", row.get("id"))): row
                          for rows in results.get("members", {}).values() for row in rows}
        material_audit = audit_frames(model, fe, plan, native_members)
        output["materials"] = material_audit
        try:
            loads = audit_loads(model, mapping, fe)
        except (ValueError, KeyError) as exc:
            loads = {"passed": False, "error": str(exc), "feaSha256": fe["sha256"]}
        output["loads"] = loads
        report_path = root / "设计结果" / "mainjss.out"
        report = report_path.read_text(encoding="gb18030")
        effective = audit_effective_settings(model, fe, receipt, report, loads, member_audit=material_audit)
        output["settings"] = effective
        output["passed"] = material_audit["passed"] is True and effective["passed"] is True and loads["passed"] is True
        if not output["passed"]:
            output["failures"] = material_audit["failures"] + effective["failures"]
    except (ValueError, KeyError, OSError, TypeError) as exc:
        output["failures"].append({"type": type(exc).__name__, "message": str(exc)})
    if fe is not None:
        output["context"] = physics_context(model, fe, material_audit, receipt,
            engine_version=engine_version, effective_settings_audit=effective)
    for name, value in (("native-physics-audit.json", output),
                        ("native-material-audit.json", material_audit),
                        ("native-effective-settings.json", effective),
                        ("native-physics-context.json", output.get("context", {}))):
        (root / name).write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
    return output
