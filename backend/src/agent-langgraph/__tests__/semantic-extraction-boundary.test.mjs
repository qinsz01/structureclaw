import { beforeEach, expect, jest, test } from '@jest/globals';

const extract = jest.fn();
jest.unstable_mockModule('../../../dist/agent-langgraph/param-extractor.js', () => ({ invokeParamExtractor: extract }));
const { createExtractDraftParamsTool } = await import('../../../dist/agent-langgraph/tools/extract-draft-params.js');
const { createDetectStructureTypeTool } = await import('../../../dist/agent-langgraph/tools/detect-structure-type.js');
const { handler } = await import('../../../dist/agent-skills/structure-type/generic/handler.js');
const plugin = { id: 'generic', structureType: 'unknown', handler };
const answer = 'C30混凝土，矩形截面 250×500（B=250mm，H=500mm）';
const question = '确认梁材料与截面：C30矩形250×500，或者Q355钢HN400×200，腹板tw=8mm、翼缘tf=13mm';
const scope = { responses: ['forces', 'reactions', 'displacements'], design: false, report: false, outputs: [] };
const match = { key: 'unknown', mappedType: 'unknown', skillId: 'generic', supportLevel: 'supported', routingSource: 'scope-selected' };
const draft = () => ({ inferredType: 'unknown', structuralTypeKey: 'unknown', skillId: 'generic',
  supportLevel: 'fallback', routingSource: 'generic-fallback', updatedAt: 1, requestScope: scope,
  engineeringDraft: { structureType: '简支梁', geometry: { lengthM: 10 }, boundary: { supportType: 'simply-supported' },
    loads: [{ id: 'L1', kind: 'point', magnitude: 1, unit: 'kN', direction: 'gravity', target: 'beam', location: { xM: 5 } }] } });
const state = () => ({ draftState: draft(), requestScope: scope, lastUserMessage: '设计一个简支梁，跨度10m，梁中间荷载1kN',
  messages: [{ role: 'user', content: '设计一个简支梁，跨度10m，梁中间荷载1kN' },
    { role: 'tool', name: 'ask_user_clarification', content: JSON.stringify({ type: 'clarification_answered',
      question, options: [answer, 'Q355钢HN400×200，腹板tw=8mm'], answer, selectedOptionId: 'option-1' }) }] });
const runtime = route => ({ resolvePluginForType: async () => plugin, detectStructuralTypeWithLlm: route });
const invoke = (tool, agentState) => tool.invoke({ message: '助手重述：楼板', locale: 'zh' },
  { toolCall: { id: 'semantic-boundary' }, configurable: { agentState } });

beforeEach(() => { extract.mockReset(); extract.mockResolvedValue({ engineeringDraft: { material: { family: 'concrete', grade: 'C30' }, sections: { beam: '250X500' } } }); });

test('an omitted invalid legacy purpose fails merged-state validation and reaches extractor repair feedback', async () => {
  const before = state(); before.draftState.supportLevel = 'supported'; before.draftState.routingSource = 'scope-selected';
  before.lastUserMessage = '梁截面为实心矩形100×200mm，保留其余已确认输入。';
  before.messages = [{ role: 'user', content: before.lastUserMessage }];
  before.draftState.engineeringDraft.sectionRecords = [{ id: 'S1', type: 'rectangular', purpose: 'member',
    shape: { kind: 'rectangular', B: 100, H: 200 } }];
  const snapshot = structuredClone(before);
  const correction = { engineeringDraft: { sectionRecords: [{ id: 'S1', purpose: 'beam' }] } };
  extract.mockImplementation(async input => {
    await expect(input.validatePatch({})).rejects.toThrow('DRAFT_SECTION_INVALID');
    await input.validatePatch(correction);
    return correction;
  });
  const result = await invoke(createExtractDraftParamsTool(runtime(jest.fn())), before);
  expect(result.update.draftState.engineeringDraft.sectionRecords[0]).toMatchObject({ purpose: 'beam', shape: { B: 100, H: 200 } });
  expect(result.update.draftState.engineeringDraft.loads).toEqual(before.draftState.engineeringDraft.loads);
  expect(before).toEqual(snapshot);
});

test('the generic C30 clarification routes only actual evidence while extraction retains its labelled context', async () => {
  const route = jest.fn(async () => match);
  const result = await invoke(createExtractDraftParamsTool(runtime(route)), state());
  expect(route).toHaveBeenCalledTimes(1);
  expect(route.mock.calls[0][1]).toContain(answer);
  expect(route.mock.calls[0][1]).not.toContain('腹板');
  expect(route.mock.calls[0][1]).not.toContain('助手重述');
  expect(extract.mock.calls[0][0].message).toContain(question);
  expect(extract.mock.calls[0][0].message).toContain('unconfirmed context');
  expect(result.update.draftState.structuralTypeKey).toBe('unknown');
  expect(result.update.draftState.engineeringDraft.material.grade).toBe('C30');
});

