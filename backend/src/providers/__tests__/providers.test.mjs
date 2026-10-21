import { describe, expect, test, jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listProviders } from '../../../dist/providers/catalog.js';
import { AgentSkillRuntime } from '../../../dist/agent-runtime/index.js';
import { createRunAnalysisTool, createRunCodeCheckTool, createSetSessionConfigTool } from '../../../dist/agent-langgraph/tools.js';
import { resolveRunPolicy } from '../../../dist/runtime/run-policy.js';
import { createRunContext, withRunContext } from '../../../dist/runtime/run-context.js';
import { engineeringKnowledge } from '../../../dist/engineering/knowledge.js';
import { buildGenericModelPrompt } from '../../../dist/agent-skills/structure-type/generic/llm-model-prompt.js';
import { beginAnalysisRequest } from '../../../dist/engineering/model-state.js';
import { readSettingsFile, writeSettingsFile } from '../../../dist/config/settings-file.js';
import { providerAccessError } from '../../../dist/providers/access.js';
import { resolveApplicationRunPolicy } from '../../../dist/agent-langgraph/policy-resolver.js';
import { buildSystemMessages } from '../../../dist/agent-langgraph/system-prompt.js';
import { buildParamExtractorPrompt } from '../../../dist/agent-langgraph/param-extractor.js';
import { executeAnalysisRun } from '../../../dist/engineering/analysis-runs.js';

const catalog = { availableSkillIds: ['beam', 'frame', 'generic'], structureTypeSkillIds: ['beam', 'frame', 'generic'],
  availableToolIds: ['run_analysis', 'run_code_check', 'set_session_config'], defaultToolIds: ['run_analysis', 'run_code_check', 'set_session_config'] };
const message = command => JSON.parse(command.update.messages[0].content);

