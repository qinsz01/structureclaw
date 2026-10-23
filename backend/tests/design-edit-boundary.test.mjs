import { beforeAll, expect, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.SCLAW_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sclaw-design-edit-'));
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/design-edit-boundary-20261015.json', import.meta.url), 'utf8').replace(/^\uFEFF/, ''));
const { createEditModelTool } = await import('../dist/agent-langgraph/model-tools.js');
const { createLocalStructureProtocolClient } = await import('../dist/services/structure-protocol-execution.js');
const { normalizeEngineeringModel } = await import('../dist/engineering/model-boundary.js');
const { commitModel } = await import('../dist/engineering/model-state.js');
let edit, protocol, initial;
beforeAll(async () => {
  protocol = createLocalStructureProtocolClient(); edit = createEditModelTool();
  initial = { ...commitModel({}, await normalizeEngineeringModel(fixture.model, protocol), 'initial'),
    analysisResult: { runId: 'previous' }, report: { runId: 'previous' } };
});
const invoke = (edits, state = initial) => edit.invoke({ baseRevision: state.modelRevision, edits },
  { toolCall: { id: 'design-edit' }, configurable: { agentState: state, structureProtocolClient: protocol } });

test('the reported falsely successful dotted edit is rejected rather than discarded by conversion', async () => {
  const before = structuredClone(initial);
  await expect(invoke(fixture.reportedEdits[1].edits)).rejects.toThrow(/MODEL_EDIT_FIELD|unsupported|Unsupported/);
  expect(initial).toEqual(before);
});

test('canonical dotted fields and serialized containers preserve numeric types and actual values', async () => {
  const result = await invoke([
    { operation: 'update', collection: 'materials', id: '1', values: { design: '{"f":215,"fv":125}' } },
    { operation: 'update', collection: 'sections', id: 'SEC-I20A', values: { 'properties.S': '0.000104', 'properties.Wnx': '0.000237', 'properties.tw': '0.0052', 'properties.imin': '0.021' } },
    { operation: 'update', collection: 'elements', id: '1', values: { 'design.beta1': '1.1', 'design.serviceability_result_keys': '["case:LC1"]' } },
  ]);
  expect(result.update.modelRevision).toBe(2);
  expect(result.update.model.materials[0].design).toMatchObject({ f: 215, fv: 125 });
  expect(result.update.model.sections[0].properties).toMatchObject({ S: 0.000104, Wnx: 0.000237, tw: 0.0052, imin: 0.021 });
  expect(result.update.model.elements[0].design).toMatchObject({ beta1: 1.1, serviceability_result_keys: ['case:LC1'] });
  expect(JSON.parse(result.update.messages[0].content)).toMatchObject({ success: true, changed: true });
});

test('a valid no-op reports no change and never reuses a previous transaction', async () => {
  const result = await invoke([{ operation: 'update', collection: 'materials', id: '1', values: { E: 206000 } }]);
  expect(JSON.parse(result.update.messages[0].content)).toMatchObject({ success: true, changed: false, transaction: null });
  expect(result.update.modelRevision).toBe(1);
  expect(result.update.analysisResult).toBeUndefined();
});

test('wrong design owner and conflicting path aliases produce actionable atomic errors', async () => {
  await expect(invoke([{ operation: 'update', collection: 'elements', id: '1', values: { design: { f: 215 } } }])).rejects.toThrow(/materials.*1.*design.f/);
  await expect(invoke([{ operation: 'update', collection: 'materials', id: '1', values: { design: { f: 215 }, 'design.f': 220 } }])).rejects.toThrow(/CONFLICT/);
  await expect(invoke([{ operation: 'update', collection: 'elements', id: '1', values: { 'design.__proto__.x': 1 } }])).rejects.toThrow(/FIELD/);
});

test('formal physical validation errors identify the rejected field instead of a generic schema failure', async () => {
  await expect(invoke([{ operation: 'update', collection:'materials', id:'1', values:{'design.f':-1} }]))
    .rejects.toThrow(/materials.*design.f.*greater than 0/);
  expect(initial.modelRevision).toBe(1);
  expect(initial.analysisResult.runId).toBe('previous');
});

test('design basis is retained by the formal schema and shared section units reach the checker', async () => {
  const result = await invoke([
    { operation: 'update', collection: 'elements', id: '1', values: { design: { phi_b: 1, basis: { phi_b: 'Explicitly supplied restraint condition' } } } },
    { operation: 'update', collection: 'sections', id: 'SEC-I20A', values: { properties: { b: 0.1, t: 0.0084, imin: 0.021 } } },
  ]);
  expect(result.update.model.elements[0].design.basis.phi_b).toBe('Explicitly supplied restraint condition');
  const { buildCodeCheckInput } = await import('../dist/agent-skills/code-check/entry.js');
  const data = buildCodeCheckInput({ traceId: 'fixture', designCode: 'GB50017', model: result.update.model, analysis: {}, analysisParameters: {} }).context.elementData['1'];
  expect(data.section).toMatchObject({ b: 100, t: 8.4, imin: 21 });
});

test('reviewing an absent optional design field gives a validated proposal that can be applied atomically', async () => {
  const { createReviewInputTool } = await import('../dist/agent-langgraph/model-tools.js');
  const reviewed = await createReviewInputTool().invoke({ resolutions:[
    { field:'materials.1.design.f', value:215, unit:'MPa', reason:'Explicit user input' },
    { field:'sections.SEC-I20A.properties.S', value:104, unit:'cm3', reason:'Explicit user input' },
  ] }, { toolCall:{id:'review-new-field'}, configurable:{agentState:initial, structureProtocolClient:protocol} });
  const payload = JSON.parse(reviewed.update.messages[0].content);
  expect(payload.modelValueErrors).toEqual([]);
  expect(payload.modelValues).toEqual([{ field:'materials.1.design.f', value:215, unit:'MPa' }, {field:'sections.SEC-I20A.properties.S',value:.000104,unit:'m3'}]);
  expect(initial.model.materials[0].design).toBeUndefined();
  const state = {...initial, ...reviewed.update};
  const committed = await invoke([
    {operation:'update',collection:'materials',id:'1',values:{'design.f':215}},
    {operation:'update',collection:'sections',id:'SEC-I20A',values:{'properties.S':.000104}},
  ],state);
  expect(committed.update.modelRevision).toBe(2);
});

test('invalid review mappings cannot save resolved evidence or invalidate existing results', async () => {
  const { createReviewInputTool } = await import('../dist/agent-langgraph/model-tools.js');
  const before = structuredClone(initial);
  await expect(createReviewInputTool().invoke({resolutions:[{field:'materials.1.design.fake_pass',value:1,unit:'1',reason:'invalid'}]},
    {toolCall:{id:'invalid-review'},configurable:{agentState:initial,structureProtocolClient:protocol}})).rejects.toThrow(/INPUT_REVIEW_INVALID.*fake_pass/);
  expect(initial).toEqual(before);
});
