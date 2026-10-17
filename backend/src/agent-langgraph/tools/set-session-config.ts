import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import type { AgentState } from '../state.js';
import { invalidateStaleResults, staleResultsKept } from '../../engineering/model-state.js';
import { currentRunPolicy } from '../../runtime/run-context.js';
import { getConfigurable, getToolCallId, toolResult } from './shared.js';

const CHINA_SEISMIC_BASELINE_SKILL_IDS = [
  'generic',
  'frame',
  'concrete-frame',
  'opensees-seismic',
  'code-check-gb50011',
  'validation-structure-model',
  'report-export-builtin',
];

function parseSkillIdsJson(value: string): { ok: true; value: string[] } | { ok: false; error: string } {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
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

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (seen.has(value)) {
      return false;
    }
    seen.add(value);
    return true;
  });
}

function isChinaSeismicSessionConfig(args: {
  analysisType?: string;
  designCode?: string;
  skillIds: string[];
}): boolean {
  const designCode = (args.designCode || '').toUpperCase();
  return args.analysisType === 'seismic'
    || designCode.includes('50011')
    || designCode.includes('55002')
    || args.skillIds.includes('opensees-seismic')
    || args.skillIds.includes('code-check-gb50011');
}

function completeChinaSeismicSkillIds(skillIds: string[]): string[] {
  const requested = new Set(skillIds);
  return uniqueStrings([
    ...CHINA_SEISMIC_BASELINE_SKILL_IDS,
    ...skillIds.filter((skillId) => !CHINA_SEISMIC_BASELINE_SKILL_IDS.includes(skillId)),
  ]).filter((skillId) => requested.has(skillId) || CHINA_SEISMIC_BASELINE_SKILL_IDS.includes(skillId));
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
      const existingSkillIds = Array.isArray(state?.selectedSkillIds)
        ? state.selectedSkillIds.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        : [];
      let nextSkillIds: string[] | undefined;

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
        nextSkillIds = parsedSkillIds.value;
      }

      const nextAnalysisType = stateUpdate.policy?.analysisType ?? state?.policy?.analysisType;
      const nextDesignCode = stateUpdate.policy?.designCode ?? state?.policy?.designCode;
      const skillIdsForDecision = nextSkillIds ?? existingSkillIds;
      if (nextSkillIds !== undefined) {
        stateUpdate.selectedSkillIds = isChinaSeismicSessionConfig({
          analysisType: nextAnalysisType,
          designCode: nextDesignCode,
          skillIds: nextSkillIds,
        })
          ? completeChinaSeismicSkillIds(nextSkillIds)
          : uniqueStrings(nextSkillIds);
        updatedKeys.push('selectedSkillIds');
      } else if (isChinaSeismicSessionConfig({
        analysisType: nextAnalysisType,
        designCode: nextDesignCode,
        skillIds: skillIdsForDecision,
      })) {
        stateUpdate.selectedSkillIds = completeChinaSeismicSkillIds(skillIdsForDecision);
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

      const responseJson = {
        success: true,
        updatedKeys,
        message: `Updated: ${updatedKeys.join(', ') || 'nothing'}`,
      };

      // Only return Command if there are actual updates
      if (updatedKeys.length > 0) {
        if (input.analysisType && input.analysisType !== state?.policy?.analysisType || input.skillIdsJson) {
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
        'For China seismic analysis, set analysisType to seismic; the tool will keep the workflow-safe baseline skills for modeling, OpenSees seismic analysis, GB50011 code-check, validation, and reporting. ' +
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
          .describe('JSON array of skill IDs to select. For China seismic workflows, opensees-seismic or GB50011 selection is auto-completed with the required modeling, code-check, validation, and report baseline skills.'),
      }),
    },
  );
}
