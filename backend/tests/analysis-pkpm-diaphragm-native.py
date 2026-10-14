"""Verify native diaphragm transport, six DOFs and equilibrium in a private job.

This checks the actual API/solver linkage, not PKPM formula certification.
Inputs are explicit product-owned JSON models; no Bench data is imported.
"""
import argparse
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import sys
import time
import uuid


def verify(model, result):
    nodes = {str(row['id']): [row[k] for k in ('x', 'y', 'z')] for row in model['nodes']}
    constraints = result['nativeContext']['effectiveConstraints']
    assert constraints['verified'] and len(constraints['sourceFeaSha256']) == 64
    groups = constraints['diaphragms']['groups']
    assert not constraints['diaphragms']['physicalSlabs']
    assert len(groups) == len(model['stories'])
    assert {g['sourceStoryId'] for g in groups} == {s['id'] for s in model['stories']}
    native = Path(result['summary']['work_dir'])
    readback = json.loads((native / 'native-diaphragm-readback.json').read_text())
    assert readback['verified'] and readback['readback'] == {'606': 1, '607': 0}
    assert all(row['thicknessMm'] == row['physicalSlabCount'] == 0 for row in readback['floors'])
    balance = []
    dofs = ('ux', 'uy', 'uz', 'rx', 'ry', 'rz')
    from native_self_weight import compile_self_weight
    weight = compile_self_weight(model)
    for source in model['load_cases']:
        case = result['caseResults'][source['id']]
        assert set(case['displacements']) == set(nodes)
        assert all(all(math.isfinite(row[k]) for k in dofs) for row in case['displacements'].values())
        for group in groups:
            reference_id = group['sourceNodeIds'][0]
            reference = case['displacements'][reference_id]
            for node_id in group['sourceNodeIds']:
                row = case['displacements'][node_id]
                dx, dy = [nodes[node_id][i] - nodes[reference_id][i] for i in (0, 1)]
                for actual, expected in ((row['rz'], reference['rz']),
                    (row['ux'] - reference['ux'], -dy * reference['rz']),
                    (row['uy'] - reference['uy'], dx * reference['rz'])):
                    assert math.isclose(actual, expected, rel_tol=1e-5, abs_tol=1e-11)
        applied = []
        for load in source.get('loads', []):
            assert load['type'] == 'nodal', 'This acceptance model uses explicit nodal loads plus member selfweight'
            applied.append((nodes[str(load['node'])], [float(load.get(k, 0)) for k in ('fx', 'fy', 'fz', 'mx', 'my', 'mz')]))
        if weight['enabled'] and source['id'] == weight['loadCaseId']:
            elements = {str(row['id']): row for row in model['elements']}
            for item in weight['members']:
                a, b = [nodes[str(n)] for n in elements[item['elementId']]['nodes']]
                applied.append(([(x+y)/2 for x, y in zip(a, b)], item['totalForceVectorKn'] + [0., 0., 0.]))
        reactions = [(nodes[identity], [row[k] for k in ('fx', 'fy', 'fz', 'mx', 'my', 'mz')])
                     for identity, row in case['reactions'].items()]
        def resultant(rows):
            total = [0.] * 6
            for (x, y, z), (fx, fy, fz, mx, my, mz) in rows:
                for i, value in enumerate((fx, fy, fz, mx+y*fz-z*fy, my+z*fx-x*fz, mz+x*fy-y*fx)):
                    total[i] += value
            return total
        expected = [-v for v in resultant(applied)]
        actual = resultant(reactions)
        residual = [a-e for a, e in zip(actual, expected)]
        assert all(math.isclose(a, e, rel_tol=1e-5, abs_tol=1e-5) for a, e in zip(actual, expected)), (source['id'], residual)
        balance.append({'case': source['id'], 'expectedReactionResultantKN_KNm': expected,
                        'actualReactionResultantKN_KNm': actual, 'residualKN_KNm': residual})
    return {'floorCount': len(groups), 'physicalNodeCount': len(nodes), 'caseCount': len(model['load_cases']),
            'sixDofValueCount': 6 * len(nodes) * len(model['load_cases']), 'equilibrium': balance,
            'tolerances': {'relative': 1e-5, 'displacementM_rotationRad': 1e-11, 'balanceKN_KNm': 1e-5}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for key in ('model', 'parameters', 'work-root', 'cycle'):
        parser.add_argument('--' + key, type=Path, required=True)
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[2]
    skill = repo / 'backend/src/agent-skills/analysis/pkpm-static'
    sys.path[:0] = [str(skill), str(skill.parent / 'runtime'), str(repo / 'backend/src/skill-shared/python')]
    folder = args.work_root.resolve() / ('pkpm-diaphragm-' + time.strftime('%Y%m%d-%H%M%S') + '-' + uuid.uuid4().hex[:8])
    folder.mkdir(parents=True, exist_ok=False)
    model = json.loads(args.model.read_text(encoding='utf8'))
    parameters = json.loads(args.parameters.read_text(encoding='utf8'))
    def save(name, value):
        path = folder / name
        path.write_text(json.dumps(value, indent=2, ensure_ascii=False), encoding='utf8')
        return {'path': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
    receipt = {'status': 'failed', 'scope': 'native-diaphragm-transport-and-result-binding',
        'notIndependentSolverCertification': True, 'files': [save('source-model.json', model), save('parameters.json', parameters)]}
    os.environ['PKPM_CYCLE_PATH'] = str(args.cycle.resolve())
    os.environ['PKPM_WORK_DIR'] = str(folder)
    try:
        spec = importlib.util.spec_from_file_location('pkpm_diaphragm_acceptance', skill / 'runtime.py')
        runtime = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(runtime)
        result = runtime.run_analysis(model, parameters)
        receipt['files'].append(save('result.json', result))
        receipt.update(verify(model, result), status='passed', nativeWorkDir=result['summary']['work_dir'])
    except Exception as error:
        receipt['error'] = f'{type(error).__name__}: {error}'
    save('acceptance.json', receipt)
    print(json.dumps({'directory': str(folder), **receipt}, ensure_ascii=False))
    return 0 if receipt['status'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
