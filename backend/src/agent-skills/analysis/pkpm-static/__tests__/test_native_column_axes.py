"""Physical strong-axis intent must affect native stiffness, not only plots."""
from copy import deepcopy
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "runtime"))
from native_column_axes import column_axis_plan
from contracts import AnalysisCapabilityError


def source(rotation=0):
    return {"schema_version": "2.0.0", "metadata": {"ndm": 3},
            "nodes": [{"id": "a", "x": 0., "y": 0., "z": 0.},
                      {"id": "b", "x": 0., "y": 0., "z": 3.}],
            "sections": [{"id": "C", "type": "rectangular", "shape": {"kind": "rectangular", "B": 400., "H": 700.}}],
            "elements": [{"id": "c", "type": "column", "nodes": ["a", "b"],
                          "section": "C", "rotation_angle": rotation}]}


@pytest.mark.parametrize("angle,swapped", [(0, True), (90, False), (180, True), (270, False), (-90, False)])
def test_both_orthogonal_strong_directions_preserve_source_and_avoid_native_angle_rounding(angle, swapped):
    model = source(angle)
    before = deepcopy(model)
    result = column_axis_plan(model, model["elements"][0])
    assert result["swapBH"] is swapped
    assert result["nativeDimensionsMm"] == ({"B": 700., "H": 400.} if swapped else {"B": 400., "H": 700.})
    assert result["nativeAngleDegrees"] == 0
    assert result["sourceDimensionsMm"] == {"B": 400., "H": 700.}
    assert model == before


def test_endpoint_reversal_preserves_same_physical_section_direction():
    model = source()
    forward = column_axis_plan(model, model["elements"][0])
    model["elements"][0]["nodes"].reverse()
    reverse = column_axis_plan(model, model["elements"][0])
    assert reverse["nativeDimensionsMm"] == forward["nativeDimensionsMm"]


def test_unverified_arbitrary_angle_is_rejected_before_native_modeling():
    model = source(25)
    with pytest.raises(AnalysisCapabilityError, match="align with global X/Y") as caught:
        column_axis_plan(model, model["elements"][0])
    assert caught.value.error_code == "ENGINE_INPUT_UNSUPPORTED"


def test_unverified_h_column_is_a_precise_input_boundary_without_shape_substitution():
    model = source()
    model["sections"][0] = {"id": "C", "type": "H", "shape": {"kind": "H", "H": 300, "B": 200, "tw": 8, "tf": 12}}
    before = deepcopy(model)
    with pytest.raises(AnalysisCapabilityError) as caught:
        column_axis_plan(model, model["elements"][0])
    assert caught.value.error_code == "ENGINE_INPUT_UNSUPPORTED"
    assert caught.value.meta["inputFields"] == ["sections.C.shape"]
    assert model == before


def test_beam_geometry_is_not_permuted_by_column_rule():
    model = source()
    model["elements"][0]["type"] = "beam"
    assert column_axis_plan(model, model["elements"][0]) is None
