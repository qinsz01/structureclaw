"""Floor components belong to typed cases; arbitrary case IDs cannot select gravity."""
import copy
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "runtime"))

from test_floor_load_expansion import build_model
from opensees_static_loads import StaticLoadContext
from opensees_shared.errors import OpenSeesInputError


@pytest.mark.parametrize("case_id,case_type", [
    ("DL-wind", "wind"), ("LL-seismic", "seismic"),
    ("DL", "other"), ("LC-LIVE", "other"), ("unrelated", "other"),
])
@pytest.mark.parametrize("selection", ["default", "ids", "combination", "inline"])
def test_empty_non_gravity_case_never_receives_story_gravity(case_id, case_type, selection):
    case = {"id": case_id, "type": case_type, "loads": []}
    model = build_model(load_cases=[case], load_combinations=[{"id": "C", "factors": {case_id: 2}}])
    before = copy.deepcopy(model.model_dump())
    parameters = {"floorLoadTransferMode": "node_tributary"}
    if selection == "ids":
        parameters["loadCaseIds"] = [case_id]
    elif selection == "combination":
        parameters["loadCombinationId"] = "C"
    elif selection == "inline":
        parameters["loadCases"] = [case]
    assert StaticLoadContext(model)._collect_nodal_loads(parameters) == []
    assert model.model_dump() == before


@pytest.mark.parametrize("selection", ["ids", "combination", "default"])
def test_multiple_implicit_owners_of_one_floor_component_are_rejected(selection):
    model = build_model(load_cases=[
        {"id": "D1", "type": "dead", "loads": []},
        {"id": "D2", "type": "dead", "loads": []},
    ], load_combinations=[{"id": "C", "factors": {"D1": 1, "D2": 1}}])
    parameters = {"loadCaseIds": ["D1"]} if selection == "ids" else {"loadCombinationId": "C"} if selection == "combination" else {}
    with pytest.raises(OpenSeesInputError, match="FLOOR_LOAD_CASE_AMBIGUOUS"):
        StaticLoadContext(model)._collect_nodal_loads(parameters)


def test_typed_case_wins_over_a_misleading_id():
    model = build_model(load_cases=[{"id": "DL-misleading", "type": "live", "loads": []}])
    loads = StaticLoadContext(model)._collect_nodal_loads({"loadCaseIds": ["DL-misleading"], "floorLoadTransferMode": "node_tributary"})
    assert sum(load["fz"] for load in loads) == pytest.approx(-72)


def test_models_without_case_bindings_can_still_analyze_all_declared_floor_components():
    loads = StaticLoadContext(build_model())._collect_nodal_loads({"floorLoadTransferMode": "node_tributary"})
    assert sum(load["fz"] for load in loads) == pytest.approx(-216)


@pytest.mark.parametrize("case_type,code", [("other", "FLOOR_LOAD_CASE_TYPE_REQUIRED"), ("live", "FLOOR_LOAD_COMPONENT_MISSING")])
def test_invalid_derived_records_are_rejected_instead_of_discarded(case_type, code):
    model = build_model(load_cases=[{"id": "FLOOR", "type": case_type, "loads": [
        {"type": "nodal", "node": "T1", "fz": -10, "source": "story_floor_loads"},
    ]}])
    if case_type == "live":
        model.stories[0].floor_loads = [item for item in model.stories[0].floor_loads if item.type != "live"]
    with pytest.raises(OpenSeesInputError, match=code):
        StaticLoadContext(model)._collect_nodal_loads({})
