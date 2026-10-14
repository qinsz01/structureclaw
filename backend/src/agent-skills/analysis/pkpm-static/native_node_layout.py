"""Bind SATWE physical and forced-diaphragm nodes without coordinate guessing."""
from __future__ import annotations

import math
import struct


def point_key(point):
    return tuple(struct.pack("<f", 0. if value == 0 else value) for value in point)


def read_node_layout(index_bytes, mesh_bytes, physical_nodes):
    """physical_nodes contain explicit coordinatesM, floor and caller identity."""
    if len(index_bytes) % 4 or len(mesh_bytes) < 40 or (len(mesh_bytes) - 20) % 20:
        raise ValueError("Uncalibrated native node layout / 未验收的原生节点布局")
    indices = struct.unpack("<" + "f" * (len(index_bytes) // 4), index_bytes)
    mesh = {i + 1: struct.unpack_from("<3f2i", mesh_bytes, 20 + i * 20) for i in range((len(mesh_bytes) - 20) // 20)}
    if any(not all(math.isfinite(v) for v in row[:3]) for row in mesh.values()):
        raise ValueError("Nonfinite native coordinates / 原生坐标非有限数值")
    by_point = {point_key(row["coordinatesM"]): row for row in physical_nodes}
    if len(by_point) != len(physical_nodes):
        raise ValueError("Ambiguous physical coordinates / 物理节点坐标有歧义")
    floors = sorted({row["floor"] for row in physical_nodes if row["floor"] > 0})
    if floors != list(range(1, len(floors) + 1)) or len(indices) < len(floors):
        raise ValueError("Invalid native displacement node count / 原生节点楼层不完整")
    counts = indices[:len(floors)]
    if any(not math.isfinite(v) or v <= 0 or v != int(v) for v in counts) or len(indices) != len(floors) + 2 * sum(map(int, counts)):
        raise ValueError("Invalid native displacement node count / 原生节点计数不符")
    rows, groups, seen = [], [], set()
    offset = len(floors)
    for floor, count in zip(floors, map(int, counts)):
        pairs = list(zip(indices[offset:offset + 2*count:2], indices[offset+1:offset+2*count:2]))
        offset += 2*count
        if any(not math.isfinite(v) or v != int(v) or v < 0 for pair in pairs for v in pair):
            raise ValueError("Native node/master identifiers must be exact / 原生主从节点编号无效")
        pairs = [(int(tag), int(master)) for tag, master in pairs]
        masters = {master for _, master in pairs if master}
        if len(masters) > 1 or len({tag for tag, _ in pairs}) != count or any(tag not in mesh or tag in seen for tag, _ in pairs):
            raise ValueError("Uncalibrated native floor/master grouping / 未验收的楼层主从分组")
        seen.update(tag for tag, _ in pairs)
        expected = {row["identity"] for row in physical_nodes if row["floor"] == floor}
        actual = set()
        floor_rows = []
        for tag, master in pairs:
            if tag in masters:
                if master or mesh[tag][3:] != (100, 0):
                    raise ValueError("Native diaphragm master type differs / 原生楼板主节点类型不符")
                item = {"tag": tag, "floor": floor, "master": 0, "kind": "diaphragm-master", "width": 3}
            else:
                physical = by_point.get(point_key(mesh[tag][:3]))
                expected_flag = 101 if masters else 0
                # Ordinary bare-frame mesh flags are zero; forced-rigid nodes
                # carry 101 (master 100), independently of floor number.
                # Neither flag alone certifies a constraint.
                if physical is None or physical["floor"] != floor or master not in (masters or {0}):
                    raise ValueError("Native node is not bound to the physical floor / 原生节点无法绑定物理楼层")
                if masters and mesh[tag][3:] != (expected_flag, 0):
                    raise ValueError("Unverified native constraint mapping: slave type differs / 原生楼板从节点类型不符")
                actual.add(physical["identity"])
                item = {"tag": tag, "floor": floor, "master": master, "kind": "physical", "width": 3 if master else 6,
                        "identity": physical["identity"], "coordinatesM": list(mesh[tag][:3])}
            floor_rows.append(item)
        if actual != expected or count != len(expected) + len(masters) or not masters.issubset({tag for tag, _ in pairs}):
            raise ValueError("Invalid native displacement node count or coverage / 原生节点覆盖不完整")
        if masters:
            groups.append({"floor": floor, "masterTag": next(iter(masters)),
                           "physicalNodeTags": [row["tag"] for row in floor_rows if row["kind"] == "physical"]})
        rows.extend(floor_rows)
    all_master_tags = {row["tag"] for row in rows if row["kind"] == "diaphragm-master"}
    physical_mesh = {tag: row for tag, row in mesh.items() if tag not in all_master_tags}
    if (len(physical_mesh) != len(physical_nodes) or
            {point_key(row[:3]) for row in physical_mesh.values()} != set(by_point)):
        raise ValueError("Native mesh has unexpected nonphysical nodes / 原生网格包含未声明节点")
    return {"rows": rows, "groups": groups, "mesh": mesh, "physicalMesh": physical_mesh,
            "physicalByPoint": by_point, "floors": floors, "counts": list(map(int, counts))}
