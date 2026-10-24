from copy import deepcopy
import json
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from yjk_native_boundaries import beam_release_plan, write_beam_releases, audit_node_restraints, compile_supports, write_supports
from member_mesh import compile_member_mesh


@pytest.mark.parametrize('ends', [(False,False),(True,False),(False,True),(True,True)])
def test_bending_hinges_keep_torsion_and_follow_native_endpoints(ends):
    member={'type':'beam','nodes':['left','right'],'releases':{key:{'ry':value,'rz':value} for key,value in zip(('i','j'),ends)}}
    a,b=[100. if x else 0. for x in ends]
    assert beam_release_plan(member)['nativeR']==[a,b,a,b,0.,0.]
    assert beam_release_plan(member,['right','left'])['nativeR']==[b,a,b,a,0.,0.]


@pytest.mark.parametrize('value', [{'i':{'ry':True}}, {'i':{'rx':True}}, {'i':{'ry':1,'rz':1}},
                                  {'i':{'ry':True,'rz':True},'releaseI':{}}, {'reference_frame':'global'}])
def test_unmapped_or_ambiguous_release_does_not_change_the_source(value):
    member={'type':'beam','nodes':['a','b'],'releases':value};original=deepcopy(member)
    with pytest.raises(ValueError):beam_release_plan(member)
    assert member==original


def test_load_refinement_preserves_only_physical_end_hinges():
    source=json.loads((Path(__file__).parent/'fixtures/native-design-concrete-model.json').read_text('utf8'))
    beam=next(row for row in source['elements'] if row['id']=='BX0')
    beam['nodes'].reverse();beam['releases']={'i':{'ry':True,'rz':True},'j':{'ry':True,'rz':True}}
    source['load_cases'][0]['loads'].extend([{'type':'point','element':'BX0','position':1.7,'fz':-3},
        {'type':'distributed','element':'BX0','start':2.,'end':4.,'wz':-2}])
    original=deepcopy(source);mesh,receipt=compile_member_mesh(source)
    parts=[next(row for row in mesh['elements'] if row['id']==segment['id']) for segment in receipt['members']['BX0']]
    assert source==original and len(parts)==4
    assert [beam_release_plan(row)['hinges'] for row in parts]==[[1,0],[0,0],[0,0],[0,1]]
    assert parts[0]['nodes'][0]==beam['nodes'][0] and parts[-1]['nodes'][-1]==beam['nodes'][-1]


def test_sdk_property_follows_grid_order_before_native_fe_reversal(monkeypatch):
    from types import SimpleNamespace
    class Property:
        def __init__(self, name):
            assert name == 'SpBeam'
            self.values = [0, 0]
        def setVal(self, index, value):
            self.values[index] = value
        def GetValString(self):
            return ','.join(map(str, self.values))
    written = []
    def arrange(member, name, kind, value):
        written.append((member, name, kind, value))
        return SimpleNamespace(ShapeVal=value)
    monkeypatch.setitem(sys.modules, 'YJKAPI', SimpleNamespace(Property=Property))
    member = {'type': 'beam', 'nodes': ['right', 'left'], 'releases': {'i': {'ry': True, 'rz': True}}}
    result = write_beam_releases(SimpleNamespace(property_arrange=arrange), 101, member,
                                {'left': {'x': 0, 'y': 0}, 'right': {'x': 6, 'y': 0}})
    assert written == [(101, 'SpBeam', 27, '1,0')]
    assert result['nativeEndpointOrder'] == ['right', 'left']


def support_fixture():
    return json.loads((Path(__file__).parent/'fixtures/native-pinned-support-mismatch.json').read_text('utf8'))


@pytest.mark.parametrize('representation', ['null', 'omitted'])
def test_optional_free_nodes_preserve_native_support_compilation(representation):
    model = support_fixture()['model']
    expected = compile_supports(model)
    for node in model['nodes']:
        if not any(node.get('restraints') or []):
            if representation == 'null':
                node['restraints'] = None
            else:
                node.pop('restraints', None)
    original = deepcopy(model)
    assert compile_supports(model) == expected
    assert model == original


