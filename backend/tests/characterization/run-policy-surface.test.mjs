// Scenario 5: run-policy / ablation surface. For each context.runPolicy variant, pin what the agent
// LLM is offered (tool names in order, tool schema hashes) and the agent system prompt (hash + text),
// plus the effective policy persisted in the session and in the run-record ledger.
// The surface tests do not need OpenSees (plain-text agent reply). The "policy enforcement inside
// tools" block exercises fixed routing and the builder policy through real tools.
import { describe, expect, test } from '@jest/globals';
import { offeredToolNames, systemPrompt, toolCall } from './helpers/llm-fixture.mjs';
import { describeWithOpenSees, internalResponder, routerDecision, runTurn, setupHarness, toolResultSeenByAgent,
  TURN_TIMEOUT_MS } from './helpers/harness.mjs';
import { normalizeText, sha256 } from './helpers/normalize.mjs';

const MESSAGES = {
  en: 'Analyze a 6 m simply supported steel beam under a 10 kN midspan point load.',
  zh: '分析一根6米简支钢梁，跨中作用10kN集中荷载。',
};

const VARIANTS = [
  { name: 'default-en', locale: 'en', runPolicy: undefined },
  { name: 'default-zh', locale: 'zh', runPolicy: undefined },
  { name: 'tools-disabled-ask-user-clarification', locale: 'en', runPolicy: { tools: { disabledIds: ['ask_user_clarification'] } } },
  { name: 'knowledge-disabled', locale: 'en', runPolicy: { knowledge: 'disabled' } },
  { name: 'builder-llm', locale: 'en', runPolicy: { builder: 'llm' } },
  { name: 'routing-fixed-beam', locale: 'en', runPolicy: { routing: { mode: 'fixed', skillId: 'beam' } } },
];

