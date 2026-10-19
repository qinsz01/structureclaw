import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { AgentSkillRuntime } from '../../agent-runtime/index.js';
import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import { getLogger, logToolCall } from '../../utils/agent-logger.js';
import type { AgentConfigurable } from '../configurable.js';
import { normalizeEngineeringModel } from '../../engineering/model-boundary.js';
import { assertConfirmedSectionInputs } from '../../engineering/section-provenance.js';
import { mergeInputEvidence } from '../../engineering/input-evidence.js';
import { buildModelToolSummary, buildModelToolStateUpdate } from './compaction/analysis.js';
import { messageRole, messageText } from './input-message.js';
import { getConfigurable, getToolCallId, toolResult, isRecord, toolSkillScope, nextActionForMissingInput, clarificationAvailable } from './shared.js';

export function createBuildModelTool(skillRuntime: AgentSkillRuntime) {
  return tool(
    async (_input: Record<string, unknown>, config: LangGraphRunnableConfig) => {
      const log = getLogger(config.configurable as Partial<AgentConfigurable> | undefined);
      const start = Date.now();
      const configurable = getConfigurable(config);
      const state = configurable.agentState;
      const toolCallId = getToolCallId(config);

      // Read draft state from graph state channel
      const draftState = state?.draftState;
      if (!draftState) {
        throw new Error('No draft state available. Run extract_draft_params first.');
      }
      const skillIds = toolSkillScope(config);
      assertConfirmedSectionInputs({ sections: draftState.engineeringDraft?.model?.sections ?? draftState.engineeringDraft?.sectionRecords });

      let candidate: Record<string, unknown> | undefined;
      try {
        candidate = await skillRuntime.buildModel(draftState, skillIds, {
          message: state?.lastUserMessage || '',
          locale: state?.locale || 'zh',
          currentModel: state?.model ?? undefined,
          conversationHistory: state?.messages.map((message) => `${messageRole(message)}: ${messageText(message)}`).join('\n'),
        });
      } catch (error) {
        const { ModelInputRequiredError } = await import('../../agent-skills/structure-type/generic/llm-model-builder.js');
        if (!(error instanceof ModelInputRequiredError)) throw error;
        // An identified missing fact is a normal clarification state, not an
        // invalid candidate or a reason to consume the automatic-repair budget.
        return toolResult(toolCallId, 'build_model', JSON.stringify({ status: 'input_required', modelBuilt: false,
          missingFields: error.missingFields, nextAction: nextActionForMissingInput(),
          instruction: clarificationAvailable()
            ? 'Ask for these missing facts, then extract the new answer before building. The saved model is unchanged. / 请询问这些缺失信息，收到新答复后再提取建模；原模型未变。'
            : 'List these missing facts in your final reply and end the turn; never invent values. The saved model is unchanged. / 在最终回复中列出这些缺失信息并结束本轮，不得编造数值；原模型未变。' }));
      }
      if (!candidate) {
        logToolCall(log, { tool: 'build_model', durationMs: Date.now() - start, extra: { success: false } });
        throw new Error('MODEL_BUILD_UNAVAILABLE: the selected builder did not produce a model. Inspect the active modeling skill and builder diagnostics before continuing; do not repeat extraction without new user input / 所选建模器未生成模型；请检查当前建模技能和诊断，不要在没有新用户输入时重复提取。');
      }
      const metadata = isRecord(candidate.metadata) ? candidate.metadata : {};
      const model = await normalizeEngineeringModel({ ...candidate, metadata: { ...metadata,
        inputEvidence: mergeInputEvidence(state?.inputEvidence, Array.isArray(metadata.inputEvidence) ? metadata.inputEvidence.filter(isRecord) : []) } }, configurable.structureProtocolClient);

      // Store model in graph state via Command.
      // Keep ToolMessage content compact — full model lives in graph state.
      // The streaming layer reads model from nodeState for artifact_payload_sync.
      const summary = buildModelToolSummary(model, state?.locale || 'zh');
      const success = summary.success !== false;
      logToolCall(log, { tool: 'build_model', durationMs: Date.now() - start, success, extra: summary });
      return toolResult(
        toolCallId,
        'build_model',
        JSON.stringify(summary),
        buildModelToolStateUpdate(model, summary, state),
      );
    },
    {
      name: 'build_model',
      description:
        'Build a computable structural model from the current draft state. ' +
        'Reads draft state from conversation state automatically — do NOT pass it as a parameter. ' +
        'Returns the model if all critical parameters are present, or an error if the draft is incomplete.',
      schema: z.object({}),
    },
  );
}
