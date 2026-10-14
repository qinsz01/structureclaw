from copy import deepcopy
import json
from pathlib import Path
import sys
import pytest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from yjk_native_offsets import audit_rigid_offsets, restore_physical_offsets
from yjk_native_stations import member_geometry, map_stations, StationConventionUnavailable


def fixture():
    return json.loads((Path(__file__).parent/'fixtures/native-rigid-offset-readback.json').read_text('utf8'))


def audit(row):
    return audit_rigid_offsets(row['model'],row['fe'],row['memberAudit'],row['members'])


def test_actual_sdk_units_and_reversed_column_ends_are_preserved():
    row=fixture();result=audit(row)
    assert result['verified'],result['failures']
    beam,column=result['members']['BX0'],result['members']['C00']
    assert (beam['elasticStartM'],beam['elasticEndM']) == (.15,5.85)
    assert (column['elasticStartM'],column['elasticEndM']) == (0.,2.775)
    assert beam['source']['readbackFields']['SDK.lengthUnit']=='m'
    assert column['source']['readbackFields']['SDK.lengthUnit']=='mm'
    assert column['source']['readbackFields']['SDK.rigid']==[225.,0.]


@pytest.mark.parametrize('bad', ['unit','missing','nan','negative','overlap','eccentric','wrong-node'])
def test_unverified_rigid_geometry_cannot_enable_station_mapping(bad):
    row=fixture();tag=row['memberAudit']['members']['BX0']['nativeFrameId']
    if bad=='unit':row['members'][tag]['native_geometry']['rigid']=[150.,150.]
    elif bad=='missing':del row['members'][tag]['native_geometry']['rigid']
    elif bad=='nan':row['members'][tag]['native_geometry']['rigid']=[float('nan'),.15]
    elif bad=='negative':row['members'][tag]['native_geometry']['rigid']=[-.15,.15]
    elif bad=='overlap':
        row['members'][tag]['native_geometry']['rigid']=[3.,3.]
        row['fe']['frames'][tag]['RZL']=[3.,3.]
    elif bad=='eccentric':row['fe']['frames'][tag]['E']=[.1,0,0,0,0,0]
    else:row['fe']['frames'][tag]['nodes']=['1000003','1000004']
    assert audit(row)['verified'] is False


@pytest.mark.parametrize('reversed_endpoints', [False,True])
def test_native_stations_remain_at_elastic_span_faces(reversed_endpoints):
    row=fixture();element=next(m for m in row['model']['elements'] if m['id']=='BX0')
    if reversed_endpoints:element['nodes'].reverse()
    offsets=audit(row);assert offsets['verified']
    lookup={str(tag):next(n['id'] for n in row['model']['nodes'] if [n[k] for k in ('x','y','z')]==p)
            for tag,p in row['fe']['nodes'].items() if int(tag) in {1,2,3,4,1000001,1000002,1000003,1000004}}
    nodes={n['id']:{k+'_m':n[k] for k in ('x','y','z')} for n in row['model']['nodes']}
    tag=row['memberAudit']['members']['BX0']['nativeFrameId']
    g=member_geometry(row['fe'],row['members'][tag],element,lookup,nodes,rigid_offsets=offsets)
    stations=map_stations([[1,2,3,4,5,6]]*9,g)
    assert stations[0]['positionM']==.15 and stations[-1]['positionM']==5.85
    assert stations[0]['nativeStationIndex']==(8 if reversed_endpoints else 0)
    assert stations[0]['source']['effectiveRigidOffsets']['sourceNodeIds']==element['nodes']
    offsets['sourceFeaSha256']='stale'
    with pytest.raises(StationConventionUnavailable):member_geometry(row['fe'],row['members'][tag],element,lookup,nodes,rigid_offsets=offsets)


def test_mesh_aggregation_retains_only_physical_outer_rigid_zones():
    source={'verified':True,'sourceFeaSha256':'native','members':{
        'a':{'physicalLengthM':2.,'startLengthM':.15,'endLengthM':0.,'sourceNodeIds':['i','m']},
        'b':{'physicalLengthM':4.,'startLengthM':0.,'endLengthM':.3,'sourceNodeIds':['m','j']}}}
    receipt={'members':{'physical':[{'id':'a','start':0.,'end':2.},{'id':'b','start':2.,'end':6.}]}}
    result=restore_physical_offsets(source,receipt)
    assert result['members']['physical']['sourceNodeIds']==['i','j']
    assert result['members']['physical']['elasticEndM']==5.7
    assert set(source['members'])=={'a','b'}
    source['members']['a']['endLengthM']=.1
    with pytest.raises(ValueError,match='internal rigid'):restore_physical_offsets(source,receipt)
