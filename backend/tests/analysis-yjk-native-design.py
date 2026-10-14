"""Opt-in SDK integration checks, using only StructureClaw's own frame fixture.

This checks adapter identity, official design fields and failure propagation. It
does not establish design-code validity or compare YJK to a replacement solver.
Set YJKS_ROOT/YJK_PYTHON_BIN to a private installation; the adapter owns each job.
"""
from __future__ import annotations

import argparse
import copy
import importlib.util
import json
import os
from pathlib import Path
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
ADAPTER = ROOT / "backend/src/agent-skills/analysis/yjk-static"
sys.path[:0] = [str(ADAPTER), str(ADAPTER.parent / "runtime"), str(ROOT / "backend/src/skill-shared/python")]


def specimen(kind: str, factor: float = 1.) -> dict:
    model = json.loads((ADAPTER / "__tests__/fixtures/elastic-frame-model.json").read_text("utf-8"))
    model["project"] = {"name": "native-design-" + kind}
    model["coordinate_system"].update(semantics="global-z-up", version=1, plane=None,
        dof_order=["ux", "uy", "uz", "rx", "ry", "rz"])
    concrete = kind == "concrete"
    model["materials"] = [{"id": "M", "name": "C30" if concrete else "Q355", "category": "concrete" if concrete else "steel",
        "grade": "C30" if concrete else "Q355", "E": 30000. if concrete else 206000.,
        "nu": .2 if concrete else .3, "G": 12500. if concrete else 206000./2.6,
        "rho": 2500. if concrete else 7850.}]
    if concrete:
        section = copy.deepcopy(model["sections"][0])
    elif kind == "box":
        b, h, t = .3, .4, .02
        section = {"type": "box", "shape": {"kind": "box", "B": b*1000, "H": h*1000, "t": t*1000},
            "properties": {"A": b*h-(b-2*t)*(h-2*t),
                "Iy": (b*h**3-(b-2*t)*(h-2*t)**3)/12, "Iz": (h*b**3-(h-2*t)*(b-2*t)**3)/12,
                "J": 2*t*(b-t)**2*(h-t)**2/(b+h-2*t), "Asy": 2*b*t, "Asz": 2*h*t}}
    else:
        b, h, tw, tf = .2, .4, .008, .013
        section = {"type": "H", "shape": {"kind": "H", "B": b*1000, "H": h*1000, "tw": tw*1000, "tf": tf*1000},
            "properties": {"A": 2*b*tf+(h-2*tf)*tw, "Iy": (b*h**3-(b-tw)*(h-2*tf)**3)/12,
                "Iz": (2*tf*b**3+(h-2*tf)*tw**3)/12, "J": (2*b*tf**3+(h-2*tf)*tw**3)/3,
                "Asy": 5*(2*b*tf)/6, "Asz": h*tw}}
    model["sections"] = [{**copy.deepcopy(section), "id": key, "name": key} for key in ("SC", "SB")]
    for element in model["elements"]:
        element["section"] = "SC" if element["type"] == "column" else "SB"
    nodal = [{"id": "P-"+node["id"], "type": "nodal", "node": node["id"], "fx": 0., "fy": 0.,
              "fz": -80.*factor, "mx": 0., "my": 0., "mz": 0.}
             for node in model["nodes"] if node["z"] > 0]
    linear = [{"id": "q-"+element["id"], "type": "distributed", "element": element["id"], "wz": -10.*factor}
              for element in model["elements"] if element["type"] == "beam"]
    model["load_cases"] = [{"id": "D", "name": "D", "type": "dead", "loads": nodal},
                           {"id": "L", "name": "L", "type": "live", "loads": linear}]
    model["load_combinations"] = []
    return model


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--native", action="store_true", required=True)
    parser.add_argument("--kind", choices=("concrete", "H", "box"), required=True)
    parser.add_argument("--factor", type=float, default=1.)
    parser.add_argument("--expect-fail", action="store_true")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if not os.environ.get("YJKS_ROOT") or not os.environ.get("YJK_PYTHON_BIN"):
        parser.error("Private YJKS_ROOT and YJK_PYTHON_BIN are required / 须指定独立原生环境")
    work = args.output.resolve() / ("yjk-design-" + time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:8])
    work.mkdir(parents=True)
    os.environ["YJK_WORK_DIR"] = str(work)
    model = specimen(args.kind, args.factor)
    request = {"traceId": "native-design-integration", "design": {"requested": True,
        "mode": "required-reinforcement" if args.kind == "concrete" else "code-check",
        "code": "GB/T50010-2010(2024)" if args.kind == "concrete" else "GB50017-2017",
        "adoptedNativeDefaults": True, "parameters": {"beamCoverMm": 30, "columnCoverMm": 35}},
        "_internalResultSelections": [{"key": "case:"+key, "kind": "case", "id": key} for key in ("D", "L")]}
    for name, value in (("source.json", model), ("request.json", request)):
        (work / name).write_text(json.dumps(value, ensure_ascii=False, indent=2), "utf-8")
    print(work, flush=True)
    spec = importlib.util.spec_from_file_location("native_design_runtime", ADAPTER / "runtime.py")
    runtime = importlib.util.module_from_spec(spec); spec.loader.exec_module(runtime)
    result = runtime.run_analysis(model, request)
    (work / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), "utf-8")
    design, context = result["nativeDesignResults"], result["nativeDesignContext"]
    assert design["status"] == "completed" and context["eligibleForConclusion"] is True
    assert len(list(work.glob("sc_*"))) == 1, "One SDK job must supply the requested set"
    entries = result["nativeResultSet"]["results"]
    assert set(entries) == {"case:D", "case:L"} and all(row["success"] is True for row in entries.values())
    statuses = {status: sum(row["status"] == status for row in design["checks"])
                for status in ("pass", "fail", "not_applicable")}
    assert bool(statuses["fail"]) == args.expect_fail, statuses
    if args.kind == "concrete":
        assert design["records"] and all(row["unit"] == "mm2" for row in design["records"])
    else:
        assert any(row.get("unit") == "MPa" for row in design["checks"])
    summary = {"kind": args.kind, "factor": args.factor, "checkCounts": statuses,
        "recordCount": len(design["records"]), "context": context, "resultSetKeys": list(result["nativeResultSet"]["results"])}
    (work / "acceptance.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), "utf-8")
    print(json.dumps({"status": "passed", "checks": statuses, "workDir": str(work)}), flush=True)


if __name__ == "__main__":
    main()
