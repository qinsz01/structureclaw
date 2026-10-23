import { expect, test } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveOpenSeesPython } from '../../../tests/characterization/helpers/backend-host.mjs';
import { buildModel } from '../../../dist/agent-runtime/model-builder.js';
import { completeDeclaredGradeMaterials } from '../../../dist/agent-runtime/template-properties.js';

const nativePython = resolveOpenSeesPython();
if (!nativePython) console.warn('[material-solver-contract] Native Python contract check unavailable; install the analysis runtime or set SCLAW_TEST_PYTHON.');
(nativePython ? test : test.skip)('grade-compiled elastic materials pass the real PKPM isotropic input boundary', () => {
  const models = ['Q235B', 'Q355', 'S355', 'A36', 'C25', 'C40', 'C45', 'C55'].map(grade => buildModel({
    inferredType: 'beam', lengthM: 6, loadKN: 10, loadType: 'distributed', loadPosition: 'full-span',
    supportType: 'simply-supported', updatedAt: 0,
    engineeringDraft: { material: { grade }, sections: { member: 'H300X200X8X12' } },
  }));
  const python = nativePython;
  expect(python).not.toBeNull();
  const script = `import json,sys\nsys.path[:0]=sys.argv[1:]\nfrom native_model_contract import validate_pkpm_material_properties\nfor model in json.load(sys.stdin): validate_pkpm_material_properties(model)`;
  const result = spawnSync(python, ['-c', script,
    fileURLToPath(new URL('../../agent-skills/analysis/runtime', import.meta.url)),
    fileURLToPath(new URL('../../skill-shared/python', import.meta.url))], {
    input: JSON.stringify(models), encoding: 'utf8', windowsHide: true, timeout: 30_000,
  });
  expect({ status: result.status, error: result.error?.message, stderr: result.stderr }).toEqual({ status: 0, error: undefined, stderr: '' });
});

test('explicit independent material constants are preserved for the solver to accept or reject', () => {
  const authored = { id: 'M', E: 206000, G: 79000, nu: .3, rho: 7850 };
  const model = buildModel({ inferredType: 'beam', lengthM: 6, loadKN: 10, loadType: 'distributed', loadPosition: 'full-span',
    supportType: 'simply-supported', updatedAt: 0,
    engineeringDraft: { materials: [authored], sectionRecords: [{ id: 'S', properties: { A: .02, Iy: .0002, Iz: .0003, J: .00001 } }] } });
  expect(model.materials).toEqual([authored]);
});

test('an authored Poisson ratio controls omitted G without replacing explicit constants', () => {
  expect(completeDeclaredGradeMaterials([{ id: 'M', grade: 'Q235', nu: .25 }])[0]).toMatchObject({ E: 206000, G: 82400, nu: .25 });
  const authored = { id: 'M', name: 'Q235', grade: 'Q235', E: 190000, G: 75000, nu: .25, rho: 7850 };
  expect(completeDeclaredGradeMaterials([authored])[0]).toEqual(authored);
});
