"""Audited SATWE automatic rigid ends with source loads kept on the full member."""
from __future__ import annotations

import copy
import hashlib
import json
import math
import os
from pathlib import Path

from native_numeric_sections import _members, _point, _model_hash


def material_plan(model):
    if (model.get("analysis_control") or {}).get("rigid_offsets") is not True:
        return None
    from native_model_contract import pkpm_section_shape
    from pkpm_native_design import NativeDesignError, standard_material_plan
    from native_member_releases import beam_release_plan
    if any(beam_release_plan(row)["nativeCode"] != 1 for row in model.get("elements", [])):
        raise NativeDesignError("Combined releases and automatic rigid ends need endpoint calibration / 端释放与自动刚域并用尚需端点校准", "ENGINE_INPUT_UNSUPPORTED")
    for section in model.get("sections", []):
        shape = pkpm_section_shape(section)
        if not shape or shape["kind"] != "Rectangle":
            raise NativeDesignError("Automatic rigid ends require real rectangular geometry / 自动刚域需要真实矩形截面几何", "ENGINE_INPUT_UNSUPPORTED")
    materials = standard_material_plan(model)
    if any(row["family"] != "concrete" for row in materials.values()):
        raise NativeDesignError("Automatic rigid ends currently cover calibrated concrete profiles / 自动刚域当前覆盖已校准混凝土材料", "ENGINE_INPUT_UNSUPPORTED")
    return {"materials": materials, "purpose": "standard-elastic-material-for-automatic-rigid-ends"}


def read_rigid_offsets(directory, model, *, input_file="DATA.SAT"):
    path = Path(directory) / input_file
    payload = path.read_bytes()
    nodes = {str(row["id"]): [float(row[key]) for key in ("x", "y", "z")] for row in model["nodes"]}
    members = {}
    for identity, data in _members(payload, model).items():
        member, row = data["member"], data["row"]
        source_ids = list(map(str, member["nodes"]))
        length = math.dist(*(nodes[key] for key in source_ids))
        same_order = _point(row[6:9]) == _point(nodes[source_ids[0]])
        fields = (17, 18) if member["type"] == "beam" else (27, 28)
        ends = [row[index] for index in fields]
        if not same_order:
            ends.reverse()
        if any(value < 0 or not math.isfinite(value) for value in ends) or sum(ends) >= length:
            raise ValueError("Native rigid ends exceed the physical member / 原生刚域长度超过物理构件")
        members[identity] = {"physicalLengthM": length, "elasticStartM": ends[0], "elasticEndM": length-ends[1],
            "startLengthM": ends[0], "endLengthM": ends[1], "sourceNodeIds": source_ids,
            "nativeStationDomain": "elastic-span" if member["type"] == "beam" else "physical-endpoints",
            "source": {"kind": "native-elastic-member-record", "file": input_file,
                "nativeFloor": data["floor"], "nativeOrdinal": data["ordinal"], "floatFields": list(fields),
                "nativeEndpointCoordinatesM": [list(row[6:9]), list(row[9:12])], "nativeValuesM": [row[k] for k in fields]}}
    return {"verified": True, "sourceFeaSha256": hashlib.sha256(payload).hexdigest(),
        "method": "native-rigid-end-readback", "members": members}


