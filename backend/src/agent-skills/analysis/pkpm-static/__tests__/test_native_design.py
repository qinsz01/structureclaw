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
    (lambda r,m: m["materials"][0].update(fck=20.1), "ENGINE_INPUT_UNSUPPORTED"),
    (lambda r,m: r.update(parameters={"beamStirrupSpacingMm": 80}), "ENGINE_INPUT_UNSUPPORTED"),
    (lambda r,m: r.update(parameters={"beamMainRebarGrade": "HRB335"}), "ENGINE_INPUT_UNSUPPORTED"),
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


def test_explicit_member_grades_are_consumed_only_without_conflicts():
    model = deepcopy(DATA["normal"]["model"])
    for member in model["elements"]:
        member["design"] = {"rebar_grade": "HRB400"}
    before = deepcopy(model)
    plan = design.compile_design_request(REQUEST, model)
    assert plan["parameters"]["beamMainRebarGrade"]["requested"] == "HRB400"
    assert plan["parameters"]["columnMainRebarGrade"]["requested"] == "HRB400"
    assert model == before
    with pytest.raises(design.NativeDesignError, match="conflicts"):
        design.compile_design_request({**REQUEST, "parameters": {"beamMainRebarGrade": "HRB500"}}, model)


def test_native_rebar_model_enum_and_result_enum_are_not_interchanged():
    model = deepcopy(DATA["normal"]["model"])
    request = {**REQUEST, "parameters": {"beamStirrupGrade": "HPB300", "columnStirrupGrade": "HRB400", "beamCoverMm": 40}}
    plan = design.compile_design_request(request, model)
    assert plan["parameters"]["beamStirrupGrade"]["nativeValue"] == 12
    assert plan["parameters"]["beamStirrupGrade"]["expectedEffectiveValue"] == 270
    assert plan["parameters"]["beamCoverMm"]["nativeValue"] == 40


def test_hrb500_uses_official_data_api_code_not_interchange_enum():
    model = deepcopy(DATA["normal"]["model"])
    request = {**REQUEST, "parameters": {"beamMainRebarGrade": "HRB500", "columnMainRebarGrade": "HRB500"}}
    plan = design.compile_design_request(request, model)
    for field in request["parameters"]:
        assert plan["parameters"][field]["nativeValue"] == 13
        assert plan["parameters"][field]["expectedEffectiveValue"] == 435
    assert design.MODEL_REBAR["HRB500"] == 13


def test_hrb500_result_cannot_pass_with_native_default_hrb400(tmp_path, monkeypatch):
    fixture = deepcopy(DATA["normal"])
    monkeypatch.setattr(design, "read_native_design", lambda *_: fixture["raw"])
    (tmp_path / "WMASS.OUT").write_text(fixture["report"], encoding="gb18030")
    request = {**REQUEST, "parameters": {"beamMainRebarGrade": "HRB500"}}
    with pytest.raises(design.NativeDesignError, match="did not persist|differs"):
        design.finish_native_design({"nativeDesignContext": {}}, fixture["model"],
            design.compile_design_request(request, fixture["model"]), tmp_path / "model.JWS", {})


def test_actual_hrb500_effective_parameters_and_reinforcement_are_preserved(tmp_path, monkeypatch):
    fixture = json.loads((Path(__file__).parent / "fixtures/native-hrb500-design.json").read_text(encoding="utf-8"))
    monkeypatch.setattr(design, "read_native_design", lambda *_: fixture["raw"])
    (tmp_path / "WMASS.OUT").write_text(fixture["report"], encoding="gb18030")
    (tmp_path / "WPJ1.OUT").write_text("\n".join(fixture["memberDesignParameterLines"]), encoding="gb18030")
    (tmp_path / "DATA.SAT").write_bytes(b"native-fixture")
    (tmp_path / "native-design-parameter-readback.json").write_text(json.dumps(fixture["readback"]))
    plan = design.compile_design_request(fixture["request"], fixture["model"])
    output = design.finish_native_design({"nativeDesignContext": {}}, fixture["model"], plan, tmp_path / "model.JWS", {})["nativeDesignResults"]
    assert len(output["records"]) == fixture["expected"]["records"]
    assert len(output["checks"]) == fixture["expected"]["checks"]
    assert len(fixture["memberDesignParameterLines"]) == len(fixture["model"]["elements"])
    for key in ("beamMainRebarGrade", "columnMainRebarGrade"):
        assert output["context"]["effectiveParameters"][key]["value"] == 435
        assert fixture["readback"]["floors"][0]["parameters"][key] == 13
    assert any(row["path"].endswith("native-design-parameter-readback.json") for row in output["context"]["evidence"])


