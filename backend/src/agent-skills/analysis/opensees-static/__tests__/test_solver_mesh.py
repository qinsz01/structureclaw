"""Independent mechanics checks for the physical-member / solver-mesh boundary."""
from pathlib import Path
import sys
import copy

import pytest

SKILL = Path(__file__).resolve().parents[1]
for p in (SKILL, SKILL.parent/'runtime', SKILL.parents[2]/'skill-shared'/'python'):
    sys.path.insert(0, str(p))
from structure_protocol.structure_model_v2 import StructureModelV2
from opensees_static_analysis import OpenSeesStaticExecutor
from opensees_static_simplified_static_analysis import StaticAnalyzer


def beam(*, dimension='2d', span=6.0, cantilever=False, loads=None):
    return StructureModelV2.model_validate({
        'coordinate_system': {'semantics': 'global-z-up', 'version': 1, 'dimension': dimension,
            'plane': 'xz' if dimension == '2d' else None, 'dof_order': ['ux','uy','uz','rx','ry','rz']},
        'nodes': [{'id': 'A', 'x': 0, 'y': 0, 'z': 0,
                   'restraints': [True]*6 if cantilever else [True,True,True,True,False,True]},
                  {'id': 'B', 'x': span, 'y': 0, 'z': 0,
                   'restraints': None if cantilever else [False,True,True,True,False,True]}],
        'elements': [{'id':'member','type':'beam','nodes':['A','B'],'material':'steel','section':'s'}],
        'materials': [{'id':'steel','name':'steel','E':200000,'nu':0.3,'rho':7850}],
        'sections': [{'id':'s','name':'s','type':'beam','properties':{'A':.02,'Iy':.0001,'Iz':.0002,'J':.00005}}],
        'load_cases': [{'id':'D','type':'dead','loads': loads or []}],
        'analysis_control': {'self_weight':False,'rigid_floor':False},
    })


def solve(model, **parameters):
    return OpenSeesStaticExecutor(StaticAnalyzer(model)).run(parameters or {'loadCaseIds':['D']})


def test_explicit_shear_modulus_controls_real_torsion():
    model = beam(dimension='3d',cantilever=True,loads=[{'node':'B','mx':10}])
    model.materials[0].G = 12345
    result = solve(model)
    assert result['displacements']['B']['rx'] == pytest.approx(10*6/(12345*1000*.00005),rel=1e-10)
    evidence = result['execution']['effectiveSettings']['materials']['steel']
    assert evidence['G'] == 12345 and evidence['shearModulusSource'] == 'explicit'


@pytest.mark.parametrize('angle', [0,90,180,270,-90])
def test_principal_2d_section_rotation_matches_same_restrained_3d_model(angle):
    models = [beam(dimension=d,loads=[{'type':'point','element':'member','position':3,'fz':-20}]) for d in ('2d','3d')]
    responses = []
    for model in models:
        model.elements[0].rotation_angle = angle
        responses.append(solve(model))
    for result in responses:
        split = result['solverMesh']['physicalElements']['member'][0]['nodes'][1]
        inertia = .0002 if round(angle/90)%2 else .0001
        assert result['segmentResults']['displacements'][split]['uz'] == pytest.approx(-20*6**3/(48*200000000*inertia),rel=1e-10)
    for end in ('n1','n2'):
        inactive = ('V3','M2') if round(angle/90)%2 else ('V2','M3')
        assert all(responses[0]['forces']['member'][end][key] == 0 for key in inactive)
        for component in ('N','V2','V3','T','M2','M3'):
            assert responses[0]['forces']['member'][end][component] == pytest.approx(
                responses[1]['forces']['member'][end][component], rel=1e-10, abs=1e-10)


@pytest.mark.parametrize('angle', [0,90,180,270,-90])
def test_rotated_section_local_uniform_load_preserves_same_global_loading(angle):
    from opensees_shared.model import OpenSeesModelBuilder
    model = beam(cantilever=True)
    model.elements[0].rotation_angle = angle
    axes = OpenSeesModelBuilder(model)._element_axes(model.elements[0])
    local = axes @ [0,0,-10]
    model.load_cases[0].loads = [{'type':'distributed','element':'member','reference_frame':'element-local',
        'wx':float(local[0]),'wy':float(local[1]),'wz':float(local[2])}]
    local_result = solve(StructureModelV2.model_validate(model.model_dump()))
    model.load_cases[0].loads = [{'type':'distributed','element':'member','wz':-10}]
    global_result = solve(model)
    assert local_result['displacements']['B']['uz'] == pytest.approx(global_result['displacements']['B']['uz'],rel=1e-10)
    assert global_result['reactions']['A']['fz'] == pytest.approx(60)
    inertia = .0002 if round(angle/90)%2 else .0001
    assert global_result['displacements']['B']['uz'] == pytest.approx(-10*6**4/(8*200000000*inertia),rel=1e-10)