def compile_load_records(model, mapping, rigid):
    """SDK type-1 beam load uses full-length resultant over the elastic span.

    Preserve source q on the clear span and integrate each rigid segment onto
    its physical node. The node moments retain the original load positions.
    """
    nodes = {str(row["id"]): [float(row[k]) for k in ("x", "y", "z")] for row in model["nodes"]}
    records, ledger = [], []
    for source in mapping["loads"]:
        row = copy.deepcopy(source)
        if row["targetType"] != "beam":
            records.append(row)
            continue
        offset = rigid["members"][row["targetId"]]
        ri, rj, length = offset["startLengthM"], offset["endLengthM"], offset["physicalLengthM"]
        if not ri and not rj:
            records.append(row)
            continue
        if row["nativeValues"][0] != 1 or any(row["nativeValues"][2:]) or row["intervalM"] != [0., length]:
            raise ValueError("Rigid ends require audited full-span beam loads / 刚域需要已审定的全跨梁荷载")
        intensity = -float(row["nativeValues"][1])
        row["nativeValues"][1] *= (length-ri-rj)/length
        records.append(row)
        a, b = [nodes[key] for key in offset["sourceNodeIds"]]
        axis = [(end-start)/length for start, end in zip(a, b)]
        nodal = []
        for index, distance in enumerate((ri, rj)):
            arm = [v*distance/2*(1 if index == 0 else -1) for v in axis]
            force = intensity*distance
            # Cross product of the rigid-segment centroid arm and global Z force.
            values = [-force, arm[1]*force, -arm[0]*force, 0., 0., 0.]
            node = offset["sourceNodeIds"][index]
            records.append({**copy.deepcopy(source), "id": source["id"]+f":rigid-{index}",
                "targetType": "node", "targetId": node, "elementKind": -1, "nativeValues": values,
                "sourceLoad": {"kind": "rigid-segment-load-integration", "sourceLoadId": source["id"],
                               "sourceElementId": source["targetId"], "lengthM": distance}})
            nodal.append({"nodeId": node, "forceVectorKn": [0., 0., force],
                          "momentVectorKnM": [values[1], values[2], 0.], "lengthM": distance})
        ledger.append({"sourceLoadId": source["id"], "loadCaseId": source["caseId"], "elementId": source["targetId"],
            "sourceIntervalM": [0., length], "elasticIntervalM": [ri, length-rj],
            "sourceIntensityVectorKnM": [0., 0., intensity], "nativeBeamWire": row["nativeValues"],
            "rigidSegmentNodeLoads": nodal})
    return records, ledger


