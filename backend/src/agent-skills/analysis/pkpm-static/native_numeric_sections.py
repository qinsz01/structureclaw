"""Compile numeric V2 sections into audited SATWE elastic member properties.

The SDK's 500 mm square is only a topology carrier. It never replaces the
source section or supplies design geometry. Compilation occurs between native
preprocessing and solving; saved source, before/after input and solver readback
remain available. Self-weight, rigid zones and geometric nonlinearity are off.
"""
from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path
import struct

from native_column_axes import column_axis_plan
from native_model_contract import pkpm_numeric_section_properties


def _point(values):
    return tuple(struct.pack("<f", 0. if value == 0 else value) for value in values)


def _model_hash(model):
    return hashlib.sha256(json.dumps(model, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def has_numeric_sections(model):
    used = {str(member["section"]) for member in model.get("elements", [])}
    return any(str(section["id"]) in used and pkpm_numeric_section_properties(section) is not None
               for section in model.get("sections", []))


def _members(payload, model):
    """Read the calibrated 60-real bare-frame record via its floor pointers."""
    if len(payload) % 4 or len(payload) < 16000:
        raise ValueError("Truncated native frame data / 原生杆系输入不完整")
    data = struct.unpack("<" + "f" * (len(payload) // 4), payload)

    def integer(value):
        if not math.isfinite(value) or value != round(value) or value < 0:
            raise ValueError("Invalid native frame record pointer / 原生杆系记录索引无效")
        return int(value)

    count = integer(data[2])
    if not 1 <= count <= 200 or count != len(model["stories"]):
        raise ValueError("Native floor count differs / 原生楼层数量不符")
    nodes = {str(row["id"]): [float(row[axis]) for axis in ("x", "y", "z")] for row in model["nodes"]}
    by_edge = {}
    for member in model["elements"]:
        key = (member["type"], frozenset(_point(nodes[str(node)]) for node in member["nodes"]))
        if key in by_edge:
            raise ValueError("Ambiguous physical member geometry / 物理构件几何不唯一")
        by_edge[key] = member
    found = {}
    for floor in range(count):
        start = integer(data[100 + floor])
        header = data[start:start + 20]
        if len(header) != 20 or any(header[index] for index in (14, 15, 16)):
            raise ValueError("Unsupported native floor record / 未验收的原生楼层记录")
        for kind, pointer, total in (("beam", 2, 12), ("column", 3, 13)):
            base, number = integer(header[pointer]), integer(header[total])
            for ordinal in range(number):
                offset = base + ordinal * 60
                row = data[offset:offset + 60]
                if len(row) != 60 or row[34] != 1. or not all(math.isfinite(value) for value in row):
                    raise ValueError("Unverified native elastic carrier record / 未验收的原生弹性载体记录")
                key = (kind, frozenset((_point(row[6:9]), _point(row[9:12]))))
                member = by_edge.get(key)
                if member is None or str(member["id"]) in found:
                    raise ValueError("Native member has no unique source binding / 原生构件无法唯一绑定源对象")
                found[str(member["id"])] = {"member": member, "offset": offset * 4,
                    "row": row, "floor": floor + 1, "ordinal": ordinal + 1}
    if set(found) != {str(row["id"]) for row in model["elements"]}:
        raise ValueError("Native/source member coverage differs / 原生与源构件覆盖不一致")
    return found


def _expected(model, member, properties):
    swap = member["type"] == "column" and column_axis_plan(model, member)["swapBH"]
    # Native zero-angle column width/depth axes differ from canonical vertical
    # member axes; the established physical column map decides this permutation.
    return [properties["A"], properties["J"], properties["Iz" if swap else "Iy"],
            properties["Iy" if swap else "Iz"]]


def compile_numeric_sections(work_dir, model):
    controls = model.get("analysis_control", {})
    if any(controls.get(key) is not False for key in ("self_weight", "rigid_floor", "rigid_offsets", "p_delta", "construction_stage")):
        raise ValueError("Numeric native sections require explicit bare-frame settings / 数值截面需要明确的线弹性裸杆设置")
    path = Path(work_dir) / "SDATA.SAT"
    before = path.read_bytes()
    after = bytearray(before)
    sections = {str(row["id"]): row for row in model["sections"]}
    edits = {}
    for identity, item in _members(before, model).items():
        member, row = item["member"], item["row"]
        properties = pkpm_numeric_section_properties(sections[str(member["section"])])
        if properties is None:
            continue
        # The generated carrier is checked before overwriting its mechanical
        # properties. No scan-by-number substitution or guessed element order.
        expected_carrier = [.25, .008802083333333334, .005208333333333333, .005208333333333333]
        if (row[35:37] != (.5, .5) or any(not math.isclose(value, expected, rel_tol=5e-7)
                for value, expected in zip(row[30:34], expected_carrier))):
            raise ValueError("Native numeric-section carrier differs / 原生数值截面载体不符")
        values = _expected(model, member, properties)
        struct.pack_into("<4f", after, item["offset"] + 120, *values)
        edits[identity] = {"sourceSectionId": str(member["section"]), "properties": properties,
            "nativeValuesAJIyIz": list(struct.unpack("<4f", struct.pack("<4f", *values))),
            "nativeFloor": item["floor"], "nativeOrdinal": item["ordinal"], "byteOffset": item["offset"] + 120,
            "source": "source-numeric-section; compiled-native-elastic-member-record"}
    if not edits:
        raise ValueError("No numeric section compilation requested / 未请求数值截面编译")
    path.with_suffix(".SAT.precompile").write_bytes(before)
    path.with_suffix(".SAT.compiled").write_bytes(after)
    path.write_bytes(after)
    evidence = {"kind": "numeric-section-native-compilation", "path": path.name,
        "physicalModelHash": _model_hash(model),
        "beforeSha256": hashlib.sha256(before).hexdigest(), "afterSha256": hashlib.sha256(after).hexdigest(),
        "carrier": {"kind": "internal-reference-only", "dimensionsMm": [500., 500.], "codeDesignGeometry": False},
        "units": {"A": "m2", "Asy": "m2", "Asz": "m2", "Iy": "m4", "Iz": "m4", "J": "m4"},
        "members": edits}
    (Path(work_dir) / "native-section-compilation.json").write_text(json.dumps(evidence, indent=2), encoding="utf-8")
    return evidence


def verify_numeric_sections(work_dir, model):
    evidence = json.loads((Path(work_dir) / "native-section-compilation.json").read_text(encoding="utf-8"))
    if evidence.get("physicalModelHash") != _model_hash(model):
        raise ValueError("Numeric section receipt belongs to another model / 数值截面记录不属于当前模型")
    input_bytes = (Path(work_dir) / "SDATA.SAT.compiled").read_bytes()
    if hashlib.sha256(input_bytes).hexdigest() != evidence["afterSha256"]:
        raise ValueError("Compiled native section input changed / 已编译原生截面输入被改变")
    output_path = Path(work_dir) / "DATA.SAT"
    sections = {str(row["id"]): row for row in model["sections"]}
    source_members = {str(row["id"]): row for row in model["elements"]
                      if pkpm_numeric_section_properties(sections[str(row["section"])]) is not None}
    if set(evidence["members"]) != set(source_members):
        raise ValueError("Native numeric section coverage differs / 原生数值截面覆盖不符")
    # Native stages legitimately rewrite unrelated SDATA fields. Verify the
    # archived exact input and all actually solved member properties, including
    # the post-solve SDATA copy, instead of treating mutable output as input.
    for payload in (input_bytes, output_path.read_bytes(), (Path(work_dir) / "SDATA.SAT").read_bytes()):
        actual = _members(payload, model)
        for identity, member in source_members.items():
            props = pkpm_numeric_section_properties(sections[str(member["section"])])
            expected = list(struct.unpack("<4f", struct.pack("<4f", *_expected(model, member, props))))
            if (list(actual[identity]["row"][30:34]) != expected
                    or evidence["members"][identity]["nativeValuesAJIyIz"] != expected
                    or evidence["members"][identity]["sourceSectionId"] != str(member["section"])
                    or evidence["members"][identity]["properties"] != props):
                raise ValueError("Solved native section properties differ / 已求解原生截面属性不符")
    return {**evidence, "verified": True, "solverDataSha256": hashlib.sha256(output_path.read_bytes()).hexdigest(),
            "solverData": output_path.name}