describe('characterization: run policy and ablation surface', () => {
  const ctx = setupHarness();
  const captured = {};

  for (const variant of VARIANTS) {
    test(`policy variant ${variant.name}: tool exposure, system prompt and persisted policy`, async () => {
      ctx.llm.setInternal(null);
      const turn = await runTurn(ctx, { message: MESSAGES[variant.locale],
        context: { locale: variant.locale, ...(variant.runPolicy ? { runPolicy: variant.runPolicy } : {}) } }, ['POLICY_ACK']);
      expect(turn.requests.map(request => request.kind)).toEqual(['agent']);
      const [request] = turn.requests;
      const tools = request.body.tools.map(item => item.function.name);
      const prompt = normalizeText(systemPrompt(request.body), { dataDir: ctx.backend.dataDir });
      captured[variant.name] = { tools, prompt };
      if (variant.locale === 'zh') {
        expect(prompt).toContain('明确报告失败并停止依赖该结果的步骤');
        expect(prompt).toContain('禁止改用关键词、正则、模板、其他技能或求解器冒充成功');
        expect(prompt).not.toContain('继续尝试其他工具');
      } else {
        expect(prompt).toContain('report the failure and stop dependent steps');
        expect(prompt).toContain('Never substitute keyword rules, regexes, templates, other skills or solvers to claim success');
        expect(prompt).not.toContain('do NOT give up. Try other tools');
      }

      expect({
        offeredTools: tools,
        systemPromptSha256: sha256(prompt),
        systemPromptChars: prompt.length,
        messageRoles: request.body.messages.map(message => message.role),
        streaming: request.body.stream,
      }).toMatchSnapshot('agent-request-surface');
      expect(prompt).toMatchSnapshot('agent-system-prompt');

      const session = await ctx.backend.session(turn.conversationId);
      expect(new Set(session.policy.activeToolIds)).toEqual(new Set(offeredToolNames(request.body)));
      expect(session.policy).toMatchSnapshot('effective-policy');
      const ledger = ctx.backend.runRecords().find(item => item.name === `${session.usage.runId}.json`);
      expect(ledger).toBeDefined();
      expect(ledger.record.policy).toEqual(session.policy);
      expect(ledger.record.usage).toMatchObject({ runId: session.usage.runId, policyHash: session.policy.policyHash, toolCalls: 0, llmCalls: 1 });
      if (variant.runPolicy) {
        expect(ledger.record.policy).toMatchObject(variant.runPolicy);
        for (const field of Object.keys(variant.runPolicy)) {
          const sources = Object.entries(ledger.record.policy.fieldSources).filter(([key]) => key === field || key.startsWith(`${field}.`));
          expect(sources.some(([, source]) => source === 'request')).toBe(true);
        }
      }
    }, TURN_TIMEOUT_MS);
  }

  test('default tool schemas (names, descriptions, parameters) are pinned by hash', () => {
    const request = ctx.llm.requests.find(item => item.kind === 'agent');
    const hashes = Object.fromEntries(request.body.tools.map(item => [item.function.name, sha256(item.function)]));
    expect(hashes).toMatchSnapshot('default-tool-schema-hashes');
  });

  test('ablations change only the intended surface', () => {
    const base = captured['default-en'];
    expect(captured['tools-disabled-ask-user-clarification'].tools).toEqual(base.tools.filter(name => name !== 'ask_user_clarification'));
    expect(captured['tools-disabled-ask-user-clarification'].prompt).not.toContain('"ask_user_clarification"');
    // The prompt must never instruct the agent to use a tool it is not offered.
    expect(captured['tools-disabled-ask-user-clarification'].prompt).not.toContain('ask_user_clarification');
    // Fixed routing is enforced in tools (extract_draft_params skips the router), not announced in the prompt.
    expect(captured['routing-fixed-beam']).toEqual(base);
    for (const name of ['knowledge-disabled', 'builder-llm']) {
      expect(captured[name].tools).toEqual(base.tools);
      expect(captured[name].prompt).not.toEqual(base.prompt);
    }
  });

  describeWithOpenSees('policy enforcement inside tools', () => {
    const beamDraft = {
      engineeringDraft: {
        structureType: 'beam', geometry: { lengthM: 6 }, boundary: { supportType: 'simply-supported' },
        materials: [{ id: 'M1', name: 'Q235 steel', E: 206000, nu: 0.3, rho: 7850 }],
        sectionRecords: [{ id: 'S1', name: '200×400 rectangle', type: 'rectangular', shape: { kind: 'rectangular', B: 200, H: 400 } }],
        templateAssignments: { beam: { materialId: 'M1', sectionId: 'S1' } },
        loads: [{ id: 'P1', kind: 'point', magnitude: 10, unit: 'kN', direction: 'gravity', target: 'beam', location: { xM: 3 } }],
        analysisControl: { self_weight: false }, analysis: { loadCombinations: [] },
      },
      requestScope: { responses: ['forces', 'reactions', 'displacements'], design: false, report: false, outputs: [] },
    };
    const llmBuiltModel = {
      schema_version: '2.2.0', unit_system: 'SI',
      coordinate_system: { semantics: 'global-z-up', version: 1, dimension: '2d', plane: 'xz', dof_order: ['ux', 'uy', 'uz', 'rx', 'ry', 'rz'] },
      nodes: [
        { id: 'LLM-N1', x: 0, y: 0, z: 0, restraints: [true, true, true, false, false, false] },
        { id: 'LLM-N2', x: 3, y: 0, z: 0 },
        { id: 'LLM-N3', x: 6, y: 0, z: 0, restraints: [false, true, true, false, false, false] },
      ],
      elements: [
        { id: 'LLM-E1', type: 'beam', nodes: ['LLM-N1', 'LLM-N2'], material: 'M1', section: 'S1' },
        { id: 'LLM-E2', type: 'beam', nodes: ['LLM-N2', 'LLM-N3'], material: 'M1', section: 'S1' },
      ],
      materials: [{ id: 'M1', name: 'Q235 steel', E: 206000, nu: 0.3, rho: 7850 }],
      sections: [{ id: 'S1', name: '200×400 rectangle', type: 'rectangular', shape: { kind: 'rectangular', B: 200, H: 400 } }],
      load_cases: [{ id: 'LC1', type: 'other', loads: [{ id: 'P1', node: 'LLM-N2', fz: -10 }] }],
      load_combinations: [],
      analysis_control: { self_weight: false },
    };
    const builderEvents = runId => ctx.backend.runRecords().find(item => item.name === `${runId}.json`).record.usage.events
      .filter(event => event.kind === 'model_builder')
      .map(({ kind, builder, requestedBuilder, skillId, source }) => ({ kind, builder, requestedBuilder, skillId, source }));

    test('routing fixed to beam: extract_draft_params bypasses the structural-type router LLM', async () => {
      ctx.llm.setInternal(internalResponder({ 'param-extractor': () => beamDraft }));
      const turn = await runTurn(ctx, { message: MESSAGES.en, context: { locale: 'en', runPolicy: { routing: { mode: 'fixed', skillId: 'beam' } } } },
        [toolCall('extract_draft_params', { locale: 'en' }, 'fixed-extract'), 'FIXED_DONE']);
      expect(turn.requests.map(request => request.kind)).toEqual(['agent', 'param-extractor', 'agent']);
      expect(toolResultSeenByAgent(turn.requests, 'fixed-extract')).toMatchObject({ skillId: 'beam', routingSource: 'policy-fixed', criticalMissing: [] });
    }, TURN_TIMEOUT_MS);

    test('builder auto uses the beam template; builder llm asks the LLM model builder', async () => {
      ctx.llm.setInternal(internalResponder({ 'structural-router': () => routerDecision('beam'), 'param-extractor': () => beamDraft }));
      const auto = await runTurn(ctx, { message: MESSAGES.en, context: { locale: 'en' } },
        [toolCall('extract_draft_params', { locale: 'en' }, 'auto-extract'), toolCall('build_model', {}, 'auto-build'), 'AUTO_DONE']);
      expect(auto.requests.map(request => request.kind)).toEqual(['agent', 'structural-router', 'param-extractor', 'agent', 'agent']);
      const autoSession = await ctx.backend.session(auto.conversationId);
      expect(builderEvents(autoSession.usage.runId)).toMatchSnapshot('auto-builder-run-events');
      expect((await ctx.backend.inputReview(auto.conversationId)).model.nodes.map(node => node.id)).toEqual(['1', '2', '3']);

      const builderPrompts = [];
      const explicitDraft = structuredClone(beamDraft);
      explicitDraft.engineeringDraft.loads[0].target = 'LLM-N2';
      ctx.llm.setInternal(internalResponder({ 'structural-router': () => routerDecision('beam'), 'param-extractor': () => explicitDraft,
        'internal-other': text => { builderPrompts.push(text); return llmBuiltModel; } }));
      const llmTurn = await runTurn(ctx, { message: MESSAGES.en, context: { locale: 'en', runPolicy: { builder: 'llm' } } },
        [toolCall('extract_draft_params', { locale: 'en' }, 'llm-extract'), toolCall('build_model', {}, 'llm-build'), 'LLM_BUILDER_DONE']);
      expect(llmTurn.requests.map(request => request.kind)).toMatchSnapshot('llm-builder-request-kinds');
      expect(builderPrompts.length).toBeGreaterThan(0);
      expect(toolResultSeenByAgent(llmTurn.requests, 'llm-build')).toMatchSnapshot('llm-builder-build-result');
      const llmSession = await ctx.backend.session(llmTurn.conversationId);
      expect(builderEvents(llmSession.usage.runId)).toMatchSnapshot('llm-builder-run-events');
      const { model } = await ctx.backend.inputReview(llmTurn.conversationId);
      expect(model?.nodes?.map(node => node.id) ?? null).toMatchSnapshot('llm-builder-model-node-ids');
      expect(model.nodes.find(node => node.id === 'LLM-N2')).toMatchObject({ x: 3, y: 0, z: 0 });
      expect(model.load_cases[0].loads).toHaveLength(1);
      expect(model.load_cases[0].loads[0]).toMatchObject({ node: 'LLM-N2', fz: -10 });
    }, TURN_TIMEOUT_MS);
  });
});