@pytest.mark.parametrize("variant", ["normal", "overlimit"])
def test_actual_q355_ratios_and_native_limit_reports_are_both_retained(tmp_path, monkeypatch, variant):
    fixtures = json.loads((Path(__file__).parent / "fixtures/native-q355-design.json").read_text(encoding="utf-8"))
    data = fixtures[variant]
    plan = design.compile_design_request({**REQUEST, "mode": "code-check", "code": "GB50017-2017"}, data["model"])
    monkeypatch.setattr(design, "read_native_design", lambda *_: data["raw"])
    (tmp_path / "WMASS.OUT").write_text(data["report"], encoding="gb18030")
    for name in ("DATA.SAT", "WPJ1.OUT"):
        (tmp_path / name).write_bytes(b"fixture-artifact")
    result = design.finish_native_design({"nativeDesignContext": {}}, data["model"], plan, tmp_path / "model.JWS", {})
    checks = result["nativeDesignResults"]["checks"]
    assert len(checks) == 24
    assert sum(row["status"] == "fail" for row in checks if row["check"] == "native-design-limit-report") == data["expected"]["nativeLimitFailures"]
    ratios = [row for row in checks if row["check"] != "native-design-limit-report"]
    assert sum(row["status"] == "fail" for row in ratios) == (16 if variant == "overlimit" else 0)
    assert all(row["unit"] == "ratio" and row["capacity"] == 1 for row in ratios)


@pytest.mark.parametrize("change_report", [False, True])
def test_actual_c35_explicit_parameters_must_survive_native_readback(tmp_path, monkeypatch, change_report):
    data = json.loads((Path(__file__).parent / "fixtures/native-c35-design-parameters.json").read_text(encoding="utf-8"))
    plan = design.compile_design_request(data["request"], data["model"])
    assert {row["grade"] for row in plan["materials"].values()} == {"C35"}
    assert all(row["G"] == 12600 for row in plan["materials"].values())
    monkeypatch.setattr(design, "read_native_design", lambda *_: data["raw"])
    report = data["report"]
    if change_report:
        import re
        report, changed = re.subn(r"(\bBCB\s*=\s*)[0-9.]+", r"\g<1>30", report)
        assert changed == 1
    (tmp_path / "WMASS.OUT").write_text(report, encoding="gb18030")
    for name in ("DATA.SAT", "WPJ1.OUT"):
        (tmp_path / name).write_bytes(b"fixture-artifact")
    if change_report:
        with pytest.raises(design.NativeDesignError, match="beamCoverMm"):
            design.finish_native_design({"nativeDesignContext": {}}, data["model"], plan, tmp_path / "model.JWS", {})
        return
    result = design.finish_native_design({"nativeDesignContext": {}}, data["model"], plan, tmp_path / "model.JWS", {})
    effective = result["nativeDesignResults"]["context"]["effectiveParameters"]
    assert set(effective) == set(data["request"]["parameters"])
    for key, row in effective.items():
        assert row["requested"] == data["request"]["parameters"][key]
        assert row["value"] == plan["parameters"][key]["expectedEffectiveValue"]
        assert row["origin"] == "explicit"
    assert effective["beamStirrupGrade"]["value"] == 270
    assert effective["columnStirrupGrade"]["value"] == 360
