import { expect, test } from '@jest/globals';
import { handler } from '../../../dist/agent-skills/structure-type/beam/handler.js';
import { mergeEngineeringDraft } from '../../../dist/agent-runtime/engineering-draft.js';
import { mergeDraftState } from '../../../dist/agent-runtime/fallback.js';
import { normalizeLegacyDraftPatch } from '../../../dist/agent-runtime/legacy.js';
import { parseDraftPatchFromContent, buildParamExtractorPrompt } from '../../../dist/agent-langgraph/param-extractor.js';
import { normalizeEngineeringModel } from '../../../dist/engineering/model-boundary.js';
import { createLocalStructureProtocolClient } from '../../../dist/services/structure-protocol-execution.js';

const source = { structureType: 'beam', geometry: { lengthM: 10 }, boundary: { supportType: 'simply-supported' },
  material: { family: 'steel', grade: 'Q235' }, sections: { beam: 'HN400X200X8X13' },
  sectionRecords: [{ id: 'S1', name: 'HN400X200X8X13', type: 'H', purpose: 'beam',
    shape: { kind: 'H', H: 400, B: 200, tw: 8, tf: 13 }, standard_steel_name: 'HN400x200x8x13' }],
  loads: [{ id: 'L1', kind: 'point', magnitude: 1, unit: 'kN', direction: 'gravity', target: 'beam', location: { xM: 5, nodeRole: 'midspan' } }],
  analysisControl: { self_weight: true } };
const original = handler.mergeState(undefined, handler.extractDraft({ locale: 'zh', llmDraftPatch: { engineeringDraft: source } }));
const update = (before, raw) => handler.mergeState(before, handler.extractDraft({ locale: 'zh', currentState: before, llmDraftPatch: raw }));

test('the reported saved draft fails before repair; omission preserves it, explicit withdrawal removes only its catalog selector', async () => {
  const client = createLocalStructureProtocolClient();
  const snapshot = structuredClone(original);
  await expect(normalizeEngineeringModel(handler.buildModel(original), client)).rejects.toThrow('combines a catalog name');
  const patch = { engineeringDraft: { sectionRecords: [{ id: 'S1', shape: { ...source.sectionRecords[0].shape } }] } };
  expect(update(original, patch).engineeringDraft.sectionRecords[0].standard_steel_name).toBe('HN400x200x8x13');
  const corrected = update(original, { ...patch, clearDraftFields: ['sectionRecords["S1"].standard_steel_name'] });
  const saved = JSON.parse(JSON.stringify(corrected));
  expect(saved.engineeringDraft.sectionRecords[0]).not.toHaveProperty('standard_steel_name');
  expect(saved.engineeringDraft.loads).toEqual(original.engineeringDraft.loads);
  expect(saved.engineeringDraft.analysisControl).toEqual({ self_weight: true });
  const model = await normalizeEngineeringModel(handler.buildModel(saved), client);
  expect(model.sections[0].id).toBe('S1');
  expect(model.sections[0].properties.A).toBeCloseTo(.2 * .013 * 2 + (.4 - 2 * .013) * .008, 14);
  expect(model.sections[0].properties.Iy).toBeCloseTo((.2 * .4 ** 3 - (.2 - .008) * (.4 - .026) ** 3) / 12, 14);
  expect(model.analysis_control.self_weight).toBe(true);
  expect(original).toEqual(snapshot);
});

test('a full object replacement clears old geometry, while ordinary partial updates preserve other supplied properties', () => {
  const before = { ...original, engineeringDraft: { ...source, sectionRecords: [{ id: 'S1', name: 'custom', type: 'H', purpose: 'beam',
    shape: source.sectionRecords[0].shape, properties: { A: .008192, J: 3e-6 } }] } };
  const after = update(before, { clearDraftFields: ['sectionRecords["S1"].shape', 'sectionRecords["S1"].properties'],
    engineeringDraft: { sectionRecords: [{ id: 'S1', type: 'circular', shape: { kind: 'circular', d: 120 } }] } });
  expect(after.engineeringDraft.sectionRecords[0]).toEqual({ id: 'S1', name: 'custom', type: 'circular', purpose: 'beam', shape: { kind: 'circular', d: 120 } });
  expect(update(before, { engineeringDraft: { sectionRecords: [{ id: 'S1', properties: { J: 5e-6 } }] } }).engineeringDraft.sectionRecords[0].properties).toEqual({ A: .008192, J: 5e-6 });
});

