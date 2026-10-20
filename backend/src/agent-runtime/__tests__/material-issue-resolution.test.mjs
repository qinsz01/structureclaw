import { describe, expect, test } from '@jest/globals';
import { handler } from '../../../dist/agent-skills/structure-type/beam/handler.js';
import { ingestDraft, mergeDraftState } from '../../../dist/agent-runtime/draft/boundary.js';
import { computeDraftMissing } from '../../../dist/agent-runtime/draft-readiness.js';
import { AgentSkillRuntime } from '../../../dist/agent-runtime/index.js';
import { createBuildModelTool } from '../../../dist/agent-langgraph/tools.js';

const issue = (field, severity = 'ambiguous') => ({ field, value: null, severity,
  reason: 'This input has not been confirmed.', question: `Please confirm ${field}.` });
const fields = state => (state.draftIssues ?? []).map(value => value.field);
const plugin = { id: 'beam', handler };

// Minimal engineering-only reproduction of the saved 31625 draft: the original
// material lacked E/nu and an explicit reply supplied them under the same ID.
const initial = () => handler.mergeState(undefined, ingestDraft({
  inferredType: 'beam', lengthM: 10, supportType: 'simply-supported', loadKN: 1,
  loadType: 'point', loadPosition: 'midspan', loadPositionM: 5,
  engineeringDraft: { structureType: 'beam', geometry: { lengthM: 10 },
    materials: [{ id: 'MAT-Q235B', name: 'unlisted coupon', f: 215, fv: 125 }],
    material: { family: 'steel', grade: 'Q235B' }, sections: { beam: 'I20a' },
    sectionRecords: [{ id: 'SEC-I20A', name: 'I20a (GB/T 706 热轧工字钢)', type: 'custom',
      properties: { A: .003555, Iy: .0000237, Iz: .00000158, S: .000104, Wnx: .000237, b: .0465, t: .0114 } }],
    templateAssignments: { beam: { materialId: 'MAT-Q235B', sectionId: 'SEC-I20A' } },
    boundary: { supportType: 'simply-supported', supportPositionsM: [0, 10] },
    loads: [{ kind: 'point', magnitude: 1, unit: 'kN', direction: 'gravity', target: 'beam',
      location: { xM: 5, spanIndex: 1, nodeRole: 'midspan' }, caseId: 'LC1', caseType: 'other' }],
    analysis: { loadCombinations: [] }, analysisControl: { self_weight: false } },
  draftIssues: [issue('materials[].E'), issue('designParameters.gammaX')],
}));
const clarification = () => ingestDraft({ engineeringDraft: {
  materials: [{ id: 'MAT-Q235B', E: 206000, G: 79230.77, nu: .3, rho: 7850 }],
}, skillState: { designParameters: { gammaX: 1, memberDesignL0Mm: 4800 } } });

