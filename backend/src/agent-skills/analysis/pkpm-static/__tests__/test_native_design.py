"""Design truth is bound to native documented fields, not elastic availability."""
from copy import deepcopy
import json
from pathlib import Path
import sys

import pytest

sys.path[:0] = [str(Path(__file__).resolve().parents[1]), str(Path(__file__).resolve().parents[2] / "runtime")]
import pkpm_native_design as design


DATA = json.loads((Path(__file__).parent / "fixtures/native-c30-design.json").read_text(encoding="utf-8"))
REQUEST = {"requested": True, "mode": "required-reinforcement", "code": "PKPM-2025R2.5-native", "adoptedNativeDefaults": True}


def test_ordinary_analysis_does_not_request_design():
    assert design.compile_design_request(None, {}) is None
    assert design.compile_design_request({"requested": False}, {}) is None


@pytest.mark.parametrize("variant", ["normal", "overlimit"])
def test_actual_c30_normal_and_real_limit_failure_survive_normalization(tmp_path, monkeypatch, variant):
    fixture = deepcopy(DATA[variant])
    model = fixture["model"]
    before = deepcopy(model)
    plan = design.compile_design_request(REQUEST, model)
    assert model == before
    monkeypatch.setattr(design, "read_native_design", lambda *_: fixture["raw"])
    (tmp_path / "WMASS.OUT").write_text(fixture["report"], encoding="gb18030")
    for name in ("DATA.SAT", "WPJ1.OUT"):
        (tmp_path / name).write_bytes(b"fixture-artifact")
    result = design.finish_native_design({"nativeDesignContext": {}}, model, plan, tmp_path / "model.JWS", {})
    actual = result["nativeDesignResults"]
    assert len(actual["records"]) == fixture["expected"]["records"]
    assert len(actual["checks"]) == fixture["expected"]["checks"]
    assert sum(row["status"] == "fail" for row in actual["checks"]) == fixture["expected"]["failedChecks"]
    assert actual["context"]["eligibleForConclusion"] is True
    assert all("calculatedArea" not in row for row in actual["records"])
    axial = next(row for row in actual["checks"] if row["elementId"] == "c2" and row["check"] == "axial-compression-ratio")
    raw = fixture["raw"]["c2"]["GetAxialCompresRatio"]
    assert (axial["nativeCombination"]["id"], axial["nativeAxialForce"], axial["demand"], axial["capacity"]) == tuple(raw)


@pytest.mark.parametrize("change,code", [
    (lambda r,m: r.pop("code"), "ANALYSIS_INPUT_REQUIRED"),
    (lambda r,m: r.update(adoptedNativeDefaults=False), "ANALYSIS_INPUT_REQUIRED"),
    (lambda r,m: m["materials"][0].update(G=12500, nu=.2), "ENGINE_INPUT_UNSUPPORTED"),
    (lambda r,m: m["materials"][0].update(design={"fc": 14.3}), "ENGINE_INPUT_UNSUPPORTED"),
    (lambda r,m: r.update(mode="check-provided"), "ANALYSIS_INPUT_REQUIRED"),
])
def test_missing_or_conflicting_inputs_reject_before_native_execution(change, code):
    request, model = deepcopy(REQUEST), deepcopy(DATA["normal"]["model"])
    change(request, model)
    with pytest.raises(design.NativeDesignError) as caught:
        design.compile_design_request(request, model)
    assert caught.value.error_code == code


def test_custom_material_zero_design_is_never_accepted(tmp_path, monkeypatch):
    fixture = deepcopy(DATA["normal"])
    fixture["raw"]["beam0"]["GetTopReinforce"] = [0.] * 9
    monkeypatch.setattr(design, "read_native_design", lambda *_: fixture["raw"])
    (tmp_path / "WMASS.OUT").write_text(fixture["report"], encoding="gb18030")
    with pytest.raises(design.NativeDesignError, match="not calculated"):
        design.finish_native_design({"nativeDesignContext": {}}, fixture["model"],
            design.compile_design_request(REQUEST, fixture["model"]), tmp_path / "model.JWS", {})
