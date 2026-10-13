"""Independent geometry and information-preservation references for V2.2."""
import pytest

from structure_protocol.structure_model_v2 import (AnalysisControl, MaterialV2, ElementV2,
    SectionV2, SectionShape, StoryDef)
from structure_protocol.section_properties import validate_section_physics


def test_design_values_and_shear_modulus_migrate_once_without_loss():
    material = MaterialV2.model_validate({'id':'m','name':'steel','E':200000,'nu':.3,'rho':7850,
        'G':12345,'f':300,'extra':{'fv':175,'notes':'reviewed'}})
    assert material.G == 12345
    assert material.design.model_dump(exclude_unset=True) == {'f':300,'fv':175}
    assert material.extra == {'notes':'reviewed'}
    member = ElementV2.model_validate({'id':'b','nodes':['a','b'],'material':'m','section':'s',
        'extra':{'phi_b':.8,'l0':4000,'deflectionLimitN':250}})
    assert member.design.l0 == 4000 and member.design.phi_b == .8
    assert member.extra == {}
    assert ElementV2.model_validate(member.model_dump(exclude_unset=True)) == member


@pytest.mark.parametrize('patch', [{'f':200,'design':{'f':300}}, {'G':10000,'extra':{'G':20000}}, {'design':{'f':float('inf')}}])
def test_conflicting_or_nonfinite_material_parameters_are_rejected(patch):
    with pytest.raises(ValueError):
        MaterialV2.model_validate({'id':'m','name':'m','E':200000,'nu':.3,'rho':7850,**patch})


def test_shape_properties_have_one_consistent_physical_meaning():
    section = SectionV2(id='s',name='s',type='rectangular',shape=SectionShape(kind='rectangular',B=200,H=500))
    validate_section_physics(section)
    assert section.properties['A'] == pytest.approx(.1,rel=1e-14)
    assert section.properties['Iy'] == pytest.approx(.2*.5**3/12,rel=1e-14)
    assert section.properties['Iz'] == pytest.approx(.5*.2**3/12,rel=1e-14)
    assert section.extra['derived_properties']['method'] == 'section-geometry-v1'
    section.properties['A'] = .001
    with pytest.raises(ValueError,match='conflicts with geometry'):
        validate_section_physics(section)


def test_catalog_does_not_silently_override_explicit_properties():
    section = SectionV2(id='s',name='s',type='H',standard_steel_name='HW300x300',properties={'A':.01})
    with pytest.raises(ValueError,match='catalog mapping is not calibrated'):
        validate_section_physics(section)


def test_section_moduli_cannot_disagree_with_geometry_or_grow_net_capacity():
    for properties in ({'Wx':1}, {'Wz':1}, {'Wnx':1}):
        section = SectionV2(id='s',name='s',type='rectangular',
            shape=SectionShape(kind='rectangular',B=200,H=500),properties=properties)
        with pytest.raises(ValueError):
            validate_section_physics(section)


def test_floor_area_migration_and_mass_direction_contract():
    story = StoryDef(id='F1',height=3,extra={'tributary_area':18})
    assert story.load_area_m2 == 18 and story.extra == {}
    with pytest.raises(ValueError,match='conflicts'):
        StoryDef(id='F1',height=3,load_area_m2=18,extra={'tributary_area':30})
    assert AnalysisControl(mass_source='floor-seismic',mass_directions=['x','y']).mass_source == 'floor-seismic'
    for directions in ([], ['x','x'], ['r']):
        with pytest.raises(ValueError):
            AnalysisControl(mass_directions=directions)


def test_unknown_design_keys_cannot_masquerade_as_supported_checks():
    with pytest.raises(ValueError):
        ElementV2(id='b',nodes=['a','b'],material='m',section='s',design={'deflection':0.001})


def test_legacy_reinforcement_is_preserved_without_inventing_confirmation():
    member = ElementV2(id='b',nodes=['a','b'],material='m',section='s',extra={'As':1256,'cover':30})
    exported = member.model_dump(exclude_unset=True)
    assert exported['design']['reinforcement'] == {'confirmed':False,'values':{'As':1256,'cover':30}}
    assert exported['extra'] == {}
    member = ElementV2(id='b',nodes=['a','b'],material='m',section='s',
        design={'reinforcement':{'As':1256,'confirmed':True}})
    assert member.design.reinforcement.confirmed is True
    assert member.design.reinforcement.values.As == 1256
