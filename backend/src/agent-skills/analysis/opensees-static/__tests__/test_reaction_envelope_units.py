import sys
from pathlib import Path

SKILL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SKILL))
sys.path.insert(0, str(SKILL.parents[2] / "skill-shared" / "python"))

from opensees_static_loads import StaticLoadContext


def test_case_and_node_envelopes_keep_force_and_moment_controls_separate():
    context = StaticLoadContext.__new__(StaticLoadContext)
    context.model = {"coordinate_system": {"dimension": "2d"}}
    context._floor_load_transfer_trace = {}
    # A 3 m cantilever: 1 kN at the tip, or 2 kN at 0.5 m from the support.
    # The second case controls force; the first controls support moment.
    reactions = {"tip": {"fz": 1.0, "my": -3.0}, "near": {"fz": 2.0, "my": -1.0}}

    def solve(parameters):
        reaction = {"A": reactions[parameters["loadCaseIds"][0]]}
        return {"reactions": reaction, "envelope": context._build_envelope({}, {}, reaction)}

    result = context._run_batch_cases({"batchCases": [
        {"id": name, "loadCaseIds": [name]} for name in reactions
    ]}, solve)
    assert result["envelope"]["maxAbsReaction"] == 2
    assert result["envelope"]["maxAbsReactionMoment"] == 3
    assert result["envelope"]["controlCase"]["reaction"] == "near"
    assert result["envelope"]["controlCase"]["reactionMoment"] == "tip"
    node = result["envelopeTables"]["nodeReaction"]["A"]
    assert node["maxAbsReaction"] == 2
    assert node["maxAbsReactionMoment"] == 3
    assert node["controlCase"] == "near"
    assert node["controlCaseReactionMoment"] == "tip"


def test_unavailable_moment_components_are_not_reported_as_zero():
    context = StaticLoadContext.__new__(StaticLoadContext)
    envelope = context._build_envelope({}, {}, {"A": {"fz": 2.0, "my": None}})
    assert envelope["maxAbsReaction"] == 2
    assert "maxAbsReactionMoment" not in envelope
    assert "controlNodeReactionMoment" not in envelope
