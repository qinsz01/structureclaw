"""Read native bare-frame topology and fixed-base evidence without editing JWS.

GetSeg positions are documented in PKPMAPI5.0 sections 3.5/3.6, in mm.
Solver endpoints come from WNL*.OUT and MESH.SAT, not GetSeg list order.
Fixed base DOFs use the independently calibrated SATWE 2025 R2.5 bare-frame
layout: ground nodes have no free six-DOF row, no MPC mapping, no member end
hinges, and zero translations in every complete DISP1.SAT case. Such zeros
are prescribed-boundary values, never presented as solver-read rotations.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
import re
import struct


class NativeGeometryUnavailable(ValueError):
    pass


def snapshot_native_geometry(jws_path, api=None):
    # OpenPMModel changes the process working directory in the native binding.
    # Keep this readback from affecting subsequent caller file operations.
    previous = Path.cwd()
    try:
        return _snapshot_native_geometry(Path(jws_path).resolve(), api)
    finally:
        os.chdir(previous)


def _snapshot_native_geometry(jws_path, api=None):
    if api is None:
        import APIPyInterface as api
    native = api.Model()
    if native.OpenPMModel(str(jws_path)) == 0:
        raise NativeGeometryUnavailable("Cannot open solved native model for geometry readback")
    floors = []
    for floor_index in range(1, int(native.GetNatualFloorCount()) + 1):
        real = native.GetFloorAssemTable(floor_index)
        standard = int(real.GetStandFloorIndex())
        native.SetCurrentStandFloor(standard)
        floor = native.GetCurrentStandFloor()
        nodes = {str(int(node.GetID())): list(node.Get()) for node in floor.GetNodes()}
        members = []
        for kind, objects, support_enum in (
            ("column", floor.GetColumns(), api.SpecialColumn.IDSp_Constrain_Support),
            ("beam", floor.GetBeams(), api.SpecialBeam.IDSp_Constrain_Support),
        ):
            for obj in objects:
                segment = list(obj.GetSeg())
                endpoints = [int(segment[0])] if kind == "column" else list(floor.GetNet(int(segment[0])).GetLine())
                members.append({"pmid": int(obj.GetID()), "kind": kind, "segment": segment,
                                "planNodeIds": endpoints, "supportCode": float(obj.GetSpecial(support_enum))})
        if floor.GetBraces() or floor.GetWalls():
            raise NativeGeometryUnavailable("Native frame contains uncalibrated brace/wall geometry")
        floors.append({"floor": floor_index, "standardFloor": standard,
                       # RealFloor exposes bottom elevation in m and height in
                       # mm. This API-specific contract is checked against the
                       # actual MESH.SAT endpoints, never inferred by magnitude.
                       "bottomM": float(real.GetBottomElevation()), "heightMm": float(real.GetFloorHeight()),
                       "nodes": nodes, "members": members})
    return {"schema": "pkpm-api-frame-geometry/v1", "floors": floors}


def _key(values):
    if len(values) != 3 or any(type(v) not in (int, float) or not math.isfinite(v) for v in values):
        raise NativeGeometryUnavailable("Invalid native coordinates")
    return tuple(struct.pack("<f", 0. if v == 0 else v) for v in values)


def _parse_member_controls(text):
    controls = {}
    floor, kind = None, None
    for line in text.splitlines():
        match = re.search(r"第\s*(\d+)\s*层构件信息", line)
        if match:
            floor, kind = int(match[1]), None
        if "梁编号" in line:
            kind = "beam"
        elif "柱编号" in line:
            kind = "column"
        elif any(title in line for title in ("支撑编号", "墙编号", "板编号")):
            kind = None
        elif floor is not None and kind and re.match(r"^\s*\d+\s", line):
            values = [float(value) for value in line.split()]
            expected = 13 if kind == "beam" else 14
            if len(values) != expected or any(not math.isfinite(value) for value in values):
                raise NativeGeometryUnavailable("Unknown GOUJIAN member control format")
            key = (floor, kind, int(values[0]))
            if key in controls:
                raise NativeGeometryUnavailable("Duplicate GOUJIAN member identity")
            controls[key] = {"angle": values[3], "hinges": values[6:8],
                             "rigidEnds": values[12:14] if kind == "column" else []}
    if not controls:
        raise NativeGeometryUnavailable("GOUJIAN member controls are missing")
    return controls


def _fortran_records(data):
    records, offset = [], 0
    while offset < len(data):
        if offset + 8 > len(data):
            raise NativeGeometryUnavailable("Truncated native displacement record")
        length = struct.unpack_from("<i", data, offset)[0]
        if length <= 0 or offset + length + 8 > len(data) or struct.unpack_from("<i", data, offset + 4 + length)[0] != length:
            raise NativeGeometryUnavailable("Uncalibrated native displacement record layout")
        records.append(data[offset + 4:offset + length + 4])
        offset += length + 8
    return records


def bind_native_geometry(model, snapshot, artifacts):
    """Pure binding of API geometry plus complete solver evidence to V2 IDs."""
    floors = snapshot.get("floors", [])
    if not floors or [row["floor"] for row in floors] != list(range(1, len(floors) + 1)):
        raise NativeGeometryUnavailable("Native natural floors are incomplete")
    nodes = {str(row["id"]): [row[axis] for axis in ("x", "y", "z")] for row in model["nodes"]}
    by_point = {_key(point): node_id for node_id, point in nodes.items()}
    if len(by_point) != len(nodes):
        raise NativeGeometryUnavailable("Physical nodes have ambiguous native coordinates")
    members = {}
    by_edge = {}
    for row in model["elements"]:
        ids = row.get("nodes", [])
        if row.get("type") not in {"beam", "column"} or len(ids) != 2 or any(str(key) not in nodes for key in ids):
            raise NativeGeometryUnavailable("Only complete physical beam/column topology is calibrated")
        key = (row["type"], frozenset(map(str, ids)))
        if key in by_edge:
            raise NativeGeometryUnavailable("Ambiguous duplicate physical member topology")
        by_edge[key] = str(row["id"])
        members[str(row["id"])] = {"type": row["type"], "nodeStart": str(ids[0]), "nodeEnd": str(ids[1])}
    mesh = artifacts["MESH.SAT"]
    if len(mesh) < 40 or (len(mesh) - 20) % 20:
        raise NativeGeometryUnavailable("Uncalibrated native mesh layout")
    mesh_nodes = {index + 1: struct.unpack_from("<3f2i", mesh, 20 + index * 20)
                  for index in range((len(mesh) - 20) // 20)}
    if len(mesh_nodes) != len(nodes) or {_key(row[:3]) for row in mesh_nodes.values()} != set(by_point):
        raise NativeGeometryUnavailable("Native mesh does not exactly cover the physical nodes")
    controls = _parse_member_controls(artifacts["GOUJIAN.OUT"].decode("gb18030"))
    evidence = {"kind": "native-api-and-solver-readback", "schema": "pkpm-2025r2.5-frame-geometry/v1",
                "artifacts": [{"path": name, "sha256": hashlib.sha256(value).hexdigest()} for name, value in artifacts.items()],
                "apiSnapshotSha256": hashlib.sha256(json.dumps(snapshot, sort_keys=True, separators=(",", ":")).encode()).hexdigest()}
    native_members = {}
    native_result_keys = {}
    for floor in floors:
        number, bottom, height = floor["floor"], floor["bottomM"], floor["heightMm"] / 1000
        if bottom < 0 or height <= 0:
            raise NativeGeometryUnavailable("Uncalibrated native floor elevations")
        wnl = artifacts[f"WNL{number}.OUT"].decode("gb18030")
        report_members = {}
        for match in re.finditer(r"N-([CB])\s*=\s*(\d+)\s*\(?Node-i\s*=\s*(\d+),\s*Node-j\s*=\s*(\d+)", wnl):
            kind = "column" if match[1] == "C" else "beam"
            i, j = int(match[3]), int(match[4])
            if i not in mesh_nodes or j not in mesh_nodes:
                raise NativeGeometryUnavailable("Native report endpoint outside mesh")
            ids = [by_point[_key(mesh_nodes[tag][:3])] for tag in (i, j)]
            edge = (kind, frozenset(ids))
            if edge in report_members:
                raise NativeGeometryUnavailable("Duplicate report member endpoints")
            report_members[edge] = (int(match[2]), ids)
        for native in floor["members"]:
            kind, segment = native["kind"], native["segment"]
            if len(segment) != 6 or any(not isinstance(v, (int, float)) or not math.isfinite(v) for v in segment):
                raise NativeGeometryUnavailable("Unknown GetSeg layout")
            if any(segment[2:]):
                raise NativeGeometryUnavailable("Native member offset/elevation/rotation is not calibrated")
            if native["supportCode"] not in (-1., 1.):
                raise NativeGeometryUnavailable("Native member release is not calibrated")
            plan = [floor["nodes"][str(tag)] for tag in native["planNodeIds"]]
            points = ([[plan[0][0] / 1000, plan[0][1] / 1000, bottom],
                       [plan[0][0] / 1000, plan[0][1] / 1000, bottom + height]] if kind == "column" else
                      [[point[0] / 1000, point[1] / 1000, bottom + height] for point in plan])
            try:
                ids = [by_point[_key(point)] for point in points]
                edge = (kind, frozenset(ids))
                member_id = by_edge[edge]
                report_id, report_ids = report_members[edge]
                control = controls[(number, kind, report_id)]
            except KeyError as exc:
                raise NativeGeometryUnavailable("API/report member has no exact physical endpoint binding") from exc
            if any(control["hinges"] + control["rigidEnds"]) or control["angle"] != 0:
                raise NativeGeometryUnavailable("Solver introduced member hinges/rigid ends/rotation")
            if member_id in native_members:
                raise NativeGeometryUnavailable("Repeated native mapping for physical member")
            result = {"kind": kind, "angleDegrees": 0., "offsetsM": [0.] * 6,
                      "releases": [False] * 12, "nativePmid": native["pmid"], "nativeFloor": number,
                      "nativeReportId": report_id, "nativeReportNodeIds": report_ids,
                      "geometrySource": {**evidence, "nativeFloor": number, "nativePmid": native["pmid"],
                                         "segment": segment, "supportCode": native["supportCode"], "solverControls": control}}
            if kind == "column":
                if report_ids != list(reversed(ids)):
                    raise NativeGeometryUnavailable("Uncalibrated native column report endpoint order")
                result.update(bottomNodeId=ids[0], topNodeId=ids[1], bottomCoordinates=points[0], topCoordinates=points[1])
            else:
                if report_ids != ids:
                    raise NativeGeometryUnavailable("Native beam API/report endpoint directions differ")
                result.update(startNodeId=ids[0], endNodeId=ids[1], startCoordinates=points[0], endCoordinates=points[1])
            native_members[member_id] = result
            native_result_keys[(int(native["pmid"]), number)] = member_id
        if len(report_members) != len(floor["members"]):
            raise NativeGeometryUnavailable("API/report native member coverage differs")
    if set(native_members) != set(members):
        raise NativeGeometryUnavailable("Native members do not cover the complete physical model")

    # No support vectors are inferred until the solved, unconstrained six-DOF
    # layout excludes exactly the requested fully fixed base nodes.
    index_bytes = artifacts["NODEINDEX.SAT"]
    if len(index_bytes) % 4:
        raise NativeGeometryUnavailable("Truncated native free-DOF index")
    indices = struct.unpack("<" + "f" * (len(index_bytes) // 4), index_bytes)
    counts = indices[:len(floors)]
    if any(value <= 0 or value != int(value) for value in counts) or len(indices) != len(floors) + 2 * sum(map(int, counts)):
        raise NativeGeometryUnavailable("Native floor/free-node counts do not agree")
    tags = indices[len(floors)::2]
    secondary = indices[len(floors) + 1::2]
    if any(tag != int(tag) or int(tag) not in mesh_nodes for tag in tags) or len(set(tags)) != len(tags) or any(secondary):
        raise NativeGeometryUnavailable("Uncalibrated native free-node constraint mapping")
    free = {by_point[_key(mesh_nodes[int(tag)][:3])] for tag in tags}
    constraint_bytes = artifacts["ConstraintNodeNo.SAT"]
    if len(constraint_bytes) != 16 + len(nodes) * 4:
        raise NativeGeometryUnavailable("Uncalibrated native MPC map layout")
    constraint = struct.unpack("<" + "i" * (len(constraint_bytes) // 4), constraint_bytes)
    if constraint[:4] != (3, 20200113, len(nodes), 4) or any(value not in (0, 1) for value in constraint[4:]):
        raise NativeGeometryUnavailable("Native MPC mapping is not an unconstrained bare frame")
    pinned_nodes = {by_point[_key(mesh_nodes[tag][:3])] for tag, value in enumerate(constraint[4:], 1) if value}
    if pinned_nodes:
        definition = artifacts.get("ConstraintNode.SAT", b"")
        stiffness = artifacts.get("ConstraintNodeSK.SAT", b"")
        if (len(definition) != 256 or struct.unpack_from("<4i", definition) != (3, 20200113, 2, 120)
                or struct.unpack_from("<6d", definition, 88) != (1e14, 1e14, 1e14, 0., 0., 0.)
                or len(stiffness) != 208 or struct.unpack_from("<4i", stiffness) != (3, 20200113, 2, 96)
                or struct.unpack_from("<12d", stiffness, 16) != (1e14, 0., 1e14, 0., 0., 1e14, 0., 0., 0., 0., 0., 0.)):
            raise NativeGeometryUnavailable("Native base rotations are not exactly free / 原生柱脚转动并未完全释放")
    expected_fixed = {node_id for node_id, point in nodes.items() if point[2] == 0}
    if set(nodes) - free != expected_fixed:
        raise NativeGeometryUnavailable("Native constrained nodes differ from physical base nodes")
    physical_nodes = {str(row["id"]): row for row in model["nodes"]}
    for node_id in nodes:
        expected = [True] * 3 + [False] * 3 if node_id in pinned_nodes else [node_id in expected_fixed] * 6
        if physical_nodes[node_id].get("restraints", [False] * 6) != expected:
            raise NativeGeometryUnavailable("Native fixed-base scope does not preserve requested restraints")
    case_rows = [line.split() for line in artifacts["WDISPGKNO.OUT"].decode("gb18030").splitlines() if line.strip()]
    if any(len(row) != 2 or row[0] not in ("DISP1.SAT", "DISP1_ZDY.SAT") for row in case_rows):
        raise NativeGeometryUnavailable("Native full-node displacement index is uncalibrated")
    case_names = [row[1] for row in case_rows]
    records = []
    for name in dict.fromkeys(row[0] for row in case_rows):
        group = _fortran_records(artifacts[name])
        if len(group) != sum(row[0] == name for row in case_rows) * (len(floors) + 1):
            raise NativeGeometryUnavailable("Native displacement file group coverage differs")
        records.extend(group)
    if not case_names or len(set(case_names)) != len(case_names) or len(records) != len(case_names) * (len(floors) + 1):
        raise NativeGeometryUnavailable("Native full-node displacement cases are incomplete")
    fixed_tags = [tag for tag, row in mesh_nodes.items() if by_point[_key(row[:3])] in expected_fixed]
    for case_index in range(len(case_names)):
        group = records[case_index * (len(floors) + 1):(case_index + 1) * (len(floors) + 1)]
        if any(len(header) != 64 for header in group[:-1]) or len(group[-1]) != len(nodes) * 12:
            raise NativeGeometryUnavailable("Native full-node displacement coverage differs")
        for tag in fixed_tags:
            displacements_mm = struct.unpack_from("<3f", group[-1], (tag - 1) * 12)
            node_id = by_point[_key(mesh_nodes[tag][:3])]
            if (node_id in pinned_nodes and any(abs(value / 1000) > 1e-11 for value in displacements_mm)
                    or node_id not in pinned_nodes and any(displacements_mm)):
                raise NativeGeometryUnavailable("Native fixed base has nonzero translation")
    support_source = {**evidence, "kind": "calibrated-native-fixed-base", "nativeCases": case_names,
                      "schema": "pkpm-2025r2.5-fixed-base-dofs/v1", "rotationSource": "prescribed-boundary"}
    supports = {node_id: {"restraints": [True] * 6, "nativeRestraints": [True] * 6, "source": support_source}
                for node_id in expected_fixed}
    if pinned_nodes - expected_fixed:
        raise NativeGeometryUnavailable("Native pin is not at a physical base node")
    for node_id in pinned_nodes:
        supports[node_id] = {"restraints": [True] * 3 + [False] * 3, "nativeRestraints": [True] * 3 + [False] * 3,
            "source": {**support_source, "kind": "calibrated-native-free-base-rotations",
                       "rotationSource": "solver-direct-constraint-dofs", "translationPenaltyKNPerM": 1e14,
                       "rotationStiffnessKNmPerRad": [0., 0., 0.], "translationToleranceM": 1e-11}}
    return {"nodes": nodes, "members": members, "native_members": native_members, "supports": supports,
            "native_result_keys": native_result_keys, "source": evidence}


def read_native_geometry(jws_path, model, api=None):
    jws_path = Path(jws_path)
    snapshot = snapshot_native_geometry(jws_path, api)
    names = ["MESH.SAT", "GOUJIAN.OUT", "NODEINDEX.SAT", "ConstraintNodeNo.SAT", "DISP1.SAT", "WDISPGKNO.OUT"]
    names.extend(f"WNL{floor['floor']}.OUT" for floor in snapshot["floors"])
    artifacts = {name: (jws_path.parent / name).read_bytes() for name in names}
    for name in ("ConstraintNode.SAT", "ConstraintNodeSK.SAT"):
        path = jws_path.parent / name
        if path.exists():
            artifacts[name] = path.read_bytes()
    for row in artifacts["WDISPGKNO.OUT"].decode("gb18030").splitlines():
        if row.split() and row.split()[0] == "DISP1_ZDY.SAT":
            artifacts["DISP1_ZDY.SAT"] = (jws_path.parent / "DISP1_ZDY.SAT").read_bytes()
    artifacts[jws_path.name] = jws_path.read_bytes()
    return bind_native_geometry(model, snapshot, artifacts)
