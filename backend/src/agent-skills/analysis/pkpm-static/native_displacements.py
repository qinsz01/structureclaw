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
    for line in files["WDISPGKNO.OUT"].decode("gb18030").splitlines():
        if not line.strip():
            continue
        fields = line.split()
        if len(fields) != 2 or not fields[0].upper().startswith("DISP") or not fields[0].upper().endswith(".SAT"):
            raise NativeDisplacementUnavailable("Unknown native displacement case index format")
        case_names.append(fields[1])
    if not case_names or len(set(case_names)) != len(case_names):
        raise NativeDisplacementUnavailable("Missing or duplicate native displacement case identities")
    indices = _floats(files["NODEINDEX.SAT"])
    if not indices or indices[0] != int(indices[0]) or indices[0] <= 0:
        raise NativeDisplacementUnavailable("Invalid native displacement node count")
    count = int(indices[0])
    if len(indices) != 1 + count * 2:
        raise NativeDisplacementUnavailable("Unknown native displacement node index layout")
    node_tags = []
    for tag, secondary in zip(indices[1::2], indices[2::2]):
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
    values = _floats(files["DISP.SAT"])
    if len(values) != 6 * count * len(case_names):
        raise NativeDisplacementUnavailable("Native displacement case/node coverage differs from index files")
    output = {}
    for case_index, case in enumerate(case_names):
        api_case = api_translations.get(case)
        if api_case is None or set(api_case) != set(identities):
            raise NativeDisplacementUnavailable(f"Case '{case}' SDK/file node coverage differs")
        rows = {}
        for index, identity in enumerate(identities):
            offset = 6 * (case_index * count + index)
            row = dict(zip(("ux", "uy", "rz", "rx", "ry", "uz"), values[offset:offset + 6]))
            for component in ("ux", "uy", "uz"):
                actual = api_case[identity].get(component)
                if (type(actual) not in (int, float) or not math.isfinite(actual)
                        or struct.pack("<f", actual) != struct.pack("<f", row[component])):
                    raise NativeDisplacementUnavailable(f"Case '{case}' SDK/file {component} disagrees at {identity}")
            rows[identity] = row
        output[case] = rows
    return {"caseDisplacements": output,
            "missingNodeRotations": sorted(all_node_keys - set(identities)),
            "source": {"kind": "solver-direct-file", "schema": "pkpm-2025r2.5-six-dof/v1",
                       "units": {"displacement": "m", "rotation": "rad"},
                       "nativeComponentOrder": ["ux", "uy", "rz", "rx", "ry", "uz"],
                       "translationCrossCheck": "float32-exact-public-api",
                       "artifacts": [{"path": name, "sha256": hashlib.sha256(data).hexdigest()} for name, data in files.items()]}}
