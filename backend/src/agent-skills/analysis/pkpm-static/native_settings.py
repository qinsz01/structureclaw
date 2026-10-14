"""Native compact settings accepted on the isolated 2025R2.5 solver runs."""
from __future__ import annotations

import re
from pathlib import Path

from contracts import AnalysisCapabilityError


CONTROLS = ("self_weight", "rigid_floor", "rigid_offsets", "construction_stage", "p_delta")


def validate_settings(data: dict) -> None:
    controls = data.get("analysis_control") or {}
    unsupported = [key for key in CONTROLS if key != "self_weight" and controls.get(key) is not None and controls.get(key) is not False]
    from native_self_weight import compile_self_weight
    compile_self_weight(data)
    unsupported += [f"stories.{story.get('id')}.rigid_diaphragm" for story in data.get("stories", [])
                    if story.get("rigid_diaphragm") is not None and story.get("rigid_diaphragm") is not False]
    if unsupported:
        raise AnalysisCapabilityError(engine="pkpm", capability="explicit-native-analysis-settings",
            reason="Native acceptance currently covers false controls only: " + ", ".join(unsupported)
                   + " / 原生验收当前仅覆盖关闭这些控制项")
    if controls.get("rigid_floor") is False or any(s.get("rigid_diaphragm") is False for s in data.get("stories", [])):
        if any((s.get("dead_load") or 0) or (s.get("live_load") or 0) or s.get("floor_loads") for s in data.get("stories", [])):
            raise AnalysisCapabilityError(engine="pkpm", capability="bare-frame-floor-loads",
                reason="A no-slab frame requires explicit member/node loads / 无楼板杆系需显式构件或节点荷载")


def control_parameters(controls: dict) -> tuple[dict[int, int], dict[int, float]]:
    integers, doubles = {}, {}
    if controls.get("construction_stage") is False:
        integers[601] = 1  # Documentation option 60102 is NOT the stored enum.
    if controls.get("rigid_floor") is False: integers[606] = 0
    if controls.get("p_delta") is False: integers[608] = 0
    if controls.get("rigid_offsets") is False: integers.update({609: 0, 641: 0})
    if type(controls.get("self_weight")) is bool: doubles.update({801: 0.0, 803: 0.0})
    return integers, doubles


def clear_floor_slab(floor) -> None:
    """Use a native zero-thickness floor and deletion, retaining hole records."""
    floor.SetInfoValue(0, 0)
    for slab in floor.GetSlabs():
        floor.DeleteSlab(slab.GetID())


def verify_effective_settings(directory: Path, controls: dict) -> dict:
    """Check actual solver reports; project parameter readback alone is weaker."""
    requested = {key: controls[key] for key in CONTROLS if controls.get(key) is not None}
    if not requested:
        return {"verified": False, "reason": "native defaults were not explicitly requested"}
    text = (directory / "WMASS.OUT").read_text(encoding="gb18030")
    patterns = {
        "construction_stage": [r"竖向荷载计算信息:\s*按一次加荷方式计算"],
        "rigid_floor": [r"是否对全楼强制采用刚性楼板假定:\s*否"],
        "p_delta": [r"考虑P-DELTA效应方法\s*:\s*不考虑"],
        "rigid_offsets": [r"梁端在梁柱重叠部分简化:\s*不作为刚域", r"柱端在梁柱重叠部分简化:\s*不作为刚域"],
        "self_weight": [r"Gc\s*=\s*0\.00", r"Gs\s*=\s*0\.00"],
    }
    for name, value in requested.items():
        if (name != "self_weight" and value is not False) or any(not re.search(pattern, text) for pattern in patterns[name]):
            raise RuntimeError(f"PKPM effective setting '{name}' differs from request / 原生有效设置与请求不符")
    if controls.get("rigid_floor") is False:
        geometry = (directory / "GOUJIAN.OUT").read_text(encoding="gb18030")
        slab_counts = re.findall(r"板总数\s*=\s*(\d+)", geometry)
        if not slab_counts or any(int(count) for count in slab_counts):
            raise RuntimeError("Native solver introduced slabs in the bare frame / 原生杆系中出现未请求的楼板")
    return {"verified": True, "requested": requested, "source": ["WMASS.OUT", "GOUJIAN.OUT"],
            "automaticNativeSelfWeight": False, "selfWeightMethod": "explicit-native-member-loads"}
