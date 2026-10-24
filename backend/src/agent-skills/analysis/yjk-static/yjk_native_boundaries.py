"""Authored local bending releases mapped to official YJK SpBeam properties.

Vendor Python example 5 documents slots 0/1 as left/right hinges. Native FE
readback calibrates R=[Ry_i,Ry_j,Rz_i,Rz_j,Rx_i,Rx_j] in percent. A hinge sets
both bending rotations to 100 and retains the torsional connection at zero.
"""
from __future__ import annotations
import re


DOFS = ("ux", "uy", "uz", "rx", "ry", "rz")


class BoundaryCapabilityError(ValueError):
    error_code = "ENGINE_INPUT_UNSUPPORTED"


def node_restraints(node: dict) -> list[bool]:
    values = node.get("restraints")
    if values is None:
        values = [False] * 6
    if not isinstance(values, list) or len(values) != 6 or any(type(value) is not bool for value in values):
        raise BoundaryCapabilityError("Node restraints require six explicit booleans / 节点约束须为六个明确布尔值")
    return list(values)


def compile_supports(model: dict) -> dict:
    """SpNode on a first-floor vertical column's plan joint controls its base."""
    from native_story_geometry import exact_mm
    nodes = {str(row['id']): row for row in model.get('nodes', [])}
    plans = {}
    for identifier, node in nodes.items():
        restraints = node_restraints(node)
        if exact_mm(node['z'], 'Support elevation') != 0:
            if any(restraints):
                raise BoundaryCapabilityError('Elevated ground supports require a dedicated native support mapping / 高处对地支座须使用专用原生映射')
            continue
        if not any(restraints):
            raise BoundaryCapabilityError('An unrestrained building base needs native automatic-support suppression / 完全自由的底部节点尚需关闭原生自动支座')
        if all(restraints):
            plans[identifier] = {'restraints': restraints, 'method': 'native-fixed-foundation'}
            continue
        attached = [row for row in model.get('elements', []) if identifier in map(str, row['nodes'])]
        if len(attached) != 1 or attached[0].get('type') != 'column':
            raise BoundaryCapabilityError('Partial base restraints require one native column connection / 部分底部约束要求唯一原生柱连接')
        member = attached[0]
        other = next(str(tag) for tag in member['nodes'] if str(tag) != identifier)
        if any(exact_mm(node[axis], 'Base coordinate') != exact_mm(nodes[other][axis], 'Column coordinate') for axis in ('x', 'y')):
            raise BoundaryCapabilityError('Inclined-column partial supports need their own native joint mapping / 斜柱部分支座尚需独立原生节点映射')
        plans[identifier] = {'restraints': restraints, 'method': 'SpNode-global-single-point',
                             'nativePlanNodeSourceId': other, 'columnId': str(member['id'])}
    return plans


def write_supports(data_func, model: dict, native_nodes: dict) -> dict:
    from YJKAPI import Property
    plans = compile_supports(model)
    for row in plans.values():
        if row['method'] == 'native-fixed-foundation':
            continue
        prop = Property('SpNode')
        for index, value in enumerate(row['restraints']):
            prop.setVal(9 + index, int(value))
        result = data_func.property_arrange(native_nodes[row['nativePlanNodeSourceId']].ID,
                                            'SpNode', 27, prop.GetValString())
        if result is None or [float(value) for value in result.ShapeVal.split(',')[9:15]] != list(map(int, row['restraints'])):
            raise RuntimeError('Native SpNode support write differs / 原生 SpNode 支座写入不一致')
    return plans


