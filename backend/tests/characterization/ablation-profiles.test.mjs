// Scenario 6: pre-registered ablation profiles (backend/src/runtime/ablation-profiles.ts, docs/ablation.md).
// For every profile: the tool list and system prompt the agent LLM is offered, the persisted profile
// and policy hash, and a completed turn (final answer + `done`). Then, per profile, the behaviour that
// distinguishes it from the full system, each against the same script under `full`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { requestText, startLlmFixture, systemPrompt, toolCall } from './helpers/llm-fixture.mjs';
import { describeWithOpenSees, internalResponder, routerDecision, runTurn, setupHarness, toolResultSeenByAgent,
  TURN_TIMEOUT_MS } from './helpers/harness.mjs';
import { resolveOpenSeesPython, startBackend } from './helpers/backend-host.mjs';
import { eventSignature, normalizeText, sha256 } from './helpers/normalize.mjs';
import { beamAnalysis, beamModel } from './fixtures/engineering-beam.mjs';
import { AgentSkillRuntime } from '../../dist/agent-runtime/index.js';
import { ABLATION_PROFILES_VERSION, PROFILE_IDS } from '../../dist/runtime/ablation-profiles.js';

const skillsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/agent-skills');
const MESSAGE = 'Analyze a 6 m simply supported steel beam under a 10 kN midspan point load.';
const INCOMPLETE = 'An 8 m simply supported steel beam, rectangular 200 mm wide and 400 mm deep, E=206000 MPa, no self-weight. Analyze forces and deflection.';

const beamDraft = (withLoad = true) => ({
  engineeringDraft: {
    structureType: 'beam', geometry: { lengthM: 6 }, boundary: { supportType: 'simply-supported' },
    materials: [{ id: 'M1', name: 'Q235 steel', E: 206000, nu: 0.3, rho: 7850 }],
    sectionRecords: [{ id: 'S1', name: '200×400 rectangle', type: 'rectangular', shape: { kind: 'rectangular', B: 200, H: 400 } }],
    templateAssignments: { beam: { materialId: 'M1', sectionId: 'S1' } },
    ...(withLoad ? { loads: [{ id: 'P1', kind: 'point', magnitude: 10, unit: 'kN', direction: 'gravity', target: 'beam', location: { xM: 3 } }] } : {}),
    analysisControl: { self_weight: false }, analysis: { loadCombinations: [] },
  },
  requestScope: { responses: ['forces', 'reactions', 'displacements'], design: false, report: false, outputs: [] },
});
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

/** Long skill descriptions and one plain line of every stage markdown file (the knowledge text). */
async function knowledgeSnippets() {
  const manifests = await new AgentSkillRuntime().listSkillManifests();
  const descriptions = manifests.flatMap(item => [item.description?.en, item.description?.zh]).filter(text => typeof text === 'string' && text.length >= 20);
  const markdown = {};
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) { if (!['__tests__', 'node_modules', 'runtime'].includes(entry.name)) walk(full); continue; }
      if (!/^(intent|draft|analysis|design)\.md$/.test(entry.name)) continue;
      const line = fs.readFileSync(full, 'utf8').split(/\r?\n/).map(text => text.trim())
        .find(text => text.length >= 30 && !/["\\`]/.test(text) && !text.startsWith('#'));
      if (line) markdown[path.relative(skillsDir, full).replaceAll('\\', '/')] = line;
    }
  };
  walk(skillsDir);
  return { descriptions, markdown };
}

function expectCompletedTurn(turn, answer) {
  expect(turn.result?.content).toMatchObject({ response: answer });
  expect(turn.events.at(-1)).toEqual({ type: 'done' });
  expect(turn.interactions).toEqual([]);
}

const ledgerFor = (ctx, runId) => ctx.backend.runRecords().find(item => item.name === `${runId}.json`)?.record;

