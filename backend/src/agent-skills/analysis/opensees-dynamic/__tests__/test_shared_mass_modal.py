"""Independent cantilever periods validate the common dynamic/seismic path."""
import math
import sys
from pathlib import Path

import pytest

ANALYSIS = Path(__file__).resolve().parents[2]
for folder in [ANALYSIS/'opensees-dynamic', ANALYSIS/'opensees-seismic', ANALYSIS/'runtime', ANALYSIS.parents[1]/'skill-shared'/'python']:
    sys.path.insert(0, str(folder))

from structure_protocol.structure_model_v2 import StructureModelV2
from opensees_shared.tags import OpenSeesTagMapper
from opensees_dynamic_analysis import OpenSeesDynamicExecutor
from modal import run_modal_analysis


def cantilever(dimension, source):
    restraints = [False, True, True, True, False, True] if dimension == '2d' else [False, False, True, False, False, True]
    return StructureModelV2.model_validate({
        'schema_version': '2.2.0', 'unit_system': 'SI',
        'coordinate_system': {'semantics': 'global-z-up', 'version': 1, 'dimension': dimension,
            'plane': 'xz' if dimension == '2d' else None, 'dof_order': ['ux','uy','uz','rx','ry','rz']},
        'nodes': [{'id':'base','x':0,'y':0,'z':0,'restraints':[True]*6},
            {'id':'top','x':0,'y':0,'z':3,'story':'F1','restraints':restraints, **({'mass':10} if source == 'nodal' else {})}],
        'elements': [{'id':'C','type':'column','nodes':['base','top'],'material':'S','section':'A'}],
        'materials': [{'id':'S','name':'explicit steel','E':200000,'nu':.3,'rho':7850}],
        'sections': [{'id':'A','name':'explicit properties','type':'custom','properties':{'A':.02,'Iy':.0001,'Iz':.0002,'J':.00005}}],
        'stories': [{'id':'F1','height':3,'elevation':0, **({'extra':{'seismic_mass':10}} if source=='floor-seismic' else {})}],
        'analysis_control': {'mass_source':source, 'mass_directions':['x'] if dimension=='2d' else ['x','y']},
    })


@pytest.mark.parametrize('dimension', ['2d','3d'])
@pytest.mark.parametrize('source', ['nodal','member-density','floor-seismic'])
def test_same_mass_and_constraints_give_same_modes_and_analytic_periods(dimension, source):
    import openseespy.opensees as ops
    model = cantilever(dimension, source)
    dynamic = OpenSeesDynamicExecutor(OpenSeesTagMapper(model)).modal_analysis(2, ops)
    seismic = run_modal_analysis(model, None, 2).to_dict()
    assert dynamic['execution']['massAssembly'] == seismic['execution']['massAssembly']
    assert [m['period'] for m in dynamic['modes']] == pytest.approx([m['period'] for m in seismic['modes']], rel=1e-10)
    assert [m['effectiveMass'] for m in dynamic['modes']] == pytest.approx([m['effectiveMass'] for m in seismic['modes']], rel=1e-10, abs=1e-10)
    tip_mass = 7850*.02*3/2000 if source == 'member-density' else 10
    inertias = [.0001] if dimension == '2d' else [.0001, .0002]
    expected = sorted([2*math.pi*math.sqrt(tip_mass*3**3/(3*200000000*i)) for i in inertias], reverse=True)
    assert [m['period'] for m in dynamic['modes']] == pytest.approx(expected, rel=1e-10)
    assert sum(m['effectiveMass'] for m in dynamic['modes']) == pytest.approx(tip_mass, rel=1e-10)


def test_time_history_records_requested_nodes_and_time_index():
    import openseespy.opensees as ops
    executor = OpenSeesDynamicExecutor(OpenSeesTagMapper(cantilever('2d','nodal')))
    result = executor.time_history_analysis(.02,.1,.05,[0,.1,-.1,.05,0],ops,monitor_node_ids=['base','top'])
    assert result['monitorNodeIds'] == ['base','top']
    assert result['responseScope'] == 'requested-nodes'
    assert [r['timeIndex'] for r in result['timeHistory']] == list(range(5))
    assert any(abs(r['nodes']['top']['ux']) > 0 for r in result['timeHistory'])
    assert all(r['nodes']['base'] == {'ux':0,'uy':0,'uz':0} for r in result['timeHistory'])


