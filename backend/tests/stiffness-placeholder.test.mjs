// Force-only requests without material/section: labelled unit stiffness, determinacy, no displacement output,
// report only when requested, and code-determined design values shown with their sources.
import { describe, expect, test, beforeAll } from '@jest/globals';

let placeholder, templateProperties, readiness, requestScope, codeChecks, modelBuilder;
beforeAll(async () => {
  placeholder = await import('../dist/engineering/stiffness-placeholder.js');
  templateProperties = await import('../dist/agent-runtime/template-properties.js');
  readiness = await import('../dist/agent-runtime/draft-readiness.js');
  requestScope = await import('../dist/engineering/request-scope.js');
  codeChecks = await import('../dist/engineering/code-checks.js');
  modelBuilder = await import('../dist/agent-runtime/model-builder.js');
});

const FORCES = { responses: ['forces', 'reactions'], method: 'solver', design: false, outputs: [] };
const beamPlugin = { id: 'beam', handler: { computeMissing: () => ({ critical: [], optional: [] }) } };
const beam = (draft = {}, scope = FORCES) => ({ inferredType: 'beam', lengthM: 10, loadKN: 1, loadType: 'point', loadPosition: 'midspan',
  supportType: 'simply-supported', requestScope: scope, engineeringDraft: { structureType: 'beam', geometry: { lengthM: 10 },
    boundary: { supportType: 'simply-supported' }, loads: [{ kind: 'point', magnitude: 1, unit: 'kN', direction: 'gravity', location: { xM: 5 } }], ...draft } });

describe('placeholder stiffness for force-only requests', () => {
  test('a determinate beam builds with labelled unit stiffness and no equal-EI assumption', () => {
    const model = modelBuilder.buildModel(beam());
    expect(model.metadata.stiffnessPlaceholder).toMatchObject({ material: true, section: true, staticIndeterminacy: 0, equalStiffnessAssumed: false });
    expect(model.materials).toEqual([expect.objectContaining({ id: '1', E: 1, extra: { stiffnessPlaceholder: true } })]);
    expect(model.materials[0].name).toBe('unit stiffness for force analysis only / 仅用于内力计算的单位刚度');
    expect(model.materials[0]).not.toHaveProperty('rho');
    expect(model.analysis_control).toMatchObject({ self_weight: false });
    expect(model.sections).toEqual([expect.objectContaining({ id: '1', properties: { A: 1e4, Iy: 1, Iz: 1, J: 1 } })]);
    expect(readiness.computeDraftMissing(beamPlugin, beam(), 'execution').critical).toEqual([]);
  });

  test('indeterminate structures record the degree and the equal-EI assumption', () => {
    const continuous = { inferredType: 'double-span-beam', spanLengthM: 6, loadKN: 10, loadType: 'distributed', loadPosition: 'full-span',
      requestScope: FORCES, engineeringDraft: { structureType: 'double-span-beam', geometry: { spanLengthsM: [6, 6] } } };
    expect(modelBuilder.buildModel(continuous).metadata.stiffnessPlaceholder).toMatchObject({ staticIndeterminacy: 1, equalStiffnessAssumed: true });
    const portal = { inferredType: 'portal-frame', spanLengthM: 12, heightM: 6, loadKN: 5, loadType: 'distributed', loadPosition: 'full-span',
      requestScope: FORCES, engineeringDraft: { structureType: 'portal-frame', geometry: { spanLengthsM: [12], heightM: 6 } } };
    const model = modelBuilder.buildModel(portal);
    expect(model.metadata.stiffnessPlaceholder).toMatchObject({ staticIndeterminacy: 3, equalStiffnessAssumed: true });
    expect(new Set(model.elements.map(element => element.section))).toEqual(new Set(['1']));
    expect(model.metadata.stiffnessPlaceholder.notice.zh).toContain('EI 相同');
    expect(model.metadata.stiffnessPlaceholder.notice.en).toContain('same EI');
  });

  test('a declared material keeps its stiffness; only the missing sections are unit placeholders', () => {
    const model = modelBuilder.buildModel(beam({ material: { family: 'steel', grade: 'Q355' } }));
    expect(model.materials[0]).toMatchObject({ grade: 'Q355', E: 206000 });
    expect(model.metadata.stiffnessPlaceholder).toMatchObject({ material: false, section: true });
  });

  test('declared sections without a material use a unit material: forces depend only on section ratios', () => {
    const model = modelBuilder.buildModel(beam({ sections: { beam: 'H300X150X6.5X9' } }));
    expect(model.metadata.stiffnessPlaceholder).toMatchObject({ material: true, section: false, equalStiffnessAssumed: false });
    expect(model.sections[0].shape).toEqual({ kind: 'H', H: 300, B: 150, tw: 6.5, tf: 9 });
  });

  test('sections given for some roles but not others are asked for', () => {
    const portal = { inferredType: 'portal-frame', spanLengthM: 12, heightM: 6, loadKN: 5, loadType: 'distributed', loadPosition: 'full-span',
      requestScope: FORCES, engineeringDraft: { structureType: 'portal-frame', geometry: { spanLengthsM: [12], heightM: 6 }, sections: { column: 'H300X300X10X15' } } };
    expect(templateProperties.templatePropertyIssues(portal).join(' ')).toContain('beam section');
  });

  test.each([
    ['displacement requested', beam({}, { ...FORCES, responses: ['forces', 'displacements'] })],
    ['explicit code check', beam({}, { ...FORCES, design: true })],
    ['self-weight requested', beam({ analysisControl: { self_weight: true } })],
    ['commercial engine', beam({ analysis: { engineTarget: 'pkpm' } })],
    ['no request scope', { ...beam(), requestScope: undefined }],
  ])('no placeholder: %s', (_name, state) => {
    expect(templateProperties.stiffnessPlaceholderUses(state)).toEqual({ material: false, section: false });
    expect(readiness.computeDraftMissing(beamPlugin, state, 'execution').critical).toContain('templateProperties');
  });

  test('a missing-material diagnostic does not block a force-only request', () => {
    const state = beam();
    state.draftIssues = [{ field: 'material', kind: 'missing', severity: 'invalid', reason: 'not given' }];
    expect(readiness.computeDraftMissing(beamPlugin, state, 'execution').critical).toEqual([]);
    state.requestScope = { ...FORCES, responses: ['displacements'] };
    expect(readiness.computeDraftMissing(beamPlugin, state, 'execution').critical).toContain('templateProperties');
  });
});

