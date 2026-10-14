"""Calibrated SATWE six-DOF file readback, cross-checked against public XYZ API.

PKPM 2025 R2.5 stores DISP.SAT node vectors as ux,uy,rz,rx,ry,uz (m/rad).
Case ordering comes from WDISPGKNO.OUT; free node tags come from NODEINDEX.SAT.
MESH.SAT coordinates (m) bind those tags to NodeInResult coordinates (mm).
The independent four-cantilever fixture exercises every DOF with asymmetric
loads. Missing rows, formats or coverage are rejected; support rotations and
cases absent from the native displacement file are never filled with zero.
"""
from __future__ import annotations

import hashlib
import math
from pathlib import Path
import struct


class NativeDisplacementUnavailable(ValueError):
    pass


def _floats(data: bytes) -> tuple[float, ...]:
    if len(data) % 4:
        raise NativeDisplacementUnavailable("Truncated SATWE float32 record")
    values = struct.unpack("<" + "f" * (len(data) // 4), data)
    if not all(math.isfinite(v) for v in values):
        raise NativeDisplacementUnavailable("Non-finite SATWE result")
    return values


def _float_key(values):
    if len(values) != 3 or any(type(v) not in (int, float) or not math.isfinite(v) for v in values):
        raise NativeDisplacementUnavailable("Invalid native node coordinates")
    # Normalize signed zero while preserving the native float32 precision.
    return tuple(struct.pack("<f", 0. if v == 0 else v) for v in values)


def read_native_displacements(work_dir: str | Path, native_nodes: list[dict],
                              api_translations: dict[str, dict[tuple[int, int], dict]]) -> dict:
    root = Path(work_dir)
    names = ("DISP.SAT", "NODEINDEX.SAT", "MESH.SAT", "WDISPGKNO.OUT")
    try:
        files = {name: (root / name).read_bytes() for name in names}
    except OSError as exc:
        raise NativeDisplacementUnavailable("Native six-DOF displacement files are unavailable") from exc
    case_names = []
    case_files = {}
    for line in files["WDISPGKNO.OUT"].decode("gb18030").splitlines():
        if not line.strip():
            continue
        fields = line.split()
        if len(fields) != 2 or not fields[0].upper().startswith("DISP") or not fields[0].upper().endswith(".SAT"):
            raise NativeDisplacementUnavailable("Unknown native displacement case index format")
        case_names.append(fields[1])
        if fields[0].upper() not in ("DISP1.SAT", "DISP1_ZDY.SAT"):
            raise NativeDisplacementUnavailable("Uncalibrated native displacement file group")
        case_files.setdefault(fields[0].upper(), []).append(fields[1])
    if not case_names or len(set(case_names)) != len(case_names):
        raise NativeDisplacementUnavailable("Missing or duplicate native displacement case identities")
    from native_node_layout import read_node_layout
    physical = [{"identity": (int(row["pmid"]), int(row["floor"])), "floor": int(row["floor"]),
                 "coordinatesM": [float(v) / 1000 for v in row["coordinates"]]} for row in native_nodes]
    try:
        layout = read_node_layout(files["NODEINDEX.SAT"], files["MESH.SAT"], physical)
    except ValueError as exc:
        raise NativeDisplacementUnavailable(str(exc)) from exc
    mesh_nodes = layout["mesh"]
    floors = layout["floors"]
    all_node_keys = {row["identity"] for row in physical}
    node_by_coordinates = {_float_key(row["coordinatesM"]): row["identity"] for row in physical}
    ordered = [row for floor in reversed(floors) for row in layout["rows"] if row["floor"] == floor]
    identities = [row["identity"] for row in ordered if row["kind"] == "physical"]
    width = sum(row["width"] for row in ordered)
    native_cases = {}
    for name, group in case_files.items():
        vector_name = name.replace("DISP1", "DISP")
        if vector_name not in files:
            files[vector_name] = (root / vector_name).read_bytes()
        blob = files[vector_name]
        if vector_name == "DISP_ZDY.SAT":
            records = []
            while blob:
                if len(blob) < 8:
                    raise NativeDisplacementUnavailable("Truncated custom displacement record")
                size = struct.unpack_from("<i", blob)[0]
                if size <= 0 or len(blob) < size + 8 or struct.unpack_from("<i", blob, size + 4)[0] != size:
                    raise NativeDisplacementUnavailable("Invalid custom displacement record length")
                records.append(blob[4:size + 4]); blob = blob[size + 8:]
            if len(records) != len(group):
                raise NativeDisplacementUnavailable("Custom displacement case coverage differs")
        else:
            if len(blob) % len(group):
                raise NativeDisplacementUnavailable("Native displacement case coverage differs")
            size = len(blob) // len(group)
            records = [blob[index * size:(index + 1) * size] for index in range(len(group))]
        native_cases.update(zip(group, records))
    values = _floats(b"".join(native_cases[case] for case in case_names))
    constraint_identities = []
    if len(values) != width * len(case_names):
        try:
            constraint_bytes = (root / "ConstraintNodeNo.SAT").read_bytes()
        except OSError as exc:
            raise NativeDisplacementUnavailable("Native displacement case/node coverage differs from index files") from exc
        if len(constraint_bytes) < 16:
            raise NativeDisplacementUnavailable("Truncated native constraint node map")
        header = struct.unpack_from("<4i", constraint_bytes)
        if header[:2] != (3, 20200113) or header[2] != len(mesh_nodes) or header[3] != 4 or len(constraint_bytes) != 16 + 4 * len(mesh_nodes):
            raise NativeDisplacementUnavailable("Uncalibrated native constraint node map")
        constraints = struct.unpack_from("<" + "i" * len(mesh_nodes), constraint_bytes, 16)
        if any(value not in (0, 1) for value in constraints):
            raise NativeDisplacementUnavailable("Multiple constraints at one native node are not calibrated")
        for tag, value in enumerate(constraints, 1):
            if value:
                identity = node_by_coordinates.get(_float_key(mesh_nodes[tag][:3]))
                if identity is None:
                    raise NativeDisplacementUnavailable("Constraint node has no physical API identity")
                constraint_identities.append(identity)
        files["ConstraintNodeNo.SAT"] = constraint_bytes
    stride = width + 6 * len(constraint_identities)
    if len(values) != stride * len(case_names):
        raise NativeDisplacementUnavailable("Native displacement case/node coverage differs from index files")
    output = {}
    constraint_output = {}
    for case_index, case in enumerate(case_names):
        api_case = api_translations.get(case)
        if api_case is None or set(api_case) != set(identities) | set(constraint_identities):
            raise NativeDisplacementUnavailable(f"Case '{case}' SDK/file node coverage differs")
        rows, native_rows = {}, {}
        cursor = case_index * stride
        for node in ordered:
            raw = values[cursor:cursor + node["width"]]
            cursor += node["width"]
            names = (("ux", "uy", "rz") if node["kind"] == "diaphragm-master" else
                     ("rx", "ry", "uz") if node["master"] else ("ux", "uy", "rz", "rx", "ry", "uz"))
            native_rows[node["tag"]] = dict(zip(names, raw))
        for node in ordered:
            if node["kind"] != "physical":
                continue
            identity = node["identity"]
            row = native_rows[node["tag"]]
            if node["master"]:
                row.update(ux=api_case[identity].get("ux"), uy=api_case[identity].get("uy"),
                           rz=native_rows[node["master"]]["rz"])
            for component in ("ux", "uy", "uz"):
                actual = api_case[identity].get(component)
                if type(actual) not in (int, float) or not math.isfinite(actual):
                    raise NativeDisplacementUnavailable("Invalid SDK displacement component")
                # The condensed in-plane translations are official SDK values;
                # independent node differences below check the native MPC map.
                if node["master"] and component in ("ux", "uy"):
                    continue
                mm = struct.unpack("<f", struct.pack("<f", row[component] * 1000))[0]
                sdk_value = struct.unpack("<f", struct.pack("<f", mm / 1000))[0]
                if struct.pack("<f", actual) != struct.pack("<f", sdk_value):
                    raise NativeDisplacementUnavailable(f"Case '{case}' SDK/file {component} disagrees at {identity}")
            rows[identity] = row
        for group in layout["groups"]:
            members = [node for node in ordered if node["tag"] in group["physicalNodeTags"]]
            first = members[0]
            reference = rows[first["identity"]]
            for node in members[1:]:
                actual = rows[node["identity"]]
                dx, dy = [node["coordinatesM"][i] - first["coordinatesM"][i] for i in (0, 1)]
                for component, expected in (("ux", -reference["rz"] * dy), ("uy", reference["rz"] * dx)):
                    delta = actual[component] - reference[component]
                    bound = 8 * 2**-23 * max(abs(actual[component]), abs(reference[component]), abs(expected), 1e-20)
                    if abs(delta - expected) > bound:
                        raise NativeDisplacementUnavailable("SDK translations contradict native diaphragm kinematics / 原生主从节点运动不符")
        output[case] = rows
        constraint_output[case] = {identity: dict(zip(("ux", "uy", "rz", "rx", "ry", "uz"),
            values[case_index * stride + width + 6*index:case_index * stride + width + 6*(index+1)]))
            for index, identity in enumerate(constraint_identities)}
    return {"caseDisplacements": output,
            "constraintDisplacements": constraint_output,
            "missingNodeRotations": sorted(all_node_keys - set(identities)),
            "source": {"kind": "solver-native-file-and-api" if layout["groups"] else "solver-direct-file",
                       "diaphragmGroups": layout["groups"],
                       "condensedComponentOrder": {"slave": ["rx", "ry", "uz"], "master": ["ux", "uy", "rz"]} if layout["groups"] else None, "schema": "pkpm-2025r2.5-six-dof/v1",
                       "units": {"displacement": "m", "rotation": "rad"},
                       "nativeComponentOrder": ["ux", "uy", "rz", "rx", "ry", "uz"],
                       "translationCrossCheck": ("uz-exact-public-api; ux-uy-official-api-and-native-MPC-kinematics" if layout["groups"] else
                                                 "exact-float32-metres-to-mm-to-metres-public-api"),
                       "floorOrder": "top-down-DISP; bottom-up-NODEINDEX",
                       "artifacts": [{"path": name, "sha256": hashlib.sha256(data).hexdigest()} for name, data in files.items()]}}
