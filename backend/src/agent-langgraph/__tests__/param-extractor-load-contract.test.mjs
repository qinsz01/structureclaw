import { describe, expect, test } from '@jest/globals';

const plugin = { id: 'generic', name: { en: 'Generic', zh: '通用' }, description: {},
  stages: ['draft'], structureType: 'unknown', markdownByStage: {} };

describe('extraction load contract', () => {
  test.each(['zh', 'en'])('patch requests carry the authoritative load encoding and selectors (%s)', async locale => {
    const { invokeParamExtractor } = await import('../../../dist/agent-langgraph/param-extractor.js');
    const { draftContract } = await import('../../../dist/engineering/draft-contract.js');
    let prompt;
    await invokeParamExtractor({ locale, plugin, message: '均竖直向下',
      existingState: { inferredType: 'unknown', engineeringDraft: {} },
      llm: { invoke: async value => { prompt = value; return { content: '{}' }; } } });
    expect(prompt).toContain('PATCH ONLY');
    const fields = draftContract.properties.loads.items.properties;
    expect(prompt).toContain(JSON.stringify(fields.direction.enum));
    expect(prompt).toContain(JSON.stringify(fields.unit.enum));
    expect(prompt).toContain(JSON.stringify(fields.target.description));
    expect(prompt).toContain(JSON.stringify(fields.location.properties.nodeRole.description));
    expect(prompt).toContain('Put the sign in magnitude, never in the direction enum');
    expect(prompt).toContain('all-stories/all-floors');
  });

  test.each(['zh', 'en'])('the last focused repair really receives the full contract (%s)', async locale => {
    const { invokeParamExtractor } = await import('../../../dist/agent-langgraph/param-extractor.js');
    const { draftContract, draftExtractionContract, promptContract } = await import('../../../dist/engineering/draft-contract.js');
    const prompts = [];
    await invokeParamExtractor({ locale, plugin, message: 'Keep supplied loads.', focusFields: ['loads'],
      existingState: { inferredType: 'unknown', engineeringDraft: {} },
      llm: { invoke: async prompt => { prompts.push(prompt); return { content: prompts.length < 3 ? '' : '{}' }; } } });
    expect(prompts).toHaveLength(3);
    expect(prompts[0]).toContain('PATCH ONLY');
    expect(prompts[1]).toContain('PATCH ONLY');
    expect(prompts[2]).not.toContain('PATCH ONLY');
    expect(prompts[2]).toContain(JSON.stringify(promptContract(draftExtractionContract)));
    expect(draftExtractionContract.properties.loads).toEqual(draftContract.properties.loads);
    expect(prompts[2]).toContain(JSON.stringify(draftExtractionContract.properties.materials));
  });

  test.each(['globalX', 'globalY', 'globalZ', 'gravity'])('signed %s loads agree between the declared schema and runtime', async direction => {
    const { draftContract, validDraftValue } = await import('../../../dist/engineering/draft-contract.js');
    const { normalizeEngineeringDraft } = await import('../../../dist/agent-runtime/engineering-draft.js');
    const load = { id: 'L1', kind: 'line', magnitude: -27, unit: 'kN/m', direction, target: 'beam', location: { story: 1 } };
    expect(validDraftValue(draftContract.properties.loads, [load])).toBe(true);
    const normalized = normalizeEngineeringDraft({ loads: [load] });
    expect(normalized.loads[0]).toMatchObject(load);
    expect(validDraftValue(draftContract.properties.loads, [{ ...load, direction: '-Z' }])).toBe(false);
    expect(() => normalizeEngineeringDraft({ loads: [{ ...load, direction: '-Z' }] })).toThrow('LOAD_DIRECTION_INVALID');
  });
});