def recompile_loads(jws, model, mapping, rigid):
    """Write official definitions and assignments, save/reopen, then preprocess."""
    import APIPyInterface as api
    from native_loads import write_native_loads, read_native_load_assignments, _native_values_equal
    if (model.get("analysis_control") or {}).get("self_weight") is True and any(
            row["nativeStationDomain"] == "physical-endpoints" and (row["startLengthM"] or row["endLengthM"])
            for row in rigid["members"].values()):
        from pkpm_native_design import NativeDesignError
        raise NativeDesignError("Column selfweight through rigid regions is not yet calibrated / 柱刚域内自重传递尚未校准", "ENGINE_INPUT_UNSUPPORTED")
    previous = Path.cwd()
    try:
        native = api.Model()
        if not native.OpenPMModel(str(jws)):
            raise ValueError("Cannot open native rigid-end load model / 无法打开原生刚域荷载模型")
        records, ledger = compile_load_records(model, mapping, rigid)
        source_nodes = {tuple(float(row[k]) for k in ("x", "y", "z")): str(row["id"]) for row in model["nodes"]}
        edges = {(row["type"], frozenset(map(str, row["nodes"]))): str(row["id"]) for row in model["elements"]}
        written, assignments = [], []
        for index in range(1, native.GetNatualFloorCount()+1):
            real = native.GetFloorAssemTable(index)
            standard = real.GetStandFloorIndex()
            native.SetCurrentStandFloor(standard)
            floor = native.GetCurrentStandFloor()
            bottom = real.GetBottomElevation(); top = bottom+real.GetFloorHeight()/1000
            node_rows = {row.GetID(): row for row in floor.GetNodes()}
            target_nodes = {key: source_nodes[(row.Get()[0]/1000, row.Get()[1]/1000, top)] for key, row in node_rows.items()}
            targets = {("node", target_nodes[key]): row for key, row in node_rows.items()}
            for kind, rows in (("beam", floor.GetBeams()), ("column", floor.GetColumns())):
                for obj in rows:
                    key = obj.GetSeg()[0]
                    if kind == "beam":
                        ids = [target_nodes[tag] for tag in floor.GetNet(key).GetLine()]
                    else:
                        point = node_rows[key].Get()
                        ids = [source_nodes[(point[0]/1000, point[1]/1000, bottom)], target_nodes[key]]
                    targets[(kind, edges[(kind, frozenset(ids))])] = obj
            selected = [row for row in records if (row["targetType"], row["targetId"]) in targets]
            # All source assignments are reconstructed explicitly, including
            # existing nodal loads. No accumulated duplicate load is allowed.
            for (kind, _), obj in targets.items():
                obj.SetLoad([], []) if kind == "node" else obj.SetLoad(0, [], [])
            output = write_native_loads(api, native, selected, targets, cases=mapping["cases"])
            written.extend(output["loads"])
            assignments.extend({"floor": index, "kind": kind, "id": obj.GetID(),
                                "cases": read_native_load_assignments(obj, kind)[0],
                                "loads": read_native_load_assignments(obj, kind)[1]} for (kind, _), obj in targets.items())
            native.SaveOneStandFloor(standard)
        if len(written) != len(records):
            raise ValueError("Rigid-segment load target is not a native floor node / 刚段荷载目标没有原生楼层节点")
        native.SavePMModel()
        if not native.OpenPMModel(str(jws)):
            raise ValueError("Cannot reopen compiled rigid-end loads / 无法重开已编译刚域荷载")
        for row in written:
            kind, values = native.GetLoadDefine(row["nativeLoadId"]).Get()
            if kind != row["elementKind"] or not _native_values_equal(list(values), row["nativeValues"]):
                raise ValueError("Saved rigid-end load definition differs / 保存的刚域荷载定义不符")
        for row in assignments:
            native.SetCurrentStandFloor(native.GetFloorAssemTable(row["floor"]).GetStandFloorIndex())
            floor = native.GetCurrentStandFloor()
            getter = {"node": floor.GetNode, "beam": floor.GetBeam, "column": floor.GetColumn}[row["kind"]]
            if read_native_load_assignments(getter(row["id"]), row["kind"]) != (row["cases"], row["loads"]):
                raise ValueError("Saved rigid-end load assignment differs / 保存的刚域荷载分配不符")
        receipt = {"verified": True, "method": "full-physical-load; elastic-span-plus-rigid-segment-node-integrals",
            "physicalModelHash": _model_hash(model), "rigidOffsetInput": rigid,
            "loads": ledger, "nativeReadback": written, "assignments": assignments}
        Path(jws).with_name("native-rigid-load-compilation.json").write_text(json.dumps(receipt, indent=2), encoding="utf8")
        return receipt
    finally:
        os.chdir(previous)


