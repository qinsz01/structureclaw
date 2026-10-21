import copy
import pytest

from structure_protocol.axis_mapping import map_vector, canonicalize_source_frame, results_in_source_frame
from structure_protocol.migrations import ensure_v2_dict
from structure_protocol.structure_model_v2 import StructureModelV2


@pytest.mark.parametrize("frame", ["y-up", "z-up", {"x": "-y", "y": "x", "z": "z"}])
def test_vectors_moments_and_restraints_round_trip(frame):
    vector = [1, 2, 3, 4, 5, 6]
    assert map_vector(map_vector(vector, frame), frame, inverse=True) == vector
    restraints = [True, False, True, False, True, False]
    assert map_vector(map_vector(restraints, frame, restraints=True), frame, inverse=True, restraints=True) == restraints


def test_declared_frame_is_consumed_once_at_model_boundary():
    source = {"schema_version": "2.2.0", "source_frame": "y-up",
              "nodes": [{"id": "N", "x": 1, "y": 2, "z": 0, "restraints": [True] * 6}],
              "load_cases": [{"id": "D", "type": "dead", "loads": [
                  {"type": "nodal", "node": "N", "fy": -10, "mz": 3}]}]}
    before = copy.deepcopy(source)
    mapped = ensure_v2_dict(source)
    assert source == before
    assert mapped["nodes"][0]["z"] == 2
    load = mapped["load_cases"][0]["loads"][0]
    assert load["fz"] == -10 and load["my"] == -3
    assert ensure_v2_dict(mapped) == mapped
    assert StructureModelV2.model_validate(source).nodes[0].z == 2
    result = {"reactions": {"N": {"fx": 0, "fy": 0, "fz": 10, "mx": 0, "my": -3, "mz": 0}},
              "displacements": {"N": {"ux": 1, "uy": -3, "uz": 2, "rx": 4, "ry": -6, "rz": 5}}}
    restored = results_in_source_frame(result, "y-up")
    assert restored["reactions"]["N"]["fy"] == 10
    assert restored["reactions"]["N"]["mz"] == 3
    assert list(restored["displacements"]["N"].values()) == [1, 2, 3, 4, 5, 6]


def test_local_loads_are_unchanged_and_left_handed_axes_fail():
    local = {"reference_frame": "element-local", "wy": -5}
    model = {"source_frame": "y-up", "load_cases": [{"loads": [local]}]}
    assert canonicalize_source_frame(model)["load_cases"][0]["loads"][0] == local
    with pytest.raises(ValueError, match="right-handed"):
        map_vector([1, 2, 3], {"x": "x", "y": "z", "z": "y"})
