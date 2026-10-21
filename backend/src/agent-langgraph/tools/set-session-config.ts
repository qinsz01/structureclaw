import { migrateLegacySkillIds } from '../../shared/legacy-capabilities.js';
import { getProvider } from '../../providers/catalog.js';
import { AgentSkillLoader } from '../../agent-runtime/loader.js';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import type { AgentState } from '../state.js';
import { invalidateStaleResults, staleResultsKept } from '../../engineering/model-state.js';
import { currentRunPolicy } from '../../runtime/run-context.js';
import { getConfigurable, getToolCallId, toolResult } from './shared.js';

function parseSkillIdsJson(value: string): { ok: true; value: string[] } | { ok: false; error: string } {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string' || !item.trim())) {
      return { ok: false, error: 'skillIdsJson must be a JSON array of strings.' };
    }
    return {
      ok: true,
      value: parsed
        .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        .map((item) => item.trim()),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function createSetSessionConfigTool() {
  return tool(
    async (input: {
      analysisType?: string;
      designCode?: string;
      skillIdsJson?: string;
    }, config: LangGraphRunnableConfig) => {
      const state = getConfigurable(config).agentState;
      const toolCallId = getToolCallId(config);

      const updatedKeys: string[] = [];
      const stateUpdate: Partial<AgentState> = {};
      let nextSkillIds: string[] | undefined;
      let preferredProviderIds: string[] = [];
      if (input.analysisType) {
        stateUpdate.policy = {
          ...(state?.policy || {}),
          analysisType: input.analysisType as 'static' | 'dynamic' | 'seismic' | 'nonlinear',
        };
        updatedKeys.push('analysisType');
      }
      if (input.designCode) {
        stateUpdate.policy = {
          ...(state?.policy || {}),
          ...(stateUpdate.policy || {}),
          designCode: input.designCode,
        };
        updatedKeys.push('designCode');
      }
      if (input.skillIdsJson) {
        const parsedSkillIds = parseSkillIdsJson(input.skillIdsJson);
        if (!parsedSkillIds.ok) {
          return toolResult(toolCallId, 'set_session_config', JSON.stringify({
            success: false,
            error_code: 'INVALID_SKILL_IDS_JSON',
            message: parsedSkillIds.error,
          }));
        }
        const migrated = migrateLegacySkillIds(parsedSkillIds.value);
        preferredProviderIds = migrated.preferredProviderIds;
        // Provider/text-only selections keep the current structure scope.
        nextSkillIds = parsedSkillIds.value.length && !migrated.skillIds.length ? undefined : migrated.skillIds;
      }

      if (nextSkillIds !== undefined) {
        const known = new Set(new AgentSkillLoader().loadBundles().filter(skill => skill.domain === 'structure-type').map(skill => skill.id));
        const unknown = nextSkillIds.filter(id => !known.has(id) && !state?.runPolicy?.activeSkillIds.includes(id));
        if (unknown.length) return toolResult(toolCallId, 'set_session_config', JSON.stringify({ success: false,
          error_code: 'INVALID_SKILL_IDS', deniedSkillIds: unknown,
          message: 'Only structure-type skills may be selected.', messageZh: '仅可选择结构类型技能。' }));
        stateUpdate.selectedSkillIds = nextSkillIds;
        updatedKeys.push('selectedSkillIds');
      }

      const runPolicy = currentRunPolicy() ?? state?.runPolicy;
      if (runPolicy && stateUpdate.selectedSkillIds) {
        const outside = stateUpdate.selectedSkillIds.filter(id => !runPolicy.activeSkillIds.includes(id));
        const fixed = runPolicy.routing.mode === 'fixed' ? runPolicy.routing.skillId : undefined;
        if (outside.length || fixed && !stateUpdate.selectedSkillIds.includes(fixed)) {
          return toolResult(toolCallId, 'set_session_config', JSON.stringify({ success: false,
            error_code: 'SKILL_SCOPE_IMMUTABLE', deniedSkillIds: outside,
            message: 'Session selection cannot widen the run scope or remove its fixed modeling provider.' }));
        }
      }

      if (preferredProviderIds.length) {
        const providers = preferredProviderIds.map(getProvider);
        const analysis = providers.find(provider => provider?.kind === 'solver'
          && (!input.analysisType || provider.analysisType === input.analysisType));
        const code = providers.find(provider => provider?.kind === 'design-code');
        stateUpdate.policy = { ...state?.policy, ...stateUpdate.policy,
          ...(analysis ? { analysisProviderPreference: analysis.id } : {}),
          ...(code ? { codeCheckProviderPreference: code.id } : {}) };
        updatedKeys.push('providerPreferences');
      }

      const responseJson = {
        success: true,
        updatedKeys,
        message: `Updated: ${updatedKeys.join(', ') || 'nothing'}`,
      };

      // Only return Command if there are actual updates
      if (updatedKeys.length > 0) {
        if (input.analysisType && input.analysisType !== state?.policy?.analysisType || stateUpdate.selectedSkillIds
          || stateUpdate.policy?.analysisProviderPreference && stateUpdate.policy.analysisProviderPreference !== state?.policy?.analysisProviderPreference) {
          Object.assign(stateUpdate, invalidateStaleResults(state));
        } else if (input.designCode && input.designCode !== state?.policy?.designCode && !staleResultsKept(state)) {
          stateUpdate.codeCheckResult = null;
          stateUpdate.report = null;
        }
        return toolResult(toolCallId, 'set_session_config', JSON.stringify(responseJson), stateUpdate);
      }
      return JSON.stringify(responseJson);
    },
    {
      name: 'set_session_config',
      description:
        'Update current-session configuration: analysis type (static/dynamic/seismic/nonlinear), ' +
        'design code (GB50010/GB50011/GB50017), or selected skill IDs. ' +
        'Only structure-type skills may be selected. Legacy provider IDs become provider preferences without changing the structure scope. ' +
        'This does not create persistent memory.',
      schema: z.object({
        analysisType: z
          .enum(['static', 'dynamic', 'seismic', 'nonlinear'])
          .optional()
          .describe('Analysis type to set'),
        designCode: z
          .string()
          .optional()
          .describe('Design code to set (e.g. GB50017, GB/T 50011-2010-2024)'),
        skillIdsJson: z
          .string()
          .optional()
          .describe('JSON array of structure-type skill IDs. Providers are selected through run_analysis/run_code_check arguments; legacy provider IDs are migrated to preferences.'),
      }),
    },
  );
}