describe('static indeterminacy', () => {
  const node = (id, x, z, restraints) => ({ id, x, y: 0, z, ...(restraints ? { restraints } : {}) });
  const fixed = [true, true, true, true, true, true], pinned = [true, true, true, false, false, false], roller = [false, true, true, false, false, false];
  test('2-D frames and trusses', () => {
    const cantilever = { nodes: [node('A', 0, 0, fixed), node('B', 5, 0)], elements: [{ id: 'e', type: 'beam', nodes: ['A', 'B'] }] };
    expect(placeholder.staticIndeterminacy(cantilever)).toBe(0);
    const proppedCantilever = { ...cantilever, nodes: [node('A', 0, 0, fixed), node('B', 5, 0, roller)] };
    expect(placeholder.staticIndeterminacy(proppedCantilever)).toBe(1);
    const truss = { nodes: [node('A', 0, 0, pinned), node('B', 4, 0, roller), node('C', 2, 2)],
      elements: [['A', 'B'], ['B', 'C'], ['A', 'C']].map((nodes, index) => ({ id: `t${index}`, type: 'truss', nodes })) };
    expect(placeholder.staticIndeterminacy(truss)).toBe(0);
    const released = { ...proppedCantilever, elements: [{ id: 'e', type: 'beam', nodes: ['A', 'B'], releases: { end: 'pin' } }] };
    expect(placeholder.staticIndeterminacy(released)).toBeNull();
  });
});

describe('placeholder results are never presented with displacements', () => {
  test('displacement fields, envelopes and member components are removed from the presentation copy only', () => {
    const run = { runId: 'r', modelSnapshot: { metadata: { stiffnessPlaceholder: { material: true, section: true } } },
      data: { displacements: { 2: { uz: -0.02 } }, reactions: { 1: { fz: 0.5 } }, envelope: { maxAbsDisplacement: 0.02, maxAbsMoment: 2.5 },
        memberResponses: [{ id: '1', samples: [{ x: 5, M2: -2.5, uz: -0.02 }] }],
        memberResponseExtrema: { values: { M2: { value: -2.5 }, uz: { value: -0.02 } } } },
      results: { 'case:LC1': { data: { displacements: { 2: { uz: -0.02 } }, reactions: {} } } } };
    const visible = placeholder.withoutPlaceholderDisplacements(run);
    expect(visible.data.displacements).toBeUndefined();
    expect(visible.data.envelope).toEqual({ maxAbsMoment: 2.5 });
    expect(visible.data.memberResponses[0].samples[0]).toEqual({ x: 5, M2: -2.5 });
    expect(Object.keys(visible.data.memberResponseExtrema.values)).toEqual(['M2']);
    expect(visible.data.responseDefinition.unavailable).toEqual(expect.arrayContaining(['displacements', 'rotations']));
    expect(visible.results['case:LC1'].data.displacements).toBeUndefined();
    expect(run.data.displacements).toEqual({ 2: { uz: -0.02 } });
    const ordinary = { runId: 'o', data: { displacements: { 2: { uz: -1 } } } };
    expect(placeholder.withoutPlaceholderDisplacements(ordinary)).toBe(ordinary);
    expect(placeholder.isDisplacementSelection('displacements', undefined)).toBe(true);
    expect(placeholder.isDisplacementSelection('forces', 'uz')).toBe(true);
    expect(placeholder.isDisplacementSelection('forces', 'M2')).toBe(false);
  });
});

describe('reports only when requested', () => {
  test.each([
    [{ ...FORCES }, false],
    [{ ...FORCES, report: true }, true],
    [{ ...FORCES, responses: ['forces', 'displacements'] }, true],
    [{ ...FORCES, responses: ['displacements'], report: false }, false],
    [undefined, true],
  ])('reportRequested(%j) = %s', (scope, expected) => {
    expect(requestScope.reportRequested(scope)).toBe(expected);
  });
});

describe('code-determined design values are shown with their sources', () => {
  test('values are grouped across elements and rendered bilingually', () => {
    const value = { field: 'material.design.f', value: 305, unit: 'MPa', origin: 'code-table', source: 'GB 50017-2017 表4.4.1, Q355, t=9mm≤16' };
    const check = { details: [{ elementId: '1', designValues: [value] }, { elementId: '2', designValues: [value] }] };
    const rows = codeChecks.checkDesignValues(check);
    expect(rows).toEqual([{ ...value, elementIds: ['1', '2'] }]);
    expect(codeChecks.designValueLines(rows, 'zh')).toEqual(['- 抗拉、抗压和抗弯强度设计值 f = 305 MPa（GB 50017-2017 表4.4.1, Q355, t=9mm≤16）']);
    expect(codeChecks.designValueLines(rows, 'en')).toEqual(['- design strength f = 305 MPa (GB 50017-2017 表4.4.1, Q355, t=9mm≤16)']);
    const feedback = codeChecks.codeCheckFeedback({ ...check, completionStatus: 'incomplete', complianceStatus: 'incomplete', summary: {} });
    expect(feedback.designValues).toEqual(rows);
  });
});
