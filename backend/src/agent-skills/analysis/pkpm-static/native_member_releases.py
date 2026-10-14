"""Official SpecialBeam support codes, preserving the two bending releases."""
from __future__ import annotations


def beam_release_plan(element, native_node_ids=None):
    value = element.get("releases") or {}
    if not isinstance(value, dict) or set(value) - {"i", "j", "releaseI", "releaseJ", "reference_frame"}:
        raise ValueError("Unsupported native release fields / 原生端释放字段不支持")
    if value.get("reference_frame", "element-local") != "element-local":
        raise ValueError("Native end releases require element-local axes / 原生端释放须使用构件局部轴")
    ends = []
    for end, alias in (("i", "releaseI"), ("j", "releaseJ")):
        if end in value and alias in value and value[end] != value[alias]:
            raise ValueError("Conflicting native end-release aliases / 原生端释放别名冲突")
        flags = value.get(end, value.get(alias, {}))
        if (not isinstance(flags, dict) or set(flags) - {"ux", "uy", "uz", "rx", "ry", "rz"}
                or any(type(flag) is not bool for flag in flags.values())):
            raise ValueError("Native end releases require explicit boolean DOFs / 原生端释放须为明确布尔自由度")
        active = {key for key, flag in flags.items() if flag}
        if active and (element.get("type") != "beam" or active != {"ry", "rz"}):
            raise ValueError("PKPM beam hinge releases both local bending rotations and retains torsion / PKPM梁铰释放局部两个弯曲转角并保留扭转")
        ends.append(bool(active))
    if native_node_ids is not None:
        physical = list(map(str, element["nodes"]))
        native = list(map(str, native_node_ids))
        if native == list(reversed(physical)):
            ends.reverse()
        elif native != physical:
            raise ValueError("Native release endpoints differ / 原生端释放端点不符")
    return {"nativeCode": 1 + int(ends[0]) + 2 * int(ends[1]), "hinges": [int(flag) for flag in ends],
            "releases": [flag and index in (4, 5) for flag in ends for index in range(6)],
            "source": "PKPM API 5.0 SpecialBeam.fData[4]"}


def write_beam_release(api, member, element, native_node_ids=None):
    plan = beam_release_plan(element, native_node_ids)
    if plan["nativeCode"] != 1:
        member.SetSpecial(api.SpecialBeam.IDSp_Constrain_Support, float(plan["nativeCode"]))
        if member.GetSpecial(api.SpecialBeam.IDSp_Constrain_Support) != plan["nativeCode"]:
            raise RuntimeError("Native beam release readback differs / 原生梁端释放回读不符")
    return plan


def reapply_member_releases(jws_path, model):
    """PMCAD canonicalizes beam direction; set official support codes afterwards."""
    import json
    import os
    import struct
    from pathlib import Path
    import APIPyInterface as api
    previous = Path.cwd()
    nodes = {str(row["id"]): tuple(float(row[a]) for a in ("x", "y", "z")) for row in model["nodes"]}
    def point_key(point):
        return tuple(struct.pack("<f", value) for value in point)
    by_point = {point_key(point): key for key, point in nodes.items()}
    if len(by_point) != len(nodes):
        raise ValueError("Ambiguous native node coordinates / 原生节点坐标有歧义")
    requested = {frozenset(map(str, row["nodes"])): row for row in model["elements"]
                 if row["type"] == "beam" and beam_release_plan(row)["nativeCode"] != 1}
    try:
        native = api.Model()
        if not native.OpenPMModel(str(jws_path)):
            raise RuntimeError("Cannot reopen native project for release mapping / 无法重开原生工程映射端释放")
        def visit(write):
            found = {}
            for index in range(1, int(native.GetNatualFloorCount()) + 1):
                real = native.GetFloorAssemTable(index)
                native.SetCurrentStandFloor(real.GetStandFloorIndex())
                floor = native.GetCurrentStandFloor()
                z = real.GetBottomElevation() + real.GetFloorHeight() / 1000
                for beam in floor.GetBeams():
                    line = floor.GetNet(int(beam.GetSeg()[0])).GetLine()
                    points = [floor.GetNode(int(tag)).Get() for tag in line]
                    ids = [by_point[point_key((point[0] / 1000, point[1] / 1000, z))] for point in points]
                    source = requested.get(frozenset(ids))
                    if source is None:
                        continue
                    plan = beam_release_plan(source, ids)
                    if write:
                        write_beam_release(api, beam, source, ids)
                    actual = beam.GetSpecial(api.SpecialBeam.IDSp_Constrain_Support)
                    if actual != plan["nativeCode"] or source["id"] in found:
                        raise RuntimeError("Native release code/coverage differs / 原生端释放代码或覆盖不符")
                    found[source["id"]] = {"nativeEndpointIds": ids, "supportCode": actual, "hinges": plan["hinges"]}
                if write:
                    native.SaveOneStandFloor(real.GetStandFloorIndex())
            if set(found) != {row["id"] for row in requested.values()}:
                raise RuntimeError("Native release coverage differs / 原生端释放构件覆盖不符")
            return found
        visit(True)
        native.SavePMModel()
        if not native.OpenPMModel(str(jws_path)):
            raise RuntimeError("Cannot verify saved native releases / 无法核对保存后的原生端释放")
        result = {"verified": True, "source": "official-SpecialBeam-after-PMCAD", "members": visit(False)}
        Path(jws_path).with_name("native-member-release-readback.json").write_text(json.dumps(result, indent=2), encoding="utf8")
        return result
    finally:
        os.chdir(previous)
