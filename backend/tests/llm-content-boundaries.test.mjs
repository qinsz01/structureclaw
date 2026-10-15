import { describe, expect, test } from '@jest/globals';
import { invokeStructuralTypeRouter } from '../dist/agent-runtime/llm-router.js';
import { tryBuildGenericModelWithLlm } from '../dist/agent-skills/structure-type/generic/llm-model-builder.js';
import { validateExplicitModel } from '../dist/agent-runtime/explicit-model.js';

const plugin = { id: 'beam', structureType: 'beam', name: { en: 'Beam', zh: '梁' },
  description: { en: 'Beam', zh: '梁' }, manifest: { structuralTypeKeys: ['beam'] } };
const model = { schema_version: '2.2.0', unit_system: 'SI',
  coordinate_system: { semantics: 'global-z-up', version: 1, dimension: '2d', plane: 'xz', dof_order: ['ux','uy','uz','rx','ry','rz'] },
  nodes: [{ id: 'A', x: 0, y: 0, z: 0, restraints: [true,true,true,true,true,true] }, { id: 'B', x: 10, y: 0, z: 0 }],
  materials: [{ id: 'M', type: 'steel', E: 206000, nu: 0.3, rho: 7850 }],
  sections: [{ id: 'S', type: 'custom', properties: { A: 0.02, Iy: 0.00006, Iz: 0.00002, J: 0.00004 } }],
  elements: [{ id: 'E', type: 'beam', nodes: ['A','B'], material: 'M', section: 'S' }],
  load_cases: [{ id: 'LC1', type: 'other', loads: [{ id: 'P', type: 'nodal', node: 'B', fz: -1, reference_frame: 'global' }] }],
  analysis_control: { self_weight: false } };

describe('nested LLM text content boundaries', () => {
  test('an explicitly disabled self-weight does not require unused density in generic/explicit analysis', async () => {
    const candidate = structuredClone(model);
    delete candidate.materials[0].rho;
    expect(() => validateExplicitModel(candidate)).not.toThrow();
    for (const self_weight of [true, undefined]) {
      const weighted = { ...candidate, analysis_control: { self_weight } };
      expect(() => validateExplicitModel(weighted)).toThrow(/rho/);
    }
    const invalid = structuredClone(candidate);
    invalid.materials[0].rho = -1;
    expect(() => validateExplicitModel(invalid)).toThrow(/density/);
    delete candidate.analysis_control;
    let calls = 0;
    const built = await tryBuildGenericModelWithLlm({ invoke: async () => { calls++; return { content: JSON.stringify(candidate) }; } },
      'Ignore self-weight', { inferredType: 'beam', updatedAt: 0, engineeringDraft: { analysisControl: { self_weight: false } } }, 'en');
    expect(built?.analysis_control.self_weight).toBe(false);
    expect(built?.materials[0].rho).toBeUndefined();
    expect(calls).toBe(1);
  });

  test.each(['plain', 'blocks', 'split-blocks'])('router and generic builder accept equivalent %s text without retry', async format => {
    const wrap = value => {
      const text = JSON.stringify(value);
      return format === 'plain' ? text : format === 'blocks' ? [{ type: 'text', text }]
        : [{ type: 'reasoning', reasoning: 'not input data' }, { type: 'text', text: text.slice(0, 25) }, { type: 'text', text: text.slice(25) }];
    };
    let routerCalls = 0;
    const routed = await invokeStructuralTypeRouter({ message: '10m beam', locale: 'en', plugins: [plugin],
      llm: { invoke: async () => { routerCalls++; return { content: wrap({ action: 'switch_skill', skillId: 'beam', confidence: 1 }) }; } } });
    expect(routed?.skillId).toBe('beam');
    expect(routerCalls).toBe(1);
    let buildCalls = 0;
    const built = await tryBuildGenericModelWithLlm({ invoke: async () => { buildCalls++; return { content: wrap(model) }; } },
      '10m beam', { inferredType: 'beam', updatedAt: 0 }, 'en');
    expect(built?.nodes).toEqual(model.nodes);
    expect(built?.load_cases).toEqual(model.load_cases);
    expect(buildCalls).toBe(1);
  });

  test.each([undefined, null, [], [{ type: 'reasoning', reasoning: JSON.stringify({ action: 'switch_skill', skillId: 'beam', confidence: 1 }) }]])('router rejects missing/non-text content without a TypeError (%j)', async content => {
    await expect(invokeStructuralTypeRouter({ message: 'beam', locale: 'en', plugins: [plugin], llm: { invoke: async () => ({ content }) } })).resolves.toBeNull();
  });
});
