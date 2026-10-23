import { expect, test } from '@jest/globals';
import { toolCall } from './helpers/llm-fixture.mjs';
import { describeWithOpenSees, internalResponder, runTurn, setupHarness, toolResultSeenByAgent } from './helpers/harness.mjs';

// Independent cantilever: T=2π√(mL³/(3EI)); E in kN/m², nodal mass in tonnes.
const expectedPeriod = 2 * Math.PI * Math.sqrt(10 * 3 ** 3 / (3 * 200000000 * .0001));
const model = {
  schema_version: '2.2.0', unit_system: 'SI', coordinate_system: { semantics: 'global-z-up', version: 1,
    dimension: '2d', plane: 'xz', dof_order: ['ux','uy','uz','rx','ry','rz'] },
  nodes: [{ id: 'base', x: 0, y: 0, z: 0, restraints: [true,true,true,true,true,true] },
    { id: 'top', x: 0, y: 0, z: 3, mass: 10, restraints: [false,true,true,true,false,true] }],
  elements: [{ id: 'C', type: 'column', nodes: ['base','top'], material: 'S', section: 'A' }],
  materials: [{ id: 'S', name: 'explicit elastic steel', E: 200000, nu: .3, rho: 7850 }],
  sections: [{ id: 'A', type: 'custom', name: 'declared mechanical section', properties: { A: .02, Iy: .0001, Iz: .0002, J: .00005 } }],
  load_cases: [{ id: 'P', type: 'other', loads: [{ type: 'nodal', node: 'top', fx: 1 }] }], load_combinations: [],
  analysis_control: { self_weight: false, rigid_floor: false, rigid_offsets: false, p_delta: false, construction_stage: false,
    mass_source: 'nodal', mass_directions: ['x'] },
};

describeWithOpenSees('all OpenSees provider modes through the persisted chat API', () => {
  const ctx = setupHarness();
  const run = async (id, args, { report = true } = {}) => {
    ctx.llm.setInternal(internalResponder({ 'param-extractor': () => ({ engineeringDraft: { model },
      requestScope: { responses: ['displacements','forces','reactions'], design: false, report, outputs: [] } }) }));
    const script = [toolCall('extract_draft_params', { locale: 'en' }, `${id}-extract`), toolCall('build_model', {}, `${id}-build`),
      toolCall('validate_model', {}, `${id}-validate`), toolCall('run_analysis', args, `${id}-analysis`),
      ...(report ? [toolCall('generate_report', { message: 'Report this analysis', locale: 'en', analysisType: args.analysisType, narrative: 'structured' }, `${id}-report`)] : []), 'DONE'];
    const turn = await runTurn(ctx, { message: `Use this confirmed model and explicit analysis request; no substitutions or code design. ${JSON.stringify({ model, ...args })}`,
      context: { locale: 'en', runPolicy: { skillIds: ['generic'], routing: { mode: 'fixed', skillId: 'generic' } } } }, script,
      { expectedToolErrors: report ? 0 : 1 });
    return { turn, receipt: toolResultSeenByAgent(turn.requests, `${id}-analysis`), session: await ctx.backend.session(turn.conversationId) };
  };

  test('modal analysis saves its independently checked period and report', async () => {
    const result = await run('modal', { analysisType: 'dynamic', analysisSkillId: 'opensees-dynamic', method: 'modal',
      massSource: 'nodal', massDirections: ['x'], numModes: 1, direction: 'x' });
    expect(result.receipt.success).toBe(true);
    expect(result.session.report.current).toBe(true);
    const stored = await ctx.backend.get(`/runs/${result.session.analysis.runId}`);
    expect(stored.body.data.modes[0].period).toBeCloseTo(expectedPeriod, 9);
    expect(stored.body.meta.engineId).toBe('builtin-opensees');
    expect(stored.body.meta.fallbackFrom).toBeNull();
  }, 120_000);

  test('time-history observations preserve linear scaling, requested nodes and saved reports', async () => {
    const outputs = [];
    for (const amplitude of [1, 2]) {
      const result = await run(`transient-${amplitude}`, { analysisType: 'dynamic', analysisSkillId: 'opensees-dynamic', method: 'time_history',
        massSource: 'nodal', massDirections: ['x'], direction: 'x', numModes: 1, timeStep: .02, duration: .1, dampingRatio: .05,
        groundMotion: [0,.1,-.1,.05,0].map(value => value * amplitude), groundMotionUnit: 'm/s2',
        monitorNodeIds: ['base','top'], monitorElementIds: ['C'], monitorSupportNodeIds: ['base'] });
      expect(result.receipt.success).toBe(true);
      expect(result.session.report.current).toBe(true);
      const stored = await ctx.backend.get(`/runs/${result.session.analysis.runId}`);
      outputs.push(stored.body.data.timeHistory);
    }
    expect(outputs[0]).toHaveLength(5);
    expect(outputs[1]).toHaveLength(5);
    expect(outputs[0].some(frame => Math.abs(frame.nodes.top.ux) > 1e-12)).toBe(true);
    for (let index = 0; index < 5; index++) {
      expect(outputs[1][index].time).toBe(outputs[0][index].time);
      expect(outputs[1][index].nodes.top.ux).toBeCloseTo(2 * outputs[0][index].nodes.top.ux, 10);
    }
  }, 180_000);

  test.each([['nonlinear', 'opensees-nonlinear'], ['seismic', 'opensees-seismic']])('%s without its required physics fails explicitly and publishes no report', async (analysisType, analysisSkillId) => {
    const result = await run(analysisType, { analysisType, analysisSkillId }, { report: false });
    expect(result.receipt.success).toBe(false);
    expect(result.session.analysis?.current ?? false).toBe(false);
    expect(result.session.report?.current ?? false).toBe(false);
    expect(result.receipt.errorCode ?? result.receipt.error_code).toBeTruthy();
  }, 120_000);
});
