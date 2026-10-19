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


def test_explicit_legacy_material_type_survives_v2_serialization():
    source = {'id':'m','name':'project steel','type':'steel','E':206000,'G':79000,'nu':.3,'rho':7850}
    normalized = MaterialV2.model_validate(source).model_dump(exclude_unset=True)
    assert normalized['category'] == 'steel' and 'type' not in normalized
    assert normalized['G'] == 79000 and source['type'] == 'steel'
    with pytest.raises(ValueError, match='category/type conflict'):
        MaterialV2.model_validate({**source, 'category':'concrete'})


def test_characteristic_concrete_and_rebar_strengths_are_not_discarded():
    source = {'id':'m','name':'material','E':30000,'nu':.2,'rho':2500,
              'fck':20.1,'extra':{'fyk':400,'fstk':540}}
    normalized = MaterialV2.model_validate(source).model_dump(exclude_unset=True)
    assert normalized['design'] == {'fck':20.1,'fyk':400.,'fstk':540.}
    assert source['fck'] == 20.1 and source['extra'] == {'fyk':400,'fstk':540}
    assert MaterialV2.model_validate(normalized).model_dump(exclude_unset=True) == normalized
    with pytest.raises(ValueError, match='design.fck conflicts'):
        MaterialV2.model_validate({**source,'design':{'fck':30}})


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
    validate_section_physics(section)
    assert section.properties['A'] == .001
    assert any(row['severity'] == 'warning' for row in section.extra['section_diagnostics'])


def test_catalog_does_not_silently_override_explicit_properties():
    section = SectionV2(id='s',name='s',type='H',standard_steel_name='HW300x300',properties={'A':.01})
    validate_section_physics(section)
    assert section.properties['A'] == .01
    assert section.extra['section_diagnostics'][0]['code'] == 'SECTION_CATALOG_LABEL'


def test_explicit_moduli_win_but_net_capacity_cannot_exceed_gross_by_over_five_percent():
    section = SectionV2(id='s',name='s',type='rectangular',
        shape=SectionShape(kind='rectangular',B=200,H=500),properties={'Wx':1,'Wz':1,'Wnx':1.05})
    validate_section_physics(section)
    assert section.properties['Wx'] == 1
    section.properties['Wnx'] = 1.051
    with pytest.raises(ValueError, match='net Wnx exceeds gross'):
        validate_section_physics(section)


def test_shape_wins_over_labels_and_legacy_dimensions_but_nonfinite_geometry_fails():
    section = SectionV2(id='s',name='s',type='H',width=300,
        shape=SectionShape(kind='rectangular',B=200,H=500))
    validate_section_physics(section)
    assert section.type == 'rectangular' and section.width == 200
    assert section.extra['type_shape_conflict']['type'] == 'H'
    assert section.extra['width_shape_conflict']['width'] == 300
    with pytest.raises(ValueError):
        validate_section_physics(SectionV2(id='s',name='s',type='rectangular',
            shape=SectionShape(kind='rectangular',B=200,H=float('inf'))))


def test_catalogue_i20a_and_rounded_inertia_are_accepted():
    shape = SectionShape(kind='I',H=200,B=100,tw=7,tf=11.4)
    section = SectionV2(id='s',name='I20a',type='I',shape=shape,
        properties={'A':35.578e-4,'Iy':2370e-8})
    validate_section_physics(section)
    assert section.properties['A'] == 35.578e-4 and section.properties['Iy'] == 2370e-8
    assert section.extra['property_geometry_delta']['A'] == pytest.approx(1.06238,rel=1e-5)
    assert section.extra['property_geometry_delta']['Iy'] == pytest.approx(.657176,rel=1e-5)
    assert all(row['severity'] == 'info' for row in section.extra['section_diagnostics'])
    rounded = SectionV2(id='s',name='I20a',type='I',shape=shape,properties={'Iy':2.3545e-5})
    validate_section_physics(rounded)
    assert rounded.properties['Iy'] == 2.3545e-5
    assert 'property_geometry_delta' not in rounded.extra
    assert 'section_diagnostics' not in rounded.extra


def test_stale_derived_provenance_warns_without_overwriting_properties():
    section = SectionV2(id='s',name='s',type='custom',properties={'A':.01},extra={'derived_properties':{'bad':True}})
    validate_section_physics(section)
    assert section.properties['A'] == .01
    assert section.extra['section_diagnostics'][0]['code'] == 'SECTION_PROVENANCE_CONFLICT'


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


def test_design_basis_survives_roundtrip_without_allowing_fake_response_fields():
    source = {'id':'b','nodes':['a','b'],'material':'m','section':'s',
              'design':{'phi_b':.9,'basis':{'phi_b':'User supplied coefficient, not inferred'}}}
    member = ElementV2.model_validate(source)
    assert member.model_dump(exclude_unset=True)['design'] == source['design']
    assert ElementV2.model_validate(member.model_dump()).design.basis == source['design']['basis']
    for invalid in ({'basis':{'phi_b':''}}, {'basis':{'phi_b':1}}, {'phi_b':.9,'fake_pass':True}):
        with pytest.raises(ValueError):
            ElementV2.model_validate({**source,'design':invalid})


@pytest.mark.parametrize('field', ['b','t','imin'])
@pytest.mark.parametrize('value', [0, -1, float('inf'), True])
def test_additional_consumed_section_lengths_are_positive_and_finite(field, value):
    with pytest.raises(ValueError, match='finite and positive'):
        validate_section_physics(SectionV2(id='s',name='s',type='custom',properties={'A':.01,'Iy':1e-4,field:value}))


def test_legacy_reinforcement_is_preserved_without_inventing_confirmation():
    member = ElementV2(id='b',nodes=['a','b'],material='m',section='s',extra={'As':1256,'cover':30})
    exported = member.model_dump(exclude_unset=True)
    assert exported['design']['reinforcement'] == {'confirmed':False,'values':{'As':1256,'cover':30}}
    assert exported['extra'] == {}
    member = ElementV2(id='b',nodes=['a','b'],material='m',section='s',
        design={'reinforcement':{'As':1256,'confirmed':True}})
    assert member.design.reinforcement.confirmed is True
    assert member.design.reinforcement.values.As == 1256