def audit_node_restraints(model: dict, fe: dict) -> dict:
    """Bind every authored support DOF to the executed global FE constraint.

    Constraint tags refer to FE nodes, not SDK plan-joint IDs. The latter can
    represent an upper joint while its SpNode property constrains the base.
    No spring, local-axis or undocumented constraint type is accepted here.
    """
    from native_story_geometry import exact_mm
    failures, constraints, evidence = [], {}, {}
    if fe.get("unit") != [0, 0, 0]:
        raise ValueError("YJK restraint audit requires native metre units / 支座核对要求原生米单位")
    endpoint_ids = {str(tag) for frame in fe.get("frames", {}).values() for tag in frame.get("nodes", [])}
    coordinates = {}
    for tag in endpoint_ids:
        position = fe.get("nodes", {}).get(tag)
        if not isinstance(position, list) or len(position) != 3:
            raise ValueError("Native support node coordinates are missing / 原生支座节点坐标缺失")
        key = tuple(exact_mm(value, "Native support coordinate") for value in position)
        coordinates.setdefault(key, []).append(tag)
    for line in fe.get("sectionsRaw", {}).get("CONSTRAINT", []):
        tag = line.split()[0]
        fields = dict(re.findall(r"(?:^|\s)(\w+)=([^\s]+)", line))
        if tag in constraints:
            failures.append({"nativeNodeId": tag, "reason": "duplicate-native-constraint"})
            continue
        try:
            values = [float(value) for value in fields["R"].split(",")]
        except (KeyError, ValueError) as exc:
            raise ValueError("Native six-DOF constraint is malformed / 原生六自由度约束无效") from exc
        if fields.get("T") != "1" or fields.get("G") != "0" or len(values) != 6 or any(value not in (0., 1.) for value in values):
            failures.append({"nativeNodeId": tag, "reason": "unmapped-native-constraint", "fields": fields})
        constraints[tag] = values
    matched = set()
    for node in model.get("nodes", []):
        source_id = str(node["id"])
        expected = node_restraints(node)
        key = tuple(exact_mm(node.get(axis), "Source support coordinate") for axis in ("x", "y", "z"))
        tags = coordinates.get(key, [])
        if len(tags) != 1 or tags[0] in matched:
            failures.append({"sourceNodeId": source_id, "reason": "source-node-not-uniquely-mapped"})
            continue
        tag = tags[0]
        matched.add(tag)
        actual = constraints.get(tag, [0.] * 6)
        if actual != list(map(int, expected)):
            failures.append({"sourceNodeId": source_id, "nativeNodeId": tag, "reason": "restraint-mismatch",
                             "expected": list(map(int, expected)), "actual": actual})
        evidence[source_id] = {"nativeNodeId": tag, "positionM": fe["nodes"][tag],
                               "authored": expected, "executed": actual, "referenceFrame": "global"}
    for tag in sorted(set(constraints) - matched):
        failures.append({"nativeNodeId": tag, "reason": "unrequested-native-constraint"})
    return {"passed": bool(evidence) and not failures, "sourceFeaSha256": fe["sha256"],
            "method": "source-node-to-native-CONSTRAINT-R", "dofOrder": list(DOFS),
            "nodes": evidence, "failures": failures}


def beam_release_plan(element: dict, native_node_ids=None) -> dict:
    value = element.get("releases") or {}
    if not isinstance(value, dict) or set(value)-{"i", "j", "releaseI", "releaseJ", "reference_frame"}:
        raise BoundaryCapabilityError("Unsupported YJK end-release fields / YJK 端释放字段未映射")
    if value.get("reference_frame", "element-local") != "element-local":
        raise BoundaryCapabilityError("YJK end releases require element-local axes / 端释放须使用构件局部轴")
    ends = []
    for end, alias in (("i", "releaseI"), ("j", "releaseJ")):
        if end in value and alias in value and value[end] != value[alias]:
            raise BoundaryCapabilityError("Conflicting end-release aliases / 端释放别名冲突")
        flags = value.get(end, value.get(alias, {}))
        if not isinstance(flags, dict) or set(flags)-{"ux", "uy", "uz", "rx", "ry", "rz"} or any(type(v) is not bool for v in flags.values()):
            raise BoundaryCapabilityError("End releases require explicit boolean DOFs / 端释放须提供明确布尔自由度")
        active = {key for key, enabled in flags.items() if enabled}
        if active and (element.get("type") != "beam" or active != {"ry", "rz"}):
            raise BoundaryCapabilityError("YJK mapped beam hinges release both local bending rotations and retain torsion / 已映射梁铰释放局部两个弯曲转角并保留扭转")
        ends.append(bool(active))
    if native_node_ids is not None:
        physical = list(map(str, element["nodes"]))
        native = list(map(str, native_node_ids))
        if native == physical[::-1]:
            ends.reverse()
        elif native != physical:
            raise BoundaryCapabilityError("Native release endpoints differ from the source / 原生端释放端点与源模型不一致")
    a, b = (100. if enabled else 0. for enabled in ends)
    return {"hinges": [int(enabled) for enabled in ends], "nativeR": [a, b, a, b, 0., 0.],
            "source": "YJKAPI Property(SpBeam).setVal(0/1); native FE R readback"}


def write_beam_releases(data_func, member_id: int, element: dict, nodes: dict) -> dict:
    """SpBeam ends follow the authored Grid_Generate start/end order.

    Native preprocessing may reverse the FE frame; audit that reversal against
    its actual endpoint coordinates instead of pre-sorting the source grid.
    """
    native_order = list(map(str, element['nodes']))
    plan = beam_release_plan(element, native_order)
    if any(plan['hinges']):
        from YJKAPI import Property
        prop = Property('SpBeam')
        for index, value in enumerate(plan['hinges']):
            prop.setVal(index, value)
        result = data_func.property_arrange(member_id, 'SpBeam', 27, prop.GetValString())
        if result is None or [float(x) for x in result.ShapeVal.split(',')[:2]] != plan['hinges']:
            raise RuntimeError("Native SpBeam release write differs / 原生梁端释放写入不一致")
    return {**plan, 'nativeEndpointOrder': native_order}
