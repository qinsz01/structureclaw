import { describe, expect, jest, test } from '@jest/globals';
import { normalizeEngineeringModel } from '../../../dist/engineering/model-boundary.js';
import { assertConfirmedSectionInputs, sectionConfirmationCandidates } from '../../../dist/engineering/section-provenance.js';
import { createRunAnalysisTool } from '../../../dist/agent-langgraph/tools/run-analysis.js';

const shape = { kind: 'I', H: 200, B: 100, tw: 5.2, tf: 8.4 };
const properties = { A: .0026, Iy: 1.809e-5, Iz: 1.4e-6, J: 4.8e-8 };

describe('unconfirmed section recall cannot become calculation input', () => {
  test.each(['shape', 'dimensions', 'properties', 'legacy-source'])('%s is refused before conversion or solver execution', async field => {
    const section = { id: 'S', name: 'I20a',
      ...(field === 'properties' ? { properties } : { [field === 'dimensions' ? field : 'shape']: shape }),
      extra: { ...(field === 'legacy-source' ? { source: 'LLM: table value, unverified' }
        : { provenance: { [field]: 'llm-table' } }), confirmed: true } }; // Untrusted flags do not confirm anything.
    const post = jest.fn();
    const model = { sections: [section] };
    await expect(normalizeEngineeringModel(model, { post })).rejects.toMatchObject({
      code: 'SECTION_CONFIRMATION_REQUIRED', statusCode: 422,
      detail: { recoverable: true, nextAction: 'ask_user_clarification', candidates: [expect.objectContaining({ id: 'S' })] },
    });
    expect(post).not.toHaveBeenCalled();
    const before = structuredClone(model);
    await expect(createRunAnalysisTool({}).invoke({ analysisSkillId: 'opensees-static' }, {
      toolCall: { id: 'blocked', name: 'run_analysis' }, configurable: { agentState: { model, locale: 'en' } },
    })).rejects.toThrow('SECTION_CONFIRMATION_REQUIRED');
    expect(model).toEqual(before);
  });

  test('user dimensions discard unused recall properties without another confirmation', () => {
    const section = { id: 'S', shape: { ...shape, tw: 7, tf: 11.4 }, properties,
      extra: { provenance: { shape: 'user', properties: 'llm-table' } } };
    expect(sectionConfirmationCandidates([section])).toEqual([]);
    expect(() => assertConfirmedSectionInputs({ sections: [section] })).not.toThrow();
  });

  test.each([{ kind: 'I' }, { kind: 'H', H: 300, B: 150 }])('an incomplete shape %j is refused before a solver run is started', async shape => {
    const model = { sections: [{ id: 'S', name: 'designation only', shape }] };
    const post = jest.fn();
    await expect(normalizeEngineeringModel(model, { post })).rejects.toMatchObject({
      code: 'SECTION_CONFIRMATION_REQUIRED', detail: { candidates: [expect.objectContaining({
        shape, requiresDimensions: expect.arrayContaining(['tw', 'tf']),
      })] },
    });
    expect(post).not.toHaveBeenCalled();
    await expect(createRunAnalysisTool({}).invoke({ analysisSkillId: 'opensees-static' }, {
      toolCall: { id: 'incomplete', name: 'run_analysis' }, configurable: { agentState: { model, locale: 'en' } },
    })).rejects.toThrow('SECTION_CONFIRMATION_REQUIRED');
  });

  test('explicit user properties remain authoritative', () => {
    expect(sectionConfirmationCandidates([{ id: 'S', shape, properties,
      extra: { provenance: { shape: 'user', properties: 'user' }, source: 'LLM: stale label' } }])).toEqual([]);
  });
});
