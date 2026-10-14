"""Opt-in selfweight SDK adapter acceptance; no benchmark or API service access.

The checks bind source area/density/case to executed native inputs and check
ordinary global equilibrium. They do not reimplement or certify the YJK solver.
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

ROOT = Path(__file__).resolve().parents[2]
ADAPTER = ROOT/'backend/src/agent-skills/analysis/yjk-static'
sys.path[:0] = [str(ADAPTER), str(ADAPTER.parent/'runtime'), str(ROOT/'backend/src/skill-shared/python')]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--native', action='store_true', required=True)
    parser.add_argument('--custom-upward', action='store_true')
    parser.add_argument('--mesh', action='store_true', help='Include partial and point loads on a physical beam')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if not os.environ.get('YJKS_ROOT') or not os.environ.get('YJK_PYTHON_BIN'):
        parser.error('Private YJKS_ROOT and YJK_PYTHON_BIN are required / 须指定独立原生环境')
    work = args.output.resolve()/('yjk-selfweight-'+time.strftime('%Y%m%d-%H%M%S')+'-'+uuid.uuid4().hex[:8])
    work.mkdir(parents=True)
    model = json.loads((ADAPTER/'__tests__/fixtures/native-design-concrete-model.json').read_text('utf8'))
    model['analysis_control']['self_weight'] = True
    request = {'traceId': 'selfweight-adapter', '_internalResultSelections': [
        {'key': 'case:'+key, 'kind': 'case', 'id': key} for key in ('D', 'L')]}
    if args.custom_upward:
        for section in model['sections']:
            section.pop('shape'); section['type'] = 'custom'; section['properties']['A'] = .0137
        model['materials'][0]['rho'] = 7123
        model['analysis_control'].update(self_weight_case_id='L', gravity_direction='z', gravity_m_s2=9.8)
    elif not args.mesh:
        request['design'] = {'requested': True, 'mode': 'required-reinforcement',
                            'code': 'GB/T50010-2010(2024)', 'adoptedNativeDefaults': True}
    if args.mesh:
        model['load_cases'][0]['loads'].extend([
            {'id': 'patch', 'type': 'distributed', 'element': 'BX0', 'start': 1., 'end': 3.5, 'wz': -7.},
            {'id': 'point', 'type': 'point', 'element': 'BX0', 'position': 1.7, 'fz': -5.}])
    for name, value in (('source.json', model), ('request.json', request)):
        (work/name).write_text(json.dumps(value, indent=2), 'utf8')
    os.environ['YJK_WORK_DIR'] = str(work)
    print(work, flush=True)
    spec = importlib.util.spec_from_file_location('selfweight_runtime', ADAPTER/'runtime.py')
    runtime = importlib.util.module_from_spec(spec); spec.loader.exec_module(runtime)
    result = runtime.run_analysis(model, request)
    (work/'result.json').write_text(json.dumps(result, indent=2), 'utf8')
    verify(work, args.custom_upward, args.mesh)

def verify(work: Path, custom_upward: bool = False, mesh: bool = False):
    model = json.loads((work/'source.json').read_text('utf8'))
    result = json.loads((work/'result.json').read_text('utf8'))
    jobs = list(work.glob('sc_*')); assert len(jobs) == 1
    audit = json.loads((jobs[0]/'native-physics-audit.json').read_text('utf8'))
    assert audit['passed'] and audit['loads']['selfWeight'] is True
    settings = json.loads((jobs[0]/'native-settings-readback.json').read_text('utf8'))
    assert all(settings['audit']['readback']['float'][key] == 0 for key in ('801', '803'))
    plan = audit['loads']['selfWeightCompilation']
    expected_count = len(model['elements'])
    if mesh:
        receipt = json.loads((jobs[0]/'physical-mesh.json').read_text('utf8'))
        expected_count = sum(len(rows) for rows in receipt['members'].values())
    assert len(plan['members']) == expected_count
    members = {row['id']: row for row in model['elements']}
    nodes = {row['id']: row for row in model['nodes']}
    balances = []
    for case in model['load_cases']:
        data = result['nativeResultSet']['results']['case:'+case['id']]['data']
        assert data['nativeContext']['effectiveLoads']['verified'] is True
        force = sum(row.get('fz', 0) for row in case['loads'] if row['type'] == 'nodal')
        for row in case['loads']:
            if row['type'] == 'distributed':
                ends = [nodes[key] for key in members[row['element']]['nodes']]
                length = math.dist(*[[n[k] for k in ('x','y','z')] for n in ends])
                force += row.get('wz', 0)*(row.get('end', length)-row.get('start', 0))
            elif row['type'] == 'point':
                force += row.get('fz', 0)
        if case['id'] == plan['loadCaseId']:
            force += sum(row['totalForceKn'] for row in plan['members'])
        reaction = sum(row['fz'] for row in data['reactions'].values())
        # Existing native six-significant-digit FE load output bounds the input;
        # keep the usual 1e-5 relative adapter tolerance, never round results.
        assert math.isclose(reaction, -force, rel_tol=1e-5, abs_tol=1e-5), (case['id'], reaction, force)
        balances.append({'caseId': case['id'], 'sourceForceKn': force, 'reactionKn': reaction})
        physical = data['nativeContext']['effectiveLoads']['selfWeight']['physicalCompilation']
        assert set(row['physicalElementId'] for row in physical) == set(members)
        if mesh:
            beam = [row for row in physical if row['physicalElementId'] == 'BX0']
            assert [(row['startM'], row['endM']) for row in beam] == [(0., 1.), (1., 1.7), (1.7, 3.5), (3.5, 6.)]
            assert all(row['sourceSegmentId'] != 'BX0' for row in beam)
    if not custom_upward and not mesh:
        assert result['nativeDesignResults']['status'] == 'completed'
        assert result['nativeDesignResults']['records']
        assert result['nativeDesignContext']['eligibleForConclusion'] is True
    summary = {'status': 'passed', 'customUpward': custom_upward, 'mesh': mesh, 'loadCaseId': plan['loadCaseId'],
               'selfWeight': plan, 'balances': balances, 'job': str(jobs[0]),
               'nativeDesignStatus': result.get('nativeDesignResults', {}).get('status')}
    (work/'acceptance.json').write_text(json.dumps(summary, indent=2), 'utf8')
    print(json.dumps({'status': 'passed', 'workDir': str(work)}), flush=True)


if __name__ == '__main__':
    main()
