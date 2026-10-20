import { describe, expect, jest, test } from '@jest/globals';
import { enforceSectionUserEvidence } from '../../../dist/engineering/section-user-evidence.js';
import { normalizeEngineeringModel } from '../../../dist/engineering/model-boundary.js';
import { ingestDraft } from '../../../dist/agent-runtime/draft/boundary.js';
import { conversationUserTexts } from '../../../dist/agent-langgraph/tools/input-message.js';
import { createRunAnalysisTool } from '../../../dist/agent-langgraph/tools/run-analysis.js';
import { createBuildModelTool } from '../../../dist/agent-langgraph/tools/build-model.js';
import { createEditModelTool } from '../../../dist/agent-langgraph/model-tools.js';
import { createLocalStructureProtocolClient } from '../../../dist/services/structure-protocol-execution.js';
import { draftSectionConfirmations } from '../../../dist/agent-runtime/draft-readiness.js';

const shape = { kind: 'I', H: 200, B: 100, tw: 7, tf: 11.4 };
const section = () => ({ id: 'S', name: 'I20a', type: 'I', shape: { ...shape }, extra: { provenance: { shape: 'user' } } });
const user = content => ({ role: 'user', content });
const reply = answer => ({ role: 'tool', name: 'ask_user_clarification',
  content: JSON.stringify({ type: 'clarification_answered', answer, question: '200×100×7×11.4 mm?',
    options: ['确认 200×100×7×11.4 mm'] }) });

