// Confirmed design inputs cross extraction, clarification, model construction,
// real V2 normalization and the real OpenSees/code-check workers. Provider stubs
// below exercise only deterministic candidate projection, not LLM acceptance.
import { describe, expect, test } from '@jest/globals';
import { normalizeEngineeringDraft, mergeEngineeringDraft, applyDraftTemplateDesign, projectDraftMaterialDesign } from '../dist/agent-runtime/engineering-draft.js';
import { buildModel } from '../dist/agent-runtime/model-builder.js';
import { buildFrameModel } from '../dist/agent-skills/structure-type/frame/model.js';
import { buildExplicitDraftModel } from '../dist/agent-runtime/explicit-model.js';
import { tryBuildGenericModelWithLlm } from '../dist/agent-skills/structure-type/generic/llm-model-builder.js';
import { invokeParamExtractor } from '../dist/agent-langgraph/param-extractor.js';
import { normalizeEngineeringModel } from '../dist/engineering/model-boundary.js';
import { createLocalStructureProtocolClient } from '../dist/services/structure-protocol-execution.js';
import { AnalysisRuntimeRunner } from '../dist/agent-skills/analysis/runtime-runner.js';
import { executeAnalysisRun } from '../dist/engineering/analysis-runs.js';
import { buildCodeCheckInput } from '../dist/agent-skills/code-check/entry.js';
import { executeGB50017CodeCheckDomain } from '../dist/agent-skills/code-check/gb50017/entry.js';
import { createLocalCodeCheckClient } from '../dist/services/code-check-execution.js';

const memberDesign = { l0: 4800, beta1: 1.1, phi_b: .9, btLimit: 13, lambdaLimit: 250,
  deflectionLimitN: 250, serviceability_result_keys: ['case:LC1'],
  basis: { l0: 'Explicit synthetic test length in mm, independent of mesh length', phi_b: 'Explicit synthetic test coefficient' } };
function confirmedDraft() {
  return normalizeEngineeringDraft({ structureType: 'beam', geometry: { lengthM: 10 },
    materials: [{ id: 'MAT', name: 'User steel', E: 206000, nu: .3, rho: 7850, design: { f: 215, fv: 125, basis: { f: 'Explicit synthetic input in MPa' } } }],
    sections: { beam: 'I20a' }, sectionRecords: [{ id: 'SEC', name: 'GB/T 706 热轧工字钢 I20a', type: 'custom',
      // Explicit test properties (designations are labels; no catalog completes them).
      properties: { A: .003555, Iy: .0000237, Iz: .00000158, Wx: .000237, Wz: .0000315, tw: .007, imin: .0212,
        S: .000104, Wnx: .000237, b: .0465, t: .0114 } }],
    templateAssignments: { beam: { materialId: 'MAT', sectionId: 'SEC', design: structuredClone(memberDesign) } },
    boundary: { supportType: 'simply-supported' }, analysisControl: { self_weight: false },
    analysis: { loadCombinations: [] },
  });
}
const state = (draft = confirmedDraft()) => ({ inferredType: 'beam', frameDimension: '2d', lengthM: 10,
  supportType: 'simply-supported', loadKN: 1, loadType: 'point', loadPosition: 'midspan', loadPositionM: 5,
  updatedAt: 0, engineeringDraft: draft });
const normalize = model => normalizeEngineeringModel(model, createLocalStructureProtocolClient());

