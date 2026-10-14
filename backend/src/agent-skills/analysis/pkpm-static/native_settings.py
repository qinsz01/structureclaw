"""Native compact settings accepted on the isolated 2025R2.5 solver runs."""
from __future__ import annotations

import re
from pathlib import Path

from contracts import AnalysisCapabilityError


CONTROLS = ("self_weight", "rigid_floor", "rigid_offsets", "construction_stage", "p_delta")


def resolved_rigid_floor(data):
    rigid = (data.get("analysis_control") or {}).get("rigid_floor")
    values = [story["rigid_diaphragm"] for story in data.get("stories", []) if story.get("rigid_diaphragm") is not None]
    if any(type(value) is not bool for value in [*values, *([] if rigid is None else [rigid])]):
        raise ValueError("Diaphragm settings must be boolean / 楼板约束须为布尔值")
    if (len(set(values)) > 1 or rigid is not None and any(value != rigid for value in values)
            or rigid is None and values and len(values) != len(data.get("stories", []))):
        raise AnalysisCapabilityError(engine="pkpm", capability="per-floor-diaphragms",
            reason="Conflicting or mixed diaphragm settings require explicit per-floor native mapping / 楼板约束冲突或混合设置须逐层原生映射")
    return rigid if rigid is not None else values[0] if values else None


def validate_settings(data: dict) -> None:
    controls = data.get("analysis_control") or {}
    unsupported = [key for key in CONTROLS if key not in ("self_weight", "rigid_floor") and controls.get(key) is not None and controls.get(key) is not False]
    from native_self_weight import compile_self_weight
    compile_self_weight(data)
    rigid = resolved_rigid_floor(data)
    if unsupported:
        raise AnalysisCapabilityError(engine="pkpm", capability="explicit-native-analysis-settings",
            reason="Native acceptance currently covers false controls only: " + ", ".join(unsupported)
                   + " / 原生验收当前仅覆盖关闭这些控制项")
    if rigid is not None:
        if any((s.get("dead_load") or 0) or (s.get("live_load") or 0) or s.get("floor_loads") for s in data.get("stories", [])):
            raise AnalysisCapabilityError(engine="pkpm", capability="bare-frame-floor-loads",
                reason="A no-slab frame requires explicit member/node loads / 无楼板杆系需显式构件或节点荷载")


def control_parameters(controls: dict) -> tuple[dict[int, int], dict[int, float]]:
    integers, doubles = {}, {}
    if controls.get("construction_stage") is False:
        integers[601] = 1  # Documentation option 60102 is NOT the stored enum.
    if type(controls.get("rigid_floor")) is bool:
        integers[606] = int(controls["rigid_floor"])
        if controls["rigid_floor"]: integers[607] = 0  # No physical plate/out-of-plane slab stiffness.
    if controls.get("p_delta") is False: integers[608] = 0
    if controls.get("rigid_offsets") is False: integers.update({609: 0, 641: 0})
    if type(controls.get("self_weight")) is bool: doubles.update({801: 0.0, 803: 0.0})
    return integers, doubles


def clear_floor_slab(floor) -> None:
    """Use a native zero-thickness floor and deletion, retaining hole records."""
    floor.SetInfoValue(0, 0)
    for slab in floor.GetSlabs():
        floor.DeleteSlab(slab.GetID())


def reapply_diaphragm_settings(jws, data):
    """Keep a kinematic diaphragm without PMCAD-generated physical slabs."""
    import APIPyInterface as api
    import json
    import os
    previous = Path.cwd()
    if resolved_rigid_floor(data) is not True:
        raise ValueError("Explicit rigid diaphragm request required / 须明确请求刚性楼板约束")
    try:
        model = api.Model()
        if not model.OpenPMModel(str(jws)):
            raise RuntimeError("Cannot open native diaphragm input / 无法打开原生楼板约束输入")
        para = model.GetProjectPara()
        for key, value in ((606, 1), (607, 0)):
            para.SetParaInt(key, value)
        model.SaveProjectPara()
        for index in range(1, model.GetNatualFloorCount() + 1):
            floor_id = model.GetFloorAssemTable(index).GetStandFloorIndex()
            model.SetCurrentStandFloor(floor_id)
            clear_floor_slab(model.GetCurrentStandFloor())
            model.SaveOneStandFloor(floor_id)
        model.SavePMModel()
        if not model.OpenPMModel(str(jws)):
            raise RuntimeError("Cannot reopen native diaphragm input / 无法重开楼板约束输入")
        readback = {str(key): model.GetProjectPara().GetPara_Int(key) for key in (606, 607)}
        if readback != {"606": 1, "607": 0}:
            raise RuntimeError("Native diaphragm parameter readback differs / 原生楼板约束参数回读不符")
        floors = []
        for index in range(1, model.GetNatualFloorCount() + 1):
            model.SetCurrentStandFloor(model.GetFloorAssemTable(index).GetStandFloorIndex())
            floor = model.GetCurrentStandFloor()
            thickness = floor.GetInfo()[0]
            regions = [{"id": slab.GetID(), "properties": list(slab.Get()), "loadCount": len(slab.GetLoad())}
                       for slab in floor.GetSlabs()]
            # PMCAD retains room polygons as zero-thickness Slab records after
            # deletion. Slab.Get is (thickness, dead load, live load, elevation).
            # These are not solver plates; GOUJIAN independently proves zero
            # plate elements after analysis.
            if thickness != 0 or any(any(row["properties"]) or row["loadCount"] for row in regions):
                raise RuntimeError("Native diaphragm introduced a physical slab / 原生约束引入了未声明实体楼板")
            floors.append({"floor": index, "thicknessMm": thickness, "physicalSlabCount": 0,
                           "zeroThicknessRegions": regions})
        result = {"verified": True, "readback": readback, "floors": floors, "source": "official-PMProjectPara-and-StandFloor-after-PMCAD"}
        Path(jws).with_name("native-diaphragm-readback.json").write_text(json.dumps(result, indent=2), encoding="utf8")
        return result
    finally:
        os.chdir(previous)


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
    if controls.get("rigid_floor") is True:
        patterns["rigid_floor"] = [r"是否对全楼强制采用刚性楼板假定:\s*是"]
    for name, value in requested.items():
        if (name not in ("self_weight", "rigid_floor") and value is not False) or any(not re.search(pattern, text) for pattern in patterns[name]):
            raise RuntimeError(f"PKPM effective setting '{name}' differs from request / 原生有效设置与请求不符")
    if type(controls.get("rigid_floor")) is bool:
        geometry = (directory / "GOUJIAN.OUT").read_text(encoding="gb18030")
        slab_counts = re.findall(r"板总数\s*=\s*(\d+)", geometry)
        if not slab_counts or any(int(count) for count in slab_counts):
            raise RuntimeError("Native solver introduced slabs in the bare frame / 原生杆系中出现未请求的楼板")
    return {"verified": True, "requested": requested, "source": ["WMASS.OUT", "GOUJIAN.OUT"],
            "automaticNativeSelfWeight": False, "selfWeightMethod": "explicit-native-member-loads"}