test('record updates preserve unrelated nodes, members, loads and design parameters by stable ID', () => {
  const before = { topology: { nodes: [{ id: 'N1', x: 0, z: 0 }, { id: 'N2', x: 10, z: 0 }],
    members: [{ id: 'E1', nodes: ['N1', 'N2'], type: 'beam', material: 'M', section: 'S' }] },
    materials: [{ id: 'M', design: { f: 215, fv: 125 } }],
    loadCases: [{ id: 'D', loads: [{ id: 'L1', node: 'N1', fz: -1 }, { id: 'L2', node: 'N2', fz: -2 }] }, { id: 'W', loads: [] }] };
  const after = mergeEngineeringDraft(before, { topology: { nodes: [{ id: 'N2', z: 1 }], members: [{ id: 'E1', design: { l0: 10000 } }] },
    materials: [{ id: 'M', design: { f: 205 } }], loadCases: [{ id: 'D', loads: [{ id: 'L2', fz: -3 }] }] });
  expect(after.topology.nodes).toEqual([before.topology.nodes[0], { ...before.topology.nodes[1], z: 1 }]);
  expect(after.topology.members[0]).toEqual({ ...before.topology.members[0], design: { l0: 10000 } });
  expect(after.materials[0].design).toEqual({ f: 205, fv: 125 });
  expect(after.loadCases).toEqual([{ id: 'D', loads: [before.loadCases[0].loads[0], { id: 'L2', node: 'N2', fz: -3 }] }, before.loadCases[1]]);
  expect(before.loadCases[0].loads[1].fz).toBe(-2);
});

test('explicit deletion works for material design fields, load IDs, and controls without deleting other values', () => {
  const state = { inferredType: 'beam', engineeringDraft: { materials: [{ id: 'M.a', E: 206000, design: { f: 215, fv: 125 } }],
    loadCases: [{ id: 'D', loads: [{ id: 'L1', fz: -1 }, { id: 'L2', fz: -2 }] }], analysisControl: { self_weight: true, mass_source: 'nodal' } } };
  const after = mergeDraftState(state, { clearDraftFields: ['materials["M.a"].design.f', 'loadCases["D"].loads["L1"]', 'analysisControl.mass_source'] });
  expect(after.engineeringDraft.materials[0]).toEqual({ id: 'M.a', E: 206000, design: { fv: 125 } });
  expect(after.engineeringDraft.loadCases[0].loads).toEqual([{ id: 'L2', fz: -2 }]);
  expect(after.engineeringDraft.analysisControl).toEqual({ self_weight: true });
});

test.each(['beam', 'column', 'truss', 'portal-frame', 'double-span-beam', 'frame', 'concrete-frame', 'generic'])('%s normalizes partial records against the accepted state before merging', async id => {
  const { AgentSkillRuntime } = await import('../../../dist/agent-runtime/index.js');
  const plugin = await new AgentSkillRuntime().resolvePluginForType(id);
  const before = structuredClone(original);
  before.engineeringDraft.loads[0].location = { xM: 5 };
  before.engineeringDraft.topology = {
    nodes: [{ id: 'N1', x: 0, y: 0, z: 0 }, { id: 'N2', x: 10, y: 0, z: 0 }],
    members: [{ id: 'E1', nodes: ['N1', 'N2'], type: 'beam', material: 'M', section: 'S1', design: { beta1: 1.1 } }],
  };
  before.engineeringDraft.analysis = { loadCombinations: [{ id: 'C1', factors: { D: 1.2, L: 1.4 } }, { id: 'C2', factors: { D: 1 } }] };
  const snapshot = structuredClone(before);
  const patch = plugin.handler.extractDraft({ locale: 'zh', currentState: before, llmDraftPatch: { engineeringDraft: {
    topology: { nodes: [{ id: 'N2', z: 1 }], members: [{ id: 'E1', design: { l0: 5000 } }] },
    loads: [{ id: 'L1', location: { xM: 4 } }],
    analysis: { loadCombinations: [{ id: 'C1', factors: { L: 1.5 } }] },
  } } });
  const after = plugin.handler.mergeState(before, patch);
  expect(after.engineeringDraft.topology.nodes).toEqual([snapshot.engineeringDraft.topology.nodes[0], { ...snapshot.engineeringDraft.topology.nodes[1], z: 1 }]);
  expect(after.engineeringDraft.topology.members[0]).toEqual({ ...snapshot.engineeringDraft.topology.members[0], design: { beta1: 1.1, l0: 5000 } });
  expect(after.engineeringDraft.loads[0]).toMatchObject({ id: 'L1', magnitude: 1, unit: 'kN', kind: 'point', location: { xM: 4 } });
  expect(after.engineeringDraft.analysis.loadCombinations).toEqual([{ id: 'C1', factors: { D: 1.2, L: 1.5 } }, snapshot.engineeringDraft.analysis.loadCombinations[1]]);
  expect(after.skillState.invalidDraftFields ?? []).toEqual([]);
  expect(after.skillState.engineeringDraft).toEqual(after.engineeringDraft);
  expect(before).toEqual(snapshot);
});

