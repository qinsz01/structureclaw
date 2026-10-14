from copy import deepcopy
import json
import math
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[4]/'skill-shared/python'))
from yjk_native_axial_weight import compile_input


def specimen(tmp_path, reversed_source=False, rigid=(.225, 0.)):
    model = {'analysis_control': {'self_weight': True, 'self_weight_case_id': 'D', 'rigid_offsets': True},
        'nodes': [{'id':'a','x':0.,'y':0.,'z':0.}, {'id':'b','x':0.,'y':0.,'z':3.}],
        'elements':[{'id':'c','type':'column','nodes':['b','a'] if reversed_source else ['a','b'], 'material':'m','section':'s'}],
        'materials':[{'id':'m','rho':2500}], 'sections':[{'id':'s','properties':{'A':.18}}],
        'load_cases':[{'id':'D','type':'dead','loads':[]}]}
    mapping = {'load_cases':[{'sourceCaseId':'D','nativeName':'SC001_D'}]}
    raw = f'''*UNIT
UNIT=0,0,0
*STRUCTURE
GRAV=10
*NODE
1 C=0,0,0
2 C=0,0,3
*FRAME
9 T=COLUMN N=2,1 RZL={rigid[0]},{rigid[1]} E=0,0,0,0,0,0
*STATIC_LDCASE
10001 N=SC001_D T=DEAD
*USE-STLD LCID=10001
*FRAMELOAD
9 T=UNILOAD DIR=GZ F=0,-4.41299,-1,-4.41299 G=0
'''.encode()
    (tmp_path/'fea.dat').write_bytes(raw)
    return model, mapping, raw


@pytest.mark.parametrize('reversed_source',[False,True])
def test_actual_rigid_input_drives_exact_axial_virtual_work(tmp_path,reversed_source):
    model,mapping,before=specimen(tmp_path,reversed_source,rigid=(.225,.1))
    original=deepcopy(model)
    plan=compile_input(tmp_path,model,mapping)
    row=plan['members'][0]
    assert (tmp_path/'fea.dat').read_bytes()==before
    assert (tmp_path/'fea-before-axial-gravity.dat').read_bytes()==before
    assert model==original and plan['verified'] is False
    assert row['nativeRigidLengthsM']==[.225,.1]
    assert row['point']['nativePositionM']==1.5
    q=row['sourceIntensityVectorKnM'][2];l=3-.325
    # Compare virtual work for independent arbitrary end displacements, not
    # just resultant equilibrium. Linear interpolation integrates exactly.
    for ui,uj in ((1.,0.),(0.,1.),(-3.,7.),(.15,-.31)):
        integrated=q*(l*(ui+uj)/2+.225*ui+.1*uj)
        compiled=row['point']['forceVectorKn'][2]*(ui+uj)/2+sum(
            node['forceVectorKn'][2]*u for node,u in zip(row['rigidSegmentNodeLoads'],(ui,uj)))
        assert math.isclose(integrated,compiled,rel_tol=1e-14,abs_tol=1e-14)
    assert row['nativeInteriorFieldSemantics']=='computational-load-vector; not-physical-uniform-load'


@pytest.mark.parametrize('bad',['direction','case','intensity','eccentric','kind','range','duplicate','units','negative'])
def test_unverified_native_inputs_cannot_generate_load_plan(tmp_path,bad):
    model,mapping,raw=specimen(tmp_path)
    changes={'direction':(b'DIR=GZ',b'DIR=GX'),'case':(b'LCID=10001',b'LCID=10002'),
             'intensity':(b'-4.41299',b'-4.4129'),'eccentric':(b'E=0,0,0,0,0,0',b'E=0,0,0,0,0,.1'),
             'kind':(b'T=COLUMN',b'T=BRACE'),'range':(b'RZL=0.225,0.0',b'RZL=3,0'),
             'units':(b'UNIT=0,0,0',b'UNIT=1,0,0'),'negative':(b'RZL=0.225,0.0',b'RZL=-1,0')}
    if bad=='duplicate':raw+=b'9 T=UNILOAD DIR=GZ F=0,-4.41299,-1,-4.41299 G=0\n'
    else:
        a,b=changes[bad];assert a in raw;raw=raw.replace(a,b)
    (tmp_path/'fea.dat').write_bytes(raw)
    with pytest.raises(ValueError):compile_input(tmp_path,model,mapping)
    assert (tmp_path/'fea.dat').read_bytes()==raw
    assert not (tmp_path/'native-axial-gravity-compilation.json').exists()


def test_a_second_compile_cannot_overwrite_prior_evidence(tmp_path):
    model,mapping,_=specimen(tmp_path)
    compile_input(tmp_path,model,mapping)
    saved=(tmp_path/'native-axial-gravity-compilation.json').read_bytes()
    with pytest.raises(ValueError,match='already compiled'):compile_input(tmp_path,model,mapping)
    assert (tmp_path/'native-axial-gravity-compilation.json').read_bytes()==saved


