"""Independent SDOF equilibrium validates the actual OpenSees observation chain."""
import math
import json
from pathlib import Path
import subprocess
import sys
import pytest

from test_shared_mass_modal import cantilever, OpenSeesDynamicExecutor, OpenSeesTagMapper


def run_worker(model, analysis_type, parameters):
    worker = Path(__file__).resolve().parents[2] / 'runtime' / 'worker.py'
    completed = subprocess.run([sys.executable, str(worker)],
        input=json.dumps({'action': 'analyze', 'input': {'type': analysis_type,
            'engineId': 'builtin-opensees', 'model': model, 'parameters': parameters}}),
        capture_output=True, text=True, encoding='utf-8', timeout=60)
    assert completed.returncode == 0, completed.stdout + completed.stderr
    response = json.loads(completed.stdout)
    assert response['ok'] and response['data']['success'], response
    return response['data']['data']


def newmark(mass, stiffness, damping, dt, accelerations):
    # Constant-average acceleration, computed independently from the scalar EOM.
    u = v = a = 0.
    rows = []
    for ground in accelerations[1:]:
        up = u + dt*v + dt*dt*a/4
        vp = v + dt*a/2
        a = (-mass*ground-damping*vp-stiffness*up)/(mass+damping*dt/2+stiffness*dt*dt/4)
        u, v = up+dt*dt*a/4, vp+dt*a/2
        rows.append((u,v,a))
    return rows


@pytest.mark.parametrize('dimension,direction,inertia', [('2d','x',.0001),('3d','x',.0001),('3d','y',.0002)])
@pytest.mark.parametrize('ratio', [0.,.05])
def test_full_observations_match_independent_eom_and_signed_support_balance(dimension,direction,inertia,ratio):
    import openseespy.opensees as ops
    model = cantilever(dimension,'nodal')
    dt, steps, mass, length = .002,100,10.,3.
    motion = [.3*math.sin(i*dt*9) for i in range(steps+2)]
    result = OpenSeesDynamicExecutor(OpenSeesTagMapper(model)).time_history_analysis(
        dt,steps*dt,ratio,motion,ops,direction=direction,monitor_node_ids=['top','base'],
        monitor_element_ids=['C'],monitor_support_node_ids=['base'])
    k = 3*200000000*inertia/length**3
    alpha = result['damping']['alphaMass']; beta = result['damping']['betaCurrentStiffness']
    expected = newmark(mass,k,alpha*mass+beta*k,dt,motion[:steps+1])
    component = 'u'+direction
    assert result['responseDefinition']['reactions']['command'] == "reactions('-dynamic')"
    assert result['responseDefinition']['displacement'] == 'relative-to-uniformly-moving-ground'
    for i,(row,(u,v,a)) in enumerate(zip(result['timeHistory'],expected)):
        assert row['time'] == pytest.approx((i+1)*dt,abs=1e-14)
        assert row['timeIndex'] == i
        assert row['nodes']['top'][component] == pytest.approx(u,rel=1e-9,abs=1e-12)
        assert row['velocities']['top'][component] == pytest.approx(v,rel=1e-9,abs=1e-12)
        assert row['accelerations']['top'][component] == pytest.approx(a,rel=1e-9,abs=1e-11)
        assert row['reactions']['base']['f'+direction] == pytest.approx(-k*(u+beta*v),rel=1e-9,abs=1e-10)
        rotation = 'ry' if direction=='x' else 'rx'
        sign = 1 if direction=='x' else -1
        assert row['nodes']['top'][rotation] == pytest.approx(sign*1.5*u/length,abs=1e-12)
        assert row['reactions']['base']['m'+rotation[1]] == pytest.approx(-sign*k*length*(u+beta*v),abs=1e-9)
        force = row['forces']['C']
        axes = [force['localAxes'][key] for key in ('x','y','z')]
        local_force = [force['n1'][key] for key in ('N','V2','V3')]
        global_force = [sum(axes[j][c]*local_force[j] for j in range(3)) for c in range(3)]
        assert global_force[0 if direction=='x' else 1] == pytest.approx(-k*u,abs=1e-10)
        assert force['source']['includesDampingForces'] is False
        assert row['reactionSource']['includesRayleighDamping'] is True


@pytest.mark.parametrize('kwargs', [{'monitor_element_ids':['missing']},{'monitor_support_node_ids':['top']},
    {'monitor_element_ids':['C','C']}])
def test_unknown_unrestrained_or_duplicate_observations_are_rejected(kwargs):
    import openseespy.opensees as ops
    model = cantilever('2d','nodal')
    model.nodes[1].restraints = None
    with pytest.raises(ValueError,match='unique existing object IDs'):
        OpenSeesDynamicExecutor(OpenSeesTagMapper(model)).time_history_analysis(
            .01,.1,.05,[0,.1,0],ops,**kwargs)


