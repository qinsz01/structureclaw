import { expect, test } from '@jest/globals';
import { ToolMessage } from '@langchain/core/messages';
import { projectToolMessagesForContext } from '../dist/agent-langgraph/graph.js';

test('old full draft payloads are projected compactly without mutating storage or losing clarification controls', () => {
  const draft = { material: { grade: 'Q235' }, sectionRecords: [{ id: 'S1', shape: { kind: 'I' } }] };
  const payload = { nextState: { engineeringDraft: draft, skillState: { engineeringDraft: draft } }, engineeringDraft: draft,
    llmDraftPatch: { engineeringDraft: draft }, criticalMissing: ['sectionConfirmation'], nextAction: 'ask_user_clarification',
    sectionConfirmations: [{ id: 'S1', requiresDimensions: ['H', 'B', 'tw', 'tf'] }] };
  const message = new ToolMessage({ content: JSON.stringify(payload), name: 'extract_draft_params', tool_call_id: 'old-extract' });
  const [projected] = projectToolMessagesForContext([message]);
  expect(JSON.parse(projected.content)).toEqual({ criticalMissing: payload.criticalMissing, nextAction: payload.nextAction,
    sectionConfirmations: payload.sectionConfirmations, stateStored: true });
  expect(projected.tool_call_id).toBe('old-extract');
  expect(projected.content.length).toBeLessThan(message.content.length / 2);
  expect(JSON.stringify(projected)).not.toContain('engineeringDraft');
  expect(JSON.stringify(projected).length).toBeLessThan(JSON.stringify(message).length);
  expect(JSON.parse(message.content)).toEqual(payload);
});