@pytest.mark.parametrize('dimension', ['2d', '3d'])
def test_interior_point_load_has_exact_deflection_and_physical_mapping(dimension):
    model = beam(dimension=dimension, loads=[{'type':'point','element':'member','position':3,'fz':-20}])
    before = copy.deepcopy(model.model_dump())
    result = solve(model)
    assert model.model_dump() == before
    assert result['execution']['executed'] is True
    assert result['execution']['solverVersion']
    from opensees_shared.evidence import artifact_sha256
    evidence = result['execution']['artifacts']
    assert evidence['normalizedInputSha256'] == artifact_sha256(model.model_dump(mode='json',exclude_unset=True))
    assert evidence['solverResponseSha256'] == artifact_sha256({k:result[k] for k in evidence['solverResponseKeys']})
    assert result['meta']['execution']['solverVersion'] == result['execution']['solverVersion']
    assert list(result['forces']) == ['member']
    assert list(result['displacements']) == ['A','B']
    segments = result['solverMesh']['physicalElements']['member']
    assert [(s['start'],s['end']) for s in segments] == [(0,3),(3,6)]
    midpoint = segments[0]['nodes'][1]
    u = result['segmentResults']['displacements'][midpoint]['uz']
    assert u == pytest.approx(-20*6**3/(48*200000000*.0001), rel=1e-10)
    assert result['reactions']['A']['fz'] == pytest.approx(10)
    assert result['reactions']['B']['fz'] == pytest.approx(10)


def test_partial_uniform_load_matches_integrated_macaulay_solution():
    q, length, a, b = 10, 9, 2, 7
    result = solve(beam(span=length, loads=[{'type':'distributed','element':'member','wz':-q,'start':a,'end':b}]))
    reaction = q*(b-a)*(length-(a+b)/2)/length
    ei = 200000000*.0001
    c1 = -(reaction*length**3/6-q*((length-a)**4-(length-b)**4)/24)/(ei*length)
    for record in result['solverMesh']['physicalElements']['member'][:-1]:
        x = record['end']
        expected = (reaction*x**3/6-q*(max(x-a,0)**4-max(x-b,0)**4)/24)/ei+c1*x
        assert result['segmentResults']['displacements'][record['nodes'][1]]['uz'] == pytest.approx(expected, rel=1e-10)
    assert result['reactions']['A']['fz'] == pytest.approx(reaction)
    assert result['effectiveLoads'][0]['start'] == a


def test_2d_global_y_moment_and_rotation_match_3d_right_hand_rule():
    responses = [solve(beam(dimension=d,cantilever=True,loads=[{'node':'B','my':10}])) for d in ('2d','3d')]
    for result in responses:
        assert result['displacements']['B']['ry'] == pytest.approx(10*6/(200000000*.0001))
        assert result['displacements']['B']['uz'] == pytest.approx(-10*6**2/(2*200000000*.0001))
        assert result['reactions']['A']['my'] == pytest.approx(-10)
        assert result['forces']['member']['n1']['M2'] == pytest.approx(-10)
        assert result['responseCoordinateConvention'] == 'global-xyz'


@pytest.mark.parametrize('dimension', ['2d','3d'])
def test_axial_truss_runs_real_opensees(dimension):
    model = beam(dimension=dimension,cantilever=True,loads=[{'node':'B','fx':30}])
    model.elements[0].type = 'truss'
    model.nodes[1].restraints = [False,True,True,False,False,False]
    result = solve(model)
    assert result['displacements']['B']['ux'] == pytest.approx(30*6/(200000000*.02))
    assert result['forces']['member']['axial'] == pytest.approx(30)
    assert result['execution']['solver'] == 'OpenSees'
    assert result['analysisMode'] == f'opensees_{dimension}_truss'


@pytest.mark.parametrize('dimension', ['2d','3d'])
def test_mixed_frame_brace_uses_combined_stiffness_without_free_rotations(dimension):
    from structure_protocol.structure_model_v2 import NodeV2, ElementV2
    model = beam(dimension=dimension,cantilever=True,loads=[{'node':'B','fz':-30}])
    model.nodes.append(NodeV2(id='C',x=6,y=0,z=-3,restraints=[True,True,True,False,False,False]))
    model.elements.append(ElementV2(id='brace',type='brace',nodes=['C','B'],material='steel',section='s'))
    result = solve(model)
    stiffness = 3*200000000*.0001/6**3 + 200000000*.02/3
    assert result['displacements']['B']['uz'] == pytest.approx(-30/stiffness, rel=1e-9)
    assert sum(r['fz'] for r in result['reactions'].values()) == pytest.approx(30)