describe('characterization: ablation profiles', () => {
  const ctx = setupHarness();
  const captured = {};

  test('the run-profiles endpoint lists every pre-registered profile with its version', async () => {
    const response = await ctx.backend.get('/api/v1/agent/run-profiles');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ version: ABLATION_PROFILES_VERSION, envProfile: null });
    expect(response.body.profiles.map(item => item.id)).toEqual([...PROFILE_IDS]);
    for (const profile of response.body.profiles) {
      expect(profile).toMatchObject({ version: ABLATION_PROFILES_VERSION, removes: { en: expect.any(String), zh: expect.any(String) } });
    }
  });

  test('an unknown requested profile is rejected at request validation with a bilingual error', async () => {
    const response = await ctx.backend.post('/api/v1/chat/stream', { message: MESSAGE, context: { locale: 'en', runPolicy: { profile: 'no-such-profile' } } });
    // The stream route rejects any schema-invalid body with 400 before a turn starts.
    expect(response.status).toBe(400);
    const text = JSON.stringify(response.body);
    expect(text).toContain('UNKNOWN_RUN_PROFILE');
    expect(text).toContain('未知的运行配置档');
    expect(ctx.llm.requests).toHaveLength(0);
  });

  for (const profile of PROFILE_IDS) {
    test(`profile ${profile}: offered tools, system prompt, persisted profile and a completed turn`, async () => {
      ctx.llm.setInternal(null);
      const answer = `ACK_${profile}`;
      const turn = await runTurn(ctx, { message: MESSAGE, context: { locale: 'en', runPolicy: { profile } } }, [answer]);
      expect(turn.requests.map(request => request.kind)).toEqual(['agent']);
      expectCompletedTurn(turn, answer);
      const [request] = turn.requests;
      const tools = request.body.tools.map(item => item.function.name);
      const prompt = normalizeText(systemPrompt(request.body), { dataDir: ctx.backend.dataDir });
      captured[profile] = { tools, prompt };
      expect({ offeredTools: tools, systemPromptSha256: sha256(prompt), systemPromptChars: prompt.length }).toMatchSnapshot('agent-request-surface');
      expect(prompt).toMatchSnapshot('agent-system-prompt');

      const session = await ctx.backend.session(turn.conversationId);
      expect(session.policy).toMatchObject({ profileId: profile, fieldSources: { profileId: 'request' } });
      expect(new Set(session.policy.activeToolIds)).toEqual(new Set(tools));
      const ledger = ledgerFor(ctx, session.usage.runId);
      expect(ledger.policy).toEqual(session.policy);
      expect(ledger.usage).toMatchObject({ policyHash: session.policy.policyHash, llmCalls: 1, toolCalls: 0 });
    }, TURN_TIMEOUT_MS);
  }

  test('profiles change only their own surface; full equals the default surface and hash', async () => {
    ctx.llm.setInternal(null);
    const defaultTurn = await runTurn(ctx, { message: MESSAGE, context: { locale: 'en' } }, ['ACK_default']);
    const defaultPrompt = normalizeText(systemPrompt(defaultTurn.requests[0].body), { dataDir: ctx.backend.dataDir });
    const defaultSession = await ctx.backend.session(defaultTurn.conversationId);
    expect(defaultSession.policy).not.toHaveProperty('profileId');
    const full = captured.full;
    expect(full).toEqual({ tools: defaultTurn.requests[0].body.tools.map(item => item.function.name), prompt: defaultPrompt });
    const fullSessions = ctx.backend.runRecords().map(item => item.record.policy).filter(policy => policy.profileId === 'full');
    expect(fullSessions.length).toBeGreaterThan(0);
    for (const policy of fullSessions) expect(policy.policyHash).toBe(defaultSession.policy.policyHash);

    const without = tool => full.tools.filter(item => item !== tool);
    for (const profile of ['no-routing', 'no-knowledge', 'no-template-builder', 'no-state-versioning', 'no-evidence-binding', 'no-repair']) {
      expect(captured[profile].tools).toEqual(full.tools);
    }
    expect(captured['no-validation-gate'].tools).toEqual(without('validate_model'));
    expect(captured['no-clarification'].tools).toEqual(without('ask_user_clarification'));
    expect(captured['generic-only'].tools).toEqual(full.tools);
    // The prompt never mentions a tool that is not offered.
    expect(captured['no-clarification'].prompt).not.toContain('ask_user_clarification');
    expect(captured['no-clarification'].prompt).toContain('list the missing inputs in your final reply and end the turn');
    expect(captured['no-validation-gate'].prompt).toContain('A separate model-validation step is not available in this run');
    expect(captured['no-validation-gate'].prompt).not.toContain('Call validate_model');
    expect(captured['no-repair'].prompt).toContain('Automatic recovery is disabled for this run');
    expect(captured['no-repair'].prompt).not.toContain('do NOT give up');
    // Generic guard: no profile's system prompt names a tool that profile removed from exposure.
    for (const profile of PROFILE_IDS) {
      for (const removed of full.tools.filter(item => !captured[profile].tools.includes(item))) {
        expect({ profile, removed, mentioned: captured[profile].prompt.includes(removed) }).toEqual({ profile, removed, mentioned: false });
      }
    }
    // Mechanisms enforced inside tools leave the prompt identical to the full system.
    for (const profile of ['no-routing', 'no-state-versioning', 'no-evidence-binding']) expect(captured[profile].prompt).toBe(full.prompt);
    expect(captured['generic-only'].prompt).toMatch(/Selected skills: [^\n]*generic/);
    expect(captured['generic-only'].prompt).not.toMatch(/Selected skills: [^\n]*\bbeam\b/);
  }, TURN_TIMEOUT_MS);

  describeWithOpenSees('distinguishing behaviour per profile', () => {
    const extractorTurn = async (profile, { draft = beamDraft(), router = 'beam', script } = {}) => {
      const prompts = { router: [], extractor: [] };
      ctx.llm.setInternal(internalResponder({
        'structural-router': text => { prompts.router.push(text); return routerDecision(router); },
        'param-extractor': text => { prompts.extractor.push(text); return draft; },
      }));
      const id = `${profile}-extract`;
      const answer = `DONE_${profile}`;
      const turn = await runTurn(ctx, { message: script?.message ?? MESSAGE, context: { locale: 'en', runPolicy: { profile } } },
        [toolCall('extract_draft_params', { locale: 'en' }, id), answer]);
      const extraction = toolResultSeenByAgent(turn.requests, id);
      expect(extraction.scopeExclusion).toBeUndefined();
      expectCompletedTurn(turn, answer);
      return { turn, prompts, extraction };
    };

    test('generic-only: only the generic structure skill is routable', async () => {
      const full = await extractorTurn('full');
      expect(full.prompts.router.join('\n')).toContain('"id": "beam"');
      const generic = await extractorTurn('generic-only', { router: 'generic' });
      expect(generic.prompts.router).toEqual([]);
      expect(generic.extraction.routingSource).toBe('scope-selected');
      expect(generic.extraction.skillId).toBe('generic');
      const session = await ctx.backend.session(generic.turn.conversationId);
      expect(session.policy.activeSkillIds).toEqual(expect.arrayContaining(['generic']));
      expect(session.policy.activeSkillIds).not.toEqual(expect.arrayContaining(['beam']));
    }, TURN_TIMEOUT_MS);

    test('no-routing: extract_draft_params is fixed to generic without the structural router', async () => {
      const full = await extractorTurn('full');
      expect(full.extraction).toMatchObject({ skillId: 'beam' });
      expect(full.prompts.router.length).toBeGreaterThan(0);
      const fixed = await extractorTurn('no-routing');
      expect(fixed.prompts.router).toEqual([]);
      expect(fixed.extraction).toMatchObject({ skillId: 'generic', routingSource: 'policy-fixed' });
    }, TURN_TIMEOUT_MS);

    test('no-knowledge: no skill description or stage markdown reaches any prompt (agent, router, extractor)', async () => {
      const { descriptions, markdown } = await knowledgeSnippets();
      expect(descriptions.length).toBeGreaterThan(10);
      const beamDraftLine = markdown['structure-type/beam/draft.md'] ?? markdown['structure-type/beam/intent.md'];
      expect(beamDraftLine).toBeDefined();
      const full = await extractorTurn('full');
      const fullText = full.turn.requests.map(request => requestText(request.body)).join('\n');
      expect(fullText).toContain(beamDraftLine);
      expect(descriptions.some(text => fullText.includes(text))).toBe(true);

      const ablated = await extractorTurn('no-knowledge');
      expect(ablated.turn.requests.map(request => request.kind)).toEqual(['agent', 'structural-router', 'param-extractor', 'agent']);
      for (const request of ablated.turn.requests) {
        const text = requestText(request.body);
        for (const description of descriptions) expect(text).not.toContain(description);
        for (const line of Object.values(markdown)) expect(text).not.toContain(line);
      }
      expect(ablated.extraction.skillId).toBe('beam');
    }, TURN_TIMEOUT_MS);

    test('no-template-builder: build_model asks the LLM model builder instead of the beam template', async () => {
      const builderPrompts = [];
      ctx.llm.setInternal(internalResponder({ 'structural-router': () => routerDecision('beam'), 'param-extractor': () => beamDraft(),
        'internal-other': text => { builderPrompts.push(text); return llmBuiltModel; } }));
      const turn = await runTurn(ctx, { message: MESSAGE, context: { locale: 'en', runPolicy: { profile: 'no-template-builder' } } },
        [toolCall('extract_draft_params', { locale: 'en' }, 'ntb-extract'), toolCall('build_model', {}, 'ntb-build'), 'DONE_no-template-builder']);
      expectCompletedTurn(turn, 'DONE_no-template-builder');
      expect(turn.requests.map(request => request.kind)).toContain('internal-other');
      expect(builderPrompts.length).toBeGreaterThan(0);
      const session = await ctx.backend.session(turn.conversationId);
      const events = ledgerFor(ctx, session.usage.runId).usage.events.filter(event => event.kind === 'model_builder');
      expect(events.map(event => event.builder)).toEqual(['llm']);
    }, TURN_TIMEOUT_MS);

    test('no-validation-gate: validate_model is not offered; normalization and the solver still run', async () => {
      ctx.llm.setInternal(null);
      const turn = await runTurn(ctx, { message: 'Analyze this supplied 10 m beam with OpenSees.',
        context: { locale: 'en', model: beamModel, modelFormat: 'structuremodel-v2', runPolicy: { profile: 'no-validation-gate' } } },
      [toolCall('run_analysis', beamAnalysis, 'nvg-analysis'), 'DONE_no-validation-gate']);
      expectCompletedTurn(turn, 'DONE_no-validation-gate');
      for (const request of turn.requests.filter(item => item.kind === 'agent')) {
        expect(request.body.tools.map(item => item.function.name)).not.toContain('validate_model');
      }
      expect(toolResultSeenByAgent(turn.requests, 'nvg-analysis')).toMatchObject({ success: true });
      expect(await ctx.backend.session(turn.conversationId)).toMatchObject({ analysis: { current: true } });
    }, TURN_TIMEOUT_MS);

    test('no-clarification: an incomplete request ends the turn with a missing-input list instead of an interrupt', async () => {
      const full = await extractorTurn('full', { draft: beamDraft(false), script: { message: INCOMPLETE } });
      expect(full.extraction).toMatchObject({ canProceed: false, nextAction: 'ask_user_clarification' });
      const ablated = await extractorTurn('no-clarification', { draft: beamDraft(false), script: { message: INCOMPLETE } });
      expect(ablated.extraction.criticalMissing).toEqual(expect.arrayContaining(['loadKN']));
      expect(ablated.extraction).toMatchObject({ canProceed: false, nextAction: 'report_missing_inputs' });
      expect(ablated.extraction.instruction).toContain('list these missing inputs in your final reply and end the turn');
      for (const request of ablated.turn.requests.filter(item => item.kind === 'agent')) {
        expect(request.body.tools.map(item => item.function.name)).not.toContain('ask_user_clarification');
        expect(systemPrompt(request.body)).not.toContain('ask_user_clarification');
      }
      const session = await ctx.backend.session(ablated.turn.conversationId);
      expect(session).toMatchObject({ waitingForReply: false, busy: false });
    }, TURN_TIMEOUT_MS);

    test('gated tools never appear in any prompt sent under their profile (agent, router, extractor, tool results)', async () => {
      const gating = PROFILE_IDS.map(profile => [profile, captured.full.tools.filter(item => !captured[profile].tools.includes(item))])
        .filter(([, removed]) => removed.length > 0);
      expect(gating.map(([profile]) => profile).sort()).toEqual(['no-clarification', 'no-validation-gate']);
      for (const [profile, removed] of gating) {
        for (const script of [{ draft: beamDraft() }, { draft: beamDraft(false), script: { message: INCOMPLETE } }]) {
          const { turn } = await extractorTurn(profile, script);
          expect(turn.requests.map(request => request.kind)).toEqual(expect.arrayContaining(['structural-router', 'param-extractor']));
          for (const request of turn.requests) {
            const text = requestText(request.body);
            for (const tool of removed) {
              expect({ profile, kind: request.kind, tool, mentioned: text.includes(tool) }).toEqual({ profile, kind: request.kind, tool, mentioned: false });
            }
          }
        }
      }
    }, TURN_TIMEOUT_MS * 4);

    const analyzeThenEdit = async profile => {
      ctx.llm.setInternal(null);
      const initial = await runTurn(ctx, { message: 'Analyze this supplied 10 m beam with OpenSees.',
        context: { locale: 'en', model: beamModel, modelFormat: 'structuremodel-v2', runPolicy: { profile } } },
      [toolCall('run_analysis', beamAnalysis, `${profile}-analysis`),
        toolCall('generate_report', { message: 'Report this beam', analysisType: 'static', locale: 'en', narrative: 'structured' }, `${profile}-report`),
        `ANALYZED_${profile}`]);
      expectCompletedTurn(initial, `ANALYZED_${profile}`);
      const before = await ctx.backend.session(initial.conversationId);
      const edit = await runTurn(ctx, { conversationId: initial.conversationId, message: 'Double the midpoint load to 2 kN. Do not recalculate.',
        context: { locale: 'en' } }, [
        toolCall('edit_model', { baseRevision: before.modelRevision, label: 'Double midpoint load',
          edits: [{ operation: 'update', collection: 'loads', caseId: 'LC1', id: 'midpoint-load', values: { fz: -2 } }] }, `${profile}-edit`),
        `EDITED_${profile}`]);
      expectCompletedTurn(edit, `EDITED_${profile}`);
      return { conversationId: initial.conversationId, before, edit, after: await ctx.backend.session(initial.conversationId) };
    };

    test('no-state-versioning: after edit_model the old analysis and report stay current; revisions are still recorded', async () => {
      const full = await analyzeThenEdit('full');
      expect(full.after).toMatchObject({ analysis: { current: false }, report: { current: false } });
      const ablated = await analyzeThenEdit('no-state-versioning');
      expect(ablated.after.modelRevision).toBeGreaterThan(ablated.before.modelRevision);
      expect(ablated.after.analysis).toMatchObject({ current: true, runId: ablated.before.analysis.runId });
      expect(ablated.after.report.current).toBe(true);
      expect(eventSignature(ablated.edit.events)).not.toContain('artifact:analysis:invalidated');
      expect(eventSignature(full.edit.events)).toContain('artifact:analysis:invalidated');
      const input = await ctx.backend.inputReview(ablated.conversationId);
      expect(input.model.load_cases[0].loads).toEqual([expect.objectContaining({ id: 'midpoint-load', fz: -2 })]);
      expect(input).toMatchObject({ analysisCurrent: true });
    }, TURN_TIMEOUT_MS * 2);

    test('no-evidence-binding: a report for a run with a different current model still renders and is flagged', async () => {
      const reportFor = async profile => {
        const { conversationId, before, after } = await analyzeThenEdit(profile);
        expect(after.analysis.current).toBe(false);
        const turn = await runTurn(ctx, { conversationId, message: 'Report the original run.', context: { locale: 'en' } }, [
          toolCall('generate_report', { message: 'Report the original run', analysisType: 'static', locale: 'en', narrative: 'structured',
            selection: { runId: before.analysis.runId, resultKey: 'case:LC1' } }, `${profile}-selected-report`), `REPORTED_${profile}`]);
        expectCompletedTurn(turn, `REPORTED_${profile}`);
        return toolResultSeenByAgent(turn.requests, `${profile}-selected-report`);
      };
      const loadOf = report => report.report.json.normalizedModel.load_cases[0].loads[0].fz;
      const full = await reportFor('full');
      expect(full).toMatchObject({ success: true });
      expect(full.report.json.meta).not.toHaveProperty('evidenceBinding');
      expect(loadOf(full)).toBe(-1); // bound to the run's own model snapshot
      const ablated = await reportFor('no-evidence-binding');
      expect(ablated).toMatchObject({ success: true, report: { json: { meta: { evidenceBinding: 'off' } } } });
      expect(loadOf(ablated)).toBe(-2); // the current (edited) model, never checked against the run
      expect(ablated.report.json.meta.source.modelHash).toBe(full.report.json.meta.source.modelHash);
    }, TURN_TIMEOUT_MS * 3);

    test('no-repair: a repeated failing model operation hits the exhausted recovery budget instead of retrying', async () => {
      const failTwice = async profile => {
        ctx.llm.setInternal(null);
        const edit = id => toolCall('edit_model', { baseRevision: 0, edits: [{ operation: 'update', collection: 'nodes', id: 'A', values: { x: 1 } }] }, id);
        const turn = await runTurn(ctx, { message: 'Move node A.', context: { locale: 'en', runPolicy: { profile } } },
          [edit(`${profile}-edit-1`), edit(`${profile}-edit-2`), `FAILED_${profile}`], { expectedToolErrors: 2 });
        expectCompletedTurn(turn, `FAILED_${profile}`);
        const session = await ctx.backend.session(turn.conversationId);
        return { second: JSON.stringify(toolResultSeenByAgent(turn.requests, `${profile}-edit-2`)), usage: ledgerFor(ctx, session.usage.runId).usage };
      };
      const full = await failTwice('full');
      expect(full.second).toContain('MODEL_REQUIRED');
      expect(full.usage.recoveries).toBe(0);
      const ablated = await failTwice('no-repair');
      expect(ablated.second).toContain('RECOVERY_BUDGET_EXHAUSTED');
      expect(ablated.usage.recoveries).toBe(0);
    }, TURN_TIMEOUT_MS);
  });
});

