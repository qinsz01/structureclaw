"""Run frozen physical references through the production PKPM entry point.

From the repository root, using the installed PKPM Python environment:
  python backend/tests/analysis-pkpm-representative-native.py --case STD-086
    --work-root <isolated-work-root> --cycle <installation>/PkpmCycle/JWSCYCLE.exe
Add --three-cases --combination for independently frozen D/L/W/ULS checks.
Use --case INT-089 --state 1|2 --planned-proxy or --case MM-089
--planned-proxy for explicitly defined capability proxies, not benchmark truths.

Every invocation freezes model, independent reference and tolerances before the
candidate runs, retains all native files, and exits nonzero on any missing or
failed physical quantity. Diagnostic numerical switches affect only that fresh
project directory; neither installation settings nor old evidence are changed.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import sys
import time
import uuid


def external_resultant(model, case):
    nodes = {row["id"]: [row[key] for key in ("x", "y", "z")] for row in model["nodes"]}
    members = {row["id"]: row for row in model["elements"]}
    vectors = []
    for load in case["loads"]:
        if load.get("reference_frame", "global") != "global":
            raise ValueError("Reference equilibrium requires explicit global load components")
        if load["type"] == "nodal":
            point = nodes[load["node"]]
            force = [load.get(key, 0.) for key in ("fx", "fy", "fz")]
            moment = [load.get(key, 0.) for key in ("mx", "my", "mz")]
        elif load["type"] == "distributed":
            member = members[load["element"]]
            first, last = (nodes[key] for key in member["nodes"])
            length = math.dist(first, last)
            if load.get("start", 0) != 0 or load.get("end", length) != length:
                raise ValueError("Reference equilibrium currently requires full-span line loads")
            point = [(a+b)/2 for a, b in zip(first, last)]
            force = [load.get(key, 0.)*length for key in ("wx", "wy", "wz")]
            moment = [0.] * 3
        else:
            raise ValueError("Unsupported reference equilibrium load")
        cross = [point[1]*force[2]-point[2]*force[1], point[2]*force[0]-point[0]*force[2], point[0]*force[1]-point[1]*force[0]]
        vectors.append(force + [a+b for a, b in zip(moment, cross)])
    return [math.fsum(row[index] for row in vectors) for index in range(6)]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--case", required=True)
    parser.add_argument("--state", type=int, default=1)
    parser.add_argument("--work-root", type=Path, required=True)
    parser.add_argument("--cycle", required=True)
    parser.add_argument("--three-cases", action="store_true", help="Independent D/L/W variant; original fixture is unchanged")
    parser.add_argument("--native-solver", type=int, choices=(0, 1, 2, 3), help="Diagnostic PKPM 621 enum: Pardiso/Mumps/VSS/LDLT")
    parser.add_argument("--native-switch", choices=("SOV_DOUBLE.OUT", "READDISPDIRECT.OUT", "OPTIMIZELOOPREAD4_TO_REAL8.OUT", "OPTIMIZELOOPREAD4_TO_REAL8_2.OUT"), action="append", default=[], help="Diagnostic native numerical switch in the isolated project only")
    parser.add_argument("--combination", action="store_true", help="Request ULS after native source cases are solved")
    parser.add_argument("--planned-proxy", action="store_true", help="Use explicit INT089/MM089 capability proxy, not formal benchmark input")
    parser.add_argument("--model-file", type=Path, help="Explicit independent capability model; not benchmark scoring truth")
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[2]
    fixture = repo / "tests/llm-benchmark/acceptance/representative-18" / ("STD-086" if args.planned_proxy or args.model_file else args.case)
    root = args.work_root.resolve() / f"pkpm-{args.case}-{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:8]}"
    root.mkdir(parents=True, exist_ok=False)
    source = args.model_file.resolve() if args.model_file else fixture / f"model-state-{1 if args.planned_proxy else args.state}.json"
    model = json.loads(source.read_text(encoding="utf-8"))
    if args.planned_proxy:
        from pkpm_planned_frame_proxies import model as planned_model
        model = planned_model(args.case, args.state)
    if args.three_cases:
        dead = copy.deepcopy(model["load_cases"][0]); dead.update(id="D", type="dead")
        live = copy.deepcopy(dead); live.update(id="L", type="live")
        for load in live["loads"]:
            for key in ("fx", "fy", "fz", "mx", "my", "mz", "wx", "wy", "wz"):
                if key in load: load[key] *= .375
        top = max(model["nodes"], key=lambda node: (node["z"], node["x"], node["y"]))
        wind = {"id": "W", "type": "wind", "loads": [{"id": "wind-asymmetric", "type": "nodal", "node": top["id"], "fx": 13., "fy": -7., "fz": 0., "mx": 2., "my": -3., "mz": 1.}]}
        model["load_cases"] = [dead, live, wind]
        model["load_combinations"] = [{"id": "ULS", "factors": {"D": 1.2, "L": 1.4, "W": -.8}}]
    (root / "frozen-source-model.json").write_text(json.dumps(model, indent=2), encoding="utf-8")
    reference = json.loads((fixture / "independent-reference.json").read_text(encoding="utf-8"))
    from native_frame_reference import solve
    timo_reference = {str(case["id"]): solve(model, str(case["id"])) for case in model["load_cases"]}
    reference_cases = copy.deepcopy(model["load_cases"])
    if args.combination:
        definition = next(row for row in model["load_combinations"] if row["id"] == "ULS")
        combined_loads = []
        for case in model["load_cases"]:
            for load in case["loads"]:
                scaled = copy.deepcopy(load)
                scaled["id"] = f"{case['id']}:{load['id']}"
                for key in ("fx", "fy", "fz", "mx", "my", "mz", "wx", "wy", "wz"):
                    if key in scaled: scaled[key] *= definition["factors"][case["id"]]
                combined_loads.append(scaled)
        reference_cases.append({"id": "ULS", "type": "dead", "loads": combined_loads})
        timo_reference["ULS"] = solve({**model, "load_cases": reference_cases}, "ULS")
    timo_reference["externalResultants"] = {case["id"]: external_resultant(model, case) for case in reference_cases}
    timo_reference["tolerance"] = {"relative": 1e-5, "translationM": 1e-11, "rotationRad": 1e-11, "forceKN": 1e-5, "momentKNm": 1e-5}
    (root / "frozen-timoshenko-reference.json").write_text(json.dumps(timo_reference, indent=2), encoding="utf-8")
    evidence = {"status": "failed", "case": args.case, "state": args.state, "directory": str(root),
        "sourceSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        "frozenModelSha256": hashlib.sha256((root / "frozen-source-model.json").read_bytes()).hexdigest(),
        "plannedCapabilityProxy": args.planned_proxy,
        "explicitCapabilityModel": bool(args.model_file),
        "referenceSha256": hashlib.sha256((fixture / "independent-reference.json").read_bytes()).hexdigest(),
        "timoshenkoReferenceSha256": hashlib.sha256((root / "frozen-timoshenko-reference.json").read_bytes()).hexdigest(),
        "referenceKind": reference["referenceKind"], "notCommercialScoringTruth": True}
    (root / "reference-provenance.json").write_text(json.dumps(evidence, indent=2), encoding="utf-8")
    analysis = repo / "backend/src/agent-skills/analysis"
    sys.path[:0] = [str(analysis / "runtime"), str(analysis / "pkpm-static"), str(repo / "backend/src/skill-shared/python")]
    os.environ["PKPM_CYCLE_PATH"] = args.cycle
    os.environ["PKPM_WORK_DIR"] = str(root)
    try:
        spec = importlib.util.spec_from_file_location("pkpm_native_runtime", analysis / "pkpm-static/runtime.py")
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        if args.native_solver is not None or args.native_switch:
            import APIPyInterface as api
            import pkpm_converter
            convert = pkpm_converter.convert_v2_to_jws
            def solver_selection(*values, **kwargs):
                jws, mapping = convert(*values, **kwargs)
                if args.native_solver is not None:
                    native = api.Model(); native.OpenPMModel(str(jws))
                    para = native.GetProjectPara(); para.SetParaInt(621, args.native_solver)
                    native.SaveProjectPara(); native.SavePMModel()
                    if para.GetPara_Int(621) != args.native_solver:
                        raise ValueError("Native solver selection readback differs")
                    evidence["nativeSolverRequest"] = args.native_solver
                if args.native_switch:
                    Path(jws).with_name("NewFunctionSwitch_SAT.IN").write_text("\n".join(args.native_switch)+"\n", encoding="ascii")
                    evidence["nativeNumericalSwitches"] = {"file": "NewFunctionSwitch_SAT.IN", "values": args.native_switch}
                return jws, mapping
            pkpm_converter.convert_v2_to_jws = solver_selection
        case_ids = [str(case["id"]) for case in model["load_cases"]]
        selection = {"loadCombinationId": "ULS"} if args.combination else {"loadCaseIds": case_ids}
        result = module.run_analysis(model, {"timeout": 120, **selection})
        (root / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        comparisons, missing, failures = [], [], []
        state = {"quantities": []} if args.planned_proxy or args.model_file else next(row for row in reference["states"] if row["state"] == args.state)
        for quantity in state["quantities"]:
            if quantity["location"]["kind"] != "node":
                continue
            selection = quantity["selection"]
            values = result["caseResults"].get(selection["id"], {}).get("displacements", {})
            actual = values.get(quantity["location"]["id"], {}).get(quantity["component"])
            if actual is None:
                missing.append(quantity["id"]); continue
            tol = quantity["tolerance"]
            passed = math.isclose(actual, quantity["value"], rel_tol=tol["relative"], abs_tol=tol["absolute"])
            item = {"id": quantity["id"], "actual": actual, "reference": quantity["value"], "tolerance": tol, "passed": passed}
            comparisons.append(item)
            if not passed: failures.append(item)
        evidence.update(status="native-completed", nativeWorkDir=result["summary"]["work_dir"],
            comparisons=comparisons, missingNodeQuantities=missing, discrepancies=failures,
            numericalCapabilityAccepted=None if args.planned_proxy or args.model_file else not missing and not failures)
        timo_checks = []
        all_results = {**result["caseResults"], **result.get("combinationResults", {})}
        for case_id, actual_case in all_results.items():
            for node_id, actual_row in actual_case["displacements"].items():
                for component, value in actual_row.items():
                    if component not in ("ux", "uy", "uz", "rx", "ry", "rz"): continue
                    expected = timo_reference[case_id]["displacements"][node_id][component]
                    timo_checks.append({"node": node_id, "case": case_id, "component": component,
                        "actual": value, "reference": expected,
                        "passed": math.isclose(value, expected, rel_tol=1e-5, abs_tol=1e-11)})
        evidence["timoshenkoChecks"] = timo_checks
        evidence["timoshenkoPassed"] = all(row["passed"] for row in timo_checks)
        force_checks = []
        for case_id, actual_case in all_results.items():
            for node_id, actual_row in actual_case.get("reactions", {}).items():
                for component in ("fx", "fy", "fz", "mx", "my", "mz"):
                    expected = timo_reference[case_id]["reactions"][node_id][component]
                    value = actual_row[component]
                    force_checks.append({"node": node_id, "case": case_id, "component": component,
                        "actual": value, "reference": expected,
                        "passed": math.isclose(value, expected, rel_tol=1e-5, abs_tol=1e-5)})
            for member_id, rows in actual_case.get("memberStations", {}).items():
                if not rows or "positionM" not in rows[0]: continue
                reference_ends = timo_reference[case_id]["localEndActions"][member_id]
                for end, row in ((0, rows[0]), (1, rows[-1])):
                    signs = (-1, 1, 1, -1, -1, -1) if end == 0 else (1, -1, -1, 1, 1, 1)
                    for index, component in enumerate(("N", "Vy", "Vz", "T", "My", "Mz")):
                        expected = signs[index] * reference_ends[end * 6 + index]
                        value = row["components"][component]
                        force_checks.append({"member": member_id, "end": end, "case": case_id, "component": component,
                            "actual": value, "reference": expected,
                            "passed": math.isclose(value, expected, rel_tol=1e-5, abs_tol=1e-5)})
        evidence["timoshenkoForceChecks"] = force_checks
        evidence["timoshenkoForcesPassed"] = bool(force_checks) and all(row["passed"] for row in force_checks)
        balance_checks = []
        nodes = {row["id"]: row for row in model["nodes"]}
        for case_id, actual_case in all_results.items():
            reaction_vectors = []
            for node_id, row in actual_case["reactions"].items():
                node = nodes[node_id]
                reaction_vectors.append([row["fx"], row["fy"], row["fz"], row["mx"]+node["y"]*row["fz"]-node["z"]*row["fy"],
                    row["my"]+node["z"]*row["fx"]-node["x"]*row["fz"], row["mz"]+node["x"]*row["fy"]-node["y"]*row["fx"]])
            for index, component in enumerate(("fx", "fy", "fz", "mx", "my", "mz")):
                actual = math.fsum(row[index] for row in reaction_vectors)
                expected = -timo_reference["externalResultants"][case_id][index]
                balance_checks.append({"case": case_id, "component": component, "actual": actual, "reference": expected,
                    "passed": math.isclose(actual, expected, rel_tol=1e-5, abs_tol=1e-5)})
        evidence["equilibriumChecks"] = balance_checks
        evidence["equilibriumPassed"] = all(row["passed"] for row in balance_checks)
        evidence["completePhysicalOutputAccepted"] = (result.get("capabilityStatus") == "complete"
            and evidence["timoshenkoPassed"] and evidence["timoshenkoForcesPassed"] and evidence["equilibriumPassed"])
    except Exception as exc:
        evidence["error"] = f"{type(exc).__name__}: {exc}"
    (root / "acceptance.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({key: value for key, value in evidence.items() if key not in {"comparisons", "discrepancies", "missingNodeQuantities", "timoshenkoChecks", "timoshenkoForceChecks", "equilibriumChecks"}}, ensure_ascii=False))
    return 0 if evidence.get("completePhysicalOutputAccepted") is True else 1


if __name__ == "__main__":
    raise SystemExit(main())
