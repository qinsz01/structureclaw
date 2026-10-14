import copy
import pytest
from structure_protocol.self_weight import SelfWeightInputError, resolve_self_weight
from structure_protocol.structure_model_v2 import AnalysisControl


def test_case_gravity_and_direction_are_shared_explicit_choices():
    model = {"analysis_control": {"self_weight": True}, "load_cases": [{"id": "D", "type": "dead"}]}
    original = copy.deepcopy(model)
    result = resolve_self_weight(model)
    assert result["loadCaseId"] == "D" and result["caseSource"] == "unique-dead-case"
    assert result["vectorMps2"] == [0., 0., -9.80665]
    model["analysis_control"].update(self_weight_case_id="L", gravity_direction="x", gravity_m_s2=10)
    model["load_cases"].append({"id": "L", "type": "live"})
    assert resolve_self_weight(model)["vectorMps2"] == [10., 0., 0.]
    assert resolve_self_weight(original)["loadCaseId"] == "D"


def test_explicit_target_resolves_multiple_dead_cases_and_schema_preserves_fields():
    model = {"analysis_control": {"self_weight": True}, "load_cases": [{"id": x, "type": "dead"} for x in ("D1", "D2")]}
    with pytest.raises(SelfWeightInputError): resolve_self_weight(model)
    model["analysis_control"]["self_weight_case_id"] = "D2"
    assert resolve_self_weight(model)["loadCaseId"] == "D2"
    parsed = AnalysisControl(**model["analysis_control"], gravity_m_s2=9.80665, gravity_direction="-z")
    assert parsed.model_dump()["self_weight_case_id"] == "D2"


@pytest.mark.parametrize("value", [0, -1, True, float("nan"), float("inf"), "9.81"])
def test_invalid_gravity_is_not_guessed(value):
    with pytest.raises(SelfWeightInputError): resolve_self_weight({"analysis_control": {"gravity_m_s2": value}})


def test_missing_target_and_invalid_direction_fail_before_solver():
    for control in ({"self_weight": True, "self_weight_case_id": "absent"}, {"gravity_direction": "down"}):
        with pytest.raises(SelfWeightInputError): resolve_self_weight({"analysis_control": control})
