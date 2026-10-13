"""Explicit V2 loads compiled into separate YJK SDK load cases.

The native DEAD case includes software self weight. Source cases deliberately
use GKLoad_Def, so a named D case never inherits undeclared gravity or another
source case. Native readback and numerical acceptance remain separate checks.
"""
from __future__ import annotations

import math
import re
from typing import Any


def _number(value: Any, field: str) -> float:
    if isinstance(value, bool):
        raise ValueError(f"{field}: a finite number is required / 必须提供有限数值")
    try:
        result = float(value)
    except (ValueError, TypeError) as error:
        raise ValueError(f"{field}: a finite number is required / 必须提供有限数值") from error
    if not math.isfinite(result):
        raise ValueError(f"{field}: a finite number is required / 必须提供有限数值")
    return result


def _text(value: float) -> str:
    return format(value, ".15g")


def _native_precision(values: list[float], label: str) -> None:
    if any(not math.isclose(value, round(value, 3), rel_tol=0, abs_tol=1e-10) for value in values):
        raise ValueError(f"{label}: load values exceed native 0.001 precision / 荷载值或位置超出原生三位小数精度")


def compile_load_definitions(model: dict) -> list[dict]:
    """Pure compilation, before touching the SDK; never drop a load component."""
    nodes = {str(node["id"]): node for node in model.get("nodes", [])}
    members = {str(member["id"]): member for member in model.get("elements", [])}
    cases = []
    seen: set[str] = set()
    for case_index, case in enumerate(model.get("load_cases", []), 1):
        case_id = str(case["id"])
        if case_id in seen:
            raise ValueError(f"Duplicate load case {case_id} / 工况 ID 重复")
        seen.add(case_id)
        case_type = str(case.get("type", "other"))
        # SDK nLive is a physical case category, not a GUI selection option ID.
        native_category = {"dead": 0, "live": 1, "wind": 3, "other": 0}.get(case_type)
        if native_category is None:
            raise ValueError(f"Unsupported static case type {case_type} / 不支持该静力工况类型")
        suffix = re.sub(r"[^A-Za-z0-9_]", "_", case_id)[:24]
        compiled = {"sourceCaseId": case_id, "nativeName": f"SC{case_index:03d}_{suffix}",
                    "nativeCategory": native_category, "loads": []}
        for index, load in enumerate(case.get("loads", [])):
            label = f"load_cases.{case_id}.loads.{index}"
            if load.get("reference_frame", "global") != "global":
                raise ValueError(f"{label}: explicit global loads are required / 荷载须使用全局坐标")
            if load.get("type") == "nodal":
                node_id = str(load.get("node", ""))
                if node_id not in nodes or float(nodes[node_id]["z"]) == 0:
                    raise ValueError(f"{label}: load must target an existing elevated node / 荷载须作用于已存在的楼层节点")
                values = [_number(load.get(key, 0), f"{label}.{key}")
                          for key in ("fz", "mx", "my", "fx", "fy", "mz")]
                values[0] = -values[0]  # SDK first component is downward gravity.
                _native_precision(values, label)
                if any(_number(load.get(key, 0), f"{label}.{key}") != 0 for key in ("wx", "wy", "wz")):
                    raise ValueError(f"{label}: nodal loads cannot contain line intensities / 节点荷载不能混入线荷载")
                entry = {"targetKind": "node", "targetId": node_id, "elementKind": -1,
                         # The seventh SDK field is the horizontal-axis angle.
                         # Omitting it serializes uninitialized memory and can
                         # rotate Fy by a nondeterministic angle.
                         "shapeVal": ",".join(map(_text, [*values, 0])), "components": values}
            elif load.get("type") in {"distributed", "point"}:
                member_id = str(load.get("element", ""))
                member = members.get(member_id)
                if member is None or member.get("type") != "beam":
                    raise ValueError(f"{label}: distributed loads require an existing beam / 线荷载须作用于已存在的梁")
                forbidden = ("wx", "wy", "fx", "fy", "mx", "my", "mz", "fz" if load["type"] == "distributed" else "wz")
                if any(_number(load.get(key, 0), f"{label}.{key}") != 0 for key in forbidden):
                    raise ValueError(f"{label}: nonvertical beam loads need an explicit native direction mapping / 非竖向梁荷载尚需原生方向映射")
                start, end = (nodes[str(node)] for node in member["nodes"])
                length = math.dist([start[key] for key in ("x", "y", "z")],
                                   [end[key] for key in ("x", "y", "z")])
                if load["type"] == "point":
                    a = b = _number(load.get("position"), f"{label}.position")
                    if not 0 <= a <= length:
                        raise ValueError(f"{label}: point position outside member / 集中力位置越界")
                    value = -_number(load.get("fz", 0), f"{label}.fz")
                    parameters = [4, value, a, 0, 0, 0, 0]
                else:
                    if load.get("distribution", "uniform") != "uniform":
                        raise ValueError(f"{label}: nonuniform load mapping is not implemented / 尚未实现变强度线荷载映射")
                    a = _number(load.get("start", 0), f"{label}.start")
                    b = _number(load.get("end", length), f"{label}.end")
                    if not 0 <= a < b <= length:
                        raise ValueError(f"{label}: load interval outside member / 分布荷载范围越界")
                    value = -_number(load.get("wz", 0), f"{label}.wz")
                    # SDK type 11: endpoint intensities, start and loaded length
                    # in metres. Native preprocessing preserves reversed grids.
                    parameters = ([1, value, 0, 0, 0, 0, 0] if a == 0 and b == length
                                  else [11, value, value, a, b-a, 0, 0])
                _native_precision(parameters, label)
                projection_factor = 1.
                if load['type'] == 'distributed' and float(start['z']) != float(end['z']):
                    # Native type 1 is global-vertical per plan length. Type 81
                    # is local-normal and changes the force direction. Compile
                    # the requested actual-length intensity into type 1 instead.
                    projected = math.dist([start[k] for k in ('x', 'y')], [end[k] for k in ('x', 'y')])
                    if projected == 0:
                        raise ValueError('Vertical beam load has no plan projection / 竖直梁没有平面投影')
                    projection_factor = length/projected
                    parameters[1] *= projection_factor
                    if parameters[0] == 11:
                        parameters[2] *= projection_factor
                entry = {"targetKind": "member", "targetId": member_id, "elementKind": 12,
                         "shapeVal": ",".join(map(_text, parameters)), "components": [value],
                         "startPositionM": a, "endPositionM": b,
                         "actualToPlanLengthFactor": projection_factor}
            else:
                raise ValueError(f"{label}: unsupported load type {load.get('type')} / 不支持的荷载类型")
            entry["sourceLoadId"] = str(load.get("id", f"{case_id}:{index}"))
            compiled["loads"].append(entry)
        cases.append(compiled)
    return cases


