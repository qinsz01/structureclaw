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
    indices = _floats(files["NODEINDEX.SAT"])
    floors = sorted({int(node["floor"]) for node in native_nodes if int(node["floor"]) > 0})
    floor_counts = [sum(int(node["floor"]) == floor for node in native_nodes) for floor in floors]
    if floors != list(range(1, len(floors) + 1)) or list(indices[:len(floors)]) != floor_counts:
        raise NativeDisplacementUnavailable("Invalid native displacement node count")
    count = sum(floor_counts)
    if not count or len(indices) != len(floors) + count * 2:
        raise NativeDisplacementUnavailable("Unknown native displacement node index layout")
    node_tags = []
    for tag, secondary in zip(indices[len(floors)::2], indices[len(floors) + 1::2]):
        if tag != int(tag) or tag <= 0 or secondary != 0:
            raise NativeDisplacementUnavailable("Uncalibrated native node index or constraint mapping")
        node_tags.append(int(tag))
    if len(set(node_tags)) != count:
        raise NativeDisplacementUnavailable("Duplicate native displacement node tag")
    mesh = files["MESH.SAT"]
    if len(mesh) < 40 or (len(mesh) - 20) % 20:
        raise NativeDisplacementUnavailable("Unknown native mesh-node record layout")
    mesh_nodes = {}
    for index in range((len(mesh) - 20) // 20):
        mesh_nodes[index + 1] = list(struct.unpack_from("<3f", mesh, 20 + index * 20))
    node_by_coordinates = {}
    all_node_keys = set()
    for node in native_nodes:
        node_key = (int(node["pmid"]), int(node["floor"]))
        coordinates = _float_key([float(v) / 1000 for v in node["coordinates"]])
        if coordinates in node_by_coordinates or node_key in all_node_keys:
            raise NativeDisplacementUnavailable("Ambiguous native node identity/coordinates")
        node_by_coordinates[coordinates] = node_key
        all_node_keys.add(node_key)
    identities = []
    for tag in node_tags:
        if tag not in mesh_nodes:
            raise NativeDisplacementUnavailable("Displacement node tag is outside native mesh")
        coordinates = _float_key(mesh_nodes[tag])
        if coordinates not in node_by_coordinates:
            raise NativeDisplacementUnavailable("Native mesh node is not bound to the public result API")
        identities.append(node_by_coordinates[coordinates])
    # NODEINDEX lists floors bottom-up; DISP stores each case top-down.
    # Native API identities provide the floor partition, never response values.
    by_floor = {floor: [identity for identity in identities if identity[1] == floor] for floor in floors}
    if [len(by_floor[floor]) for floor in floors] != floor_counts:
        raise NativeDisplacementUnavailable("Native mesh floor partition differs from node index")
    if identities != [identity for floor in floors for identity in by_floor[floor]]:
        raise NativeDisplacementUnavailable("Unknown native node index floor order")
    identities = [identity for floor in reversed(floors) for identity in by_floor[floor]]
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
    if len(values) != 6 * count * len(case_names):
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
                identity = node_by_coordinates.get(_float_key(mesh_nodes[tag]))
                if identity is None:
                    raise NativeDisplacementUnavailable("Constraint node has no physical API identity")
                constraint_identities.append(identity)
        files["ConstraintNodeNo.SAT"] = constraint_bytes
    stride = count + len(constraint_identities)
    if len(values) != 6 * stride * len(case_names):
        raise NativeDisplacementUnavailable("Native displacement case/node coverage differs from index files")
    output = {}
    constraint_output = {}
    for case_index, case in enumerate(case_names):
        api_case = api_translations.get(case)
        if api_case is None or set(api_case) != set(identities) | set(constraint_identities):
            raise NativeDisplacementUnavailable(f"Case '{case}' SDK/file node coverage differs")
        rows = {}
        for index, identity in enumerate(identities):
            offset = 6 * (case_index * stride + index)
            row = dict(zip(("ux", "uy", "rz", "rx", "ry", "uz"), values[offset:offset + 6]))
            for component in ("ux", "uy", "uz"):
                actual = api_case[identity].get(component)
                # ResultData reads displacement display files in float32 mm,
                # then returns float32 metres. Compare that exact transport.
                mm = struct.unpack("<f", struct.pack("<f", row[component] * 1000))[0]
                sdk_value = struct.unpack("<f", struct.pack("<f", mm / 1000))[0]
                if (type(actual) not in (int, float) or not math.isfinite(actual)
                        or struct.pack("<f", actual) != struct.pack("<f", sdk_value)):
                    raise NativeDisplacementUnavailable(f"Case '{case}' SDK/file {component} disagrees at {identity}")
            rows[identity] = row
        output[case] = rows
        constraint_output[case] = {identity: dict(zip(("ux", "uy", "rz", "rx", "ry", "uz"),
            values[6 * (case_index * stride + count + index):6 * (case_index * stride + count + index + 1)]))
            for index, identity in enumerate(constraint_identities)}
    return {"caseDisplacements": output,
            "constraintDisplacements": constraint_output,
            "missingNodeRotations": sorted(all_node_keys - set(identities)),
            "source": {"kind": "solver-direct-file", "schema": "pkpm-2025r2.5-six-dof/v1",
                       "units": {"displacement": "m", "rotation": "rad"},
                       "nativeComponentOrder": ["ux", "uy", "rz", "rx", "ry", "uz"],
                       "translationCrossCheck": "exact-float32-metres-to-mm-to-metres-public-api",
                       "floorOrder": "top-down-DISP; bottom-up-NODEINDEX",
                       "artifacts": [{"path": name, "sha256": hashlib.sha256(data).hexdigest()} for name, data in files.items()]}}