test('partial validation cannot bring back a withdrawn field or invent a missing record', () => {
  const before = structuredClone(original);
  const after = update(before, { clearDraftFields: ['loads["L1"].location.nodeRole'], engineeringDraft: { loads: [{ id: 'L1', location: { xM: 4 } }] } });
  expect(after.engineeringDraft.loads[0].location).toEqual({ xM: 4 });
  expect(after.engineeringDraft.loads[0].magnitude).toBe(1);
  expect(() => update(before, { engineeringDraft: { loads: [{ id: 'missing', location: { xM: 4 } }] } })).toThrow('INVALID_ENGINEERING_LOAD');
  expect(() => update(before, { engineeringDraft: { topology: { nodes: [{ id: 'missing', z: 1 }] } } })).toThrow('INVALID_EXPLICIT_TOPOLOGY');
  expect(before).toEqual(original);
});

test.each(['sectionRecords[0].shape', 'sectionRecords[*].shape', 'sectionRecords["missing"].shape',
  'sectionRecords["S1"].id', 'sectionRecords["S1"].typo', 'metadata', 'inputEvidence', '__proto__.polluted'])('invalid removal %s is atomic', field => {
  const snapshot = structuredClone(original);
  expect(() => update(original, { clearDraftFields: ['sectionRecords["S1"].standard_steel_name', field] })).toThrow('DRAFT_CLEAR_INVALID');
  expect(original).toEqual(snapshot);
});

test('duplicate stable IDs are rejected in both updates and removal', () => {
  const before = { ...original, engineeringDraft: { sectionRecords: [source.sectionRecords[0], source.sectionRecords[0]] } };
  expect(() => update(before, { clearDraftFields: ['sectionRecords["S1"].standard_steel_name'] })).toThrow('ambiguous');
  expect(() => mergeEngineeringDraft({ materials: [] }, { materials: [{ id: 'M', E: 1 }, { id: 'M', E: 2 }] })).toThrow('DUPLICATE_DRAFT_RECORD_ID');
});

test('legacy scalar geometry cannot resurrect a cleared canonical field', () => {
  const after = update(original, { clearDraftFields: ['geometry.lengthM'] });
  expect(after.lengthM).toBeUndefined();
  expect(after.engineeringDraft.geometry.lengthM).toBeUndefined();
  expect(mergeEngineeringDraft(source, { loads: [] }).loads).toEqual([]);
});

test('explicit withdrawal resolves only that field diagnostic; other conflicts and original evidence remain', () => {
  const state = structuredClone(original);
  state.draftIssues = [{ field: 'sectionRecords[0].standard_steel_name', severity: 'conflict', reason: 'Catalog was superseded' },
    { field: 'loads[0].direction', severity: 'conflict', reason: 'Unresolved drawing conflict' }];
  state.skillState.invalidDraftFields = state.draftIssues.map(issue => issue.field);
  state.engineeringDraft.inputEvidence = [{ id: 'drawing', source: 'original drawing' }];
  const after = update(state, { clearDraftFields: ['sectionRecords["S1"].standard_steel_name'] });
  expect(after.draftIssues).toEqual([state.draftIssues[1]]);
  expect(after.skillState.invalidDraftFields).toEqual(['loads[0].direction']);
  expect(after.engineeringDraft.inputEvidence).toEqual(state.engineeringDraft.inputEvidence);
  expect(state.draftIssues).toHaveLength(2);
});

