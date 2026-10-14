"""Private SDK automatic rigid-end adapter acceptance with independent reference."""
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

ROOT=Path(__file__).resolve().parents[2]
ADAPTER=ROOT/'backend/src/agent-skills/analysis/yjk-static'
sys.path[:0]=[str(ADAPTER),str(ADAPTER.parent/'runtime'),str(ROOT/'backend/src/skill-shared/python')]
from native_frame_reference import solve


def verify(work):
    model=json.loads((work/'source.json').read_text('utf8'))
    result=json.loads((work/'result.json').read_text('utf8'))
    reference=json.loads((work/'reference.json').read_text('utf8'))
    counts={'displacement':0,'reaction':0,'elasticEndAction':0}
    def compare(actual,expected,label,unit):
        tolerance=1e-11 if unit=='displacement' else 1e-5
        assert math.isclose(actual,expected,rel_tol=1e-5,abs_tol=tolerance),(label,actual,expected)
        counts[unit]+=1
    for case in model['load_cases']:
        identifier=case['id'];data=result['nativeResultSet']['results']['case:'+identifier]['data']
        expected=reference['cases'][identifier]
        offsets=data['nativeContext']['effectiveRigidOffsets']
        assert offsets['verified'] and offsets['sourceFeaSha256']==data['nativeContext']['sourceFeaSha256']
        assert offsets['sourceLoadSemanticsPreserved'] is True
        assert offsets['loadCompilation']['sourceFeaSha256']==offsets['sourceFeaSha256']
        for kind,field,axes in [('displacement','displacements',('ux','uy','uz','rx','ry','rz')),
                              ('reaction','reactions',('fx','fy','fz','mx','my','mz'))]:
            for node,values in expected[field].items():
                if node not in {row['id'] for row in model['nodes']}:
                    continue
                for axis in axes: compare(data[field][node][axis],values[axis],(identifier,node,axis),kind)
        for member,values in expected['elasticEndActions'].items():
            mapped=reference['memberMap'].get(member,{'physicalId':member,'startM':0.})
            stations=data['memberStations'][mapped['physicalId']];rigid=offsets['members'][mapped['physicalId']]
            assert math.isclose(stations[0]['positionM'],rigid['elasticStartM'],abs_tol=1e-12)
            assert math.isclose(stations[-1]['positionM'],rigid['elasticEndM'],abs_tol=1e-12)
            ref_length=reference['memberLengthsM'][member]
            ri,rj=reference['rigidLengthsM'][member]
            endpoints=[]
            for position,side in ((mapped['startM']+ri,'right'),(mapped['startM']+ref_length-rj,'left')):
                matches=[row for row in stations if math.isclose(row['positionM'],position,rel_tol=0,abs_tol=1e-12) and row['side']==side]
                assert len(matches)==1,(member,position,side)
                endpoints.append(matches[0])
            for index,(row,sign) in enumerate(((endpoints[0],1),(endpoints[1],-1))):
                c=row['components']
                actual=[-c['N'],c['Vy'],c['Vz'],-c['T'],-c['My'],-c['Mz']]
                for axis,value in enumerate(actual):
                    compare(sign*value,values[index*6+axis],(identifier,member,index,axis),'elasticEndAction')
    summary={'status':'passed','checks':counts,'referenceMethod':reference['method'],
             'nativeStationDomain':'elastic-span','rigidLengthsM':reference['rigidLengthsM'],
             'cases':list(reference['cases'])}
    (work/'acceptance.json').write_text(json.dumps(summary,indent=2),'utf8')
    print(json.dumps({'status':'passed','workDir':str(work),'checks':counts}),flush=True)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--native',action='store_true',required=True)
    parser.add_argument('--reverse',action='store_true')
    parser.add_argument('--mesh',action='store_true')
    parser.add_argument('--self-weight',action='store_true')
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    if not os.environ.get('YJKS_ROOT') or not os.environ.get('YJK_PYTHON_BIN'):
        parser.error('Private YJKS_ROOT and YJK_PYTHON_BIN are required / 须指定独立原生环境')
    work=args.output.resolve()/('yjk-rigid-offsets-'+time.strftime('%Y%m%d-%H%M%S')+'-'+uuid.uuid4().hex[:8]);work.mkdir(parents=True)
    model=json.loads((ADAPTER/'__tests__/fixtures/native-design-concrete-model.json').read_text('utf8'))
    model['analysis_control']['rigid_offsets']=True
    if args.self_weight:
        model['analysis_control'].update(self_weight=True,self_weight_case_id='D')
    if args.reverse: next(row for row in model['elements'] if row['id']=='BX0')['nodes'].reverse()
    model['load_cases']=[{'id':key,'name':key,'type':'other','loads':[{'id':key,'type':'nodal','node':'N100',key.lower():10}]}
                         for key in ('FX','FY','FZ','MX','MY','MZ')]
    model['load_cases'].append({'id':'D','name':'D','type':'dead','loads':[
        {'id':'q-'+row['id'],'type':'distributed','element':row['id'],'wz':-7} for row in model['elements'] if row['type']=='beam']})
    model['load_combinations']=[]
    # SDK/FE geometry readback in the retained preliminary probe determined
    # these native automatic lengths; freeze before this candidate execution.
    rigid={row['id']:([0.,.225] if row['type']=='column' else [.15,.15] if row['id'].startswith('BX') else [0.,0.]) for row in model['elements']}
    if args.mesh:
        load=next(row for row in model['load_cases'][-1]['loads'] if row['element']=='BX0')
        load.update(start=1.,end=3.5)
        model['load_cases'][-1]['loads'].append({'id':'interior-point','type':'point','element':'BX0','position':1.7,'fz':-5})
    reference_model=copy.deepcopy(model);member_map={}
    if args.mesh:
        member=next(row for row in reference_model['elements'] if row['id']=='BX0')
        nodes={row['id']:row for row in reference_model['nodes']};a,b=[nodes[key] for key in member['nodes']]
        chain=[a['id']]
        for index,position in enumerate((1.,1.7,3.5)):
            tag='reference-joint-'+str(index)
            reference_model['nodes'].append({'id':tag,**{key:a[key]+position/6*(b[key]-a[key]) for key in ('x','y','z')},'restraints':[False]*6})
            chain.append(tag)
        chain.append(b['id']);cuts=(0.,1.,1.7,3.5,6.)
        reference_model['elements'].remove(member)
        for index in range(4):
            tag='reference-segment-'+str(index)
            reference_model['elements'].append({**member,'id':tag,'nodes':chain[index:index+2]})
            member_map[tag]={'physicalId':'BX0','startM':cuts[index]}
            rigid[tag]=[.15 if index==0 else 0.,.15 if index==3 else 0.]
        del rigid['BX0']
        reference_model['load_cases'][-1]['loads']=[row for row in reference_model['load_cases'][-1]['loads'] if row.get('element')!='BX0']+[
            {'type':'distributed','element':'reference-segment-1','wz':-7},
            {'type':'distributed','element':'reference-segment-2','wz':-7},
            {'type':'nodal','node':chain[2],'fz':-5}]
    ref_nodes={row['id']:[row[key] for key in ('x','y','z')] for row in reference_model['nodes']}
    if args.self_weight:
        materials={row['id']:row for row in model['materials']}
        sections={row['id']:row for row in model['sections']}
        for member in reference_model['elements']:
            q=-materials[member['material']]['rho']*sections[member['section']]['properties']['A']*9.80665/1000
            reference_model['load_cases'][-1]['loads'].append({'type':'distributed','element':member['id'],'wz':q})
    lengths={row['id']:math.dist(*(ref_nodes[key] for key in row['nodes'])) for row in reference_model['elements']}
    references={row['id']:solve(reference_model,row['id'],rigid_end_lengths=rigid) for row in model['load_cases']}
    reference={'method':'independent-Timoshenko-stiffness-with-rigid-end-kinematics',
        'geometryEvidence':'yjk-rigid-offset-probe-20261014-125634-bddcd2','rigidLengthsM':rigid,'cases':references,
        'memberMap':member_map,'memberLengthsM':lengths,
        'tolerance':{'relative':1e-5,'displacementAbsolute':1e-11,'forceAbsolute':1e-5}}
    request={'traceId':'rigid-offset-adapter','_internalResultSelections':[{'key':'case:'+r['id'],'kind':'case','id':r['id']} for r in model['load_cases']]}
    for name,value in [('source.json',model),('request.json',request),('reference.json',reference),('reference-model.json',reference_model)]:
        (work/name).write_text(json.dumps(value,indent=2),'utf8')
    os.environ['YJK_WORK_DIR']=str(work);print(work,flush=True)
    spec=importlib.util.spec_from_file_location('offset_runtime',ADAPTER/'runtime.py')
    runtime=importlib.util.module_from_spec(spec);spec.loader.exec_module(runtime)
    result=runtime.run_analysis(model,request)
    (work/'result.json').write_text(json.dumps(result,indent=2),'utf8');verify(work)


if __name__=='__main__':main()