def test_real_native_pin_cannot_certify_an_authored_fixed_support():
    fixture = support_fixture()
    audit = audit_node_restraints(fixture['model'], fixture['fe'])
    assert audit['passed'] is False
    assert audit['failures'] == [{'sourceNodeId': 'N000', 'nativeNodeId': '1',
        'reason': 'restraint-mismatch', 'expected': [1, 1, 1, 1, 1, 1], 'actual': [1., 1., 1., 0., 0., 0.]}]
    fixture['model']['nodes'][0]['restraints'] = [True, True, True, False, False, False]
    audit = audit_node_restraints(fixture['model'], fixture['fe'])
    assert audit['passed'] and len(audit['nodes']) == len(fixture['model']['nodes'])


@pytest.mark.parametrize('mode', ['extra', 'local', 'spring', 'duplicate', 'missing', 'upper', 'malformed'])
def test_unrequested_or_unmapped_native_constraint_is_not_accepted(mode):
    fixture = support_fixture()
    fixture['model']['nodes'][0]['restraints'] = [True, True, True, False, False, False]
    lines = fixture['fe']['sectionsRaw']['CONSTRAINT']
    if mode == 'extra': lines.append('999 R=1,1,1,1,1,1 T=1 G=0')
    elif mode == 'local': lines[0] = lines[0].replace('G=0', 'G=1')
    elif mode == 'spring': lines[0] = lines[0].replace('R=1,1,1,0,0,0', 'R=1,1,1,0.001,0,0')
    elif mode == 'duplicate': lines.append(lines[0])
    elif mode == 'missing': lines.pop(0)
    elif mode == 'upper': lines.append('1000001 R=1,1,1,1,1,1 T=1 G=0')
    else: fixture['model']['nodes'][0]['restraints'] = [1] * 6
    if mode == 'malformed':
        with pytest.raises(ValueError): audit_node_restraints(fixture['model'], fixture['fe'])
    else:
        assert audit_node_restraints(fixture['model'], fixture['fe'])['passed'] is False


def test_support_writer_uses_upper_sdk_joint_but_preserves_physical_base_identity(monkeypatch):
    from types import SimpleNamespace
    model = support_fixture()['model']
    nodes = {row['id']:row for row in model['nodes']}
    nodes['N000']['restraints'] = [True, True, True, False, False, False]
    nodes['N001']['restraints'] = [False, True, True, False, False, False]
    class Property:
        def __init__(self, name):
            assert name == 'SpNode'
            self.values = [0] * 100
        def setVal(self, index, value): self.values[index] = value
        def GetValString(self): return ','.join(map(str, self.values))
    writes = []
    def arrange(tag, name, kind, value):
        writes.append((tag, name, kind, [int(x) for x in value.split(',')[9:15]]))
        return SimpleNamespace(ShapeVal=value)
    monkeypatch.setitem(sys.modules, 'YJKAPI', SimpleNamespace(Property=Property))
    before = deepcopy(model)
    plans = write_supports(SimpleNamespace(property_arrange=arrange), model,
                           {'N100':SimpleNamespace(ID=501), 'N101':SimpleNamespace(ID=987)})
    assert model == before
    assert plans['N000']['nativePlanNodeSourceId'] == 'N100'
    assert plans['N001']['nativePlanNodeSourceId'] == 'N101'
    assert writes == [(501, 'SpNode', 27, [1,1,1,0,0,0]), (987, 'SpNode', 27, [0,1,1,0,0,0])]


@pytest.mark.parametrize('mode', ['elevated', 'inclined', 'unconnected', 'free-base'])
def test_unmapped_support_topology_is_not_silently_changed(mode):
    model = support_fixture()['model']
    nodes = {row['id']:row for row in model['nodes']}
    nodes['N000']['restraints'] = [True, True, True, False, False, False]
    if mode == 'elevated': nodes['N100']['restraints'] = [True] * 6
    elif mode == 'inclined': nodes['N100']['x'] = .3
    elif mode == 'unconnected': model['elements'] = [row for row in model['elements'] if 'N000' not in row['nodes']]
    else: nodes['N000']['restraints'] = [False] * 6
    with pytest.raises(ValueError): compile_supports(model)
