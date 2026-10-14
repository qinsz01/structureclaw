"""Exercise official PKPM parameter transport and effective design readback.

This integration check verifies input/result binding; it does not independently
certify PKPM's design formulas. The model and native-design request are explicit
JSON files. All native artifacts remain in a fresh, privately owned directory.
"""
from pathlib import Path
import argparse
import hashlib
import importlib.util
import json
import os
import sys
import time
import uuid


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--request", type=Path, required=True)
    parser.add_argument("--work-root", type=Path, required=True)
    parser.add_argument("--cycle", type=Path, required=True)
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[2]
    skill = repo / "backend/src/agent-skills/analysis/pkpm-static"
    sys.path[:0] = [str(skill), str(skill.parent / "runtime"), str(repo / "backend/src/skill-shared/python")]
    folder = args.work_root.resolve() / ("pkpm-design-parameters-" + time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:8])
    folder.mkdir(parents=True, exist_ok=False)
    model = json.loads(args.model.read_text(encoding="utf-8"))
    request = json.loads(args.request.read_text(encoding="utf-8"))
    def save(name, value):
        path = folder / name
        path.write_text(json.dumps(value, indent=2, ensure_ascii=False), encoding="utf-8")
        return {"path": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
    evidence = {"status": "failed", "scope": "official-parameter-transport-and-effective-design-readback",
                "notIndependentSolverCertification": True, "files": [save("source-model.json", model), save("request.json", request)]}
    os.environ["PKPM_CYCLE_PATH"] = str(args.cycle.resolve())
    os.environ["PKPM_WORK_DIR"] = str(folder)
    try:
        spec = importlib.util.spec_from_file_location("pkpm_parameter_acceptance", skill / "runtime.py")
        runtime = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(runtime)
        result = runtime.run_analysis(model, {"design": request, "loadCaseIds": [row["id"] for row in model["load_cases"]]})
        evidence["files"].append(save("result.json", result))
        design = result["nativeDesignResults"]
        if design["status"] != "completed" or not design["context"]["eligibleForConclusion"]:
            raise ValueError("Native design was not completed")
        evidence.update(status="passed", nativeWorkDir=result["summary"]["work_dir"],
                        effectiveParameters=design["context"]["effectiveParameters"],
                        recordCount=len(design["records"]), checkCount=len(design["checks"]))
    except Exception as error:
        evidence["error"] = f"{type(error).__name__}: {error}"
    save("acceptance.json", evidence)
    print(json.dumps({"directory": str(folder), **evidence}, ensure_ascii=False))
    return 0 if evidence["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
