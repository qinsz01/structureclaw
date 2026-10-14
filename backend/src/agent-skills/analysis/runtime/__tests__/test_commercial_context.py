import copy
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from commercial_context import project_commercial_model, build_native_design_context
from commercial_context import attach_native_result_set


def test_native_result_set_projects_one_job_without_mutating_source_or_cross_case_contamination():
    model = {"load_cases": [{"id": "D"}, {"id": "L"}],
             "load_combinations": [{"id": "U", "factors": {"D": 1.2, "L": 1.4}}]}
    source_result = {"caseResults": {"D": {"value": 2}, "L": {"value": 3}}, "summary": {"nativeProject": "owned.jws"}}
    before = copy.deepcopy(source_result)
    def select(output, cases, combo):
        value = sum(output["caseResults"][key]["value"] * (combo["factors"][key] if combo else 1) for key in cases)
        output["caseResults"]["D"]["value"] = 999
        output.update(value=value, selectedResult={"kind": "combination" if combo else "case", "id": combo["id"] if combo else cases[0]})
        return output
    params = {"_internalResultSelections": [{"key": f"{kind}:{identity}", "kind": kind, "id": identity}
              for kind, identity in [("case", "D"), ("case", "L"), ("combination", "U")]]}
    result = attach_native_result_set(source_result, model, params, select)
    entries = result["nativeResultSet"]["results"]
    assert entries["case:D"]["data"]["value"] == 2
    assert entries["case:L"]["data"]["value"] == 3
    assert entries["combination:U"]["data"]["value"] == pytest.approx(6.6)
    assert "caseResults" not in entries["case:D"]["data"]
    assert source_result == before


def source():
    return {"materials": [{"id": "C", "category": "concrete", "grade": "C30", "E": 30000,
                           "nu": .2, "G": 12500, "rho": 2500, "design": {"fc": 14.3}}],
            "sections": [{"id": "S", "type": "custom", "properties": {"A": .1, "Iy": .01}}],
            "elements": [{"id": "B", "section": "S", "material": "C", "rebar_grade": "HRB400",
                          "design": {"l0": 3000}, "extra": {"stiffness_factor": .5}}]}


@pytest.mark.parametrize("engine", ["pkpm", "yjk"])
def test_only_known_design_fields_are_projected_without_changing_source(engine):
    model = source()
    before = copy.deepcopy(model)
    projection = project_commercial_model(model, engine)
    assert model == before
    assert projection["analysisModel"]["materials"][0]["G"] == 12500
    assert "design" not in projection["analysisModel"]["materials"][0]
    assert "rebar_grade" not in projection["analysisModel"]["elements"][0]
    assert projection["analysisModel"]["elements"][0]["extra"] == {"stiffness_factor": .5}
    assert projection["designInputs"]["fields"]["materials.C.design"] == {"fc": 14.3}
    assert projection["designInputs"]["fields"]["elements.B.rebar_grade"] == "HRB400"
    changed = copy.deepcopy(model)
    changed["materials"][0]["design"]["fc"] = 19.1
    next_projection = project_commercial_model(changed, engine)
    assert projection["analysisModelHash"] == next_projection["analysisModelHash"]
    assert projection["sourceModelHash"] != next_projection["sourceModelHash"]
    assert projection["designInputsHash"] != next_projection["designInputsHash"]


def test_unknown_physics_disguised_as_design_is_not_silently_removed():
    model = source()
    model["materials"][0]["design"]["G"] = 2
    with pytest.raises(ValueError, match="Unknown design fields"):
        project_commercial_model(model, "pkpm")


@pytest.mark.parametrize("engine", ["pkpm", "yjk"])
def test_characteristic_compressive_strength_is_retained_without_changing_elastic_properties(engine):
    model = source()
    model["materials"][0]["fck"] = 30.
    before = copy.deepcopy(model)
    projected = project_commercial_model(model, engine)
    assert model == before
    assert projected["designInputs"]["fields"]["materials.C.fck"] == 30.
    elastic = projected["analysisModel"]["materials"][0]
    assert "fck" not in elastic
    assert {key: elastic[key] for key in ("E", "G", "nu", "rho")} == {
        "E": 30000, "G": 12500, "nu": .2, "rho": 2500,
    }
    changed = copy.deepcopy(model)
    changed["materials"][0]["fck"] = 35.
    next_projection = project_commercial_model(changed, engine)
    assert projected["analysisModelHash"] == next_projection["analysisModelHash"]
    assert projected["designInputsHash"] != next_projection["designInputsHash"]
    assert projected["sourceModelHash"] != next_projection["sourceModelHash"]


def test_numeric_carrier_and_missing_rebar_cannot_be_used_for_native_design(tmp_path):
    model = source()
    projection = project_commercial_model(model, "yjk")
    project = tmp_path / "model.yjk"
    project.write_bytes(b"native-model")
    context = build_native_design_context(model, projection, native_project=str(project),
        parameters={"design": {"requested": True, "mode": "check-provided", "code": "GB50010-2010"}},
        representation={"analysisOnly": True})
    reasons = {row["reason"] for row in context["missingInputs"]}
    assert "physical-design-geometry-required" in reasons
    assert "confirmed-existing-reinforcement-required" in reasons
    assert "analysis-reference-carrier-not-design-geometry" in reasons
    assert context["nativeProjectSha256"]
    assert context["status"] == "needs-input"
    assert context["eligibleForConclusion"] is False


def test_plain_analysis_does_not_request_native_design(tmp_path):
    model = source()
    context = build_native_design_context(model, project_commercial_model(model, "pkpm"),
        native_project=str(tmp_path / "model.JWS"), parameters={})
    assert context["status"] == "not-requested"
    assert context["nativeProjectSha256"] is None
