import { describe, expect, test } from '@jest/globals';
import { handler } from '../../../dist/agent-skills/structure-type/generic/handler.js';
import { invokeParamExtractor } from '../../../dist/agent-langgraph/param-extractor.js';
import { createBuildModelTool } from '../../../dist/agent-langgraph/tools/build-model.js';
import { tryBuildGenericModelWithLlm } from '../../../dist/agent-skills/structure-type/generic/llm-model-builder.js';
import { modelContract } from '../../../dist/engineering/draft-contract.js';
import { DraftSectionValidationError } from '../../../dist/engineering/draft-sections.js';

const section = { id: 'S1', type: 'rectangular', purpose: 'beam', shape: { kind: 'rectangular', B: 100, H: 200 } };
const patch = purpose => ({ engineeringDraft: { sectionRecords: [{ ...section, purpose }] } });
const state = () => ({ inferredType: 'unknown', skillId: 'generic', updatedAt: 1,
  engineeringDraft: { sectionRecords: [structuredClone(section)] } });
const plugin = { id: 'generic', name: { en: 'Generic', zh: '通用' }, description: { en: 'Generic', zh: '通用' },
  stages: ['draft'], structureType: 'unknown', markdownByStage: { draft: 'Preserve supplied engineering values.' } };

describe('draft section protocol validation before model generation', () => {
  test.each(['member', '', 7, false])('rejects invalid purpose %p before it can poison confirmed state', purpose => {
    const accepted = state(), before = structuredClone(accepted);
    expect(() => handler.extractDraft({ currentState: accepted, llmDraftPatch: patch(purpose) })).toThrow(DraftSectionValidationError);
    expect(accepted).toEqual(before);
  });

  test('accepts every canonical purpose and partial records without inventing one', () => {
    const values = modelContract.$defs.SectionV2.properties.purpose.anyOf.find(s => s.enum).enum;
    for (const purpose of [...values, null, undefined]) {
      const extracted = handler.extractDraft({ currentState: state(), llmDraftPatch: patch(purpose) });
      expect(extracted.engineeringDraft.sectionRecords[0].purpose).toBe(purpose);
    }
  });

  test.each(['zh', 'en'])('returns invalid extraction to the LLM for correction without asking known inputs again (%s)', async locale => {
    const accepted = state(), before = structuredClone(accepted), prompts = [];
    const result = await invokeParamExtractor({ locale, plugin, existingState: accepted, message: 'A beam, 100 by 200 mm.',
      traceLogger: { info() {}, debug() {}, warn() {} },
      validatePatch: candidate => handler.extractDraft({ currentState: accepted, llmDraftPatch: candidate }),
      llm: { invoke: async prompt => { prompts.push(prompt); return { content: JSON.stringify(patch(prompts.length === 1 ? 'member' : 'beam')) }; } },
    });
    expect(result).toEqual(patch('beam'));
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('DRAFT_SECTION_INVALID');
    expect(prompts[1]).toContain('sectionRecords["S1"].purpose');
    expect(accepted).toEqual(before);
  });

  test('persisted invalid draft gets a repair action without invoking the builder or changing the accepted model', async () => {
    const accepted = { model: { nodes: [{ id: 'old' }] }, modelRevision: 4,
      draftState: { ...state(), engineeringDraft: patch('member').engineeringDraft } };
    const before = structuredClone(accepted);
    const tool = createBuildModelTool({ buildModel() { throw new Error('builder must not be invoked'); } });
    const result = await tool.invoke({}, { toolCall: { id: 'test-invalid-section' },
      configurable: { agentState: accepted, toolContext: { skillScope: ['generic'] } } });
    expect(JSON.parse(result.update.messages[0].content)).toMatchObject({ success: false, modelBuilt: false,
      errorCode: 'DRAFT_PROTOCOL_INVALID', field: 'sectionRecords["S1"].purpose', nextAction: 'extract_draft_params',
      repair: { clearDraftFields: ['sectionRecords["S1"].purpose'] } });
    expect(result.update).not.toHaveProperty('model');
    expect(accepted).toEqual(before);
  });

  test('direct builder calls cannot waste repeated model generations on an invalid source record', async () => {
    let calls = 0;
    await expect(tryBuildGenericModelWithLlm({ invoke: async () => { calls++; throw new Error('must not call'); } },
      'Build the beam.', { ...state(), engineeringDraft: patch('member').engineeringDraft }, 'en')).rejects.toThrow(DraftSectionValidationError);
    expect(calls).toBe(0);
  });
});
