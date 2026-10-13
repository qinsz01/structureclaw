"""Isolated SDK calibration, not a production capability bypass.

References are frozen before creating the native model. The four identical
columns carry identical roof point loads, so the live-load axial response is
P*L/(E*A), independently of the horizontal connecting beams. No existing user
project or GUI is attached. Run manually with the licensed engineering Python.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import sys
import time
import uuid


def save(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False), encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work-root", type=Path, required=True)
    parser.add_argument("--cycle", type=Path)
    parser.add_argument("--timeout", type=int, default=120)
    parser.add_argument("--build-only", action="store_true", help="Verify SDK write/readback without launching SATWE; never accepts numerical capability")
    args = parser.parse_args()
    if not args.build_only and args.cycle is None:
        parser.error("--cycle is required unless --build-only is selected")
    root = args.work_root.resolve() / f"pkpm-axial-{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:8]}"
    root.mkdir(parents=True, exist_ok=False)
    reference = {
        "method": "four equal prismatic columns under equal live nodal compression; u=-PL/EA",
        "E_MPa": 30000, "length_m": 3, "section_m": [0.6, 0.6], "P_kN": 1,
        "displacement_m": -1 * 3 / (30000 * 1000 * 0.6 * 0.6),
        "axial_magnitude_kN": 1, "relative_tolerance": 1e-5, "absolute_tolerance_m": 1e-11,
        "scope": "axial elastic modulus, positive vertical load convention and LL membership only; not G, nu, density or arbitrary frame equivalence",
    }
    save(root / "reference.json", reference)
    evidence = {"status": "failed", "directory": str(root), "referenceSha256": hashlib.sha256((root / "reference.json").read_bytes()).hexdigest(), "numericalCapabilityAccepted": False, "steps": []}
    repo = Path(__file__).resolve().parents[2]
    analysis = repo / "backend/src/agent-skills/analysis"
    sys.path[:0] = [str(analysis / "runtime"), str(analysis / "pkpm-static"), str(repo / "backend/src/skill-shared/python")]
    try:
        import APIPyInterface as api
        from native_loads import plan_native_loads, write_native_loads
        spec = importlib.util.spec_from_file_location("pkpm_calibration_runtime", analysis / "pkpm-static/runtime.py")
        runtime = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(runtime)
        model = api.Model()
        model.CreatNewModel(str(root), "calibration")
        jws = root / "calibration.JWS"
        model.OpenPMModel(str(jws))
        sections = []
        for cls, b, h in ((api.ColumnSection, 600, 600), (api.BeamSection, 300, 500)):
            shape = api.SectionShape()
            shape.Set_B(b); shape.Set_H(h); shape.Set_M(6)
            section = cls(); section.SetUserSect(api.SectionKind.IDSec_Rectangle, shape)
            sections.append(model.AddColumnSection(section) if cls == api.ColumnSection else model.AddBeamSection(section))
        floor = model.GetCurrentStandFloor()
        nodes = [floor.AddNode(x, y) for x, y in ((0, 0), (4000, 0), (4000, 4000), (0, 4000))]
        node_ids = [node.GetID() for node in nodes]
        for node in nodes:
            column = floor.AddColumn(sections[0], node.GetID()); column.SetConcreteGrade(30)
        source_load_model = {"nodes": [{"id": f"N{i}"} for i in range(4)], "load_cases": [{"id": "L", "type": "live",
                             "loads": [{"id": f"P{i}", "type": "nodal", "node": f"N{i}", "fz": -1} for i in range(4)]}]}
        load_mapping = write_native_loads(api, model, plan_native_loads(source_load_model), {("node", f"N{i}"): node for i, node in enumerate(nodes)})
        save(root / "load-mapping.json", load_mapping)
        for start, end in ((0, 1), (1, 2), (2, 3), (3, 0)):
            net = floor.AddLineNet(nodes[start].GetID(), nodes[end].GetID())
            beam = floor.AddBeamEx(sections[1], net.GetID(), 0, 0, 0, 0.0); beam.SetConcreteGrade(30)
        floor.SetDeadLive(0.0, 0.0)
        real = api.RealFloor(); real.SetFloorHeight(3000); real.SetBottomElevation(0); real.SetStandFloorIndex(1)
        model.AddNaturalFloor(real)
        para = model.GetProjectPara()
        settings = {103: 10301, 101: 10101, 601: 60102, 606: 0, 608: 0, 609: 0, 624: 1, 626: 0, 630: 0, 641: 0}
        for key, value in settings.items(): para.SetParaInt(key, value)
        para.SetParaDouble(611, 1.0)
        model.SaveProjectPara(); model.SavePMModel()
        # Model materialization can reset fields: reopen, set, save, then read.
        model.OpenPMModel(str(jws)); floor = model.GetCurrentStandFloor(); floor.SetDeadLive(0.0, 0.0)
        para = model.GetProjectPara()
        for key, value in settings.items(): para.SetParaInt(key, value)
        para.SetParaDouble(611, 1.0)
        model.SaveProjectPara(); model.SavePMModel()
        model.OpenPMModel(str(jws)); floor = model.GetCurrentStandFloor(); para = model.GetProjectPara()
        readback = {"settings": {str(key): para.GetPara_Int(key) for key in settings}, "nodes": [{"id": n.GetID(), "xy_mm": n.Get(), "load": n.GetLoad()} for n in floor.GetNodes()], "loads": [model.GetLoadDefine(row["nativeLoadId"]).Get() for row in load_mapping["loads"]], "grades": [c.GetConcreteGrade() for c in floor.GetColumns()], "floorHeightMm": model.GetFloorAssemTable(1).GetFloorHeight()}
        save(root / "readback-before.json", readback)
        if any(readback["settings"][str(key)] != value for key, value in settings.items()): raise RuntimeError("Native effective settings did not survive save/reopen")
        if readback["grades"] != [30] * 4 or readback["floorHeightMm"] != 3000:
            raise RuntimeError("Native grades or column height did not survive save/reopen")
        native_nodes = {node["id"]: node for node in readback["nodes"]}
        if set(native_nodes) != set(node_ids):
            raise RuntimeError("Native node IDs did not survive save/reopen")
        for index, row in enumerate(load_mapping["loads"]):
            actual = native_nodes[node_ids[index]]["load"]
            if list(actual[0]) != [row["nativeCaseId"]] or list(actual[1]) != [row["nativeLoadId"]]:
                raise RuntimeError("Native live nodal load assignment did not survive save/reopen")
            kind, values = readback["loads"][index]
            if kind != row["elementKind"] or list(values) != row["nativeValues"]:
                raise RuntimeError("Native nodal load magnitude/direction did not survive save/reopen")
        evidence["steps"].append({"name": "native-settings-load-readback", "status": "passed"})
        del model, floor, para
        if args.build_only:
            evidence["status"] = "partial"
            evidence["remaining"] = ["native-solver-response-and-independent-numerical-comparison"]
            save(root / "acceptance.json", evidence)
            print(json.dumps(evidence, ensure_ascii=False))
            return 0
        runtime._run_jws_cycle(args.cycle.resolve(), root, timeout=args.timeout)
        results = runtime._extract_results(jws, "concrete")
        observed = {"LL": [{"node": list(key), **value} for key, value in results["case_node_disps"].get("LL", {}).items()], "stations": [{"case": case, "member": list(key), "stations": rows} for case, members in results["case_member_stations"].items() for key, rows in members.items()]}
        save(root / "observed.json", observed)
        if len(observed["LL"]) != 4: raise RuntimeError("LL must contain four native node translations")
        for row in observed["LL"]:
            if not math.isclose(row["uz"], reference["displacement_m"], rel_tol=reference["relative_tolerance"], abs_tol=reference["absolute_tolerance_m"]):
                raise RuntimeError(f"Native axial displacement {row['uz']} differs from frozen {reference['displacement_m']}")
        evidence["steps"].append({"name": "independent-axial-displacement", "status": "passed", "count": 4})
        evidence["status"] = "passed"
        evidence["numericalCapabilityAccepted"] = True
    except Exception as error:
        evidence["error"] = f"{type(error).__name__}: {error}"
    save(root / "acceptance.json", evidence)
    print(json.dumps(evidence, ensure_ascii=False))
    return 0 if evidence["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
