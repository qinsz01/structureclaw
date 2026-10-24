import { withDeclaredProperties } from '../../../tests/fixtures/declared-template-properties.mjs';
import { describe, expect, test } from '@jest/globals';
import process from 'node:process';
import {
  stampDraftSemantics,
  STRUCTURAL_COORDINATE_SEMANTICS,
} from '../../../dist/engineering/coordinate-semantics.js';
import { buildElementReferenceVectors } from '../../../dist/agent-runtime/reference-vectors.js';

describe('agent runtime helper utilities', () => {
  test('loads structural handlers from the active backend build', async () => {
    const { AgentSkillRuntime } = await import('../../../dist/agent-runtime/index.js');
    const runtime = new AgentSkillRuntime();
    const cases = [
      {
        skillId: 'beam',
        dimension: '2d',
        state: {
          inferredType: 'beam',
          skillId: 'beam',
          lengthM: 3,
          supportType: 'cantilever',
          loadKN: 10,
          loadType: 'point',
          loadPosition: 'midspan',
        },
      },
      {
        skillId: 'frame',
        dimension: '3d',
        state: {
          inferredType: 'frame',
          skillId: 'frame',
          frameDimension: '3d',
          storyCount: 1,
          bayCountX: 1,
          bayCountY: 1,
          storyHeightsM: [3],
          bayWidthsXM: [6],
          bayWidthsYM: [5],
          floorLoads: [{ story: 1, verticalKN: 10 }],
          frameBaseSupportType: 'fixed',
        },
      },
      {
        skillId: 'concrete-frame',
        dimension: '2d',
        state: {
          inferredType: 'concrete-frame',
          skillId: 'concrete-frame',
          frameDimension: '2d',
          storyCount: 2,
          bayCount: 1,
          storyHeightsM: [3, 3],
          bayWidthsM: [6],
          floorLoads: [
            { story: 1, verticalKN: 10 },
            { story: 2, verticalKN: 10 },
          ],
          frameBaseSupportType: 'fixed',
        },
      },
    ];

    for (const fixture of cases) {
      const model = await runtime.buildModel(fixture.skillId === 'concrete-frame'
        ? { ...fixture.state, frameConcreteGrade: 'C30', frameRebarGrade: 'HRB400', frameColumnSection: '500X500', frameBeamSection: '300X600' }
        : withDeclaredProperties(fixture.state), [fixture.skillId]);
      expect(model?.coordinate_system).toEqual({
        semantics: 'global-z-up',
        version: 1,
        dimension: fixture.dimension,
        plane: fixture.dimension === '2d' ? 'xz' : null,
        dof_order: ['ux', 'uy', 'uz', 'rx', 'ry', 'rz'],
      });
    }
  });

  test('resolves structure type key aliases to the owning skill plugin', async () => {
    const { AgentSkillRuntime } = await import('../../../dist/agent-runtime/index.js');
    const runtime = new AgentSkillRuntime();

    expect((await runtime.resolvePluginForType('frame'))?.id).toBe('frame');
    expect((await runtime.resolvePluginForType('steel-frame'))?.id).toBe('frame');
    expect((await runtime.resolvePluginForType('concrete-frame'))?.id).toBe('concrete-frame');
  });

  test('resolves latest GB50011 seismic code aliases to the GB50011 code-check skill', async () => {
    const { AgentSkillRuntime } = await import('../../../dist/agent-runtime/index.js');
    const runtime = new AgentSkillRuntime();

    expect(runtime.resolveCodeCheckSkillId('GB50011')).toBe('code-check-gb50011');
    expect(runtime.resolveCodeCheckSkillId('GB/T 50011-2010-2024')).toBe('code-check-gb50011');
    expect(runtime.resolveCodeCheckSkillId('GB 55002+GB/T 50011')).toBe('code-check-gb50011');
  });

  test('report summaries include failed warning and not-applicable code-check counts', async () => {
    const { AgentSkillRuntime } = await import('../../../dist/agent-runtime/index.js');
    const runtime = new AgentSkillRuntime();
    const codeCheck = {
      summary: {
        total: 4,
        passed: 1,
        failed: 1,
        warnings: 1,
        notApplicable: 1,
      },
    };

    const zh = await runtime.executeReportSkill({
      message: '生成报告',
      analysisType: 'seismic',
      analysis: { success: true, data: {} },
      codeCheck,
      format: 'markdown',
      locale: 'zh',
    });
    const en = await runtime.executeReportSkill({
      message: 'Generate report',
      analysisType: 'seismic',
      analysis: { success: true, data: {} },
      codeCheck,
      format: 'markdown',
      locale: 'en',
    });

    expect(zh.report.summary).toContain('校核通过 1 / 4，失败 1，警告 1，不适用 1');
    expect(en.report.summary).toContain('Code checks passed 1 / 4, failed 1, warnings 1, not applicable 1');
  });

  test('uses LLM router decision instead of locking broad new requests to the current draft', async () => {
    const { AgentSkillRuntime } = await import('../../../dist/agent-runtime/index.js');
    const runtime = new AgentSkillRuntime();
    const fakeRouterLlm = {
      invoke: async () => ({
        content: JSON.stringify({
          action: 'generic',
          skillId: 'generic',
          structuralTypeKey: 'unknown',
          mappedType: 'unknown',
          supportLevel: 'supported',
          confidence: 0.88,
          reason: '新的办公楼柱网描述不应继续旧梁草稿',
        }),
      }),
    };

    const match = await runtime.detectStructuralTypeWithLlm(
      fakeRouterLlm,
      '办公楼，混凝土柱网，三层',
      'zh',
      {
        inferredType: 'beam',
        structuralTypeKey: 'beam',
        skillId: 'beam',
        supportLevel: 'supported',
        lengthM: 6,
        updatedAt: 0,
      },
    );

    expect(match).toMatchObject({
      key: 'unknown',
      mappedType: 'unknown',
      skillId: 'generic',
      supportLevel: 'supported',
      routingSource: 'llm-suggested',
    });
  });

  test('rejects unusable LLM routing without changing the current draft', async () => {
    const { AgentSkillRuntime } = await import('../../../dist/agent-runtime/index.js');
    const runtime = new AgentSkillRuntime();
    const fakeRouterLlm = {
      invoke: async () => ({
        content: JSON.stringify({
          action: 'continue_current',
          confidence: 0.1,
          reason: '低置信度，不能继续沿用旧梁',
        }),
      }),
    };

    await expect(runtime.detectStructuralTypeWithLlm(
      fakeRouterLlm,
      '五层混凝土办公楼，柱网8m×8m，层高3.6m',
      'zh',
      {
        inferredType: 'beam',
        structuralTypeKey: 'beam',
        skillId: 'beam',
        supportLevel: 'supported',
        lengthM: 6,
        updatedAt: 0,
      },
    )).rejects.toThrow('LLM_STRUCTURAL_ROUTER_INVALID_OUTPUT');
  });

  test('legacy environment flags cannot enable rule routing', async () => {
    const previous = process.env.SCLAW_BENCHMARK_LLM_ONLY;
    process.env.SCLAW_BENCHMARK_LLM_ONLY = '1';
    try {
      const { AgentSkillRuntime } = await import('../../../dist/agent-runtime/index.js');
      const runtime = new AgentSkillRuntime();
      await expect(runtime.detectStructuralTypeWithLlm(
        {
          invoke: async () => ({
            content: 'not-json',
            response_metadata: { finish_reason: 'length' },
            additional_kwargs: { reasoning_content: 'reasoning only' },
          }),
        },
        'A two-story steel frame',
        'en',
      )).rejects.toThrow('LLM_STRUCTURAL_ROUTER_INVALID_OUTPUT');
    } finally {
      if (previous === undefined) delete process.env.SCLAW_BENCHMARK_LLM_ONLY;
      else process.env.SCLAW_BENCHMARK_LLM_ONLY = previous;
    }
  });

  test('legacy environment flags cannot bypass unsupported capability guards', async () => {
    const previous = process.env.SCLAW_BENCHMARK_LLM_ONLY;
    process.env.SCLAW_BENCHMARK_LLM_ONLY = '1';
    let invocations = 0;
    let routerPrompt = '';
    try {
      const { AgentSkillRuntime } = await import('../../../dist/agent-runtime/index.js');
      const runtime = new AgentSkillRuntime();
      const match = await runtime.detectStructuralTypeWithLlm(
        {
          invoke: async (prompt) => {
            invocations += 1;
            routerPrompt = String(prompt);
            return {
              content: JSON.stringify({
                action: 'unsupported',
                structuralTypeKey: 'bridge',
                mappedType: 'unknown',
                supportLevel: 'unsupported',
                confidence: 0.98,
                reason: 'Moving-load bridge workflows are outside the available skills.',
              }),
            };
          },
        },
        'Build a three-span bridge model with moving vehicle loads.',
        'en',
      );

      expect(invocations).toBe(1);
      expect(routerPrompt).not.toContain('Rule hint:');
      expect(match).toMatchObject({
        key: 'bridge',
        mappedType: 'unknown',
        supportLevel: 'unsupported',
        routingSource: 'llm-suggested',
      });
      expect(match.skillId).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.SCLAW_BENCHMARK_LLM_ONLY;
      else process.env.SCLAW_BENCHMARK_LLM_ONLY = previous;
    }
  });


  test.each(['invalid', 'network'])('fails explicitly after two %s routing attempts', async failure => {
    const { AgentSkillRuntime } = await import('../../../dist/agent-runtime/index.js');
    const runtime = new AgentSkillRuntime();
    let calls = 0;
    const llm = { invoke: async () => {
      calls++;
      if (failure === 'network') throw new Error('unavailable');
      return { content: 'invalid' };
    } };
    await expect(runtime.detectStructuralTypeWithLlm(llm, 'simply supported beam', 'en')).rejects.toThrow(
      failure === 'network' ? 'LLM_STRUCTURAL_ROUTER_INFRASTRUCTURE_ERROR' : 'LLM_STRUCTURAL_ROUTER_INVALID_OUTPUT');
    expect(calls).toBe(2);
  });

  test('a successful retry remains an LLM decision even for unsupported keywords', async () => {
    const { AgentSkillRuntime } = await import('../../../dist/agent-runtime/index.js');
    let calls = 0;
    const match = await new AgentSkillRuntime().detectStructuralTypeWithLlm({ invoke: async () => ({
      content: ++calls === 1 ? 'invalid' : JSON.stringify({ action: 'switch_skill', skillId: 'beam',
        structuralTypeKey: 'beam', mappedType: 'beam', supportLevel: 'supported', confidence: .99 }),
    }) }, 'A beam in a bridge; only analyze this simply supported member.', 'en');
    expect(calls).toBe(2);
    expect(match).toMatchObject({ key: 'beam', routingSource: 'llm-suggested' });
  });

  test('aborted routing does not retry or fall back', async () => {
    const { AgentSkillRuntime } = await import('../../../dist/agent-runtime/index.js');
    const controller = new AbortController();
    let calls = 0;
    await expect(new AgentSkillRuntime().detectStructuralTypeWithLlm({ invoke: async () => {
      calls++; controller.abort(new Error('cancelled')); throw new Error('cancelled');
    } }, 'beam', 'en', undefined, undefined, controller.signal)).rejects.toThrow('cancelled');
    expect(calls).toBe(1);
  });

  test('fails explicitly when no LLM is configured', async () => {
    const { AgentSkillRuntime } = await import('../../../dist/agent-runtime/index.js');
    const runtime = new AgentSkillRuntime();

    await expect(runtime.detectStructuralTypeWithLlm(
      null,
      '简支梁跨度6m',
      'zh',
    )).rejects.toThrow('LLM_STRUCTURAL_ROUTER_REQUIRED');
  });

  test('stampDraftSemantics adds global coordinate semantics without mutating input', () => {
    const draft = { inferredType: 'frame', storyCount: 2 };
    const stamped = stampDraftSemantics(draft);

    expect(stamped).toEqual({
      inferredType: 'frame',
      storyCount: 2,
      coordinateSemantics: STRUCTURAL_COORDINATE_SEMANTICS,
    });
    expect(stamped).not.toBe(draft);
    expect(draft).not.toHaveProperty('coordinateSemantics');
  });

  test('buildElementReferenceVectors assigns columns and beams while skipping invalid elements', () => {
    const nodes = [
      { id: 'N1', x: 0, y: 0, z: 0 },
      { id: 2, x: 0, y: 0, z: 3 },
      { id: 'N3', x: 5, y: 0, z: 3 },
      { id: 'bad', x: 'not-a-number', y: 0, z: 0 },
    ];
    const elements = [
      { id: 'C1', nodes: ['N1', 2] },
      { id: 'B1', nodes: [2, 'N3'] },
      { id: 'missing-node', nodes: ['N1', 'N404'] },
      { id: 42, nodes: ['N1', 'N3'] },
      { id: 'bad-coordinates', nodes: ['N1', 'bad'] },
    ];

    expect(buildElementReferenceVectors(elements, nodes)).toEqual({
      C1: [1, 0, 0],
      B1: [0, 0, 1],
    });
  });

  test('legacy draft validation blocks non-positive model parameters until corrected', async () => {
    const { buildLegacyModel, computeLegacyMissing, mergeLegacyState } = await import('../../../dist/agent-runtime/legacy.js');
    const { ingestDraft } = await import('../../../dist/agent-runtime/draft/boundary.js');

    const invalidPatch = ingestDraft({
      inferredType: 'beam',
      lengthM: -5,
      supportType: 'simply-supported',
      loadKN: 20,
    });
    const invalidState = mergeLegacyState(undefined, invalidPatch, 'beam', 'beam');

    expect(invalidState.skillState?.invalidDraftFields).toContain('lengthM');
    expect(computeLegacyMissing(invalidState, 'execution', ['lengthM', 'supportType', 'loadKN']).critical).toContain('lengthM');
    expect(buildLegacyModel(invalidState)).toBeUndefined();

    const correctedPatch = ingestDraft({ lengthM: 5 });
    const correctedState = mergeLegacyState(invalidState, correctedPatch, 'beam', 'beam');

    expect(correctedState.skillState?.invalidDraftFields ?? []).not.toContain('lengthM');
    expect(computeLegacyMissing(correctedState, 'execution', ['lengthM', 'supportType', 'loadKN']).critical).not.toContain('lengthM');
  });

  test('draft issues mark fields invalid even when invalidDraftFields is omitted', async () => {
    const { computeLegacyMissing, mergeLegacyState } = await import('../../../dist/agent-runtime/legacy.js');
    const { ingestDraft } = await import('../../../dist/agent-runtime/draft/boundary.js');

    const patch = ingestDraft({
      inferredType: 'portal-frame',
      spanLengthM: 18,
      heightM: 6,
      draftIssues: [{
        field: 'loadKN',
        severity: 'ambiguous',
        reason: 'Negative roof load may mean uplift rather than gravity magnitude.',
      }],
    });
    const state = mergeLegacyState(undefined, patch, 'portal-frame', 'portal-frame');

    expect(state.draftIssues?.[0].field).toBe('loadKN');
    expect(state.skillState?.invalidDraftFields).toContain('loadKN');
    expect(computeLegacyMissing(state, 'execution', ['spanLengthM', 'heightM', 'loadKN']).critical).toContain('loadKN');
  });

  test('unresolved issues on defaultable fields block legacy execution and model building', async () => {
    const { buildLegacyModel, computeLegacyMissing, mergeLegacyState } = await import('../../../dist/agent-runtime/legacy.js');
    const { ingestDraft } = await import('../../../dist/agent-runtime/draft/boundary.js');

    const patch = ingestDraft({
      inferredType: 'beam',
      lengthM: 6,
      supportType: 'simply-supported',
      loadKN: 20,
      draftIssues: [{
        field: 'loadType',
        severity: 'ambiguous',
        reason: 'The value 20 could be a point load in kN or a line load in kN/m.',
      }],
    });
    const state = mergeLegacyState(undefined, patch, 'beam', 'beam');
    const allowedKeys = ['lengthM', 'supportType', 'loadKN', 'loadType', 'loadPosition'];

    expect(computeLegacyMissing(state, 'execution', allowedKeys).critical).toContain('loadType');
    expect(buildLegacyModel(state, allowedKeys)).toBeUndefined();
  });

  test('structured engineering-draft issue paths block legacy execution until corrected', async () => {
    const { buildLegacyModel, computeLegacyMissing, mergeLegacyState } = await import('../../../dist/agent-runtime/legacy.js');
    const { ingestDraft } = await import('../../../dist/agent-runtime/draft/boundary.js');

    const patch = ingestDraft({
      inferredType: 'beam',
      engineeringDraft: {
        structureType: 'beam',
        geometry: { lengthM: 100000 },
        sections: { beam: '1mm' },
        boundary: { supportType: 'simply-supported' },
        loads: [{
          kind: 'distributed',
          magnitude: 999999999,
          unit: 'kN/m',
          direction: 'gravity',
          target: 'beam',
        }],
      },
      draftIssues: [
        {
          field: 'geometry.lengthM',
          severity: 'unrealistic',
          reason: 'The span requires confirmation.',
          question: 'Please confirm the intended span.',
        },
        {
          field: 'sections.beam',
          severity: 'unrealistic',
          reason: 'The section depth requires confirmation.',
          question: 'Please provide the intended beam section.',
        },
        {
          field: 'loads[0].magnitude',
          severity: 'unrealistic',
          reason: 'The load requires confirmation.',
          question: 'Please confirm the intended load.',
        },
      ],
    });
    const state = mergeLegacyState(undefined, patch, 'beam', 'beam');
    const allowedKeys = ['lengthM', 'supportType', 'loadKN', 'loadType', 'loadPosition'];

    expect(computeLegacyMissing(state, 'execution', allowedKeys).critical).toEqual(expect.arrayContaining([
      'geometry.lengthM',
      'sections.beam',
      'loads[0].magnitude',
    ]));
    expect(buildLegacyModel(state, allowedKeys)).toBeUndefined();

    const correctedPatch = ingestDraft({
      engineeringDraft: {
        geometry: { lengthM: 6 },
        sections: { beam: 'H400x200x8x13' },
        loads: [{
          kind: 'distributed',
          magnitude: 20,
          unit: 'kN/m',
          direction: 'gravity',
          target: 'beam',
        }],
      },
    });
    const correctedState = mergeLegacyState(state, correctedPatch, 'beam', 'beam');

    expect(computeLegacyMissing(correctedState, 'execution', allowedKeys).critical).not.toEqual(expect.arrayContaining([
      'geometry.lengthM',
      'sections.beam',
      'loads[0].magnitude',
    ]));
  });

  test('structured issue questions retain the engineering reason and requested correction', async () => {
    const { buildInteractionQuestions } = await import('../../../dist/agent-runtime/fallback.js');
    const [question] = buildInteractionQuestions(
      ['geometry.lengthM'],
      ['geometry.lengthM'],
      {
        inferredType: 'beam',
        updatedAt: 0,
        draftIssues: [{
          field: 'geometry.lengthM',
          severity: 'unrealistic',
          reason: 'The stated span is physically implausible.',
          question: 'Please confirm the intended span.',
        }],
      },
      'en',
    );

    expect(question).toEqual(expect.objectContaining({
      paramKey: 'geometry.lengthM',
      critical: true,
      question: 'The stated span is physically implausible. Please confirm the intended span.',
    }));
    expect(question.suggestedValue).toBeUndefined();
  });

  test('runtime refuses model building whenever the selected skill reports critical missing input', async () => {
    const { AgentSkillRuntime } = await import('../../../dist/agent-runtime/index.js');
    const runtime = new AgentSkillRuntime();
    runtime.getRegistry().resolvePluginForState = async () => ({
      id: 'test-critical-guard',
      handler: {
        computeMissing: () => ({ critical: ['loadType'], optional: [] }),
        buildModel: () => {
          throw new Error('buildModel must not be called while critical input is unresolved');
        },
      },
    });

    await expect(runtime.buildModel({
      inferredType: 'beam',
      updatedAt: 0,
    })).rejects.toThrow('MODEL_DRAFT_INCOMPLETE: loadType');
  });

  test('valid engineering draft span arrays clear prior invalid span issues', async () => {
    const { mergeDraftState } = await import('../../../dist/agent-runtime/draft/boundary.js');

    const state = mergeDraftState({
      inferredType: 'portal-frame',
      skillState: { invalidDraftFields: ['spanLengthsM'] },
      draftIssues: [{
        field: 'spanLengthsM',
        severity: 'invalid',
        reason: 'Span lengths must be positive.',
      }],
      updatedAt: 0,
    }, {
      engineeringDraft: {
        geometry: { spanLengthsM: [18, 18] },
      },
    });

    expect(state.skillState?.invalidDraftFields ?? []).not.toContain('spanLengthsM');
    expect(state.draftIssues ?? []).toEqual([]);
  });

  test('valid support positions may start at the global origin', async () => {
    const { mergeDraftState } = await import('../../../dist/agent-runtime/draft/boundary.js');

    const state = mergeDraftState({
      inferredType: 'beam',
      skillState: { invalidDraftFields: ['boundary.supportPositionsM'] },
      draftIssues: [{
        field: 'boundary.supportPositionsM',
        severity: 'invalid',
        reason: 'Support positions must be valid coordinates.',
      }],
      updatedAt: 0,
    }, {
      engineeringDraft: {
        boundary: { supportPositionsM: [0, 6] },
      },
    });

    expect(state.skillState?.invalidDraftFields ?? []).not.toContain('boundary.supportPositionsM');
    expect(state.draftIssues ?? []).toEqual([]);
  });

  test('merges engineering draft loads without duplicating repeated load definitions', async () => {
    const { mergeDraftState } = await import('../../../dist/agent-runtime/draft/boundary.js');

    const first = mergeDraftState(undefined, {
      engineeringDraft: {
        structureType: 'frame',
        loads: [
          { kind: 'line', magnitude: 10, unit: 'kN/m', direction: 'gravity', target: 'floor 1' },
        ],
      },
    });
    const second = mergeDraftState(first, {
      engineeringDraft: {
        structureType: 'frame',
        loads: [
          { kind: 'line', magnitude: 12, unit: 'kN/m', direction: 'gravity', target: 'floor 1' },
          { kind: 'point', magnitude: 30, unit: 'kN', direction: 'globalX', target: 'roof' },
        ],
      },
    });

    expect(second.engineeringDraft?.loads).toEqual([
      { kind: 'line', magnitude: 12, unit: 'kN/m', direction: 'gravity', target: 'floor 1' },
      { kind: 'point', magnitude: 30, unit: 'kN', direction: 'globalX', target: 'roof' },
    ]);
  });

  test('preserves distinct named load cases and explicit combinations', async () => {
    const {
      mergeEngineeringDraft,
      normalizeEngineeringDraft,
    } = await import('../../../dist/agent-runtime/engineering-draft.js');

    const dead = normalizeEngineeringDraft({
      structureType: 'steel-frame',
      loads: [{
        kind: 'line',
        magnitude: 10,
        unit: 'kN/m',
        direction: 'gravity',
        target: 'floor beam',
        loadCaseId: 'D',
        loadCaseType: 'dead',
      }],
    });
    const live = normalizeEngineeringDraft({
      loads: [{
        kind: 'line',
        magnitude: 8,
        unit: 'kN/m',
        direction: 'gravity',
        target: 'floor beam',
        caseId: 'L',
        caseType: 'live',
      }],
      analysis: {
        type: 'static',
        loadCombinations: [{ id: 'ULS', factors: { D: 1.2, L: 1.4 } }],
      },
    });
    const merged = mergeEngineeringDraft(dead, live);

    expect(merged?.loads).toEqual([
      expect.objectContaining({ magnitude: 10, caseId: 'D', caseType: 'dead' }),
      expect.objectContaining({ magnitude: 8, caseId: 'L', caseType: 'live' }),
    ]);
    expect(merged?.analysis?.loadCombinations).toEqual([
      { id: 'ULS', factors: { D: 1.2, L: 1.4 } },
    ]);
  });

  test('deduplicates equivalent load aliases emitted in one engineering draft', async () => {
    const { mergeEngineeringDraft } = await import('../../../dist/agent-runtime/engineering-draft.js');

    const merged = mergeEngineeringDraft(undefined, {
      structureType: 'steel-frame',
      geometry: { storyHeightsM: [12], bayWidthsM: [24] },
      loads: [
        {
          kind: 'line',
          magnitude: 36,
          unit: 'kN/m',
          direction: 'gravity',
          target: 'roof beam',
          location: { story: 1 },
          caseId: 'D',
        },
        {
          kind: 'distributed',
          magnitude: 36,
          unit: 'kN/m',
          direction: 'gravity',
          target: 'story 1 beam',
          location: { story: 1 },
          caseId: 'D',
        },
        {
          kind: 'point',
          magnitude: 98,
          unit: 'kN',
          direction: 'gravity',
          target: 'right column top',
          location: { story: 1, nodeRole: 'right-side' },
          caseId: 'C',
        },
        {
          kind: 'nodal',
          magnitude: 98,
          unit: 'kN',
          direction: 'gravity',
          target: 'right roof joint',
          location: { story: 1, nodeRole: 'right-side' },
          caseId: 'C',
        },
      ],
      analysis: {
        loadCombinations: [{ id: 'ULS', factors: { D: 1, C: 1 } }],
      },
    });

    expect(merged?.loads).toEqual([
      expect.objectContaining({ kind: 'distributed', magnitude: 36, caseId: 'D' }),
      expect.objectContaining({ kind: 'nodal', magnitude: 98, caseId: 'C' }),
    ]);
  });

  test('treats span 1 and omitted locations as the same full-span load for a single-span beam', async () => {
    const { mergeDraftState } = await import('../../../dist/agent-runtime/draft/boundary.js');

    const first = mergeDraftState(undefined, {
      engineeringDraft: {
        structureType: 'beam',
        geometry: { lengthM: 6 },
        loads: [
          {
            kind: 'distributed',
            magnitude: 20,
            unit: 'kN/m',
            direction: 'gravity',
            target: 'beam',
            location: { spanIndex: 1 },
          },
        ],
      },
    });
    const second = mergeDraftState(first, {
      engineeringDraft: {
        structureType: 'beam',
        loads: [
          {
            kind: 'distributed',
            magnitude: 20,
            unit: 'kN/m',
            direction: 'gravity',
            target: 'beam',
          },
          {
            kind: 'point',
            magnitude: 30,
            unit: 'kN',
            direction: 'gravity',
            target: 'beam',
            location: { xM: 3, nodeRole: 'midspan' },
          },
        ],
      },
    });

    expect(second.engineeringDraft?.loads).toEqual([
      {
        kind: 'distributed',
        magnitude: 20,
        unit: 'kN/m',
        direction: 'gravity',
        target: 'beam',
        location: { spanIndex: 1 },
      },
      {
        kind: 'point',
        magnitude: 30,
        unit: 'kN',
        direction: 'gravity',
        target: 'beam',
        location: { xM: 3, nodeRole: 'midspan' },
      },
    ]);
  });

  test('projects frame area engineering loads into per-story floor loads', async () => {
    const { projectDraftPatch } = await import('../../../dist/agent-runtime/draft/project-patch.js');

    const patch = projectDraftPatch({
      engineeringDraft: {
        structureType: 'concrete-frame',
        coordinateSystem: { dimension: '3d' },
        geometry: {
          storyHeightsM: [3.6, 3.6],
          bayWidthsXM: [6],
          bayWidthsYM: [6],
        },
        loads: [
          { kind: 'area', magnitude: 12, unit: 'kN/m2', direction: 'gravity', target: 'floor 1' },
          { kind: 'area', magnitude: 12, unit: 'kN/m2', direction: 'gravity', target: 'floor 2' },
        ],
      },
    }, 'frame');

    expect(patch.floorLoads).toEqual([
      { story: 1, verticalKN: 432 },
      { story: 2, verticalKN: 432 },
    ]);
  });

  test('does not project frame line loads into floor loads but keeps point lateral loads', async () => {
    const { projectDraftPatch } = await import('../../../dist/agent-runtime/draft/project-patch.js');

    const patch = projectDraftPatch({
      engineeringDraft: {
        structureType: 'steel-frame',
        geometry: {
          storyHeightsM: [3.3, 3.3],
          bayWidthsM: [5, 7],
        },
        loads: [
          { kind: 'line', magnitude: 10, unit: 'kN/m', direction: 'gravity' },
          { kind: 'point', magnitude: 20, unit: 'kN', direction: 'globalX', target: 'roof' },
        ],
      },
    }, 'frame');

    expect(patch.engineeringDraft?.loads?.[0]).toMatchObject({ kind: 'line', magnitude: 10, unit: 'kN/m' });
    expect(patch.floorLoads).toEqual([
      { story: 2, lateralXKN: 20 },
    ]);
  });

  test('prefers structured story locations when projecting frame floor loads', async () => {
    const { projectDraftPatch } = await import('../../../dist/agent-runtime/draft/project-patch.js');

    const patch = projectDraftPatch({
      engineeringDraft: {
        structureType: 'concrete-frame',
        coordinateSystem: { dimension: '3d' },
        geometry: {
          storyHeightsM: [3.6, 3.6],
          bayWidthsXM: [6],
          bayWidthsYM: [6],
        },
        loads: [
          {
            kind: 'area',
            magnitude: 8,
            unit: 'kN/m2',
            direction: 'gravity',
            target: 'floor 1',
            location: { story: 2 },
          },
          {
            kind: 'area',
            magnitude: 5,
            unit: 'kN/m2',
            direction: 'gravity',
            location: { story: 1 },
          },
        ],
      },
    }, 'frame');

    expect(patch.floorLoads).toEqual([
      { story: 1, verticalKN: 180 },
      { story: 2, verticalKN: 288 },
    ]);
  });

  test('preserves explicitly located frame nodal loads instead of projecting them as floor totals', async () => {
    const { projectDraftPatch } = await import('../../../dist/agent-runtime/draft/project-patch.js');

    const patch = projectDraftPatch({
      engineeringDraft: {
        structureType: 'steel-frame',
        geometry: {
          storyHeightsM: [3, 3, 3],
          bayWidthsM: [6, 6],
        },
        loads: [
          {
            kind: 'nodal',
            magnitude: 10,
            unit: 'kN',
            direction: 'globalX',
            location: { story: 1, nodeRole: 'right-side' },
          },
          {
            kind: 'nodal',
            magnitude: 15,
            unit: 'kN',
            direction: 'globalX',
            location: { story: 2, nodeRole: 'right-side' },
          },
          {
            kind: 'nodal',
            magnitude: 20,
            unit: 'kN',
            direction: 'globalX',
            location: { story: 3, nodeRole: 'right-side' },
          },
        ],
      },
    }, 'frame');

    expect(patch.engineeringDraft?.loads?.map((load) => load.location)).toEqual([
      { story: 1, nodeRole: 'right-side' },
      { story: 2, nodeRole: 'right-side' },
      { story: 3, nodeRole: 'right-side' },
    ]);
    expect(patch.floorLoads).toBeUndefined();
  });

  test('treats x-only engineering frame spans as 2d geometry', async () => {
    const { projectDraftPatch } = await import('../../../dist/agent-runtime/draft/project-patch.js');

    const patch = projectDraftPatch({
      engineeringDraft: {
        structureType: 'steel-frame',
        geometry: {
          storyHeightsM: [4.5],
          bayWidthsXM: [6],
        },
        loads: [
          { kind: 'line', magnitude: 10, unit: 'kN/m', direction: 'gravity', target: 'beam' },
        ],
      },
    }, 'frame');

    expect(patch).toMatchObject({
      frameDimension: '2d',
      storyCount: 1,
      bayCount: 1,
      bayWidthsM: [6],
    });
    expect(patch.floorLoads).toBeUndefined();
    expect(patch.bayCountX).toBeUndefined();
    expect(patch.bayWidthsXM).toBeUndefined();
  });

  test.each([undefined, '第十一层', '不是第三层', '非屋顶', '柱顶'])('requires structured selectors for unresolved frame loads: %s', async target => {
    const { projectDraftPatch } = await import('../../../dist/agent-runtime/draft/project-patch.js');
    expect(() => projectDraftPatch({ engineeringDraft: {
      geometry: { storyHeightsM: [3, 3, 3], bayWidthsM: [5] },
      loads: [{ kind: 'point', magnitude: 10, unit: 'kN', direction: 'gravity', ...(target ? { target } : {}) }],
    } }, 'frame')).toThrow('MODEL_EDIT_FIELD_INVALID');
  });

  test('projects declared story indices without inferring them from load order or display labels', async () => {
    const { projectDraftPatch } = await import('../../../dist/agent-runtime/draft/project-patch.js');
    const patch = projectDraftPatch({ engineeringDraft: {
      geometry: { storyHeightsM: Array.from({ length: 12 }, () => 3), bayWidthsM: [5] },
      loads: [{ kind: 'point', magnitude: 10, unit: 'kN', direction: 'gravity', target: 'floor', location: { story: 11 } }],
    } }, 'frame');
    expect(patch.floorLoads).toEqual([{ story: 11, verticalKN: 10 }]);
  });

  test('does not convert frame load intensity into fallback floor totals', async () => {
    const { mergeDraftState } = await import('../../../dist/agent-runtime/draft/boundary.js');
    const { projectDraftPatch } = await import('../../../dist/agent-runtime/draft/project-patch.js');

    const patch = projectDraftPatch({
      engineeringDraft: {
        structureType: 'steel-frame',
        geometry: {
          storyHeightsM: [3, 3],
        },
        loads: [
          { kind: 'line', magnitude: 10, unit: 'kN/m', direction: 'gravity' },
        ],
      },
    }, 'frame');
    const state = mergeDraftState(undefined, patch);

    expect(patch.loadKN).toBeUndefined();
    expect(state.floorLoads).toBeUndefined();
  });
});
