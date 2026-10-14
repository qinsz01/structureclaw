"""Opt-in native SpBeam adapter acceptance, including reversed physical ends.

Checks documented release readback, zero released bending moments, retained
torsion and equilibrium. Partial loads exercise connected internal mesh joints.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import math
import os
from pathlib import Path
import sys
import time
import uuid

ROOT=Path(__file__).resolve().parents[2]
ADAPTER=ROOT/'backend/src/agent-skills/analysis/yjk-static'
sys.path[:0]=[str(ADAPTER),str(ADAPTER.parent/'runtime'),str(ROOT/'backend/src/skill-shared/python')]
from yjk_native_boundaries import beam_release_plan


def verify(work):
    model=json.loads((work/'source.json').read_text('utf8'))
    result=json.loads((work/'result.json').read_text('utf8'))
    job=next(work.glob('sc_*'));audit=json.loads((job/'native-physics-audit.json').read_text('utf8'))
    assert audit['passed']
    nodes={row['id']:row for row in model['nodes']};members={row['id']:row for row in model['elements']}
    released={key:beam_release_plan(row)['hinges'] for key,row in members.items() if row.get('releases')}
    torsion_seen=False;checks=[]
    for case in model['load_cases']:
        data=result['nativeResultSet']['results']['case:'+case['id']]['data']
        assert data['nativeContext']['stationConventionsVerified'] is True
        for identifier,ends in released.items():
            stations=data['memberStations'][identifier]
            for end,station in zip(ends,(stations[0],stations[-1])):
                if end:
                    assert abs(station['components']['My'])<=1e-5
                    assert abs(station['components']['Mz'])<=1e-5
                    torsion_seen |= abs(station['components']['T'])>1e-4
        external=[0.]*6
        for load in case['loads']:
            if load['type']=='nodal':
                position=[nodes[load['node']][key] for key in ('x','y','z')]
                force=[load.get(key,0) for key in ('fx','fy','fz')]
                moment=[load.get(key,0) for key in ('mx','my','mz')]
            else:
                a,b=[nodes[key] for key in members[load['element']]['nodes']]
                length=math.dist([a[key] for key in ('x','y','z')],[b[key] for key in ('x','y','z')])
                if load['type']=='point':
                    x=load['position'];force=[0,0,load['fz']]
                else:
                    start,end=load.get('start',0),load.get('end',length)
                    x=(start+end)/2;force=[0,0,load['wz']*(end-start)]
                position=[a[key]+x/length*(b[key]-a[key]) for key in ('x','y','z')];moment=[0,0,0]
            x,y,z=position;fx,fy,fz=force
            values=[*force,moment[0]+y*fz-z*fy,moment[1]+z*fx-x*fz,moment[2]+x*fy-y*fx]
            external=[a+b for a,b in zip(external,values)]
        reactions=[0.]*6
        for identifier,row in data['reactions'].items():
            x,y,z=[nodes[identifier][key] for key in ('x','y','z')]
            fx,fy,fz,mx,my,mz=[row[key] for key in ('fx','fy','fz','mx','my','mz')]
            values=[fx,fy,fz,mx+y*fz-z*fy,my+z*fx-x*fz,mz+x*fy-y*fx]
            reactions=[a+b for a,b in zip(reactions,values)]
        for index,(r,f) in enumerate(zip(reactions,external)):
            assert math.isclose(r,-f,rel_tol=1e-5,abs_tol=1e-5),(case['id'],index,r,f)
        checks.append({'caseId':case['id'],'applied':external,'reactions':reactions})
    assert torsion_seen,'A bending hinge must still transfer torsion'
    if (job/'physical-mesh.json').exists():
        receipt=json.loads((job/'physical-mesh.json').read_text('utf8'))
        rows=receipt['members']['BX0']
        for index,row in enumerate(rows):
            plan=audit['materials']['members'][row['id']]['nativeEndReleases']
            assert sum(plan['hinges'])==(1 if index==0 else 0)
    summary={'status':'passed','nativeJob':str(job),'bendingReleasedTorsionRetained':True,
             'cases':checks,'releaseMembers':released,'mesh':(job/'physical-mesh.json').exists()}
    (work/'acceptance.json').write_text(json.dumps(summary,indent=2),'utf8')
    print(json.dumps({'status':'passed','workDir':str(work)}),flush=True)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--native',action='store_true',required=True)
    parser.add_argument('--mesh',action='store_true')
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    if not os.environ.get('YJKS_ROOT') or not os.environ.get('YJK_PYTHON_BIN'):
        parser.error('Private YJKS_ROOT and YJK_PYTHON_BIN are required / 须指定独立原生环境')
    work=args.output.resolve()/('yjk-end-releases-'+time.strftime('%Y%m%d-%H%M%S')+'-'+uuid.uuid4().hex[:8]);work.mkdir(parents=True)
    model=json.loads((ADAPTER/'__tests__/fixtures/native-design-concrete-model.json').read_text('utf8'))
    members={row['id']:row for row in model['elements']}
    members['BX0']['nodes'].reverse()
    for identifier,ends in [('BX0',('i',)),('BX1',('i','j')),('BY0',('j',))]:
        members[identifier]['releases']={key:{'ry':True,'rz':True} for key in ends}
    model['load_cases']=[{'id':key,'name':key,'type':'other','loads':[{'id':key,'type':'nodal','node':'N100',key.lower():10}]}
                         for key in ('FX','FY','FZ','MX','MY','MZ')]
    loads=[{'id':'q','type':'distributed','element':'BX0','wz':-7}]
    if args.mesh:
        loads[0].update(start=1.,end=3.5)
        loads.append({'id':'p','type':'point','element':'BX0','position':1.7,'fz':-5})
    model['load_cases'].append({'id':'D','name':'D','type':'dead','loads':loads});model['load_combinations']=[]
    request={'traceId':'end-release-adapter','_internalResultSelections':[{'key':'case:'+r['id'],'kind':'case','id':r['id']} for r in model['load_cases']]}
    for name,value in [('source.json',model),('request.json',request)]:
        (work/name).write_text(json.dumps(value,indent=2),'utf8')
    os.environ['YJK_WORK_DIR']=str(work)
    print(work,flush=True)
    spec=importlib.util.spec_from_file_location('release_runtime',ADAPTER/'runtime.py')
    runtime=importlib.util.module_from_spec(spec);spec.loader.exec_module(runtime)
    result=runtime.run_analysis(model,request)
    (work/'result.json').write_text(json.dumps(result,indent=2),'utf8')
    verify(work)


if __name__=='__main__':main()