describe('canonical declared design inputs survive the draft/model boundary', () => {
  test('partial role updates preserve effective length, section identity, arrays and nested basis', () => {
    const first = confirmedDraft(), before = structuredClone(first);
    const patched = mergeEngineeringDraft(first, normalizeEngineeringDraft({ templateAssignments: {
      beam: { design: { phi_b: .85, basis: { phi_b: 'Explicit revised test coefficient' } } },
    } }));
    expect(patched.templateAssignments.beam).toEqual({ materialId: 'MAT', sectionId: 'SEC', design: {
      ...memberDesign, phi_b: .85, basis: { ...memberDesign.basis, phi_b: 'Explicit revised test coefficient' },
    } });
    expect(first).toEqual(before);
    patched.templateAssignments.beam.design.serviceability_result_keys.push('case:OTHER');
    expect(first.templateAssignments.beam.design.serviceability_result_keys).toEqual(['case:LC1']);
  });

  test.each([null, [], 4800, 'l0=4800'])('invalid design containers %j are not silently dropped', design => {
    expect(() => normalizeEngineeringDraft({ templateAssignments: { beam: { design } } })).toThrow('INVALID_TEMPLATE_ASSIGNMENTS');
  });

  test('design-only role assignments retain uniform material/section choices without leaking beam-specific limits to columns', () => {
    const source = confirmedDraft();
    source.templateAssignments = { member: { materialId: 'MAT', sectionId: 'SEC', design: { lambdaLimit: 200, basis: { lambdaLimit: 'Uniform test limit' } } },
      beam: { design: { l0: 4800, lambdaLimit: 250 } }, column: { design: { l0: 3000 } } };
    const model = buildFrameModel({ ...state(source), inferredType: 'frame', storyCount: 1, bayCount: 1,
      storyHeightsM: [3], bayWidthsM: [10], floorLoads: [{ story: 1, verticalKN: 1 }] });
    expect(model.elements.every(element => element.material === 'MAT' && element.section === 'SEC')).toBe(true);
    expect(model.elements.filter(element => element.type === 'beam').every(element => element.design.l0 === 4800 && element.design.lambdaLimit === 250)).toBe(true);
    expect(model.elements.filter(element => element.type === 'column').every(element => element.design.l0 === 3000 && element.design.lambdaLimit === 200)).toBe(true);
  });

  test('unmapped free-form designParameters are preserved for clarification and never become checker inputs', () => {
    const raw = { l0mm: 4800, appliesTo: 'uncertain', gammaX: 1, beta1: 1.1 };
    const draft = normalizeEngineeringDraft({ ...confirmedDraft(), templateAssignments: { beam: { materialId: 'MAT', sectionId: 'SEC' } }, designParameters: raw });
    const later = mergeEngineeringDraft(draft, normalizeEngineeringDraft({ materials: [{ id: 'MAT', rho: 7800 }] }));
    expect(later.metadata.unmappedDesignParameters).toEqual({ status: 'requires-confirmation', sourcePath: 'engineeringDraft.designParameters', values: raw });
    expect(later.designParameters).toBeUndefined();
    expect(buildModel(state(later)).elements.every(element => element.design === undefined)).toBe(true);
    expect(later.metadata.unmappedDesignParameters.values).not.toBe(raw);
  });

  test('role design cannot be silently discarded or applied to a different structural role', () => {
    expect(() => applyDraftTemplateDesign({ elements: [{ id: 'C', type: 'column' }] }, confirmedDraft())).toThrow('TEMPLATE_DESIGN_TARGET_UNRESOLVED: beam');
  });

  test('template and true V2 normalization retain all supplied inputs, including historical material f/fv migration', async () => {
    const input = state(), before = structuredClone(input);
    const built = buildModel(input), model = await normalize(built);
    expect(model.elements).toHaveLength(2);
    for (const element of model.elements) expect(element.design).toEqual(memberDesign);
    expect(model.materials[0].design).toEqual(input.engineeringDraft.materials[0].design);
    expect(model.sections[0].extra?.catalogSource).toBeUndefined();
    expect(model.sections[0].properties.Iy).toBe(.0000237);
    const legacy = structuredClone(built);
    delete legacy.materials[0].design;
    Object.assign(legacy.materials[0], { f: 215, fv: 125 });
    const migrated = await normalize(legacy);
    expect(migrated.materials[0].design).toMatchObject({ f: 215, fv: 125 });
    expect(migrated.materials[0].f).toBeUndefined();
    expect(input).toEqual(before);
  }, 30000);

  test('unsupported canonical design fields remain a real validator error rather than a silently ignored coefficient', async () => {
    const input = state();
    input.engineeringDraft.templateAssignments.beam.design.gammaX = 1;
    await expect(normalize(buildModel(input))).rejects.toThrow(/gammaX|validation/i);
  }, 30000);

  test('explicit stable-member design records remain per-member inputs', async () => {
    const source = buildModel(state());
    source.elements[1].design.l0 = 4200;
    const explicit = buildExplicitDraftModel({ frameDimension: '2d', engineeringDraft: normalizeEngineeringDraft({
      topology: { nodes: source.nodes, members: source.elements }, materials: source.materials,
      sectionRecords: source.sections, loadCases: source.load_cases, analysis: { loadCombinations: [] }, analysisControl: { self_weight: false },
    }) });
    const model = await normalize(explicit);
    expect(model.elements.map(element => element.design.l0)).toEqual([4800, 4200]);
  }, 30000);

  test('a new generic candidate receives confirmed role and material design without editing an existing model', async () => {
    const input = state(), candidate = buildModel(input);
    candidate.elements.forEach(element => { element.design = { l0: 5000, basis: { l0: 'Generated candidate mesh-derived value' } }; });
    delete candidate.materials[0].design;
    const provider = { invoke: async () => ({ content: JSON.stringify(candidate) }) };
    const generated = await tryBuildGenericModelWithLlm(provider, 'Build from the confirmed draft', input, 'en');
    expect(generated.elements.every(element => element.design.l0 === 4800)).toBe(true);
    expect(generated.materials[0].design).toEqual(input.engineeringDraft.materials[0].design);
    expect(generated.elements[0].design.basis.l0).toBe(memberDesign.basis.l0);
    // An existing-model edit has its own revision/source contract; stale draft values cannot override it.
    const edited = await tryBuildGenericModelWithLlm(provider, 'Keep current values', input, 'en', undefined, undefined, candidate);
    expect(edited.elements.every(element => element.design.l0 === 5000)).toBe(true);
    expect(candidate.elements.every(element => element.design.l0 === 5000)).toBe(true);
  });

  test('material design uses stable IDs or an unambiguous single record, never positional guessing', () => {
    const draft = confirmedDraft();
    const renamed = projectDraftMaterialDesign({ materials: [{ id: 'GENERATED' }] }, draft);
    expect(renamed.materials[0]).toMatchObject({ id: 'GENERATED', design: { f: 215, fv: 125 } });
    expect(() => projectDraftMaterialDesign({ materials: [{ id: 'OTHER1' }, { id: 'OTHER2' }] }, draft)).toThrow('DRAFT_MATERIAL_DESIGN_TARGET_UNRESOLVED');
    const multiple = { materials: [{ id: 'MAT', design: { f: 215 } }, { id: 'UNASSIGNED', design: { f: 310 } }] };
    expect(() => projectDraftMaterialDesign({ materials: [{ id: 'MAT' }] }, multiple)).toThrow('DRAFT_MATERIAL_DESIGN_TARGET_UNRESOLVED: UNASSIGNED');
  });

  test.each(['zh', 'en'])('actual extractor entry advertises canonical design units and applicability (%s)', async locale => {
    let prompt;
    const expected = { engineeringDraft: { materials: confirmedDraft().materials, templateAssignments: confirmedDraft().templateAssignments } };
    const result = await invokeParamExtractor({ locale, message: 'Explicit per-beam l0=4800mm; f=215MPa, fv=125MPa', requireLlmResult: true,
      plugin: { id: 'beam', name: { zh: '梁', en: 'Beam' }, description: { zh: '梁', en: 'Beam' }, stages: ['draft'], structureType: 'beam', markdownByStage: {} },
      llm: { invoke: async value => { prompt = String(value); return { content: JSON.stringify(expected) }; } } });
    expect(prompt).toContain('materials[].design.f/fv');
    expect(prompt).toContain('templateAssignments.beam/column/member.design');
    expect(prompt).toContain('serviceability_result_keys');
    expect(prompt).toContain('mm');
    expect(prompt).toContain('metadata.unmappedDesignParameters');
    expect(normalizeEngineeringDraft(result.engineeringDraft).templateAssignments.beam.design).toEqual(memberDesign);
  });

  test('real worker chain uses 4800mm effective length rather than either 5m analysis cell', async () => {
    const model = await normalize(buildModel(state()));
    const runner = new AnalysisRuntimeRunner();
    const run = await executeAnalysisRun({ model, type: 'static', engineId: 'builtin-opensees', parameters: {} },
      input => runner.invoke({ action: 'analyze', input }), async () => {});
    expect(Object.keys(run.results)).toEqual(['case:LC1']);
    const result = run.results['case:LC1'];
    expect(result.success).toBe(true);
    expect(result.data.execution).toMatchObject({ executed: true, solver: 'OpenSees', analysisReturnCode: 0 });
    expect(result.data.envelope.maxAbsMoment).toBeCloseTo(2.5, 10);
    expect(result.data.envelope.maxAbsDisplacement).toBeCloseTo(1 * 10 ** 3 / (48 * 206e6 * .0000237), 10);
    const input = buildCodeCheckInput({ traceId: 'draft-design-projection', designCode: 'GB50017', model, analysis: result, analysisParameters: {} });
    const checked = await executeGB50017CodeCheckDomain(createLocalCodeCheckClient(), input);
    expect(checked.completionStatus).toBe('complete');
    expect(checked.complianceStatus).toBe('pass');
    expect(checked.summary.inputRequired).toBe(0);
    const items = checked.details.flatMap(detail => detail.checks.flatMap(group => group.items));
    const slenderness = items.filter(item => item.item === '长细比');
    expect(slenderness).toHaveLength(2);
    for (const item of slenderness) expect(item.inputs.demand).toBeCloseTo(4800 / 21.2, 10);
    expect(model.elements.every(element => element.design.requested_checks === undefined)).toBe(true);
  }, 60000);
});
