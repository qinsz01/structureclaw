"""Authored local bending releases mapped to official YJK SpBeam properties.

Vendor Python example 5 documents slots 0/1 as left/right hinges. Native FE
readback calibrates R=[Ry_i,Ry_j,Rz_i,Rz_j,Rx_i,Rx_j] in percent. A hinge sets
both bending rotations to 100 and retains the torsional connection at zero.
"""
from __future__ import annotations


class BoundaryCapabilityError(ValueError):
    error_code = "ENGINE_INPUT_UNSUPPORTED"


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