def verify_rigid_offsets(directory, model):
    directory = Path(directory)
    result = read_rigid_offsets(directory, model)
    receipt = json.loads((directory / "native-rigid-load-compilation.json").read_text(encoding="utf8"))
    if receipt.get("verified") is not True or receipt.get("physicalModelHash") != _model_hash(model):
        raise ValueError("Rigid-end load receipt belongs to another model / 刚域荷载记录不属于当前模型")
    before = receipt["rigidOffsetInput"]["members"]
    for key, member in result["members"].items():
        if key not in before or any(member[field] != before[key][field] for field in
                ("sourceNodeIds", "physicalLengthM", "startLengthM", "endLengthM", "nativeStationDomain")):
            raise ValueError("Solved rigid ends differ from compiled loads / 已求解刚域与荷载编译不符")
    if set(before) != set(result["members"]):
        raise ValueError("Rigid-end source coverage differs / 刚域源对象覆盖不符")
    from native_loads import plan_native_loads
    from native_self_weight import compile_self_weight, native_weight_records
    records = plan_native_loads(model) + native_weight_records(model, compile_self_weight(model))
    _, expected = compile_load_records(model, {"loads": records}, result)
    if expected != receipt["loads"]:
        raise ValueError("Rigid-end physical load semantics differ / 刚域物理荷载语义不符")
    from native_load_readback import read_beam_load_inputs, _f32
    executed = read_beam_load_inputs(directory, model)
    source_indices = {(str(case['id']), str(load.get('id', f"{case['id']}:{index}"))): index
                      for case in model['load_cases'] for index, load in enumerate(case.get('loads', []))}
    element_loads = []
    for ledger in receipt['loads']:
        written = [row for row in receipt['nativeReadback'] if row['targetType'] == 'beam'
                   and row['targetId'] == ledger['elementId'] and row['caseId'] == ledger['loadCaseId']
                   and row['id'] == ledger['sourceLoadId']]
        if len(written) != 1:
            raise ValueError('Rigid-end SDK load binding differs / 刚域 SDK 荷载绑定不符')
        written = written[0]
        candidates = [row for row in executed['members'][ledger['elementId']]
                      if row['nativeCaseId'] == written['nativeCaseId']]
        # The text bridge is checked against this saved SDK scalar on every
        # run; it is not inferred from an observed shear-force slope.
        sdk = written['nativeReadbackValues']
        token = format(sdk[1], '.6g')
        candidates = [row for row in candidates if float(row['intensityToken']) == float(token)
                      and row['globalZIntensityKnM'] == _f32(-float(token))]
        if not candidates:
            raise ValueError('Native rigid-end load quantization is not verified / 原生刚域荷载量化未核对')
        # Equal loads on the same physical member/case are a multiset. Their
        # identical native records are interchangeable, but none can be reused.
        actual = candidates[0]
        executed['members'][ledger['elementId']].remove(actual)
        interval = ledger['elasticIntervalM']; length = ledger['sourceIntervalM'][1]
        element_loads.append({
            'loadCaseId': ledger['loadCaseId'], 'sourceLoadId': ledger['sourceLoadId'],
            'sourceLoadIndex': source_indices.get((ledger['loadCaseId'], ledger['sourceLoadId'])),
            'elementId': ledger['elementId'], 'sourceIntervalM': ledger['sourceIntervalM'],
            'sourceIntensityVectorKnM': ledger['sourceIntensityVectorKnM'],
            'elasticIntervalM': interval,
            'nativeWireReadback': {**actual, 'sdkValues': sdk,
                'sdkValueSemantics': 'type,downward-global-z-kN/m,unused,unused,unused,unused',
                'inputValueSemantics': 'member,type,case-marker,global-z-q-i,global-z-q-j,start,end,direction,member[,custom-case]',
                'quantization': 'SDK-float32 -> native-text-six-significant-digits -> solver-float32',
                'files': executed['files']},
            'effectiveElasticIntensityVectorKnM': [0., 0., actual['globalZIntensityKnM'] * length / (interval[1]-interval[0])],
            'rigidSegmentNodeLoads': ledger['rigidSegmentNodeLoads']})
    for identity, remaining in executed['members'].items():
        member = result['members'][identity]
        if remaining and (member['startLengthM'] or member['endLengthM']):
            raise ValueError('Unclaimed native rigid-span load record / 存在未对应源荷载的原生刚域梁记录')
    return {**result, "sourceLoadSemanticsPreserved": True,
        "loadCompilation": {"method": receipt["method"], "sourceFeaSha256": result["sourceFeaSha256"],
            "sourceModelHash": receipt["physicalModelHash"], "source": "native-rigid-load-compilation.json",
            "sha256": hashlib.sha256((directory / "native-rigid-load-compilation.json").read_bytes()).hexdigest(),
            "loads": receipt["loads"], "elementLoads": element_loads,
            "executionReadbackMethod": executed['method']}}


