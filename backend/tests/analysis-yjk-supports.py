"""Opt-in private SDK support mapping acceptance; no external API is called."""
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

ROOT = Path(__file__).resolve().parents[2]
ADAPTER = ROOT / 'backend/src/agent-skills/analysis/yjk-static'
sys.path[:0] = [str(ADAPTER), str(ADAPTER.parent/'runtime'), str(ROOT/'backend/src/skill-shared/python')]
from yjk_native_boundaries import DOFS


def verify(work: Path):
    model = json.loads((work/'source.json').read_text('utf8'))
    result = json.loads((work/'result.json').read_text('utf8'))
    job = next(work.glob('sc_*'))
    audit = json.loads((job/'native-physics-audit.json').read_text('utf8'))
    raw = json.loads((job/'results.json').read_text('utf8'))
    assert audit['passed'] and audit['settings']['supports']['passed']
    nodes = {row['id']: row for row in model['nodes']}
    base = {tag: row for tag, row in nodes.items() if row['z'] == 0}
    native_supports = audit['settings']['supports']['nodes']
    checks, moving = [], set()
    for case in model['load_cases']:
        data = result['nativeResultSet']['results']['case:'+case['id']]['data']
        context = data['nativeContext']['effectiveConstraints']
        assert context['verified'] and context['supports'] == audit['settings']['supports']
        raw_key = result['caseResults'][case['id']]['nativeResultKey']
        raw_disp = {str(row['id']): row for row in raw['node_disp'][raw_key]}
        for identifier, node in base.items():
            disp, reaction = data['displacements'][identifier], data['reactions'][identifier]
            native_id = native_supports[identifier]['nativeNodeId']
            for index, (dof, force) in enumerate(zip(DOFS, ('fx','fy','fz','mx','my','mz'))):
                assert disp[dof] == raw_disp[native_id][dof], (identifier, dof, 'SDK value changed')
                if node['restraints'][index]:
                    assert abs(disp[dof]) <= 1e-12, (identifier, dof, disp[dof])
                else:
                    assert abs(reaction[force]) <= 1e-5, (identifier, force, reaction[force])
                    if abs(disp[dof]) > 1e-8:
                        moving.add((identifier, dof))
        applied = [0.] * 6
        for load in case['loads']:
            x,y,z = [nodes[load['node']][axis] for axis in ('x','y','z')]
            fx,fy,fz,mx,my,mz = [load.get(key, 0) for key in ('fx','fy','fz','mx','my','mz')]
            applied = [a+b for a,b in zip(applied, (fx,fy,fz,mx+y*fz-z*fy,my+z*fx-x*fz,mz+x*fy-y*fx))]
        total = [0.] * 6
        for identifier, reaction in data['reactions'].items():
            x,y,z = [nodes[identifier][axis] for axis in ('x','y','z')]
            fx,fy,fz,mx,my,mz = [reaction[key] for key in ('fx','fy','fz','mx','my','mz')]
            total = [a+b for a,b in zip(total, (fx,fy,fz,mx+y*fz-z*fy,my+z*fx-x*fz,mz+x*fy-y*fx))]
        assert all(math.isclose(a,-b,rel_tol=1e-5,abs_tol=1e-5) for a,b in zip(applied,total)), (case['id'],applied,total)
        checks.append({'caseId': case['id'], 'external': applied, 'reaction': total})
    expected_motion = {(tag, dof) for tag,node in base.items() for dof,value in zip(DOFS,node['restraints']) if not value}
    assert moving == expected_motion, ('Unverified free base response', sorted(expected_motion-moving))
    if model['load_combinations']:
        combo = result['nativeResultSet']['results']['combination:C']['data']
        for identifier in base:
            for dof in DOFS:
                expected = sum(factor * result['nativeResultSet']['results']['case:'+case_id]['data']['displacements'][identifier][dof]
                               for case_id, factor in model['load_combinations'][0]['factors'].items())
                assert math.isclose(combo['displacements'][identifier][dof], expected, rel_tol=1e-12, abs_tol=1e-15)
    summary = {'status':'passed', 'nativeJob':str(job), 'supportNodes': {key: row['restraints'] for key,row in base.items()},
               'directSdkDisplacements':True, 'movingFreeDofs':sorted(moving), 'cases':checks,
               'nativeConstraintAudit':audit['settings']['supports']}
    (work/'acceptance.json').write_text(json.dumps(summary,indent=2),'utf8')
    print(json.dumps({'status':'passed','workDir':str(work)}),flush=True)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--native',action='store_true',required=True)
    parser.add_argument('--fixed',action='store_true')
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    if not os.environ.get('YJKS_ROOT') or not os.environ.get('YJK_PYTHON_BIN'):
        parser.error('Private YJKS_ROOT and YJK_PYTHON_BIN are required / 须指定独立原生环境')
    work=args.output.resolve()/('yjk-supports-'+time.strftime('%Y%m%d-%H%M%S')+'-'+uuid.uuid4().hex[:8]);work.mkdir(parents=True)
    model=json.loads((ADAPTER/'__tests__/fixtures/native-design-concrete-model.json').read_text('utf8'))
    nodes={row['id']:row for row in model['nodes']}
    if not args.fixed:
        nodes['N000']['restraints']=[True,True,True,False,False,False]
        nodes['N001']['restraints']=[False,True,True,False,False,False]
        nodes['N010']['restraints']=[True,False,True,False,False,False]
    model['load_cases']=[{'id':key,'name':key,'type':'other','loads':[{'id':key,'type':'nodal','node':'N100',key.lower():10}]}
                         for key in ('FX','FY','FZ','MX','MY','MZ')]
    model['load_combinations']=[{'id':'C','name':'C','type':'custom','factors':{'FX':1.2,'FY':-0.7,'MZ':1.4}}]
    selections=[{'key':'case:'+r['id'],'kind':'case','id':r['id']} for r in model['load_cases']]
    selections.append({'key':'combination:C','kind':'combination','id':'C'})
    request={'traceId':'support-adapter','_internalResultSelections':selections}
    for name,value in [('source.json',model),('request.json',request)]:
        (work/name).write_text(json.dumps(value,indent=2),'utf8')
    os.environ['YJK_WORK_DIR']=str(work)
    print(work,flush=True)
    spec=importlib.util.spec_from_file_location('support_runtime',ADAPTER/'runtime.py')
    runtime=importlib.util.module_from_spec(spec);spec.loader.exec_module(runtime)
    result=runtime.run_analysis(model,request)
    (work/'result.json').write_text(json.dumps(result,indent=2),'utf8')
    verify(work)


if __name__=='__main__':main()
