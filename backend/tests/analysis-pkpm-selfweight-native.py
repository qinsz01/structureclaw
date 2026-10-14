"""Exercise native selfweight transport with explicit source files, without Bench."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import time
import uuid


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--parameters", type=Path, required=True)
    parser.add_argument("--work-root", type=Path, required=True)
    parser.add_argument("--cycle", type=Path, required=True)
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[2]
    skill = repo / "backend/src/agent-skills/analysis/pkpm-static"
    sys.path[:0] = [str(skill), str(skill.parent / "runtime"), str(repo / "backend/src/skill-shared/python")]
    folder = args.work_root.resolve() / ("pkpm-selfweight-" + time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:8])
    folder.mkdir(parents=True, exist_ok=False)
    model = json.loads(args.model.read_text(encoding="utf8"))
    parameters = json.loads(args.parameters.read_text(encoding="utf8"))
    def save(name, value):
        path = folder / name
        path.write_text(json.dumps(value, indent=2, ensure_ascii=False), encoding="utf8")
        return {"path": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
    receipt = {"status": "failed", "scope": "official-selfweight-transport-and-result-binding",
               "notIndependentSolverCertification": True, "files": [save("source-model.json", model), save("parameters.json", parameters)]}
    os.environ["PKPM_CYCLE_PATH"] = str(args.cycle.resolve())
    os.environ["PKPM_WORK_DIR"] = str(folder)
    try:
        spec = importlib.util.spec_from_file_location("pkpm_selfweight_acceptance", skill / "runtime.py")
        runtime = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(runtime)
        result = runtime.run_analysis(model, parameters)
        receipt["files"].append(save("result.json", result))
        weight = result["nativeContext"]["effectiveLoads"]
        if weight.get("verified") is not True or not weight["selfWeight"]["enabled"]:
            raise ValueError("Selfweight was not verified")
        receipt.update(status="passed", nativeWorkDir=result["summary"]["work_dir"],
            selectedResult=result["selectedResult"], memberCount=len(weight["selfWeight"]["members"]),
            cases=list(result["caseResults"]), sourceCase=weight["selfWeight"]["loadCaseId"],
            intensityVectors={row["elementId"]: row["intensityVectorKnM"] for row in weight["selfWeight"]["members"]},
            reactionSums={key: {component: sum(row[component] for row in case["reactions"].values())
                for component in ("fx", "fy", "fz")} for key, case in result["caseResults"].items()})
    except Exception as error:
        receipt["error"] = f"{type(error).__name__}: {error}"
    save("acceptance.json", receipt)
    print(json.dumps({"directory": str(folder), **receipt}, ensure_ascii=False))
    return 0 if receipt["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
