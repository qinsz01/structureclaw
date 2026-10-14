from copy import deepcopy
import json
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from yjk_native_boundaries import beam_release_plan, write_beam_releases
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
