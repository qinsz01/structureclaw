import { expect, jest, test } from '@jest/globals';
import { createBuildModelTool } from '../dist/agent-langgraph/tools/build-model.js';
import { assertResolvedInput, mergeInputEvidence } from '../dist/engineering/input-evidence.js';

test('building uses current review receipts and confirmed candidates without mutating the saved draft', async () => {
  const source = { id: 'file-source', field: 'file:beam.dxf:fields', status: 'unread', required: true,
    requirement: 'field-mapping', source: { file: 'beam.dxf', sha256: 'sha', complete: true } };
  const inputEvidence = mergeInputEvidence([source], [{ id: 'endpoint', field: 'nodes.B.x', status: 'observed', required: true,
    value: 6, unit: 'm', source: source.source }, { id: 'review', field: source.field, status: 'resolved', required: true,
    resolution: { value: true, reason: 'Mapped endpoint', mappedFields: ['nodes.B.x'] } }]);
  const shape = { kind: 'I', H: 200, B: 100, tw: 7, tf: 11.4 };
  const saved = { updatedAt: 0, engineeringDraft: { inputEvidence: [source], sectionRecords: [
    { id: 'S', name: 'I', type: 'I', shape, extra: { provenance: { shape: 'llm-table' } } },
  ] } };
  const state = { draftState: saved, inputEvidence, messages: [{ role: 'tool', name: 'ask_user_clarification',
    content: JSON.stringify({ type: 'clarification_answered', clarificationId: 'q', answer: '确认', selectedOptionId: 'yes',
      sectionCandidates: [{ id: 'c', sectionId: 'S', field: 'shape', values: shape, optionIds: ['yes'] }] }) }] };
  const buildModel = jest.fn(async draft => {
    assertResolvedInput(draft.engineeringDraft.inputEvidence);
    expect(draft.engineeringDraft.sectionRecords[0].extra.provenance.shape).toBe('user');
    throw new Error('builder reached');
  });
  await expect(createBuildModelTool({ buildModel }).invoke({}, { toolCall: { id: 'build' },
    configurable: { agentState: state } })).rejects.toThrow('builder reached');
  expect(buildModel).toHaveBeenCalledTimes(1);
  expect(saved.engineeringDraft.inputEvidence).toEqual([source]);
  expect(saved.engineeringDraft.sectionRecords[0].extra.provenance.shape).toBe('llm-table');
});
