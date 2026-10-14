"""The standalone capability harness must fail if native outputs disappear."""
import copy
import importlib.util
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location("pkpm_capability_acceptance", Path(__file__).with_name("analysis-pkpm-representative-native.py"))
acceptance = importlib.util.module_from_spec(spec)
spec.loader.exec_module(acceptance)


def fixture():
    model = {"nodes": [{"id": "a", "x": 0., "y": 0., "z": 0., "restraints": [True]*6},
                       {"id": "b", "x": 0., "y": 0., "z": 3., "restraints": [False]*6}],
             "elements": [{"id": "c", "nodes": ["a", "b"]}]}
    results = {"D": {"displacements": {key: dict.fromkeys(("ux", "uy", "uz", "rx", "ry", "rz"), 0.) for key in ("a", "b")},
                     "reactions": {"a": dict.fromkeys(("fx", "fy", "fz", "mx", "my", "mz"), 0.)},
                     "memberStations": {"c": [{"positionM": x, "components": dict.fromkeys(("N", "Vy", "Vz", "T", "My", "Mz"), 0.)} for x in (0., 3.)]}}}
    return model, results


def test_complete_physical_coverage():
    model, results = fixture()
    original = copy.deepcopy(results)
    acceptance.require_complete_output(model, results, ["D"])
    assert results == original


@pytest.mark.parametrize("missing", ["case", "node", "rotation", "reaction", "member", "end", "position", "component"])
def test_missing_output_never_passes(missing):
    model, results = fixture()
    case = results["D"]
    if missing == "case": results.clear()
    elif missing == "node": del case["displacements"]["b"]
    elif missing == "rotation": del case["displacements"]["b"]["ry"]
    elif missing == "reaction": del case["reactions"]["a"]
    elif missing == "member": del case["memberStations"]["c"]
    elif missing == "end": case["memberStations"]["c"].pop()
    elif missing == "position": case["memberStations"]["c"][-1]["positionM"] = 2.9
    elif missing == "component": del case["memberStations"]["c"][0]["components"]["N"]
    with pytest.raises(ValueError):
        acceptance.require_complete_output(model, results, ["D"])
