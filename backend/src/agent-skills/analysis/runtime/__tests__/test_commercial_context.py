import copy
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from commercial_context import project_commercial_model, build_native_design_context


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