def native_fixture(tmp_path):
    fixture = json.loads((Path(__file__).parent/'fixtures/native-rigid-axial-weight.json').read_text('utf8'))
    for name,key in [('fea-before-axial-gravity.dat','beforeFE'),('fea.dat','afterFE')]:
        (tmp_path/name).write_bytes(fixture[key].encode('gb18030'))
    for name,key in [('native-axial-gravity-compilation.json','plan'),('geometry-mapping.json','geometryMapping')]:
        (tmp_path/name).write_text(json.dumps(fixture[key]),'utf8')
    fixture['mapping']['ydb_path'] = str(tmp_path/'model.ydb')
    return fixture


def audit_fixture(tmp_path,fixture):
    from native_fe import parse_fe
    from native_load_audit import audit_loads
    return audit_loads(fixture['model'],fixture['mapping'],parse_fe(tmp_path/'fea.dat'))


def test_real_sdk_local_axial_point_is_bound_to_source_virtual_work(tmp_path):
    fixture=native_fixture(tmp_path)
    audited=audit_fixture(tmp_path,fixture)
    packet=audited['selfWeightCompilation']['consistentLoadCompilation']
    assert audited['passed'] and packet['verified']
    assert packet['sourceFeaSha256']==audited['feaSha256']
    assert packet['sourceFeaSha256']!=packet['geometryFeaSha256']
    row=next(row for row in packet['members'] if row['physicalElementId']=='C00')
    assert row['nativeNodeIds']==['1000001','1']
    assert row['executedPoint']=={'nativePositionM':1.5,'forceVectorKn':[0.,0.,-12.2461],
        'nativeDirection':'LX','nativeValues':[1.5,12.2461]}
    assert row['nativeNodeAggregates'][0]['executedTotalForceVectorKn']==[0.,0.,-.992923]
    assert row['sourceIntensityVectorKnM']==[0.,0.,-4.4129925]
    assert all(row['executionMethod']=='consistent-axial-load-vector' for row in
        audited['selfWeightCompilation']['executedCompilation'] if row['sourceSegmentId'].startswith('C'))


@pytest.mark.parametrize('bad',['direction','point','rigid','receipt','source','node','extra-point'])
def test_native_compilation_cannot_hide_wrong_inputs(tmp_path,bad):
    fixture=native_fixture(tmp_path)
    path=tmp_path/'fea.dat';raw=path.read_bytes()
    if bad=='receipt':
        plan=fixture['plan'];plan['physicalModelHash']='0'*64
        (tmp_path/'native-axial-gravity-compilation.json').write_text(json.dumps(plan),'utf8')
    elif bad=='source':
        fixture['model']['materials'][0]['rho']+=1
    else:
        changes={'direction':(b'DIR=LX F=1.5,12.2461',b'DIR=LY F=1.5,12.2461'),
            'point':(b'DIR=LX F=1.5,12.2461',b'DIR=LX F=1.5,12.2462'),
            'rigid':(b'RZL=0.225,0',b'RZL=0.226,0'),
            'node':(b'F=0,0,-0.992923,0,0,0',b'F=0,0,-0.992823,0,0,0')}
        if bad=='extra-point':
            raw+=b'\n*USE-STLD LCID=10013\n*FRAMELOAD\n1000008 T=CONLOAD DIR=LX F=1.5,1 G=0\n'
        else:
            a,b=changes[bad];assert a in raw;raw=raw.replace(a,b,1)
        path.write_bytes(raw)
    with pytest.raises(ValueError):audit_fixture(tmp_path,fixture)


def test_consistent_packet_preserves_source_and_compiled_model_binding(tmp_path):
    from yjk_self_weight import restore_physical_compilation
    fixture=native_fixture(tmp_path)
    weight=audit_fixture(tmp_path,fixture)['selfWeightCompilation']
    compiled_hash=weight['consistentLoadCompilation']['physicalModelHash']
    receipt={'compiledModelHash':compiled_hash,'physicalModelHash':'physical-source-hash',
        'members':{row['elementId']:[{'id':row['elementId'],'start':0.,'end':row['lengthM']}] for row in weight['members']}}
    restored=restore_physical_compilation(weight,receipt)['consistentLoadCompilation']
    assert restored['physicalModelHash']=='physical-source-hash'
    assert restored['compiledModelHash']==restored['sourceModelHash']==compiled_hash
    assert weight['consistentLoadCompilation']['physicalModelHash']==compiled_hash
    with pytest.raises(ValueError,match='compiled mesh'):
        restore_physical_compilation(weight,{**receipt,'compiledModelHash':'stale'})
