"""Compare source loads with the actual FE input, independent of SDK setters."""
from __future__ import annotations

from collections import defaultdict
import hashlib
import json
import math
from pathlib import Path
import re


def audit_loads(model: dict, mapping: dict, fe: dict) -> dict:
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
    path = Path(mapping["ydb_path"]).parent / "fea.dat"
    text = path.read_bytes().decode("gb18030")
    actual = {key: defaultdict(float) for key in by_native.values()}
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
                if tag not in members or fields.get("DIR") != "GZ":
                    raise ValueError("YJK member load target/direction changed / 构件荷载对象或方向改变")
                member, length, reversed_order = members[tag]
                position = lambda x: -x*length if x < 0 else x
                if fields.get("T") == "CONLOAD" and len(values) == 2:
                    x = position(values[0]); x = length-x if reversed_order else x
                    actual[active][("point", member, round(x, 9))] += values[1]
                elif fields.get("T") == "UNILOAD" and len(values) == 4:
                    a, b = position(values[0]), position(values[2])
                    qa, qb = values[1], values[3]
                    if reversed_order:
                        a, b, qa, qb = length-b, length-a, qb, qa
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
    differences = []
    for case, rows in expected.items():
        for key in rows.keys() | actual[case].keys():
            # Native decimal representation only; this is not a solve tolerance.
            if not math.isclose(rows[key], actual[case][key], rel_tol=0, abs_tol=1e-8):
                differences.append({"case": case, "target": key, "expected": rows[key], "actual": actual[case][key]})
    if differences:
        raise ValueError("YJK executed loads differ from input / 原生实际荷载与输入不符: " + json.dumps(differences[:12]))
    payload = {"passed": True, "sourceCases": sorted(expected), "nativeCases": by_native,
               "feaSha256": fe["sha256"], "method": "signed-case-target-position-component-readback",
               "selfWeightExcludedFromSourceCases": (model.get("analysis_control") or {}).get("self_weight") is False}
    payload["loadHash"] = hashlib.sha256(json.dumps(model.get("load_cases", []), sort_keys=True).encode()).hexdigest()
    return payload
