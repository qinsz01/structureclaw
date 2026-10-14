"""Independent beam formula checks for native releases and physical refinement."""
import copy

import pytest

from test_solver_mesh import beam, solve


@pytest.mark.parametrize('dimension', ['2d', '3d'])
@pytest.mark.parametrize('angle', [0, 90])
def test_two_end_hinges_preserve_refined_beam_continuity(dimension, angle):
    model = beam(dimension=dimension, loads=[{'type': 'point', 'element': 'member', 'position': 3, 'fz': -20}])
    member = model.elements[0]
    member.rotation_angle = angle
    key = 'rz' if angle else 'ry'
    member.releases = {'i': {key: True}, 'j': {key: True}}
    before = copy.deepcopy(model.model_dump())
    result = solve(model)
    assert model.model_dump() == before
    middle = result['solverMesh']['physicalElements']['member'][0]['nodes'][1]
    inertia = .0002 if angle else .0001
    assert result['segmentResults']['displacements'][middle]['uz'] == pytest.approx(-20*6**3/(48*200000000*inertia), rel=1e-10)
    assert 'ry' not in result['displacements']['A']
    assert 'ry' not in result['displacements']['B']
    assert result['nodalResponseAvailability']['A']['ry'] is False
    assert result['nodalResponseAvailability'][middle]['ry'] is True
    for end in ('n1', 'n2'):
        assert result['forces']['member'][end]['M3' if angle else 'M2'] == pytest.approx(0, abs=1e-10)
    assert result['reactions']['A']['fz'] == pytest.approx(10)
    assert result['reactions']['B']['fz'] == pytest.approx(10)


@pytest.mark.parametrize('dimension', ['2d', '3d'])
@pytest.mark.parametrize('reverse', [False, True])
def test_fixed_pinned_uniform_beam_releases_only_the_physical_end(dimension, reverse):
    model = beam(dimension=dimension, loads=[{'type': 'distributed', 'element': 'member', 'wz': -10}])
    for node in model.nodes:
        node.restraints = [True]*6
    model.nodes[1].restraints[0] = False
    if reverse:
        model.elements[0].nodes.reverse()
    model.elements[0].releases = {'i' if reverse else 'j': {'ry': True}}
    result = solve(model)
    assert result['reactions']['A']['fz'] == pytest.approx(5*60/8)
    assert result['reactions']['B']['fz'] == pytest.approx(3*60/8)
    assert result['reactions']['A']['my'] == pytest.approx(-10*6**2/8)
    assert result['reactions']['B']['my'] == pytest.approx(0, abs=1e-10)
    # A fixed joint rotation is known even when its member end is released.
    assert result['displacements']['B']['ry'] == 0


def test_3d_two_bending_releases_do_not_release_torsion():
    model = beam(dimension='3d', cantilever=True, loads=[{'node': 'B', 'mx': 10}])
    model.nodes[1].restraints = [True, True, True, False, False, False]
    model.elements[0].releases = {'j': {'ry': True, 'rz': True}}
    result = solve(model)
    assert result['displacements']['B']['rx'] == pytest.approx(10*6/(200000000/(2*1.3)*.00005), rel=1e-10)
    assert 'ry' not in result['displacements']['B'] and 'rz' not in result['displacements']['B']
    assert result['reactions']['A']['mx'] == pytest.approx(-10)


def test_skew_released_joint_is_gauged_without_inventing_global_rotations():
    import math
    model = beam(dimension='3d', cantilever=True)
    model.nodes[1].x = model.nodes[1].y = model.nodes[1].z = 2
    model.nodes[1].restraints = [True, True, True, False, False, False]
    model.elements[0].releases = {'j': {'ry': True, 'rz': True}}
    model.load_cases[0].loads = [{'node': 'B', 'mx': 10/math.sqrt(3), 'my': 10/math.sqrt(3), 'mz': 10/math.sqrt(3)}]
    result = solve(model)
    assert set(result['displacements']['B']) == {'ux', 'uy', 'uz'}
    assert result['forces']['member']['n2']['T'] == pytest.approx(10, rel=1e-10)
    for key in ('mx', 'my', 'mz'):
        assert result['reactions']['A'][key] == pytest.approx(-10/math.sqrt(3), rel=1e-10)


@pytest.mark.parametrize('released,free_joint_rotations', [(False,False),(True,False),(True,True)])
def test_fully_prescribed_beam_still_applies_loads_and_returns_native_reactions(released, free_joint_rotations):
    model = beam(loads=[{'type':'distributed','element':'member','wz':-10}])
    for node in model.nodes:
        node.restraints = [True]*6
        if free_joint_rotations:
            node.restraints[4] = False
    if released:
        model.elements[0].releases = {'i': {'ry': True}, 'j': {'ry': True}}
    result = solve(model)
    assert len(result['solverMesh']['physicalElements']['member']) == 2
    assert result['reactions']['A']['fz'] == pytest.approx(30)
    assert result['reactions']['B']['fz'] == pytest.approx(30)
    assert result['reactions']['A']['my'] == pytest.approx(0 if released else -30)
    assert result['reactions']['B']['my'] == pytest.approx(0 if released else 30)


@pytest.mark.parametrize('load', [{'node':'B','my':10}, {'type':'displacement','node':'B','ry':.01}])
def test_load_on_unidentified_joint_rotation_is_not_absorbed_by_gauge(load):
    model = beam(loads=[load])
    model.elements[0].releases = {'j': {'ry': True}}
    with pytest.raises(ValueError, match='no member stiffness|no identifiable joint rotation'):
        solve(model)


@pytest.mark.parametrize('release', [
    {'i': {'ry': 1}}, {'i': {'ry': True}, 'releaseI': {'ry': False}},
    {'i': {'rx': True}}, {'i': {'rz': True}}, {'spring': 5},
    {'i': {'ry': True}, 'reference_frame': 'global'},
])
def test_invalid_or_unimplemented_release_is_explicitly_rejected(release):
    model = beam()
    model.elements[0].releases = release
    with pytest.raises(ValueError, match='release|releases'):
        solve(model)


def test_null_joint_rotation_cannot_be_falsely_fixed_when_coupled_by_diaphragm():
    import openseespy.opensees as ops
    from opensees_shared.model import OpenSeesModelBuilder
    from structure_protocol.structure_model_v2 import StoryV2
    model = beam(dimension='3d')
    for node in model.nodes:
        node.z = 1
        node.story = 'F1'
        node.restraints = [True, True, True, True, True, False]
    model.stories = [StoryV2(id='F1',height=1,elevation=0)]
    model.analysis_control.rigid_floor = True
    model.elements[0].releases = {'i': {'rz': True}, 'j': {'rz': True}}
    try:
        with pytest.raises(ValueError, match='Rigid diaphragm coupling'):
            OpenSeesModelBuilder(model).build(ops)
    finally:
        ops.wipe()