def test_piecewise_linear_member_load_is_integrated_exactly():
    result = solve(beam(cantilever=True,loads=[{'type':'distributed','element':'member','distribution':'piecewise_linear',
          'points':[{'position':0,'wz':0},{'position':1,'wz':-12}]}]))
    assert result['displacements']['B']['uz'] == pytest.approx(-11*12*6**4/(120*200000000*.0001),rel=1e-10)
    assert result['reactions']['A']['fz'] == pytest.approx(36)
    assert result['reactions']['A']['my'] == pytest.approx(-144)


def test_prescribed_support_settlement_is_not_discarded():
    result = solve(beam(loads=[{'type':'displacement','node':'B','uz':-.01}]))
    assert result['displacements']['B']['uz'] == pytest.approx(-.01)
    assert result['displacements']['A']['ry'] == pytest.approx(.01/6)
    assert result['reactions']['A']['fz'] == pytest.approx(0,abs=1e-9)


def test_unknown_and_ambiguous_case_selections_fail():
    model = beam()
    with pytest.raises(ValueError,match='Unknown load cases'):
        solve(model,loadCaseIds=['missing'])
    with pytest.raises(ValueError,match='Unknown load combination'):
        solve(model,loadCombinationId='missing')
    model.load_cases.append(model.load_cases[0].model_copy(update={'id':'L'}))
    with pytest.raises(ValueError,match='explicit'):
        OpenSeesStaticExecutor(StaticAnalyzer(model)).run({})


def test_self_weight_follows_dead_case_combination_factor():
    from structure_protocol.structure_model_v2 import LoadCombinationV2
    model = beam()
    model.analysis_control.self_weight = True
    model.load_combinations.append(LoadCombinationV2(id='ULS',factors={'D':1.3}))
    result = solve(model,loadCombinationId='ULS')
    expected = 1.3*7850*.02*6*9.80665/1000
    assert sum(r['fz'] for r in result['reactions'].values()) == pytest.approx(expected)
    assert result['execution']['effectiveSettings']['self_weight']['factor'] == 1.3


def test_explicit_unsupported_features_fail_before_a_success_response():
    model = beam()
    model.elements[0].releases = {'i':{'rx':True}}
    with pytest.raises(ValueError,match='release') as rejected:
        solve(model)
    assert rejected.value.error_code == 'ENGINE_INPUT_UNSUPPORTED'
    model.elements[0].releases = None
    model.analysis_control.construction_stage = True
    with pytest.raises(ValueError,match='construction_stage') as rejected:
        solve(model)
    assert rejected.value.error_code == 'ENGINE_INPUT_UNSUPPORTED'


def test_conversion_preserves_member_loads_settings_and_prescribed_motion():
    from structure_protocol.runtime import convert_structure_model_payload
    class IdentityConverter:
        def to_v2(self, value):
            return value
    source = beam(loads=[{'type':'displacement','node':'B','uz':-.01}]).model_dump(exclude_unset=True)
    converted = convert_structure_model_payload(source, '2.0.0', 'structuremodel-v2', 'structuremodel-v2',
        ['structuremodel-v2'], lambda _: IdentityConverter())
    result = solve(StructureModelV2.model_validate(converted['model']))
    assert result['displacements']['B']['uz'] == pytest.approx(-.01)
    assert result['execution']['effectiveSettings']['self_weight']['source'] == 'explicit'


def test_undeclared_physical_node_fields_cannot_be_silently_discarded():
    payload = beam().model_dump(exclude_unset=True)
    for key, value in [('lumped_mass',100), ('settlement',-.01)]:
        wrong = copy.deepcopy(payload)
        wrong['nodes'][1][key] = value
        with pytest.raises(ValueError,match='Extra inputs are not permitted'):
            StructureModelV2.model_validate(wrong)


@pytest.mark.parametrize('load', [{'node':'B','fz':500,'unit':'N'}, {'type':'temperature','node':'B','fz':500}])
def test_runtime_parameter_loads_cannot_bypass_explicit_unit_or_kind_validation(load):
    analyzer = StaticAnalyzer(beam())
    with pytest.raises(ValueError, match='unit|Unsupported structural load type'):
        analyzer._normalize_load(load)
