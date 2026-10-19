"""Section spelling is representation; geometry and supplied properties are not."""
from copy import deepcopy
from typing import get_args

import pytest

from structure_protocol.structure_model_v2 import SECTION_SHAPE_KINDS, SectionShape, SectionV2
from structure_protocol.section_properties import validate_section_physics


@pytest.mark.parametrize('kind', get_args(SECTION_SHAPE_KINDS))
def test_shape_case_aliases_serialize_to_the_declared_contract(kind):
    for spelling in (kind, kind.lower(), kind.upper(), ' ' + kind.lower() + ' '):
        source = {'kind': spelling}
        before = deepcopy(source)
        assert SectionShape.model_validate(source).model_dump(exclude_unset=True) == {'kind': kind}
        assert source == before


def test_reported_hw_beam_record_preserves_geometry_and_identity():
    source = {'id': 'SEC-BEAM-1', 'name': 'HW300×300×10×15', 'type': 'h',
              'shape': {'kind': 'h', 'H': 300, 'B': 300, 'tw': 10, 'tf': 15}}
    before = deepcopy(source)
    section = SectionV2.model_validate(source)
    validate_section_physics(section)
    assert section.type == section.shape.kind == 'H'
    assert section.id == source['id'] and section.name == source['name']
    # Independent SI rectangle subtraction about the centroid; no catalog approximation.
    assert section.properties['A'] == pytest.approx(.3*.3 - 2*.145*.27, rel=1e-12)
    assert section.properties['Iy'] == pytest.approx((.3*.3**3 - .29*.27**3)/12, rel=1e-12)
    assert section.properties['Iz'] == pytest.approx((2*.015*.3**3 + .27*.01**3)/12, rel=1e-12)
    assert source == before


@pytest.mark.parametrize('shape', [
    {'kind': 'unknown'}, {'kind': 'h', 'height': 300}, {'kind': 'h', 'H': -1},
    {'kind': 'h', 'H': float('inf')}, {'kind': 'circular', 'D': 300},
])
def test_unknown_or_misplaced_geometry_is_not_discarded(shape):
    with pytest.raises(ValueError):
        SectionShape.model_validate(shape)


@pytest.mark.parametrize('extra', [{'type': 'CIRCULAR'}, {'properties': {'A': .001}}])
def test_case_normalization_does_not_hide_physical_conflicts(extra):
    section = SectionV2.model_validate({'id': 'S', 'name': 'H', 'type': 'h',
        'shape': {'kind': 'h', 'H': 300, 'B': 300, 'tw': 10, 'tf': 15}, **extra})
    validate_section_physics(section)
    assert section.extra['section_diagnostics']
    assert section.type == section.shape.kind
    if 'properties' in extra:
        assert section.properties['A'] == extra['properties']['A']