describe('clarification retires only the material issues it resolves', () => {
  test.each(['materials[MAT-Q235B].E', 'materials["MAT-Q235B"].E', "materials['MAT-Q235B'].E",
    'engineeringDraft.materials[MAT-Q235B].E'])('a supplied stable-ID material clears %s and permits building', async field => {
    const before = initial();
    before.draftIssues = [issue(field)]; before.skillState.invalidDraftFields = [field];
    const after = handler.mergeState(before, clarification());
    expect(fields(after)).toEqual([]);
    expect(after.skillState.invalidDraftFields ?? []).toEqual([]);
    expect(computeDraftMissing(plugin, after, 'execution').critical).toEqual([]);
    expect((await new AgentSkillRuntime().buildModel(after, ['beam'])).materials[0].E).toBe(206000);
  });

  test('a bracket selector never clears another material or a new explicit conflict', () => {
    const before = { inferredType: 'beam', engineeringDraft: { materials: [{ id: 'A' }, { id: 'B' }] },
      draftIssues: [issue('materials[A].E'), issue('materials[B].E'), issue('materials[missing].E')] };
    const conflict = issue('materials[B].E', 'conflict');
    const after = mergeDraftState(before, { engineeringDraft: { materials: [{ id: 'B', E: 206000 }] }, draftIssues: [conflict] });
    expect(after.draftIssues).toEqual([before.draftIssues[0], before.draftIssues[2], conflict]);
  });

  test('unquoted numeric selectors retain array-index meaning when another record has that ID', () => {
    const before = { inferredType: 'beam', engineeringDraft: { materials: [{ id: 'A' }, { id: '0' }] },
      draftIssues: [issue('materials[0].E'), issue('materials["0"].E'), issue('materials[1].E')] };
    const after = mergeDraftState(before, { engineeringDraft: { materials: [{ id: '0', E: 206000 }] } });
    expect(fields(after)).toEqual(['materials[0].E']);
    expect(after.engineeringDraft.materials[0].E).toBeUndefined();
  });

  test('the actual beam reply clears the stale wildcard E issue and permits the original template', async () => {
    const before = initial(), saved = structuredClone(before);
    // The legacy grade now reaches the record and supplies omitted constants. The explicit
    // confirmation issue is still unresolved until the user supplies/accepts E.
    expect(computeDraftMissing(plugin, before, 'execution').critical).toEqual(['materials[].E']);
    expect(handler.buildModel(before)).toBeUndefined();
    const after = handler.mergeState(before, clarification());
    // Design diagnostics are not draft issues: the code check reports its own missing inputs.
    expect(fields(after)).toEqual([]);
    expect(after.skillState.invalidDraftFields).toBeUndefined();
    expect(computeDraftMissing(plugin, after, 'execution')).toEqual({ critical: [], optional: [] });
    expect(handler.computeMissing(after, 'execution')).toEqual({ critical: [], optional: [] });
    const model = await new AgentSkillRuntime().buildModel(after, ['beam'], { locale: 'zh' });
    expect(model.nodes.map(node => node.x)).toEqual([0, 5, 10]);
    expect(model.materials[0]).toMatchObject({ id: 'MAT-Q235B', E: 206000, nu: .3, rho: 7850, f: 215, fv: 125 });
    expect(model.sections[0].properties).toMatchObject({ A: .003555, Iy: .0000237, Iz: .00000158 });
    expect(model.elements).toHaveLength(2);
    expect(before).toEqual(saved);
  });

  test('material IDs and original indices identify issues independently of patch ordering', () => {
    const before = { inferredType: 'beam', engineeringDraft: { materials: [{ id: 'A' }, { id: 'B' }] },
      draftIssues: ['materials.A.E', 'materials[0].E', 'materials.B.E', 'materials[1].E', 'engineeringDraft.materials.B.E', 'materials[].E'].map(field => issue(field)) };
    const after = mergeDraftState(before, { engineeringDraft: { materials: [{ id: 'B', E: 206000 }] } });
    expect(fields(after)).toEqual(['materials.A.E', 'materials[0].E', 'materials[].E']);
    expect(after.engineeringDraft.materials).toEqual([{ id: 'A' }, { id: 'B', E: 206000 }]);
    const complete = mergeDraftState(after, { engineeringDraft: { materials: [{ id: 'A', E: 30000 }] } });
    expect(fields(complete)).toEqual([]);
  });

  test.each([undefined, 0, -1, NaN, Infinity])('a wildcard remains unresolved when another material has E=%s', value => {
    const before = { inferredType: 'beam', engineeringDraft: { materials: [{ id: 'A', E: value }, { id: 'B' }] },
      draftIssues: [issue('materials[].E'), issue('engineeringDraft.materials[*].E')] };
    expect(fields(mergeDraftState(before, { engineeringDraft: { materials: [{ id: 'B', E: 206000 }] } })))
      .toEqual(['materials[].E', 'engineeringDraft.materials[*].E']);
  });

  test('existing values without a confirming patch do not silently erase diagnostics', () => {
    const before = initial();
    before.engineeringDraft.materials[0].E = 206000;
    const after = handler.mergeState(before, ingestDraft({ engineeringDraft: { materials: [{ id: 'MAT-Q235B', nu: .3 }] } }));
    expect(fields(after)).toContain('materials[].E');
    expect(computeDraftMissing(plugin, after, 'execution').critical).toContain('materials[].E');
  });

  test('a new explicit conflict survives a valid numeric patch and still blocks building', async () => {
    const conflict = issue('materials[].E', 'conflict');
    const patch = clarification();
    patch.draftIssues = [conflict]; patch.skillState.invalidDraftFields = ['materials[].E'];
    const after = handler.mergeState(initial(), patch);
    expect(after.draftIssues).toContainEqual(conflict);
    expect(after.skillState.invalidDraftFields).toContain('materials[].E');
    expect(computeDraftMissing(plugin, after, 'execution').critical).toEqual(['materials[].E']);
    await expect(new AgentSkillRuntime().buildModel(after, ['beam'])).rejects.toThrow('MODEL_DRAFT_INCOMPLETE: materials[].E');
  });

  test('invalid nu is retained while independent valid E is resolved', () => {
    const before = initial(); before.draftIssues.push(issue('materials[].nu', 'invalid'));
    const patch = clarification(); patch.engineeringDraft.materials[0].nu = .5;
    const after = handler.mergeState(before, patch);
    expect(fields(after)).not.toContain('materials[].E');
    expect(fields(after)).toContain('materials[].nu');
    expect(computeDraftMissing(plugin, after, 'execution').critical).toEqual(['materials.MAT-Q235B.nu']);
  });

  test.each(['loadKN', 'supportType', 'loads[0].direction', 'unrecognizedPhysicalInput'])('a material answer does not clear unrelated physical issue %s', field => {
    const before = initial(); before.draftIssues.push(issue(field));
    const after = handler.mergeState(before, clarification());
    expect(fields(after)).toContain(field);
    expect(computeDraftMissing(plugin, after, 'execution').critical).toContain(field);
  });

  test('build_model names the actual unresolved fields and asks for a new answer instead of repeating extraction', async () => {
    const invoke = createBuildModelTool(new AgentSkillRuntime()).invoke({}, {
      toolCall: { id: 'incomplete', name: 'build_model' }, configurable: {
        toolContext: { skillScope: ['beam'] }, agentState: { draftState: initial(), locale: 'zh', messages: [], lastUserMessage: '' },
      },
    });
    await expect(invoke).rejects.toThrow('MODEL_DRAFT_INCOMPLETE: materials[].E');
  });
});