def verify_case_equilibrium(model, case, case_id):
    """Native cuts must conserve source loads and every free node component."""
    import numpy as np
    from native_self_weight import compile_self_weight
    nodes = {str(row["id"]): row for row in model["nodes"]}
    source_case = next(row for row in model["load_cases"] if str(row["id"]) == case_id)
    external = {key: np.zeros(6) for key in nodes}
    actions = {key: np.zeros(6) for key in nodes}
    q = {str(row["id"]): np.zeros(3) for row in model["elements"]}
    weight = compile_self_weight(model)
    if weight["enabled"] and weight["loadCaseId"] == case_id:
        for row in weight["members"]:
            q[row["elementId"]] += row["intensityVectorKnM"]
    for load in source_case.get("loads", []):
        if load["type"] == "nodal":
            external[str(load["node"])] += [float(load.get(k, 0)) for k in ("fx", "fy", "fz", "mx", "my", "mz")]
        elif load["type"] in ("uniform", "distributed"):
            q[str(load["element"])] += [float(load.get(k, 0)) for k in ("wx", "wy", "wz")]
        else:
            raise ValueError("Rigid-end equilibrium has no source load mapping / 刚域平衡缺少源荷载映射")
    checked = 0
    def compare(actual, expected, context):
        nonlocal checked
        checked += len(actual)
        if any(not math.isclose(float(a), float(b), rel_tol=1e-5, abs_tol=1e-5) for a, b in zip(actual, expected)):
            raise ValueError("Native/source load equilibrium differs: " + context + " / 原生与源荷载平衡不符")
    for member in model["elements"]:
        identity = str(member["id"])
        rows = case["memberStations"][identity]
        if len(rows) < 2:
            raise ValueError("Native rigid-end cuts are incomplete / 原生刚域截面不完整")
        axes = np.array(rows[0]["localAxes"])
        def cut(row):
            c = row["components"]
            return (axes.T @ np.array([c["N"], -c["Vy"], -c["Vz"]]),
                    axes.T @ np.array([c["T"], c["My"], c["Mz"]]))
        def at(anchor, position):
            f0, m0 = cut(anchor)
            delta = position-anchor["positionM"]
            return np.concatenate((f0-q[identity]*delta,
                m0-np.cross(axes[0], f0*delta-q[identity]*delta**2/2)))
        for previous, row in zip(rows, rows[1:]):
            origin = np.concatenate(cut(previous))
            compare(np.concatenate(cut(row))-origin, at(previous, row["positionM"])-origin,
                    f"{case_id}/{identity}/{row['positionM']}")
        length = math.dist(*[[float(nodes[str(key)][axis]) for axis in ("x", "y", "z")] for key in member["nodes"]])
        actions[str(member["nodes"][0])] -= at(rows[0], 0.)
        actions[str(member["nodes"][1])] += at(rows[-1], length)
    from native_settings import resolved_rigid_floor
    floor_groups = {}
    for key, node in nodes.items():
        restraints = node.get("restraints")
        free = [index for index, fixed in enumerate(restraints if restraints is not None else [False]*6) if not fixed]
        if resolved_rigid_floor(model) is True and float(node["z"]) > 0:
            floor_groups.setdefault(float(node["z"]), []).append(key)
            free = [index for index in free if index not in (0, 1, 5)]
        compare(actions[key][free], external[key][free], f"{case_id}/node/{key}")
    for elevation, ids in floor_groups.items():
        def group_resultant(vectors):
            total = np.zeros(3)
            for key in ids:
                value = vectors[key]
                total += [value[0], value[1], value[5]+nodes[key]["x"]*value[1]-nodes[key]["y"]*value[0]]
            return total
        compare(group_resultant(actions), group_resultant(external), f"{case_id}/diaphragm/{elevation}")
    return {"verified": True, "method": "signed-cuts-and-source-load-free-node-equilibrium", "components": checked,
            "relativeTolerance": 1e-5, "forceMomentAbsoluteTolerance": 1e-5}