def test_unrequested_member_or_reaction_does_not_become_a_zero_result():
    import openseespy.opensees as ops
    result = OpenSeesDynamicExecutor(OpenSeesTagMapper(cantilever('2d','nodal'))).time_history_analysis(
        .01,.1,0,[0,.1,0],ops)
    assert all(row['forces']=={} and row['reactions']=={} for row in result['timeHistory'])


@pytest.mark.parametrize('dimension', ['2d', '3d'])
def test_released_tip_rotation_is_omitted_and_physical_transient_is_unchanged(dimension):
    import openseespy.opensees as ops
    model = cantilever(dimension, 'nodal')
    # A free end already has zero bending moment. Releasing its joint changes
    # only the identifiability of that joint rotation, not member translation.
    motion = [0, .1, -.05, .1, 0]
    before = OpenSeesDynamicExecutor(OpenSeesTagMapper(model)).time_history_analysis(
        .01,.04,.05,motion,ops,monitor_element_ids=['C'],monitor_support_node_ids=['base'])
    model.elements[0].releases = {'j': {'ry': True}}
    after = OpenSeesDynamicExecutor(OpenSeesTagMapper(model)).time_history_analysis(
        .01,.04,.05,motion,ops,monitor_element_ids=['C'],monitor_support_node_ids=['base'])
    assert after['nodalResponseAvailability']['top']['ry'] is False
    for a,b in zip(before['timeHistory'],after['timeHistory']):
        assert b['nodes']['top']['ux'] == pytest.approx(a['nodes']['top']['ux'], rel=1e-10)
        for key in ('nodes', 'velocities', 'accelerations'):
            assert 'ry' not in b[key]['top']
        assert b['forces']['C']['n2']['M2'] == pytest.approx(0, abs=1e-10)
        assert b['reactions']['base']['fx'] == pytest.approx(a['reactions']['base']['fx'], abs=1e-10)


@pytest.mark.parametrize('dimension', ['2d', '3d'])
def test_mixed_axial_frame_transient_includes_brace_stiffness_damping(dimension):
    from structure_protocol.structure_model_v2 import NodeV2, ElementV2
    # Production starts one Python worker per request. OpenSees Truss keeps
    # process-static M6/V6 buffers shared by 3-D/3-DOF and 2-D/3-DOF elements;
    # ops.wipe() alone does not isolate those layouts in a direct library call.
    # Exercise the real worker boundary with a preceding pure spatial truss,
    # then retain all independent transient physics assertions below.
    prior = cantilever('3d', 'nodal').model_dump(mode='json')
    prior['nodes'][1]['restraints'] = [False, True, True, True, True, True]
    prior['nodes'].append({'id': 'anchor', 'x': -3, 'y': 0, 'z': 3, 'restraints': [True]*6})
    prior['elements'] = [{'id': 'brace', 'type': 'truss', 'nodes': ['anchor', 'top'],
                          'material': 'S', 'section': 'A'}]
    prior['load_cases'] = [{'id': 'D', 'type': 'dead', 'loads': [
        {'type': 'nodal', 'node': 'top', 'fx': 100}]}]
    static = run_worker(prior, 'static', {'loadCaseIds': ['D']})
    assert static['displacements']['top']['ux'] == pytest.approx(100/(200000000*.02/3), rel=1e-10)
    assert static['forces']['brace']['axial'] == pytest.approx(100, rel=1e-10)
    model = cantilever(dimension, 'nodal')
    model.nodes.append(NodeV2(id='anchor', x=-3, y=0, z=3, restraints=[True]*6))
    model.elements.append(ElementV2(id='brace', type='brace', nodes=['anchor','top'], material='S', section='A'))
    dt, steps = .002, 100
    motion = [.3*math.sin(i*dt*9) for i in range(steps+2)]
    result = run_worker(model.model_dump(mode='json'), 'dynamic', {
        'analysisType': 'time_history', 'timeStep': dt, 'duration': steps*dt,
        'dampingRatio': .05, 'groundMotion': motion, 'monitorElementIds': ['C', 'brace'],
        'monitorSupportNodeIds': ['base', 'anchor']})
    k_frame, k_brace = 3*200000000*.0001/3**3, 200000000*.02/3
    k = k_frame+k_brace
    alpha, beta = result['damping']['alphaMass'], result['damping']['betaCurrentStiffness']
    expected = newmark(10,k,10*alpha+beta*k,dt,motion[:steps+1])
    for row,(u,v,a) in zip(result['timeHistory'], expected):
        assert row['nodes']['top']['ux'] == pytest.approx(u, rel=1e-9, abs=1e-12)
        assert row['forces']['brace']['n2']['N'] == pytest.approx(k_brace*u, abs=1e-10)
        assert sum(r['fx'] for r in row['reactions'].values()) == pytest.approx(-k*(u+beta*v), abs=1e-9)
