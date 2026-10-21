import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { AgentSkillRuntime } from '../../agent-runtime/index.js';
import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import { assertInputEvidenceMatchesModel } from '../../engineering/input-evidence.js';
import { resolveRequestedAnalysisEngineId, normalizeAnalysisType } from './analysis-resolution.js';
import { getConfigurable, toolSkillScope } from './shared.js';
import { getAnalysisSkillCatalogEntry } from '../../providers/analysis-catalog.js';

export function createValidateModelTool(skillRuntime: AgentSkillRuntime) {
  return tool(
    async (input: { engineId?: string }, config: LangGraphRunnableConfig) => {
      const configurable = getConfigurable(config);
      const state = configurable.agentState;
      // Read model from graph state channel
      const model = state?.model;
      if (!model) {
        return JSON.stringify({ error: 'No model available. Run build_model first.' });
      }
      assertInputEvidenceMatchesModel(model, state?.inputEvidence);
      const skillIds = toolSkillScope(config);
      const analysisType = normalizeAnalysisType(state?.policy?.analysisType);
      const preferred = getAnalysisSkillCatalogEntry(state?.policy?.analysisProviderPreference);
      const requestedEngineId = preferred && (!analysisType || preferred.analysisType === analysisType) ? preferred.engineId
        : resolveRequestedAnalysisEngineId(state?.lastUserMessage, skillIds, analysisType);
      const result = await skillRuntime.executeValidationSkill({
        model,
        engineId: input.engineId || requestedEngineId,
        structureProtocolClient: configurable.structureProtocolClient,
      });
      // Keep output compact — trim large model echo from validation result
      const compact: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(result as Record<string, unknown>)) {
        if (k === 'input') {
          compact[k] = { model: '(model stored in state)' };
        } else {
          compact[k] = v;
        }
      }
      return JSON.stringify(compact);
    },
    {
      name: 'validate_model',
      description:
        'Validate the current structural model for correctness (connectivity, geometry, loads). ' +
        'Reads the model from conversation state automatically — do NOT pass it as a parameter. ' +
        'Returns validation errors and warnings.',
      schema: z.object({
        engineId: z.string().optional().describe('Optional analysis engine ID'),
      }),
    },
  );
}
