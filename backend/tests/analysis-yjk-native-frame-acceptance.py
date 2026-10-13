"""Freeze an independent frame solution before invoking the actual YJK adapter."""
from __future__ import annotations
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

from native_frame_reference import solve


def main():
    cli = argparse.ArgumentParser()
    cli.add_argument('--model', required=True)
    cli.add_argument('--output', required=True)
    cli.add_argument('--combination')
    args = cli.parse_args()
    repo = Path(__file__).resolve().parents[2]
    adapter = repo/'backend/src/agent-skills/analysis/yjk-static'
    sys.path[:0] = [str(adapter), str(adapter.parent/'runtime'), str(repo/'backend/src/skill-shared/python')]
    spec = importlib.util.spec_from_file_location('yjk_acceptance_runtime', adapter/'runtime.py')
    runtime = importlib.util.module_from_spec(spec); spec.loader.exec_module(runtime)
    model = json.loads(Path(args.model).read_text(encoding='utf-8-sig'))
    work = Path(args.output).resolve()/('yjk-frame-acceptance-'+time.strftime('%Y%m%d-%H%M%S')+'-'+uuid.uuid4().hex[:6])
    work.mkdir(parents=True, exist_ok=False)
    reference = {case['id']: solve(model, case['id']) for case in model['load_cases']}
    combinations = {}
    if args.combination:
        factors = next(row['factors'] for row in model['load_combinations'] if row['id'] == args.combination)
        first = reference[next(iter(factors))]
        combined = {}
        for field in ('displacements', 'reactions'):
            combined[field] = {key: {component: math.fsum(factor*reference[case][field][key][component]
                for case, factor in factors.items()) for component in values} for key, values in first[field].items()}
        combined['localEndActions'] = {key: [math.fsum(factor*reference[case]['localEndActions'][key][index]
            for case, factor in factors.items()) for index in range(12)] for key in first['localEndActions']}
        combinations[args.combination] = combined
    payload = {'modelSha256': hashlib.sha256(Path(args.model).read_bytes()).hexdigest(),
               'frozenAt': time.time(), 'relativeTolerance': 1e-5,
               'absoluteTolerance': {'displacements': 1e-11, 'reactions': 1e-5, 'localEndActions': 1e-5},
               'cases': reference, 'combinations': combinations,
               'referenceScriptSha256': hashlib.sha256((Path(__file__).parent/'native_frame_reference.py').read_bytes()).hexdigest()}
    ref_path = work/'reference.json'
    ref_path.write_text(json.dumps(payload, indent=2), encoding='utf8')
    ref_hash = hashlib.sha256(ref_path.read_bytes()).hexdigest()
    (work/'input.json').write_text(json.dumps(model, indent=2, ensure_ascii=False), encoding='utf8')
    os.environ['YJK_WORK_DIR'] = str(work)
    print(work, flush=True)
    result = runtime.run_analysis(model, {'traceId': Path(args.model).parent.name,
                                         **({'loadCombinationId': args.combination} if args.combination else {})})
    (work/'result.json').write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding='utf8')
    checks = []
    for case, data, actual in [*( (key, value, result['caseResults'][key]) for key, value in reference.items()),
                              *( (key, value, result['combinationResults'][key]) for key, value in combinations.items())]:
        for field in ('displacements', 'reactions'):
            for node, values in data[field].items():
                for component, wanted in values.items():
                    value = actual[field].get(node, {}).get(component)
                    passed = value is not None and math.isclose(value, wanted, rel_tol=1e-5, abs_tol=payload['absoluteTolerance'][field])
                    checks.append(dict(case=case, field=field, object=node, component=component, expected=wanted, actual=value, passed=passed))
        for member, end_actions in data['localEndActions'].items():
            rows = actual['memberStations'][member]
            for station, end, signs in ((rows[0], 0, [-1, 1, 1, -1, -1, -1]),
                                        (rows[-1], 6, [1, -1, -1, 1, 1, 1])):
                for i, component in enumerate(('N', 'Vy', 'Vz', 'T', 'My', 'Mz')):
                    wanted, value = signs[i]*end_actions[end+i], station['components'][component]
                    checks.append(dict(case=case, field='memberStations', object=member, positionM=station['positionM'],
                        component=component, expected=wanted, actual=value,
                        passed=math.isclose(value, wanted, rel_tol=1e-5, abs_tol=1e-5)))
    if hashlib.sha256(ref_path.read_bytes()).hexdigest() != ref_hash:
        raise RuntimeError('Frozen reference changed during native run')
    failed = [row for row in checks if not row['passed']]
    receipt = {'passed': not failed, 'checks': checks, 'referenceSha256': ref_hash,
               'nativeWorkDir': result['meta']['workDir'], 'scope': 'all-source-case-nodes-and-member-end-actions'}
    (work/'acceptance.json').write_text(json.dumps(receipt, indent=2), encoding='utf8')
    print(json.dumps({'passed': not failed, 'checkCount': len(checks), 'failureCount': len(failed), 'firstFailures': failed[:8]}), flush=True)
    return 1 if failed else 0


if __name__ == '__main__':
    raise SystemExit(main())
