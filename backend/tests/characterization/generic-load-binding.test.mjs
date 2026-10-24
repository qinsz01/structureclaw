import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { startBackend, resolveOpenSeesPython } from './helpers/backend-host.mjs';
import { startLlmFixture, toolCall } from './helpers/llm-fixture.mjs';
import { genericLoadBindingFixture } from '../fixtures/generic-load-binding.mjs';

describe('source-load identity repair through the public conversation API', () => {
  let llm, backend;
  beforeAll(async () => {
    const pythonBin = resolveOpenSeesPython();
    if (!pythonBin) throw new Error('This full engineering regression requires the configured OpenSees runtime.');
    llm = await startLlmFixture();
    backend = await startBackend({ llmBaseUrl: llm.baseUrl, pythonBin });
  }, 120_000);
  afterAll(async () => { await backend?.close(); await llm?.close(); }, 60_000);

  const context = locale => ({ locale, runPolicy: { builder: 'llm', skillIds: ['generic'],
    routing: { mode: 'fixed', skillId: 'generic' }, repair: { enabled: true, maxRecoveriesPerTurn: 2 } } });

  test('invalid IDs, then an unbound case, are corrected by LLM responses before a real solve and saved report', async () => {
    const fixture = genericLoadBindingFixture();
    const saved = structuredClone(fixture.draft);
    let attempts = 0;
    llm.setInternal((body, request) => {
      if (request.kind === 'param-extractor') return JSON.stringify(fixture.draft);
      const candidate = structuredClone(fixture.model);
      const prompt = body.messages.map(message => message.content).join('\n');
      attempts++;
      if (attempts === 1) candidate.metadata.loadMappings[0].loadId = 'ORIGINAL-ROOF-DL-S3-E2';
      else if (attempts === 2) {
        expect(prompt).toContain('availableLoadIds');
        expect(prompt).toContain('ORIGINAL-ROOF-DL-S3-E2');
        delete candidate.metadata.loadMappings[0].caseId;
      } else expect(prompt).toContain('LOAD_MAPPING_CASE_REQUIRED');
      return JSON.stringify(candidate);
    });
    llm.enqueue(toolCall('extract_draft_params', { locale: 'en' }), toolCall('build_model', {}),
      toolCall('validate_model', {}), toolCall('run_analysis', { analysisType: 'static', analysisSkillId: 'opensees-static' }),
      toolCall('generate_report', { message: 'Export the confirmed analysis.', analysisType: 'static', locale: 'en', narrative: 'structured' }), 'Analysis completed.');
    const turn = await backend.stream({ message: `These are explicitly confirmed inputs. Build, validate, analyze and report without changing their values: ${JSON.stringify(fixture.draft)}`, context: context('en') });
    expect(turn.errors).toEqual([]);
    expect(llm.failures).toEqual([]);
    expect(attempts).toBe(3);
    const session = await backend.session(turn.conversationId);
    expect(session.modeling.usedSkillIds).toEqual(['generic']);
    expect(session.analysis.current).toBe(true);
    expect(session.report.current).toBe(true);
    const run = (await backend.get(`/runs/${session.analysis.runId}`)).body;
    expect(Object.keys(run.results).sort()).toEqual(Object.keys(fixture.totals).sort());
    for (const [key, force] of Object.entries(fixture.totals)) {
      const result = run.results[key];
      expect(result.success).toBe(true);
      expect(result.meta.engineId).toBe('builtin-opensees');
      expect(result.meta.fallbackFrom).toBe(null);
      const reaction = Object.values(result.data.reactions).reduce((sum, value) => sum + value.fz, 0);
      expect(Math.abs(reaction - force)).toBeLessThan(1e-3);
    }
    expect(fixture.draft).toEqual(saved);
  }, 120_000);

  test('exhausted repair publishes the specific Chinese diagnosis and never publishes a model, solve or report', async () => {
    const fixture = genericLoadBindingFixture();
    let attempts = 0;
    llm.setInternal((_body, request) => {
      if (request.kind === 'param-extractor') return JSON.stringify(fixture.draft);
      attempts++;
      const candidate = structuredClone(fixture.model);
      candidate.metadata.loadMappings[0].loadId = 'ORIGINAL-ROOF-DL-S3-E2';
      return JSON.stringify(candidate);
    });
    llm.enqueue(toolCall('extract_draft_params', { locale: 'zh' }), toolCall('build_model', {}));
    const turn = await backend.stream({ message: `以下输入均已明确确认，请保持原值并建模分析：${JSON.stringify(fixture.draft)}`, context: context('zh') });
    const error = JSON.stringify(turn.errors);
    expect(error).toContain('LOAD_MAPPING_ID_INVALID');
    expect(error).toContain('ORIGINAL-ROOF-DL-S3-E2');
    expect(error).toContain('原始已确认荷载编号');
    expect(error).not.toContain('MODEL_PHYSICS_INVALID: MODEL_PHYSICS_INVALID');
    expect(attempts).toBe(3);
    expect(llm.failures).toEqual([]);
    const session = await backend.session(turn.conversationId);
    expect(session.analysis.current).toBe(false);
    expect(session.report.current).toBe(false);
    expect((await backend.inputReview(turn.conversationId)).model).toBe(null);
  }, 120_000);
});