describe('providers are independent of structure skills', () => {
  test('only the eight modelling methods remain skills; every provider is bilingual', async () => {
    const runtime = new AgentSkillRuntime();
    expect((await runtime.listSkillManifests()).map(skill => skill.id).sort())
      .toEqual(['beam', 'column', 'concrete-frame', 'double-span-beam', 'frame', 'generic', 'portal-frame', 'truss']);
    expect(new Set(listProviders().map(provider => provider.kind))).toEqual(new Set(['solver', 'design-code', 'input-parser', 'report-exporter']));
    for (const provider of listProviders()) for (const locale of ['en', 'zh']) {
      expect(provider.name[locale]).toBeTruthy(); expect(provider.description[locale]).toBeTruthy();
    }
    expect(runtime.resolvePreferredAnalysisSkill({ analysisType: 'static', skillIds: ['generic'] }).id).toBe('opensees-static');
  });

  test.each(['opensees-static', 'pkpm-static', 'yjk-static'])('run_analysis forwards explicit %s with generic alone and never substitutes an engine', async id => {
    const executeAnalysisSkill = jest.fn(async () => ({ skillId: id, result: { success: false, error_code: 'ENGINE_UNAVAILABLE' } }));
    const command = await createRunAnalysisTool({ executeAnalysisSkill }).invoke({ analysisType: 'static', analysisSkillId: id }, {
      toolCall: { id: 'solver' }, configurable: { agentState: { model: { nodes: [], elements: [], sections: [], materials: [] } }, toolContext: { skillScope: ['generic'] } },
    });
    expect(executeAnalysisSkill).toHaveBeenCalledTimes(1);
    expect(executeAnalysisSkill.mock.calls[0][0].analysisSkillId).toBe(id);
    expect(message(command).success).toBe(false);
    expect(message(command).errorCode).toBe('ENGINE_UNAVAILABLE');
  });

  test.each(['builtin-pkpm', 'builtin-yjk'])('unavailable %s retains its structured error across batched result storage', async engineId => {
    const invoke = jest.fn(async () => { throw Object.assign(new Error('Engine is unavailable'), { errorCode: 'ENGINE_UNAVAILABLE' }); });
    const result = await executeAnalysisRun({ type: 'static', engineId,
      model: { nodes: [], elements: [], materials: [], sections: [], load_cases: [
        { id: 'D', type: 'dead', loads: [] }, { id: 'L', type: 'live', loads: [] },
      ] }, parameters: {} }, invoke, async () => {});
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ success: false, error_code: 'ENGINE_UNAVAILABLE' });
    expect(Object.values(result.results).every(item => item.error_code === 'ENGINE_UNAVAILABLE')).toBe(true);
  });

  test('GB50017 is callable with generic alone', async () => {
    const runtime = new AgentSkillRuntime();
    const execute = jest.spyOn(runtime, 'executeCodeCheckSkill').mockResolvedValue({ result: { summary: { passed: 0, total: 0 }, details: [] } });
    const state = { model: { nodes: [], elements: [], sections: [], materials: [] } };
    const binding = beginAnalysisRequest(state, 'code-fixture');
    Object.assign(state, binding, { analysisResult: { success: true, meta: binding.analysisRequest, data: {} } });
    const command = await createRunCodeCheckTool(runtime).invoke({ designCode: 'GB50017', provider: 'builtin' }, {
      toolCall: { id: 'code' }, configurable: { agentState: state, toolContext: { skillScope: ['generic'] } },
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(command.update.codeCheckResult.meta.codeCheckSkillId).toBe('code-check-gb50017');
  });

  test('legacy API and saved policy ids become provider preferences and no-op text ids', () => {
    const previous = resolveRunPolicy({ ...catalog, legacy: { skillIds: ['generic', 'pkpm-static', 'code-check-gb50017', 'dead-load'] } });
    expect(previous.activeSkillIds).toEqual(['generic']);
    expect(previous.providers.preferredIds).toEqual(['pkpm-static', 'code-check-gb50017']);
    expect(resolveRunPolicy({ ...catalog, previous }).providers).toEqual(previous.providers);
    expect(resolveRunPolicy({ ...catalog, legacy: { skillIds: ['validation-structure-model', 'opensees-static'] } }).activeSkillIds).toEqual(['beam', 'frame', 'generic']);
  });

  test('set_session_config migrates provider ids without widening the skill scope or changing the frozen policy', async () => {
    const policy = resolveRunPolicy({ ...catalog, requested: { skillIds: ['generic'] } });
    const command = await createSetSessionConfigTool().invoke({ analysisType: 'seismic', skillIdsJson: '["opensees-seismic", "dead-load"]' }, {
      toolCall: { id: 'session' }, configurable: { agentState: { runPolicy: policy, selectedSkillIds: ['generic'], policy: {} } },
    });
    expect(command.update.selectedSkillIds).toBeUndefined();
    expect(command.update.runPolicy).toBeUndefined();
    expect(command.update.policy.analysisProviderPreference).toBe('opensees-seismic');
    expect(message(command).success).toBe(true);
  });

  test.each(['en', 'zh'])('knowledge switch removes shared guidance from all three injection sites (%s)', async locale => {
    const on = engineeringKnowledge(locale, ['loads', 'boundaries'], { knowledge: 'enabled' });
    expect(on).toBeTruthy();
    expect(engineeringKnowledge(locale, ['loads', 'boundaries'], { knowledge: 'disabled' })).toBe('');
    const disabled = createRunContext(resolveRunPolicy({ ...catalog, requested: { knowledge: 'disabled' } }));
    const prompt = withRunContext(disabled, () => buildGenericModelPrompt('structure', {}, locale));
    expect(prompt).not.toContain(on.split('\n')[0]);
    const plugin = await new AgentSkillRuntime().resolvePluginForType('generic');
    const extractor = withRunContext(disabled, () => buildParamExtractorPrompt(locale, undefined, plugin, 'structure'));
    expect(extractor).not.toContain(engineeringKnowledge('en', ['loads'], { knowledge: 'enabled' }));
    const system = buildSystemMessages({ state: { locale, selectedSkillIds: ['generic'], runPolicy: disabled.policy }, skillManifests: [] });
    expect(system[0].content).not.toContain(on.split('\n')[0]);
  });

  test('legacy settings migrate the sole budget; explicit provider disables cannot be bypassed', () => {
    const old = process.env.SCLAW_DATA_DIR;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sclaw-provider-settings-'));
    try {
      process.env.SCLAW_DATA_DIR = directory;
      fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify({ agent: { maxToolCallsPerTurn: 37 } }));
      const settings = readSettingsFile();
      expect(settings.agent.runPolicy.budgets.maxToolCallsPerTurn).toBe(37);
      expect(settings.agent.maxToolCallsPerTurn).toBeUndefined();
      writeSettingsFile({ agent: { runPolicy: { budgets: { maxToolCallsPerTurn: 37 }, context: { memoryScopes: [] } } } });
      const override = resolveApplicationRunPolicy({ availableSkillIds: ['generic'],
        requested: { budgets: { maxToolCallsPerTurn: 50 }, context: { memoryScopes: ['conversation'] } } });
      expect(override.context.memoryScopes).toEqual(['conversation']);
      expect(override.budgets.maxToolCallsPerTurn).toBe(50);
      writeSettingsFile({ agent: { runPolicy: { providers: { disabledIds: ['yjk-static'] } } } });
      expect(providerAccessError('yjk-static', resolveRunPolicy({ ...catalog, requested: { providers: { disabledIds: [] } } })))
        .toMatchObject({ error_code: 'ENGINE_UNAVAILABLE', reason: 'provider_disabled' });
    } finally {
      if (old === undefined) delete process.env.SCLAW_DATA_DIR; else process.env.SCLAW_DATA_DIR = old;
      if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir())) throw new Error('Unsafe test cleanup');
      fs.rmSync(directory, { recursive: true });
    }
  });
});