def test_conflicting_request_mass_source_cannot_replace_model_mass():
    import openseespy.opensees as ops
    executor = OpenSeesDynamicExecutor(OpenSeesTagMapper(cantilever('2d','nodal')), {'massSource':'member-density'})
    with pytest.raises(ValueError, match='conflicts'):
        executor.modal_analysis(1,ops)


def test_one_story_mass_is_not_repeated_at_different_roof_elevations():
    from opensees_shared.mass import assemble_mass
    model = cantilever('2d','floor-seismic')
    model.nodes.append(model.nodes[1].model_copy(update={'id':'roof2','x':4,'z':3.5}))
    with pytest.raises(ValueError, match='multiple elevated nodal levels'):
        assemble_mass(model)


def test_roundoff_in_same_floor_elevation_preserves_one_declared_mass():
    from opensees_shared.mass import assemble_mass, floor_mass_records
    model = cantilever('2d','floor-seismic')
    model.nodes.append(model.nodes[1].model_copy(update={'id':'roof2','x':4,'z':3.0000000000000004}))
    result = assemble_mass(model)
    assert result['totalMass'] == 10
    assert len(result['floorMasses']) == 1
    assert result['nodeMasses'] == {'base':0,'top':5,'roof2':5}
    assert sum(row['mass'] for row in floor_mass_records(model, result['nodeMasses'])) == 10


@pytest.mark.parametrize('source', ['nodal', 'member-density', 'floor-seismic'])
def test_undeclared_mass_selection_is_identical_for_dynamic_and_seismic(source):
    import openseespy.opensees as ops
    model = cantilever('2d', source)
    model.analysis_control = None
    dynamic = OpenSeesDynamicExecutor(OpenSeesTagMapper(model)).modal_analysis(1, ops)
    seismic = run_modal_analysis(model, None, 1).to_dict()
    assert dynamic['massAssembly'] == seismic['execution']['massAssembly']
    assert dynamic['massAssembly']['source'] == source
    assert dynamic['modes'][0]['period'] == pytest.approx(seismic['modes'][0]['period'], rel=1e-12)


def test_explicit_floor_and_nodal_mass_are_a_conflict_even_with_selected_source():
    from opensees_shared.mass import assemble_mass
    model = cantilever('2d', 'nodal')
    model.stories[0].extra = {'seismic_mass': 10}
    with pytest.raises(ValueError, match='story seismic mass conflicts'):
        assemble_mass(model)


def test_request_mass_directions_conflict_and_seismic_copy_preserves_original():
    from opensees_shared.mass import model_with_mass_request, assemble_mass
    model = cantilever('3d', 'nodal')
    before = model.model_dump()
    with pytest.raises(ValueError, match='massDirections conflicts'):
        model_with_mass_request(model, {'massDirections': ['x']})
    model.analysis_control = None
    selected = model_with_mass_request(model, {'massSource': 'nodal', 'massDirections': ['y']})
    assert selected is not model and model.analysis_control is None
    assert assemble_mass(selected)['directions'] == ['y']
    model.analysis_control = type(selected.analysis_control).model_validate(before['analysis_control'])
    assert model.model_dump() == before


def test_inactive_and_empty_requested_mass_directions_fail_before_solver():
    from opensees_shared.mass import assemble_mass
    model = cantilever('2d', 'nodal')
    for invalid in ([], ['y'], ['x', 'x']):
        with pytest.raises(ValueError, match='unique active global axes'):
            assemble_mass(model, directions=invalid)


@pytest.mark.parametrize('mass_directions', [['x'], ['x','z']])
def test_time_history_rejects_excitation_without_free_mass_in_its_direction(mass_directions):
    import openseespy.opensees as ops
    model = cantilever('2d','nodal')
    model.analysis_control.mass_directions = mass_directions
    if mass_directions == ['x']:
        # Geometrically free Z still has no mass in the selected mass basis.
        model.nodes[1].restraints[2] = False
    executor = OpenSeesDynamicExecutor(OpenSeesTagMapper(model))
    try:
        with pytest.raises(ValueError, match='no active free translational mass'):
            executor.time_history_analysis(.02,.1,.05,[0,1,-1,1,0],ops,direction='z')
    finally:
        ops.wipe()