describe('characterization: SCLAW_RUN_PROFILE selects the profile for the backend process', () => {
  const env = {};
  beforeAll(async () => {
    env.llm = await startLlmFixture();
    env.backend = await startBackend({ llmBaseUrl: env.llm.baseUrl, pythonBin: resolveOpenSeesPython() ?? '',
      env: { SCLAW_RUN_PROFILE: 'no-knowledge' } });
  }, 120_000);
  afterAll(async () => {
    await env.backend?.close();
    await env.llm?.close();
  }, 60_000);

  test('a request without a profile runs under the env profile; a requested profile still wins', async () => {
    const profiles = await env.backend.get('/api/v1/agent/run-profiles');
    expect(profiles.body.envProfile).toBe('no-knowledge');
    const turn = await runTurn(env, { message: MESSAGE, context: { locale: 'en' } }, ['ENV_DONE']);
    expectCompletedTurn(turn, 'ENV_DONE');
    const session = await env.backend.session(turn.conversationId);
    expect(session.policy).toMatchObject({ profileId: 'no-knowledge', knowledge: 'disabled', fieldSources: { profileId: 'env', knowledge: 'env' } });
    const { descriptions } = await knowledgeSnippets();
    const prompt = systemPrompt(turn.requests[0].body);
    for (const description of descriptions) expect(prompt).not.toContain(description);

    const requested = await runTurn(env, { message: MESSAGE, context: { locale: 'en', runPolicy: { profile: 'full' } } }, ['REQUEST_DONE']);
    expect((await env.backend.session(requested.conversationId)).policy).toMatchObject({ profileId: 'full', knowledge: 'enabled',
      fieldSources: { profileId: 'request' } });
  }, TURN_TIMEOUT_MS);

  test('an unknown SCLAW_RUN_PROFILE stops the backend at startup', async () => {
    await expect(startBackend({ llmBaseUrl: env.llm.baseUrl, pythonBin: '', env: { SCLAW_RUN_PROFILE: 'no-such-profile' } }))
      .rejects.toThrow(/UNKNOWN_RUN_PROFILE/);
  }, 120_000);
});
