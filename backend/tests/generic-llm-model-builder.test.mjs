import { describe, expect, test } from '@jest/globals';
import { tryBuildGenericModelWithLlm } from '../dist/agent-skills/structure-type/generic/llm-model-builder.js';
import { createRunContext, withRunContext } from '../dist/runtime/run-context.js';
import { resolveRunPolicy } from '../dist/runtime/run-policy.js';
import { createLocalStructureProtocolClient } from '../dist/services/structure-protocol-execution.js';
import { normalizeEngineeringModel } from '../dist/engineering/model-boundary.js';

const optionalFieldModel = () => ({
  schema_version: '2.2.0', unit_system: 'SI',
  coordinate_system: { semantics: 'global-z-up', version: 1, dimension: '2d', plane: 'xz', dof_order: ['ux', 'uy', 'uz', 'rx', 'ry', 'rz'] },
  nodes: [{ id: 'N1', x: 0, y: 0, z: 0, restraints: [true, true, true, true, true, true] }, { id: 'N2', x: 2, y: 0, z: 0 }],
  elements: [{ id: 'E1', type: 'beam', nodes: ['N1', 'N2'], material: 'M1', section: 'S1' }],
  materials: [{ id: 'M1', name: 'Explicit steel', type: 'steel', E: 200000, nu: 0.3, rho: 7850 }],
  sections: [{ id: 'S1', name: 'Explicit rectangle', type: 'rectangular', shape: { kind: 'rectangular', B: 100, H: 200 } }],
  load_cases: [{ id: 'LC1', name: 'Empty', type: 'other', loads: [] }],
});
const noRepair = () => createRunContext(resolveRunPolicy({ availableSkillIds: [], availableToolIds: [],
  requested: { repair: { enabled: false } } }));

describe('tryBuildGenericModelWithLlm', () => {
  test.each(['rotation_angle', 'restraints'])('accepts optional null %s consistently with the real V2 protocol without repair', async field => {
    const source = optionalFieldModel();
    (field === 'rotation_angle' ? source.elements[0] : source.nodes[1])[field] = null;
    const original = structuredClone(source), context = noRepair(); let calls = 0;
    const result = await withRunContext(context, () => tryBuildGenericModelWithLlm({ invoke: async () => {
      calls++; return { content: JSON.stringify(source) };
    } }, 'Use the explicit model', { inferredType: 'beam', updatedAt: 0 }, 'en', undefined, undefined, undefined,
    candidate => normalizeEngineeringModel(candidate, createLocalStructureProtocolClient())));
    expect(result.nodes.map(node => node.id)).toEqual(['N1', 'N2']);
    expect(result.elements[0].rotation_angle ?? 0).toBe(0);
    expect(result.nodes[1].restraints ?? null).toBeNull();
    expect(calls).toBe(1); expect(context.usage.recoveries).toBe(0); expect(source).toEqual(original);
  }, 20000);

  test('repair disabled preserves the original invalid field error and invokes the builder once', async () => {
    const source = optionalFieldModel(); source.elements[0].rotation_angle = 'not-a-number';
    const context = noRepair(); let calls = 0;
    await expect(withRunContext(context, () => tryBuildGenericModelWithLlm({ invoke: async () => {
      calls++; return { content: JSON.stringify(source) };
    } }, 'Use the explicit model', { inferredType: 'beam', updatedAt: 0 }, 'en')))
      .rejects.toMatchObject({ code: 'MODEL_PHYSICS_INVALID', check: { diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'INVALID_KINEMATICS' })]) } });
    expect(calls).toBe(1); expect(context.usage.recoveries).toBe(0);
  });

  test('accepts an explicit typed coordinate contract and stamps matching metadata', async () => {
    const llm = {
      invoke: async () => ({
        content: JSON.stringify({
          schema_version: '2.0.0',
          unit_system: 'SI',
          coordinate_system: {
            semantics: 'global-z-up',
            version: 1,
            dimension: '2d',
            plane: 'xz',
            dof_order: ['ux', 'uy', 'uz', 'rx', 'ry', 'rz'],
          },
          nodes: [
            { id: 'N1', x: 0, y: 0, z: 0, restraints: [true, true, true, true, true, true] },
            { id: 'N2', x: 10, y: 0, z: 0 },
          ],
          elements: [
            { id: 'E1', type: 'beam', nodes: ['N1', 'N2'], material: 'M1', section: 'S1' },
          ],
          materials: [{ id: 'M1', E: 206000, nu: 0.3, rho: 7850 }],
          sections: [{ id: 'S1', properties: { A: 0.01, Iy: 0.0001, Iz: 0.0001, J: 0.0001 } }],
          load_cases: [{ id: 'LC1', loads: [] }],
          load_combinations: [{ id: 'ULS', factors: { LC1: 1.0 } }],
        }),
      }),
    };

    const model = await tryBuildGenericModelWithLlm(
      llm,
      '设计一个简支梁，跨度10m，梁中间荷载1kN',
      {
        inferredType: 'beam',
        skillId: 'generic',
        structuralTypeKey: 'beam',
        updatedAt: Date.now(),
      },
      'zh',
    );

    expect(model).toBeDefined();
    expect(model.metadata.coordinateSemantics).toBe('global-z-up');
    expect(model.metadata.frameDimension).toBe('2d');
    expect(model.metadata.inferredType).toBe('beam');
  });

  test('rejects generic V2 output that omits the typed coordinate contract', async () => {
    const llm = {
      invoke: async () => ({
        content: JSON.stringify({
          schema_version: '2.0.0',
          unit_system: 'SI',
          nodes: [{ id: 'N1', x: 0, y: 0, z: 0, restraints: [true, true, true, true, true, true] }, { id: 'N2', x: 10, y: 0, z: 0 }],
          elements: [{ id: 'E1', type: 'beam', nodes: ['N1', 'N2'] }],
          materials: [],
          sections: [],
          load_cases: [{ id: 'LC1', loads: [] }],
          load_combinations: [],
        }),
      }),
    };

    await expect(tryBuildGenericModelWithLlm(
      llm,
      'build a beam',
      { inferredType: 'beam', skillId: 'generic', structuralTypeKey: 'beam', updatedAt: 0 },
      'en',
    )).rejects.toThrow('LLM_MODEL_VALIDATION_FAILED: Generic V2 models must explicitly declare coordinate_system.dimension');
  });
});
