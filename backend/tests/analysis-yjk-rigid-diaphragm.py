"""Opt-in private YJK diaphragm adapter acceptance, without Bench dependencies.

Checks native setting/constraint readback, in-plane kinematics, independent
out-of-plane motion and ordinary global equilibrium; no substitute solver.
"""
from __future__ import annotations

import argparse
import copy
import importlib.util
import json
import math
import os
from pathlib import Path
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
ADAPTER = ROOT/'backend/src/agent-skills/analysis/yjk-static'
sys.path[:0] = [str(ADAPTER), str(ADAPTER.parent/'runtime'), str(ROOT/'backend/src/skill-shared/python')]


def verify(work: Path):
    model = json.loads((work/'source.json').read_text('utf8'))
    result = json.loads((work/'result.json').read_text('utf8'))
    jobs = list(work.glob('sc_*')); assert len(jobs) == 1
    audit = json.loads((jobs[0]/'native-physics-audit.json').read_text('utf8'))
    assert audit['passed']
    assert audit['settings']['diaphragms']['passed']
    nodes = {row['id']: row for row in model['nodes']}
    elevated = [row for row in model['nodes'] if row['z'] > 0]
    checks = []
    for case in model['load_cases']:
        data = result['nativeResultSet']['results']['case:'+case['id']]['data']
        assert data['nativeContext']['effectiveSettingsVerified'] is True
        disp = data['displacements']
        for node in elevated:
            first = next(row for row in elevated if row['z'] == node['z'])
            u, v = disp[node['id']], disp[first['id']]
            dx, dy = node['x']-first['x'], node['y']-first['y']
            expressions = [(u['ux']-v['ux'], -v['rz']*dy),
                           (u['uy']-v['uy'], v['rz']*dx), (u['rz'], v['rz'])]
            for actual, target in expressions:
                bound = 8*2**-23*max(abs(actual), abs(target), *(abs(row[key]) for row in (u,v) for key in ('ux','uy','rz')), 1e-14)
                assert abs(actual-target) <= bound, (case['id'], node['id'], actual, target, bound)
        expected = [0.]*6
        for load in case['loads']:
            node = nodes[load['node']]
            fx, fy, fz, mx, my, mz = [load.get(key, 0) for key in ('fx','fy','fz','mx','my','mz')]
            applied = [fx,fy,fz,mx+node['y']*fz-node['z']*fy,my+node['z']*fx-node['x']*fz,mz+node['x']*fy-node['y']*fx]
            expected = [a+b for a,b in zip(expected,applied)]
        weight = data['nativeContext']['effectiveLoads']['selfWeight']
        if case['id'] == weight.get('loadCaseId'):
            elements = {row['id']: row for row in model['elements']}
            for row in weight['members']:
                ends = [nodes[tag] for tag in elements[row['elementId']]['nodes']]
                x,y,z = [(a[key]+b[key])/2 for key in ('x','y','z') for a,b in [ends]]
                fx,fy,fz = row['totalForceVectorKn']
                applied = [fx,fy,fz,y*fz-z*fy,z*fx-x*fz,x*fy-y*fx]
                expected = [a+b for a,b in zip(expected,applied)]
        reactions = [sum(row[key] for row in data['reactions'].values()) for key in ('fx','fy','fz','mx','my','mz')]
        for identifier, row in data['reactions'].items():
            node = nodes[identifier]
            reactions[3] += node['y']*row['fz']-node['z']*row['fy']
            reactions[4] += node['z']*row['fx']-node['x']*row['fz']
            reactions[5] += node['x']*row['fy']-node['y']*row['fx']
        for index,(r,f) in enumerate(zip(reactions,expected)):
            assert math.isclose(r, -f, rel_tol=1e-5, abs_tol=1e-5), (case['id'],index,r,f)
        checks.append({'caseId':case['id'], 'sourceResultant':expected,'reactionResultant':reactions})
    # A rigid diaphragm must not make all six nodal DOFs identical.
    gravity = result['nativeResultSet']['results']['case:D']['data']['displacements']
    assert max(gravity[n['id']]['uz'] for n in elevated)-min(gravity[n['id']]['uz'] for n in elevated) > 1e-8
    request = json.loads((work/'request.json').read_text('utf8'))
    if request.get('design', {}).get('requested'):
        assert result['nativeDesignResults']['status'] == 'completed'
        assert result['nativeDesignResults']['records']
    else:
        assert result['nativeDesignContext']['eligibleForConclusion'] is False
    summary={'status':'passed','job':str(jobs[0]),'checks':checks,'diaphragms':audit['settings']['diaphragms'],
             'nativeDesignStatus':result.get('nativeDesignResults',{}).get('status')}
    (work/'acceptance.json').write_text(json.dumps(summary,indent=2),'utf8')
    print(json.dumps({'status':'passed','workDir':str(work)}),flush=True)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--native',action='store_true',required=True)
    parser.add_argument('--custom',action='store_true')
    parser.add_argument('--two-storeys',action='store_true')
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    if not os.environ.get('YJKS_ROOT') or not os.environ.get('YJK_PYTHON_BIN'):
        parser.error('Private YJKS_ROOT and YJK_PYTHON_BIN are required / 须指定独立原生环境')
    work=args.output.resolve()/('yjk-diaphragm-'+time.strftime('%Y%m%d-%H%M%S')+'-'+uuid.uuid4().hex[:8]);work.mkdir(parents=True)
    model=json.loads((ADAPTER/'__tests__/fixtures/native-design-concrete-model.json').read_text('utf8'))
    model['analysis_control'].update(rigid_floor=True,self_weight=True)
    if args.two_storeys:
        old_nodes = {row['id']: row for row in model['nodes']}
        upper = [row for row in model['nodes'] if row['z'] == 3]
        for row in upper:
            model['nodes'].append({**copy.deepcopy(row), 'id': row['id']+'_F2', 'z': 6})
        for row in list(model['elements']):
            refs = []
            for tag in row['nodes']:
                node = old_nodes[tag]
                refs.append(tag+'_F2' if node['z'] == 3 else next(n['id'] for n in upper if n['x']==node['x'] and n['y']==node['y']))
            model['elements'].append({**copy.deepcopy(row), 'id':row['id']+'_F2', 'nodes':refs})
        model['stories'].append({'id':'F2','elevation':3,'height':3})
    model['load_cases']=[{'id':key,'name':key,'type':kind,'loads':[{'id':key+'1','type':'nodal','node':'N100',component:value}]}
                         for key,kind,component,value in [('FX','other','fx',10),('FY','other','fy',7),('D','dead','fz',-80)]]
    if args.two_storeys:
        for case in model['load_cases']:
            case['loads'][0]['node'] += '_F2'
    model['load_combinations']=[]
    request={'traceId':'diaphragm-adapter','_internalResultSelections':[{'key':'case:'+row['id'],'kind':'case','id':row['id']} for row in model['load_cases']]}
    if args.custom:
        for section in model['sections']:
            section.pop('shape'); section['type']='custom'; section['properties'].update(A=.027,Iy=.0011,Iz=.0023,J=.0009)
    else:
        request['design']={'requested':True,'mode':'required-reinforcement','code':'GB/T50010-2010(2024)','adoptedNativeDefaults':True}
    for name,value in [('source.json',model),('request.json',request)]:
        (work/name).write_text(json.dumps(value,indent=2),'utf8')
    os.environ['YJK_WORK_DIR']=str(work)
    print(work,flush=True)
    spec=importlib.util.spec_from_file_location('diaphragm_runtime',ADAPTER/'runtime.py')
    runtime=importlib.util.module_from_spec(spec);spec.loader.exec_module(runtime)
    result=runtime.run_analysis(model,request)
    (work/'result.json').write_text(json.dumps(result,indent=2),'utf8')
    verify(work)


if __name__=='__main__':
    main()
