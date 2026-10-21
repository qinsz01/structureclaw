"""Retained solid-outline section integration, independently checked against rectangles."""
import pytest
from structure_protocol.section_properties import polygon_properties


@pytest.mark.parametrize('reverse', [False, True])
def test_translated_rectangle_centroid_and_inertias(reverse):
    points = [(10, 20), (110, 20), (110, 220), (10, 220)]
    result = polygon_properties(list(reversed(points)) if reverse else points)
    assert result['A'] == pytest.approx(.1*.2)
    assert result['Iy'] == pytest.approx(.1*.2**3/12)
    assert result['Iz'] == pytest.approx(.2*.1**3/12)
    assert result['centroid_mm'] == pytest.approx([60, 120])


def test_concave_l_outline_is_not_its_bounding_rectangle():
    result = polygon_properties([(0, 0), (200, 0), (200, 100), (100, 100), (100, 200), (0, 200)])
    assert result['A'] == pytest.approx(.03)
    assert result['centroid_mm'] == pytest.approx([250/3, 250/3])


@pytest.mark.parametrize('points', [[], [(0, 0), (1, 0)], [(0, 0), (1, 0), (2, 0)], [(0, 0), (1, 0), (0, float('inf'))]])
def test_degenerate_or_nonfinite_outline_fails(points):
    with pytest.raises(ValueError):
        polygon_properties(points)
