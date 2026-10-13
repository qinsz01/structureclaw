"""Owned native YJK six-effect acceptance; references are frozen before launch.

Independent Timoshenko cantilevers expose EA, both EI, GA and GJ, including
non-square section orientation. This is an opt-in native test, never a mock.
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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True)
    parser.add_argument('--material', choices=('C30', 'Q355'), default='C30')
    parser.add_argument('--width', type=float, default=300)
    parser.add_argument('--height', type=float, default=600)
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[2]
    adapter = repo / 'backend/src/agent-skills/analysis/yjk-static'
    sys.path[:0] = [str(adapter), str(adapter.parent / 'runtime'), str(repo / 'backend/src/skill-shared/python')]
    spec = importlib.util.spec_from_file_location('yjk_native_runtime', adapter / 'runtime.py')
    runtime = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(runtime)
    work = Path(args.output).resolve() / ('yjk-six-effect-' + time.strftime('%Y%m%d-%H%M%S') + '-' + uuid.uuid4().hex[:6])
    work.mkdir(parents=True, exist_ok=False)
    b, h, length = args.width/1000, args.height/1000, 3.
    area, iy, iz = b*h, b*h**3/12, h*b**3/12
    wide, narrow = max(b, h), min(b, h)
    torsion = wide*narrow**3*(1/3-.21*narrow/wide*(1-narrow**4/(12*wide**4)))
    E, nu, rho = (30000., .2, 2500.) if args.material == 'C30' else (206000., .3, 7850.)
    G, shear_area = E/(2*(1+nu)), 5*area/6
    e, g = E*1000, G*1000  # MPa -> kN/m2, explicitly.
    components = ('ux', 'uy', 'uz', 'rx', 'ry', 'rz')
    expected = {key: dict.fromkeys(components, 0.) for key in ('FX', 'FY', 'FZ', 'MX', 'MY', 'MZ')}
    expected['FX'].update(ux=length**3/(3*e*iy)+length/(g*shear_area), ry=length**2/(2*e*iy))
    expected['FY'].update(uy=length**3/(3*e*iz)+length/(g*shear_area), rx=-length**2/(2*e*iz))
    expected['FZ'].update(uz=-length/(e*area))
    expected['MX'].update(uy=-length**2/(2*e*iz), rx=length/(e*iz))
    expected['MY'].update(ux=length**2/(2*e*iy), ry=length/(e*iy))
    expected['MZ'].update(rz=length/(g*torsion))
    reference = {'method': 'independent-closed-form-Timoshenko-cantilever', 'frozenAt': time.time(),
                 'relativeTolerance': 1e-5, 'absoluteTolerance': 1e-11, 'units': {'translation': 'm', 'rotation': 'rad'},
                 'properties': dict(E=E, G=G, A=area, Iy=iy, Iz=iz, J=torsion, As=shear_area, L=length),
                 'expected': expected}
    (work/'reference.json').write_text(json.dumps(reference, indent=2), encoding='utf8')
    points = [(0, 0), (4, 0), (4, 4), (0, 4)]
    model = {'schema_version': '2.2.0', 'unit_system': 'SI',
        'coordinate_system': {'dimension': '3d', 'plane': None, 'semantics': 'global-z-up', 'version': 1,
                              'dof_order': list(components)}, 'project': {'name': 'six_effect_calibration'},
        'materials': [{'id': 'M', 'name': args.material, 'category': 'concrete' if args.material == 'C30' else 'steel',
                       'grade': args.material, 'E': E, 'G': G, 'nu': nu, 'rho': rho}],
        'sections': [{'id': 'C', 'type': 'rectangular', 'shape': {'kind': 'rectangular', 'B': args.width, 'H': args.height},
                      'properties': dict(A=area, Iy=iy, Iz=iz, J=torsion)}],
        'nodes': [{'id': f'N{j}_{i}', 'x': x, 'y': y, 'z': length*j, 'restraints': [j == 0]*6}
                  for j in (0, 1) for i, (x, y) in enumerate(points)],
        'elements': [{'id': f'C{i}', 'type': 'column', 'nodes': [f'N0_{i}', f'N1_{i}'], 'section': 'C', 'material': 'M'} for i in range(4)],
        'stories': [{'id': 'S1', 'elevation': 0, 'height': length, 'rigid_diaphragm': False}],
        'analysis_control': dict.fromkeys(('self_weight', 'rigid_floor', 'rigid_offsets', 'construction_stage', 'p_delta'), False),
        'load_cases': [{'id': key, 'type': 'other', 'loads': [{'type': 'nodal', 'node': f'N1_{i}', key.lower(): -1 if key == 'FZ' else 1} for i in range(4)]}
                       for key in expected], 'load_combinations': [{'id': 'CX', 'factors': {'FX': 1, 'FY': -2, 'MZ': .5}}]}
    (work/'input.json').write_text(json.dumps(model, indent=2), encoding='utf8')
    os.environ['YJK_WORK_DIR'] = str(work)
    print(work, flush=True)
    result = runtime.run_analysis(model, {'traceId': 'six-effects', 'loadCombinationId': 'CX'})
    (work/'result.json').write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding='utf8')
    checks = []
    for case, vector in expected.items():
        for index in range(4):
            actual = result['caseResults'][case]['displacements'][f'N1_{index}']
            for component, value in vector.items():
                checks.append({'case': case, 'node': f'N1_{index}', 'component': component, 'expected': value,
                    'actual': actual[component], 'passed': math.isclose(value, actual[component], rel_tol=1e-5, abs_tol=1e-11)})
    report = {'passed': all(row['passed'] for row in checks), 'checks': checks, 'nativeWorkDir': result['meta']['workDir']}
    (work/'acceptance.json').write_text(json.dumps(report, indent=2), encoding='utf8')
    print(json.dumps({'passed': report['passed'], 'failed': [row for row in checks if not row['passed']], 'nativeWorkDir': report['nativeWorkDir']}), flush=True)
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