test('explicit structure detection cannot treat the assistant restatement or unselected candidates as user input', async () => {
  const route = jest.fn(async () => match);
  await invoke(createDetectStructureTypeTool(runtime(route)), state());
  expect(route.mock.calls[0][1]).toContain(answer);
  expect(route.mock.calls[0][1]).not.toContain('腹板');
  expect(route.mock.calls[0][1]).not.toContain('助手重述');
});

test('unsupported extraction leaves an accepted generic draft and its type untouched', async () => {
  const before = state(), snapshot = structuredClone(before);
  const route = jest.fn(async () => ({ key: 'plate-slab', mappedType: 'unknown', supportLevel: 'unsupported', routingSource: 'llm-suggested' }));
  const result = await invoke(createExtractDraftParamsTool(runtime(route)), before);
  expect(extract).not.toHaveBeenCalled();
  expect(result.update).not.toHaveProperty('draftState');
  expect(result.update).not.toHaveProperty('structuralTypeKey');
  expect(result.update).not.toHaveProperty('requestScope');
  expect(JSON.parse(result.update.messages[0].content)).toMatchObject({ success: false, canProceed: false });
  expect(before).toEqual(snapshot);
});

test.each(['LLM_STRUCTURAL_ROUTER_REQUIRED', 'LLM_STRUCTURAL_ROUTER_INVALID_OUTPUT', 'LLM_STRUCTURAL_ROUTER_INFRASTRUCTURE_ERROR'])
('terminal routing error %s stops extraction without updating saved state', async code => {
  const before = state(), snapshot = structuredClone(before);
  const route = async () => { throw new Error(`${code}: routing unavailable / 路由不可用`); };
  const result = await invoke(createExtractDraftParamsTool(runtime(route)), before);
  expect(extract).not.toHaveBeenCalled();
  expect(result.update).not.toHaveProperty('draftState');
  expect(result.update).not.toHaveProperty('structuralTypeKey');
  expect(JSON.parse(result.update.messages[0].content)).toMatchObject({ success: false, errorCode: code, nextAction: 'report_internal_error' });
  expect(before).toEqual(snapshot);
});

test('an accepted generic route can be reused but never substitutes for a failed extractor', async () => {
  const before = state(); before.draftState.supportLevel = 'supported'; before.draftState.routingSource = 'scope-selected';
  const route = jest.fn(async () => match);
  extract.mockRejectedValue(new Error('LLM_PARAM_EXTRACTOR_CONFIGURATION_ERROR: LLM required / 必须配置LLM'));
  const result = await invoke(createExtractDraftParamsTool(runtime(route)), before);
  expect(route).not.toHaveBeenCalled();
  expect(result.update).not.toHaveProperty('draftState');
  expect(JSON.parse(result.update.messages[0].content)).toMatchObject({ success: false, errorCode: 'LLM_PARAM_EXTRACTOR_CONFIGURATION_ERROR', nextAction: 'report_internal_error' });
});
test.each([
  { success: false, errorCode: 'LLM_STRUCTURAL_ROUTER_INVALID_OUTPUT', message: 'LLM_STRUCTURAL_ROUTER_INVALID_OUTPUT: bad result / 无效结果' },
  { key: 'plate-slab', mappedType: 'unknown', supportLevel: 'unsupported', routingSource: 'llm-suggested' },
  { key: 'unknown', mappedType: 'unknown', supportLevel: 'supported' },
])('a rejected current detection cannot be replaced by an older accepted generic route: %j', async rejected => {
  const before = state(); before.draftState.supportLevel = 'supported'; before.draftState.routingSource = 'scope-selected';
  before.messages.push({ role: 'tool', name: 'detect_structure_type', content: JSON.stringify(rejected) });
  const route = jest.fn(async () => match);
  const result = await invoke(createExtractDraftParamsTool(runtime(route)), before);
  expect(route).not.toHaveBeenCalled();
  expect(extract).not.toHaveBeenCalled();
  expect(result.update).not.toHaveProperty('draftState');
  expect(JSON.parse(result.update.messages[0].content)).toMatchObject({ success: false, canProceed: false });
});

test('serialized current routing errors cannot be bypassed by an accepted route', async () => {
  const before = state(); before.draftState.supportLevel = 'supported'; before.draftState.routingSource = 'scope-selected';
  before.messages.push({ type: 'tool', kwargs: { name: 'detect_structure_type', content: JSON.stringify({
    success: false, errorCode: 'LLM_STRUCTURAL_ROUTER_REQUIRED', message: 'LLM_STRUCTURAL_ROUTER_REQUIRED: Missing LLM / 缺少LLM',
  }) } });
  const route = jest.fn(async () => match);
  const result = await invoke(createExtractDraftParamsTool(runtime(route)), before);
  expect(route).not.toHaveBeenCalled();
  expect(extract).not.toHaveBeenCalled();
  expect(result.update).not.toHaveProperty('draftState');
  expect(JSON.parse(result.update.messages[0].content)).toMatchObject({ success: false, errorCode: 'LLM_STRUCTURAL_ROUTER_REQUIRED' });
});