test('every extraction wrapper preserves removal instructions and both locales explain their semantics', () => {
  const clearDraftFields = ['sectionRecords["S1"].standard_steel_name'];
  const parsed = parseDraftPatchFromContent(JSON.stringify({ draftPatch: {}, clearDraftFields }));
  expect(normalizeLegacyDraftPatch(parsed).clearDraftFields).toEqual(clearDraftFields);
  expect(() => normalizeLegacyDraftPatch({ clearDraftFields: 'S1' })).toThrow('DRAFT_CLEAR_INVALID');
  const plugin = { id: 'beam', name: { zh: '梁', en: 'Beam' }, description: {}, stages: ['draft'], structureType: 'beam', markdownByStage: {} };
  for (const locale of ['zh', 'en']) {
    const prompt = buildParamExtractorPrompt(locale, original, plugin, 'Use explicit geometry, no catalog name');
    expect(prompt).toContain('clearDraftFields');
    expect(prompt).toContain('omission DOES NOT delete');
    expect(prompt).toContain('standard_steel_name');
  }
});

test('material-group absence uses the same declared-grade projection as the template builder', () => {
  const missing = { field: 'materials', kind: 'missing', severity: 'invalid', reason: 'No material supplied', target: 'materials' };
  const before = { inferredType: 'beam', engineeringDraft: {}, draftIssues: [missing], skillState: { invalidDraftFields: ['materials'] } };
  for (const grade of ['Q235', 'Q355B', 'C30']) {
    const after = update(before, { engineeringDraft: { material: { grade } } });
    expect(after.draftIssues ?? []).toEqual([]);
    expect(after.skillState?.invalidDraftFields ?? []).toEqual([]);
    // Diagnostic resolution does not write a second set of model attributes.
    expect(after.engineeringDraft.materials).toBeUndefined();
  }
  const unknown = update(before, { engineeringDraft: { material: { grade: 'Unknown' } } });
  expect(unknown.draftIssues).toEqual([missing]);
  const incomplete = update(before, { engineeringDraft: { material: { grade: 'Q235' }, materials: [{ id: 'custom', E: -1 }] } });
  expect(incomplete.draftIssues).toEqual([missing]);
  for (const issue of [{ ...missing, kind: 'confirmation' }, { ...missing, severity: 'conflict' },
    { ...missing, field: 'materials["M2"].E', target: 'materials["M2"].E' }]) {
    const after = update({ ...before, draftIssues: [issue], skillState: { invalidDraftFields: [issue.field] } }, { engineeringDraft: { material: { grade: 'Q235' } } });
    expect(after.draftIssues).toEqual([issue]);
  }
  expect(before.draftIssues).toEqual([missing]);
});

test.each(['beam', 'column', 'truss', 'portal-frame', 'double-span-beam', 'frame', 'concrete-frame', 'generic'])('%s preserves the common deletion contract through its handler', async id => {
  const { AgentSkillRuntime } = await import('../../../dist/agent-runtime/index.js');
  const plugin = await new AgentSkillRuntime().resolvePluginForType(id);
  expect(plugin).toBeTruthy();
  const raw = { clearDraftFields: ['sectionRecords["S1"].standard_steel_name'] };
  const patch = plugin.handler.extractDraft({ locale: 'zh', currentState: original, llmDraftPatch: raw });
  expect(patch.clearDraftFields).toEqual(raw.clearDraftFields);
  const after = plugin.handler.mergeState(original, patch);
  expect(after.engineeringDraft.sectionRecords[0]).not.toHaveProperty('standard_steel_name');
  expect(original.engineeringDraft.sectionRecords[0].standard_steel_name).toBe('HN400x200x8x13');
});
