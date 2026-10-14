"""Compare source loads with the actual FE input, independent of SDK setters."""
from __future__ import annotations

from collections import defaultdict
import hashlib
import json
import math
from pathlib import Path
import re
import struct


def audit_loads(model: dict, mapping: dict, fe: dict) -> dict:
    from yjk_self_weight import compile_self_weight
    weight = compile_self_weight(model)
    path = Path(mapping['ydb_path']).parent / 'fea.dat'
    consistent = None
    if (path.parent/'native-axial-gravity-compilation.json').exists():
        from yjk_native_axial_weight import verify_compilation
        consistent = verify_compilation(path.parent, model, mapping, fe)
    axial = {row['sourceSegmentId']: row for row in (consistent or {}).get('members', [])}
    nodes = {str(n["id"]): tuple(float(n[k]) for k in ("x", "y", "z")) for n in model["nodes"]}
    coords = lambda p: tuple(round(float(x), 9) for x in p)
    source_at = {coords(p): k for k, p in nodes.items()}
    native_nodes = {tag: source_at.get(coords(p)) for tag, p in fe["nodes"].items()}
    edges = {tuple(sorted((coords(nodes[e["nodes"][0]]), coords(nodes[e["nodes"][1]])))): e
             for e in model["elements"]}
    members = {}
    for tag, row in fe["frames"].items():
        points = [coords(fe["nodes"][n]) for n in row["nodes"]]
        element = edges.get(tuple(sorted(points)))
        if element is None:
            raise ValueError(f"YJK native member {tag} has no exact physical load target / 原生构件与物理荷载对象不一致")
        members[tag] = (element["id"], math.dist(*points), points[0] != coords(nodes[element["nodes"][0]]))
    cases = {}
    for line in fe["sectionsRaw"].get("STATIC_LDCASE", []):
        match = re.match(r"(\d+)\s+N=(\S+)\s", line)
        if match:
            cases[match[2]] = match[1]
    by_native = {}
    for entry in mapping.get("load_cases", []):
        if entry["nativeName"] not in cases:
            raise ValueError(f"YJK did not execute source case {entry['sourceCaseId']} / 缺少指定工况")
        by_native[cases[entry["nativeName"]]] = entry["sourceCaseId"]

    # Read repeated USE-STLD blocks directly; flattening repeated sections would
    # discard their case ownership and can make two wrong cases look correct.
    text = path.read_bytes().decode("gb18030")
    actual = {key: defaultdict(float) for key in by_native.values()}
    executed_lines, executed_points = [], []
    active, section = None, ""
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith("*USE-STLD"):
            match = re.search(r"LCID=(\d+)", line)
            active = by_native.get(match[1]) if match else None
        elif line.startswith("*"):
            section = line[1:].split()[0]
        elif active and line and section in {"NODELOAD", "FRAMELOAD"}:
            fields = dict(re.findall(r"\b([A-Z]+)=([^\s]+)", line))
            tag = line.split()[0]
            values = [float(v) for v in fields.get("F", "").split(",")]
            if not all(math.isfinite(v) for v in values):
                raise ValueError("YJK FE contains non-finite loads / 原生荷载非有限数值")
            if section == "NODELOAD":
                node = native_nodes.get(tag)
                if node is None or len(values) != 6:
                    raise ValueError("YJK load was moved to a floor master or unbound node / 荷载被移到楼板主节点或未映射节点")
                for index, value in enumerate(values):
                    actual[active][("node", node, index)] += value
            else:
                if tag not in members:
                    raise ValueError("YJK member load target/direction changed / 构件荷载对象或方向改变")
                member, length, reversed_order = members[tag]
                native_direction = fields.get('DIR')
                native_values = list(values)
                if native_direction == 'LX' and member in axial and fields.get('T') == 'CONLOAD' and len(values) == 2:
                    frame=fe['frames'][tag]
                    a,b=[fe['nodes'][node] for node in frame['nodes']]
                    if a[:2] != b[:2] or a[2] == b[2]:
                        raise ValueError('Axial gravity native axis is not vertical / 轴向自重原生轴不竖直')
                    values[1] *= 1. if b[2] > a[2] else -1.
                elif native_direction != 'GZ':
                    raise ValueError("YJK member load target/direction changed / 构件荷载对象或方向改变")
                position = lambda x: -x*length if x < 0 else x
                if fields.get("T") == "CONLOAD" and len(values) == 2:
                    x = position(values[0]); x = length-x if reversed_order else x
                    actual[active][("point", member, round(x, 9))] += values[1]
                    executed_points.append({'case':active,'member':member,'positionM':x,
                                            'forceKn':values[1],'nativeFrameId':tag,
                                            'nativeDirection':native_direction,'nativeValues':native_values})
                elif fields.get("T") == "UNILOAD" and len(values) == 4:
                    a, b = position(values[0]), position(values[2])
                    qa, qb = values[1], values[3]
                    if reversed_order:
                        a, b, qa, qb = length-b, length-a, qb, qa
                    executed_lines.append({"case": active, "member": member, "start": a, "end": b,
                                           "qa": qa, "qb": qb, "nativeFrameId": tag})
                    actual[active][("line-start", member, round(a, 9), round(b, 9))] += qa
                    actual[active][("line-end", member, round(a, 9), round(b, 9))] += qb
                else:
                    raise ValueError("Unsupported executed native load record / 原生实际荷载格式尚未校准")
    expected = {key: defaultdict(float) for key in by_native.values()}
    source_members = {e["id"]: e for e in model["elements"]}
    for case in model.get("load_cases", []):
        if case["id"] not in expected:
            raise ValueError("A source load case has no executed native mapping / 源工况未计算")
        for load in case.get("loads", []):
            target = expected[case["id"]]
            if load["type"] == "nodal":
                for index, component in enumerate(("fx", "fy", "fz", "mx", "my", "mz")):
                    target[("node", load["node"], index)] += float(load.get(component, 0))
            elif load["type"] == "point":
                target[("point", load["element"], round(float(load["position"]), 9))] += float(load.get("fz", 0))
            elif load["type"] == "distributed":
                element = source_members[load["element"]]
                length = math.dist(*(nodes[node] for node in element["nodes"]))
                a, b = round(float(load.get("start", 0)), 9), round(float(load.get("end", length)), 9)
                for key in ("line-start", "line-end"):
                    target[(key, load["element"], a, b)] += float(load.get("wz", 0))
            else:
                raise ValueError("Unsupported source load audit / 不支持的源荷载核对")
    weight_keys = set()
    if weight["enabled"]:
        for member in weight["members"]:
            compiled = axial.get(member['elementId'])
            if compiled:
                point = compiled['point']
                key = ('point',member['elementId'],round(point['nativePositionM'],9))
                expected[weight['loadCaseId']][key] += point['forceVectorKn'][2]
                weight_keys.add((weight['loadCaseId'],key))
                for load in compiled['rigidSegmentNodeLoads']:
                    key = ('node',load['sourceNodeId'],2)
                    expected[weight['loadCaseId']][key] += load['forceVectorKn'][2]
                    weight_keys.add((weight['loadCaseId'],key))
                continue
            for label in ("line-start", "line-end"):
                key = (label, member["elementId"], 0., round(member["lengthM"], 9))
                expected[weight["loadCaseId"]][key] += member["intensityKnM"]
                weight_keys.add((weight["loadCaseId"], key))
    differences = []
    for case, rows in expected.items():
        for key in rows.keys() | actual[case].keys():
            # Native decimal representation only; this is not a solve tolerance.
            tolerance = 1e-8
            if (case, key) in weight_keys and rows[key] != 0:
                # fea.dat serializes native float32 load values with six
                # significant digits. Derived rho*A*g is deliberately not
                # rounded to a user-load increment. Bound that exact encoding,
                # without changing any structural response tolerance.
                value = abs(rows[key])
                decimal_half_step = .5*10**(math.floor(math.log10(value))-5)
                stored = struct.unpack('f', struct.pack('f', rows[key]))[0]
                tolerance += decimal_half_step + abs(stored-rows[key])
            if not math.isclose(rows[key], actual[case][key], rel_tol=0, abs_tol=tolerance):
                differences.append({"case": case, "target": key, "expected": rows[key], "actual": actual[case][key]})
    if differences:
        raise ValueError("YJK executed loads differ from input / 原生实际荷载与输入不符: " + json.dumps(differences[:12]))
    if weight["enabled"]:
        executed = []
        for row in weight["physicalCompilation"]:
            compiled = axial.get(row['sourceSegmentId'])
            if compiled:
                matching = [point for point in executed_points if point['case'] == weight['loadCaseId']
                            and point['member'] == row['sourceSegmentId']
                            and point['positionM'] == compiled['point']['nativePositionM']]
                if len(matching) != 1:
                    raise ValueError('Consistent axial load has no unique native point / 一致轴向荷载缺少唯一原生点载')
                point_target = compiled['point']['forceVectorKn'][2]
                encoded = float(format(struct.unpack('f',struct.pack('f',point_target))[0],'.6g'))
                if matching[0]['forceKn'] != encoded:
                    raise ValueError('Consistent axial point encoding differs / 一致轴向点载编码不符')
                compiled['executedPoint'] = {'nativePositionM':matching[0]['positionM'],
                    'forceVectorKn':[0.,0.,matching[0]['forceKn']],
                    'nativeDirection':matching[0]['nativeDirection'], 'nativeValues':matching[0]['nativeValues']}
                compiled['nativeNodeAggregates'] = [{'sourceNodeId':load['sourceNodeId'],
                    'nativeNodeId':load['nativeNodeId'],
                    'sourceTotalForceVectorKn':[expected[weight['loadCaseId']][('node',load['sourceNodeId'],i)] for i in range(3)],
                    'executedTotalForceVectorKn':[actual[weight['loadCaseId']][('node',load['sourceNodeId'],i)] for i in range(3)]}
                    for load in compiled['rigidSegmentNodeLoads']]
                for node in compiled['nativeNodeAggregates']:
                    expected_node=[float(format(struct.unpack('f',struct.pack('f',value))[0],'.6g'))
                                   for value in node['sourceTotalForceVectorKn']]
                    if node['executedTotalForceVectorKn'] != expected_node:
                        raise ValueError('Consistent rigid-node load encoding differs / 一致刚段节点荷载编码不符')
                # This is a physical-field recovery input, not an executed FE
                # uniform-load record. Consumers must inspect the compilation.
                executed.append({**row,'intensityVectorKnM':list(row['intensityVectorKnM']),
                                 'executionMethod':'consistent-axial-load-vector'})
                continue
            authored = row["intensityVectorKnM"][2]
            quantized = float(format(authored, ".6g"))
            bound = 8*math.ulp(max(abs(quantized), 1e-300))
            matches = [line for line in executed_lines if line["case"] == weight["loadCaseId"]
                       and line["member"] == row["sourceSegmentId"]
                       and abs(line["start"]-row["startM"]) <= 8*math.ulp(max(1., row["endM"]))
                       and abs(line["end"]-row["endM"]) <= 8*math.ulp(max(1., row["endM"]))
                       and abs(line["qa"]-quantized) <= bound and abs(line["qb"]-quantized) <= bound]
            if not matches:
                raise ValueError("Executed selfweight has no bound six-significant-digit FE record / 自重缺少绑定的六位有效数字原生荷载读回")
            # Select an actual matching FE record. Never manufacture the
            # executed vector from rounding the source after the fact.
            value = matches[0]["qa"]
            executed.append({**row, "intensityVectorKnM": [0., 0., value]})
        weight["executedCompilation"] = executed
        weight["inputQuantization"] = {"source": "fea.dat", "significantDigits": 6}
        if consistent:
            consistent['verified'] = True
            weight['consistentLoadCompilation'] = consistent
    payload = {"passed": True, "sourceCases": sorted(expected), "nativeCases": by_native,
               "feaSha256": fe["sha256"], "method": "signed-case-target-position-component-readback",
               "selfWeightExcludedFromSourceCases": (model.get("analysis_control") or {}).get("self_weight") is False}
    payload.update(selfWeight=weight["enabled"], selfWeightCompilation=weight)
    payload["loadHash"] = hashlib.sha256(json.dumps(model.get("load_cases", []), sort_keys=True).encode()).hexdigest()
    return payload
