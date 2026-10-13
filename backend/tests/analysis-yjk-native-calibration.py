"""Isolated YJK frame readback/solver probe; does not authorize formal V2 physics.

Uses a private installation and a contained process tree, never an API service
or existing GUI. Reference geometry and grades are frozen before native launch.
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import sqlite3
import sys
import time
import uuid


def write(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def reference(model):
    nodes = {n["id"]: tuple(n[c] * 1000 for c in ("x", "y", "z")) for n in model["nodes"]}
    sections = {s["id"]: s["shape"] for s in model["sections"]}
    materials = {m["id"]: int(m["grade"][1:]) for m in model["materials"]}
    return [{"id": e["id"], "role": e["type"], "endpointsMm": [nodes[n] for n in e["nodes"]],
             "shapeMm": [sections[e["section"]][key] for key in ("B", "H")],
             "grade": materials[e["material"]]} for e in model["elements"]]


def readback(path, expected):
    """Match physical endpoints, independent of SDK IDs or input mapping.json."""
    with sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True) as db:
        db.row_factory = sqlite3.Row
        floors = list(db.execute("SELECT * FROM tblFloor ORDER BY LevelB"))
        joints = {r["ID"]: r for r in db.execute("SELECT * FROM tblJoint")}
        grids = {r["ID"]: r for r in db.execute("SELECT * FROM tblGrid")}
        actual = []
        for floor in floors:
            bottom, height = float(floor["LevelB"]), float(floor["Height"])
            for role, table, section_table, grade_index in (
                ("column", "tblColSeg", "tblColSect", 4), ("beam", "tblBeamSeg", "tblBeamSect", 5),
            ):
                for member in db.execute(f"SELECT * FROM {table} WHERE StdFlrID=?", (floor["StdFlrID"],)):
                    section = db.execute(f"SELECT * FROM {section_table} WHERE ID=?", (member["SectID"],)).fetchone()
                    if section["Mat"] != 6 or section["Kind"] != 1:
                        raise ValueError("Expected native rectangular RC member")
                    if role == "column":
                        j = joints[member["JtID"]]
                        endpoints = [(j["X"], j["Y"], bottom), (j["X"], j["Y"], bottom + height)]
                    else:
                        grid = grids[member["GridID"]]
                        endpoints = [(joints[grid[k]]["X"], joints[grid[k]]["Y"], bottom + height)
                                     for k in ("Jt1ID", "Jt2ID")]
                    grade_rows = list(db.execute("SELECT ShapeVal FROM tblProperty WHERE ID=? AND Name='HNTDJ'", (member["ID"],)))
                    if len(grade_rows) != 1:
                        raise ValueError("Explicit per-member concrete grade was lost")
                    actual.append({"role": role, "endpointsMm": endpoints,
                                   "shapeMm": [section["b"], section["h"]], "grade": float(grade_rows[0][0])})
        def key(row):
            return (row["role"], tuple(sorted(tuple(p) for p in row["endpointsMm"])),
                    tuple(row["shapeMm"]), row["grade"])
        if Counter(map(key, actual)) != Counter(map(key, expected)):
            raise ValueError("Native geometry, sections or per-member grades differ from frozen input")
        return {"path": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                "memberCount": len(actual), "floorCount": len(floors), "members": actual}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--installation", type=Path, required=True)
    parser.add_argument("--python", type=Path, required=True)
    parser.add_argument("--work-root", type=Path, required=True)
    parser.add_argument("--timeout", type=int, default=240)
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[2]
    adapter = repo / "backend/src/agent-skills/analysis/yjk-static"
    sys.path.insert(0, str(adapter))
    from windows_job import run_contained_driver
    spec = importlib.util.spec_from_file_location("fixture", Path(__file__).with_name("analysis-commercial-native-acceptance.py"))
    fixture = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fixture)
    model = fixture.representative_model()
    model["project"]["name"] = "frame"
    model["materials"].append({"id": "M40", "name": "C40", "grade": "C40", "category": "concrete"})
    model["elements"][0]["material"] = "M40"
    work = args.work_root.resolve() / ("yjk-frame-" + time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6])
    work.mkdir(parents=True, exist_ok=False)
    expected = reference(model)
    write(work / "input.json", model)
    # Independent dead-load balance for this diagnostic native-default model:
    # columns + 6 lower/4 upper beams + two 16 m², 100 mm panels at 25 kN/m³,
    # plus 2 kN/m² superimposed dead load. These explicit native assumptions
    # are NOT a general V2 frame/slab equivalence claim.
    dead_reaction = 25 * (10*.36*3 + 6*4*.3*.5 + 4*4*.25*.45 + 2*16*.1) + 2*16*2
    write(work / "reference.json", {"scope": "geometry-grade-and-native-default-dead-balance", "members": expected,
                                   "deadReactionKn": dead_reaction, "absoluteReactionToleranceKn": 1e-5,
                                   "nativeAssumptions": {"panelThicknessMm": 100, "panelAreasM2": [16, 16],
                                                         "concreteUnitWeightKnM3": 25},
                                   "formalV2AnalysisAccepted": False, "frozenAt": time.time()})
    print(work, flush=True)
    env = dict(os.environ, YJK_PATH=str(args.installation.resolve()), YJKS_ROOT=str(args.installation.resolve()),
               YJK_INVISIBLE="1", YJK_VERSION="8.0.0", PYTHONDONTWRITEBYTECODE="1",
               SC_YJK_SELECTED_CASE=json.dumps({"id": "D", "labels": ["DL"]}))
    evidence = {"status": "failed", "formalV2AnalysisAccepted": False, "workDirectory": str(work)}
    try:
        with (work / "stdout.log").open("w", encoding="utf-8") as out, (work / "stderr.log").open("w", encoding="utf-8") as err:
            code = run_contained_driver([str(args.python.resolve()), "-u", str(adapter / "yjk_driver.py"),
                                         str(work / "input.json"), str(work)],
                                        work_dir=work, env=env, stdout=out, stderr=err, timeout=args.timeout)
        evidence["driverExitCode"] = code
        evidence["exchangeReadback"] = readback(work / "frame.ydb", expected)
        if (work / "frame.ymd").is_file():
            evidence["savedModelReadback"] = readback(work / "frame.ymd", expected)
        output = work / "driver-output.json"
        result = json.loads(output.read_text(encoding="utf-8")) if output.is_file() else {}
        evidence["driverStatus"] = result.get("status")
        evidence["driverDetail"] = result.get("detailed", {}).get("error")
        if code == 0 and result.get("status") == "success" and "savedModelReadback" in evidence:
            if set(result.get("caseResults", {})) != {"D"}:
                raise ValueError("Requested dead case was not selected exactly")
            base = {n["id"] for n in model["nodes"] if n["z"] == 0}
            reactions = result["caseResults"]["D"]["reactions"]
            actual = sum(reactions[n]["fz"] for n in base)
            if not math.isfinite(actual) or abs(actual - dead_reaction) > 1e-5:
                raise ValueError(f"Dead reaction balance differs: {actual} vs {dead_reaction} kN")
            evidence["deadLoadBalance"] = {"expectedKn": dead_reaction, "actualKn": actual,
                                           "absoluteToleranceKn": 1e-5, "status": "passed"}
            evidence["status"] = "passed"
    except Exception as exc:
        evidence["error"] = str(exc)
    write(work / "acceptance.json", evidence)
    print(json.dumps({k: v for k, v in evidence.items() if not k.endswith("Readback")}, ensure_ascii=False), flush=True)
    return 0 if evidence["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
