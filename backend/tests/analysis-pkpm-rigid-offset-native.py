"""Freeze an independent rigid-arm reference, then exercise the public runtime.

Lengths are supplied explicitly before launch; they are never fitted to solver
results. This validates source transport and result coordinates, not PKPM's
automatic choice of engineering rigid-region lengths.
"""
import argparse
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import sys
import time
import uuid

from native_frame_reference import solve


def executed_reference_model(model, lengths, input_readback):
    """Independent piecewise load: executed net-span q, source rigid-arm q.

    Express it as full-length executed q plus the exact integral of the
    source-minus-executed load on each rigid segment. No solver outputs enter.
    """
    import copy
    result = copy.deepcopy(model)
    nodes = {row['id']: [row[k] for k in ('x', 'y', 'z')] for row in model['nodes']}
    members = {row['id']: row for row in model['elements']}
    cases = {row['id']: row for row in result['load_cases']}
    for item in input_readback['loadCompilation']['elementLoads']:
        load = cases[item['loadCaseId']]['loads'][item['sourceLoadIndex']]
        identity = item['elementId']
        if load['element'] != identity or [load.get(k, 0.) for k in ('wx', 'wy', 'wz')] != item['sourceIntensityVectorKnM']:
            raise ValueError('Executed-input reference is bound to another source load')
        source_q = item['sourceIntensityVectorKnM']; actual_q = item['effectiveElasticIntensityVectorKnM']
        if any(source_q[:2]) or any(actual_q[:2]):
            raise ValueError('Executed-input reference covers global vertical loads only')
        for key, value in zip(('wx', 'wy', 'wz'), actual_q):
            load[key] = value
        tags = members[identity]['nodes']; a, b = [nodes[key] for key in tags]
        length = math.dist(a, b); axis = [(y-x)/length for x, y in zip(a, b)]
        for index, distance in enumerate(lengths[identity]):
            force = (source_q[2]-actual_q[2])*distance
            arm = [x*distance/2*(1 if index == 0 else -1) for x in axis]
            cases[item['loadCaseId']]['loads'].append({'type': 'nodal', 'node': tags[index],
                'fz': force, 'mx': arm[1]*force, 'my': -arm[0]*force})
    return result