describe('section numbers require actual user evidence', () => {
  test('a designation, question, options and agent restatement are not numeric evidence', () => {
    const texts = conversationUserTexts({ messages: [user('10m beam, 1kN'),
      { role: 'assistant', content: '200×100×7×11.4 mm' }, reply('材料Q235钢，截面工字钢I20a')] });
    expect(texts).toEqual(['10m beam, 1kN', '材料Q235钢，截面工字钢I20a']);
    const original = section();
    expect(enforceSectionUserEvidence(original, texts).extra.provenance.shape).toBe('llm-table');
    expect(original.extra.provenance.shape).toBe('user');
    expect(ingestDraft({ engineeringDraft: { sectionRecords: [original] } }, undefined, texts)
      .engineeringDraft.sectionRecords[0].extra.provenance.shape).toBe('llm-table');
  });

  test.each([
    '200×100×7×11.4 mm',
    'H=20cm, B=10cm, tw=0.7cm, tf=1.14cm',
    '0.2×0.1×0.007×0.0114 m',
    '20×10×0.7×1.14 cm',
    'H200x100x7x11.4',
    '确认 I20a：H200,B100,tw7,tf11.4',
    'H=200.01 mm, B=100, tw=7, tf=11.4 mm',
  ])('typed dimensions and unit variants are accepted: %s', text => {
    expect(enforceSectionUserEvidence(section(), [text]).extra.provenance.shape).toBe('user');
  });

  test('numbers from any user turn, including the exact selected option, remain evidence', () => {
    const texts = conversationUserTexts({ messages: [user('H=20cm, B=10cm'), user('another task'),
      reply('确认 tw=7mm, tf=11.4mm')], lastUserMessage: 'Q235' });
    expect(enforceSectionUserEvidence(section(), texts).extra.provenance.shape).toBe('user');
    expect(enforceSectionUserEvidence(section(), conversationUserTexts({ messages: [reply('确认 200×100×7×11.4 mm')] }))
      .extra.provenance.shape).toBe('user');
    expect(enforceSectionUserEvidence(section(), conversationUserTexts({ messages: [reply('确认')] }))
      .extra.provenance.shape).toBe('llm-table');
  });

  test('persisted messages retain user evidence without including question or attachment text', () => {
    expect(conversationUserTexts({ messages: [
      { type: 'constructor', id: ['langchain_core', 'messages', 'HumanMessage'],
        kwargs: { content: 'H=20cm [Attachment analysis: 200×100×7×11.4 mm]' } },
      { type: 'constructor', id: ['langchain_core', 'messages', 'ToolMessage'],
        kwargs: { name: 'ask_user_clarification', content: reply('B=100 mm').content } },
    ] })).toEqual(['H=20cm', 'B=100 mm']);
  });

  test('unit powers and a small relative tolerance preserve explicit properties', () => {
    const record = { id: 'S', properties: { A: .0035578, Iy: 2.37e-5, Iz: 1.4e-6, J: 4.8e-8 },
      extra: { provenance: { properties: 'user' } } };
    expect(enforceSectionUserEvidence(record, ['A=35.578cm², Iy=2370cm^4, Iz=140 cm4, J=4.8 cm⁴'])
      .extra.provenance.properties).toBe('user');
    expect(enforceSectionUserEvidence(record, ['A=0.0035578m², Iy=2.37001e-5m4, Iz=1.4e-6m⁴, J=4.8e-8m^4'])
      .extra.provenance.properties).toBe('user');
    expect(enforceSectionUserEvidence(record, ['A=35.578cm, Iy=2370cm², Iz=140cm, J=4.8cm'])
      .extra.provenance.properties).toBe('llm-table');
    expect(enforceSectionUserEvidence(section(), ['200×100×7×11.2 mm']).extra.provenance.shape).toBe('llm-table');
    expect(enforceSectionUserEvidence({ shape: { H: 235 }, extra: { provenance: { shape: 'user' } } }, ['Q235'])
      .extra.provenance.shape).toBe('llm-table');
  });

  test('a name-only section asks for a numeric definition without losing its material', async () => {
    const state = { messages: [user('材料Q235钢，截面工字钢I20a')], draftState: { engineeringDraft: {
      materials: [{ id: 'M1', family: 'steel', grade: 'Q235', name: 'Q235' }],
      sectionRecords: [{ id: 'S1', family: 'steel', name: 'I20a', type: 'I', extra: { source: 'user' } }],
      templateAssignments: { beam: { materialId: 'M1' } },
    } } };
    expect(draftSectionConfirmations(state.draftState)).toEqual([
      { id: 'S1', name: 'I20a', fields: ['shape'], requiresNumericDefinition: true },
    ]);
    const buildModel = jest.fn();
    await expect(createBuildModelTool({ buildModel }).invoke({}, { toolCall: { id: 'name-only' },
      configurable: { agentState: state } })).rejects.toThrow('SECTION_CONFIRMATION_REQUIRED');
    expect(buildModel).not.toHaveBeenCalled();
    expect(state.draftState.engineeringDraft.materials[0].grade).toBe('Q235');
    expect(draftSectionConfirmations({ engineeringDraft: { sectionRecords: [{ id: 'S1', name: 'HN300×150×6.5×9' }] } })).toEqual([]);
  });

  test('a forged user source cannot cross build, import or analysis boundaries', async () => {
    const state = { locale: 'en', messages: [user('Q235, I20a')], model: { sections: [section()] },
      draftState: { engineeringDraft: { sectionRecords: [section()] } } };
    const buildModel = jest.fn(), post = jest.fn(), executeAnalysis = jest.fn();
    const config = { toolCall: { id: 'blocked' }, configurable: { agentState: state, structureProtocolClient: { post } } };
    await expect(createBuildModelTool({ buildModel }).invoke({}, config)).rejects.toThrow('SECTION_CONFIRMATION_REQUIRED');
    await expect(normalizeEngineeringModel(state.model, { post }, undefined, conversationUserTexts(state)))
      .rejects.toThrow('SECTION_CONFIRMATION_REQUIRED');
    await expect(createRunAnalysisTool({ executeAnalysis }).invoke({ analysisSkillId: 'opensees-static' }, config))
      .rejects.toThrow('SECTION_CONFIRMATION_REQUIRED');
    expect(buildModel).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(executeAnalysis).not.toHaveBeenCalled();
    expect(state.model.sections[0].extra.provenance.shape).toBe('user');
  });

  test('edits cannot claim user numbers absent from the conversation; rejection is atomic', async () => {
    const state = { locale: 'en', messages: [user('Change to I20a')], modelRevision: 1,
      model: { nodes: [], elements: [], materials: [], load_cases: [], load_combinations: [],
        sections: [{ id: 'S', name: 'rectangular', type: 'rectangular', shape: { kind: 'rectangular', B: 100, H: 200 } }] } };
    const original = structuredClone(state.model);
    await expect(createEditModelTool().invoke({ baseRevision: 1, edits: [{
      operation: 'update', collection: 'sections', id: 'S', values: section(),
    }] }, { toolCall: { id: 'edit' }, configurable: { agentState: state, structureProtocolClient: createLocalStructureProtocolClient() } }))
      .rejects.toThrow('SECTION_CONFIRMATION_REQUIRED');
    expect(state.model).toEqual(original);
  });
});