def arrange_native_loads(data_func, model: dict, native_nodes: dict, native_members: dict) -> list[dict]:
    from YJKAPI import GKLoadDefCreateInfo

    mapping = compile_load_definitions(model)
    for case in mapping:
        info = GKLoadDefCreateInfo()
        info.SetDeadFacotr(0.0).SetLiveFacotr(case["nativeCategory"], 0.0, 0.0, 0.0)
        info.SetName(case["nativeName"]).SetData("0,1,1,1,1,1,1,1,1,")
        native_case = data_func.GKLoad_Def(info)
        case["nativeKind"] = int(native_case.kind)
        case["nativeDefinitionId"] = int(native_case.ID)
        for load in case["loads"]:
            targets = native_nodes if load["targetKind"] == "node" else native_members
            target = targets.get(load["targetId"])
            if target is None:
                raise ValueError(f"Load {load['sourceLoadId']} has no native target / 荷载缺少原生对象映射")
            definition = data_func.Load_Def(load["elementKind"], load["shapeVal"], load["sourceLoadId"])
            data_func.load_arrange([target], definition, case["nativeKind"])
            load["nativeTargetId"] = int(target.ID)
            load["nativeLoadDefinitionId"] = int(definition.ID)
    # The SDK leaves these fields uninitialized. Explicit zeros avoid undefined
    # extra distribution fields in the exchange database (audited API pattern).
    definitions = {row.ID: row.ElementKind for row in data_func.GetLoadSectList()}
    for load in data_func.GetLoadSegList():
        if definitions.get(load.SectID) != 14:
            load.strParas1 = "0,0,0,0,0,"
        load.strParasX = load.strParasY = load.strParasZ = ""
    return mapping


def repair_exchange_load_precision(ydb_path, work_dir, mapping: list[dict]) -> None:
    """Preserve derived actual/plan-length conversion before native import."""
    from contextlib import closing
    import hashlib
    import json
    from pathlib import Path
    import sqlite3
    definitions = {}
    for case in mapping:
        for load in case['loads']:
            if load.get('actualToPlanLengthFactor', 1.) == 1.:
                continue
            key = load['nativeLoadDefinitionId']
            if key in definitions and definitions[key] != load['shapeVal']:
                raise ValueError('Native load definition aliases different intensities / 原生荷载定义发生精度合并冲突')
            definitions[key] = load['shapeVal']
    if not definitions:
        return
    root, path = Path(work_dir).resolve(), Path(ydb_path).resolve()
    if path.parent != root or path.suffix.lower() != '.ydb' or not path.is_file() or any(root.glob('*.ymd')):
        raise ValueError('Load precision repair requires this run\'s pre-import exchange / 仅能修复本次导入前交换文件')
    before = hashlib.sha256(path.read_bytes()).hexdigest()
    with closing(sqlite3.connect(path.as_uri()+'?mode=rw', uri=True)) as db:
        with db:
            for key, value in definitions.items():
                rows = db.execute('SELECT ElementKind, ShapeVal FROM tblLoadSect WHERE ID=?', (key,)).fetchall()
                if len(rows) != 1 or rows[0][0] != 12:
                    raise ValueError('Missing native beam load definition / 缺少原生梁荷载定义')
                actual = [float(x) for x in rows[0][1].split(',') if x.strip()]
                expected = [float(x) for x in value.split(',')]
                if len(actual) != len(expected) or any(abs(a-b) > .00050001 for a, b in zip(actual, expected)):
                    raise ValueError('Native load differs beyond serialization precision / 原生荷载差异超出序列化精度')
            for key, value in definitions.items():
                db.execute('UPDATE tblLoadSect SET ShapeVal=? WHERE ID=?', (value, key))
                if db.execute('SELECT ShapeVal FROM tblLoadSect WHERE ID=?', (key,)).fetchone() != (value,):
                    raise ValueError('Native load precision readback failed / 原生荷载精度回读失败')
    receipt = {'scope': 'generated-exchange-input; only tblLoadSect.ShapeVal', 'passed': True,
               'definitions': definitions, 'beforeSha256': before, 'afterSha256': hashlib.sha256(path.read_bytes()).hexdigest(),
               'method': 'global-vertical-actual-length-to-plan-length-intensity'}
    (root/'native-load-precision.json').write_text(json.dumps(receipt, indent=2), encoding='utf8')