def verify(model, result, references, lengths):
    failures, counts = [], {"dofs": 0, "endForces": 0, "reactions": 0, "positions": 0}
    def check(category, name, actual, expected, absolute):
        counts[category] += 1
        if not math.isclose(actual, expected, rel_tol=1e-5, abs_tol=absolute):
            failures.append({"field": name, "actual": actual, "expected": expected})
    for case_id, reference in references.items():
        case = result["caseResults"][case_id]
        if not case["nativeContext"]["effectiveRigidOffsets"]["sourceLoadSemanticsPreserved"]:
            raise ValueError("Source load semantics are not verified")
        for node, values in reference["displacements"].items():
            for key, value in values.items():
                check("dofs", f"{case_id}/{node}/{key}", case["displacements"][node][key], value, 1e-11)
        for node, values in case["reactions"].items():
            for key in ("fx", "fy", "fz", "mx", "my", "mz"):
                check("reactions", f"{case_id}/{node}/{key}", values[key], reference["reactions"][node][key], 1e-5)
        for member in model["elements"]:
            identity = str(member["id"])
            stations = case["memberStations"][identity]
            offset = case["nativeContext"]["effectiveRigidOffsets"]["members"][identity]
            ri, rj = lengths.get(identity, [0., 0.])
            for key, actual, expected in (("rigidStart", offset["startLengthM"], ri), ("rigidEnd", offset["endLengthM"], rj)):
                check("positions", identity+"/"+key, actual, expected, 1e-6)
            force = reference["elasticEndActions" if member["type"] == "beam" else "localEndActions"][identity]
            for index, station in ((0, stations[0]), (1, stations[-1])):
                for k, (component, sign) in enumerate(zip(("N", "Vy", "Vz", "T", "My", "Mz"), (-1, 1, 1, -1, -1, -1))):
                    check("endForces", f"{case_id}/{identity}/{index}/{component}", station["components"][component], force[6*index+k]*sign*(1 if index == 0 else -1), 1e-5)
    return {"counts": counts, "failures": failures, "passed": not failures}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--rigid-lengths", type=Path, required=True)
    parser.add_argument("--parameters", type=Path)
    parser.add_argument("--executed-input-readback", type=Path,
        help="Freeze an independently read native input packet before this fresh run; preserve source reference separately")
    parser.add_argument("--work-root", type=Path, required=True)
    parser.add_argument("--cycle", type=Path, required=True)
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[2]
    skill = repo/"backend/src/agent-skills/analysis/pkpm-static"
    sys.path[:0] = [str(skill), str(skill.parent/"runtime"), str(repo/"backend/src/skill-shared/python")]
    folder = args.work_root.resolve()/("pkpm-rigid-offsets-"+time.strftime("%Y%m%d-%H%M%S")+"-"+uuid.uuid4().hex[:8])
    folder.mkdir(parents=True, exist_ok=False)
    model = json.loads(args.model.read_text(encoding="utf8"))
    from structure_protocol.structure_model_v2 import StructureModelV2
    StructureModelV2.model_validate(model)
    lengths = json.loads(args.rigid_lengths.read_text(encoding="utf8"))
    parameters = json.loads(args.parameters.read_text(encoding="utf8")) if args.parameters else {}
    reference_model = json.loads(json.dumps(model))
    for case in reference_model["load_cases"]:
        for load in case["loads"]:
            if load["type"] == "uniform":
                load["type"] = "distributed"
    # Authored selfweight must be present in the independent reference as well.
    if (model.get("analysis_control") or {}).get("self_weight"):
        raise ValueError("This reference fixture must explicitly freeze selfweight loads before extending its scope")
    def save(name, value):
        path = folder/name
        path.write_text(json.dumps(value, indent=2, ensure_ascii=False), encoding="utf8")
        return {"path": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
    source_references = {case["id"]: solve(reference_model, case["id"], rigid_end_lengths=lengths) for case in model["load_cases"]}
    input_readback = json.loads(args.executed_input_readback.read_text(encoding='utf8')) if args.executed_input_readback else None
    if input_readback:
        reference_model = executed_reference_model(reference_model, lengths, input_readback)
    references = {case["id"]: solve(reference_model, case["id"], rigid_end_lengths=lengths) for case in model["load_cases"]}
    evidence = {"status": "reference-frozen", "relativeTolerance": 1e-5, "displacementAbsoluteTolerance": 1e-11,
        "forceAbsoluteTolerance": 1e-5, "files": [save("source-model.json", model), save("parameters.json", parameters),
            save("rigid-lengths.json", lengths), save("reference.json", references)]}
    if input_readback:
        evidence['files'].extend([save('source-reference.json', source_references),
            save('executed-input-reference.json', input_readback), save('executed-reference-model.json', reference_model)])
    save("reference-provenance.json", evidence)
    os.environ["PKPM_CYCLE_PATH"] = str(args.cycle.resolve())
    os.environ["PKPM_WORK_DIR"] = str(folder)
    try:
        spec = importlib.util.spec_from_file_location("pkpm_rigid_acceptance", skill/"runtime.py")
        runtime = importlib.util.module_from_spec(spec); spec.loader.exec_module(runtime)
        result = runtime.run_analysis(model, {"loadCaseIds": [case["id"] for case in model["load_cases"]], **parameters})
        evidence["files"].append(save("result.json", result))
        if input_readback:
            actual = result['nativeContext']['effectiveRigidOffsets']['loadCompilation']['elementLoads']
            expected = input_readback['loadCompilation']['elementLoads']
            fields = ('loadCaseId', 'sourceLoadIndex', 'elementId', 'sourceIntervalM', 'sourceIntensityVectorKnM',
                      'elasticIntervalM', 'effectiveElasticIntensityVectorKnM')
            if len(actual) != len(expected) or any(
                    any(a[k] != e[k] for k in fields) or a['nativeWireReadback']['inputValues'] != e['nativeWireReadback']['inputValues']
                    for a, e in zip(actual, expected)):
                raise ValueError('Fresh executed input differs from frozen input reference')
        checks = verify(model, result, references, lengths)
        if input_readback:
            evidence['sourceReferenceComparison'] = verify(model, result, source_references, lengths)
        evidence.update(status="passed" if checks["passed"] else "failed", checks=checks,
                        nativeWorkDir=result["summary"]["work_dir"])
    except Exception as error:
        evidence.update(status="failed", error=f"{type(error).__name__}: {error}")
    save("acceptance.json", evidence)
    print(json.dumps({"directory": str(folder), **evidence}, ensure_ascii=False))
    return 0 if evidence["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
