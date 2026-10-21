import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { AgentSkillRuntime } from '../../agent-runtime/index.js';
import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import { getLogger, logToolCall } from '../../utils/agent-logger.js';
import type { AgentConfigurable } from '../configurable.js';
import { normalizeEngineeringModel } from '../../engineering/model-boundary.js';
import { assertConfirmedSectionInputs, SectionConfirmationRequiredError } from '../../engineering/section-provenance.js';
import { draftSectionConfirmations } from '../../agent-runtime/draft-readiness.js';
import { verifyDraftSectionEvidence } from '../../agent-runtime/draft/boundary.js';
import { mergeInputEvidence } from '../../engineering/input-evidence.js';
import { buildModelToolSummary, buildModelToolStateUpdate } from './compaction/analysis.js';
import { conversationSectionEvidence, messageRole, messageText } from './input-message.js';
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
      const savedDraft = state?.draftState;
      if (!savedDraft) {
        throw new Error('No draft state available. Run extract_draft_params first.');
      }
      const skillIds = toolSkillScope(config);
      const userTexts = conversationSectionEvidence(state);
      const draftState = { ...savedDraft, engineeringDraft: verifyDraftSectionEvidence(savedDraft.engineeringDraft
        ? { ...savedDraft.engineeringDraft, inputEvidence: mergeInputEvidence(savedDraft.engineeringDraft.inputEvidence, state?.inputEvidence) }
        : undefined, userTexts) };
      assertConfirmedSectionInputs({ sections: draftState.engineeringDraft?.model?.sections ?? draftState.engineeringDraft?.sectionRecords }, userTexts);
      const pendingSections = draftSectionConfirmations(draftState);
      if (pendingSections.length) throw new SectionConfirmationRequiredError(pendingSections);

      let candidate: Record<string, unknown> | undefined;
      try {
        candidate = await skillRuntime.buildModel(draftState, skillIds, {
          message: state?.lastUserMessage || '',
          locale: state?.locale || 'zh',
          currentModel: state?.model ?? undefined,
          conversationHistory: state?.messages.map((message) => `${messageRole(message)}: ${messageText(message)}`).join('\n'),
          sectionEvidence: userTexts,
        });
      } catch (error) {
        const { ModelInputRequiredError } = await import('../../agent-skills/structure-type/generic/llm-model-builder.js');
        const { ModelPhysicsError } = await import('../../engineering/model-physics.js');
        const { ModellingOperationError } = await import('../../skill-shared/modelling/contract.js');
        if (error instanceof ModellingOperationError) return toolResult(toolCallId, 'build_model', JSON.stringify({ success: false,
          errorCode: error.code, modelBuilt: false, details: error.details, nextAction: nextActionForMissingInput(),
          instruction: 'Modelling operations remain invalid after repair. Explain the unresolved geometry, targets or identities; do not claim a successful calculation. / 修正后建模操作仍无效，请说明未解决的几何、目标或标识，不得声称计算成功。' }));
        if (error instanceof ModelPhysicsError) return toolResult(toolCallId, 'build_model', JSON.stringify({
          success: false, errorCode: error.code, modelBuilt: false, ...error.check, nextAction: nextActionForMissingInput(),
          instruction: 'Automatic repair ended with these physical diagnostics. Explain the unresolved inputs together; do not claim a valid model or calculation. / 自动修正结束后仍有这些物理诊断；请一次说明未解决输入，不得声称模型或计算已完成。',
        }));
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
      let model: Record<string, unknown>;
      try {
        model = await normalizeEngineeringModel({ ...candidate, metadata: { ...metadata,
          inputEvidence: mergeInputEvidence(state?.inputEvidence, Array.isArray(metadata.inputEvidence) ? metadata.inputEvidence.filter(isRecord) : []) } }, configurable.structureProtocolClient, undefined, userTexts);
      } catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith('INPUT_EVIDENCE_MODEL_FIELD_NOT_FOUND_OR_AMBIGUOUS:')) throw error;
        const preview = (collection: unknown, keys: string[]) => Array.isArray(collection)
          ? collection.filter(isRecord).slice(0, 50).map(row => Object.fromEntries(keys.map(key => [key, row[key]]))) : [];
        return toolResult(toolCallId, 'build_model', JSON.stringify({ success: false, modelBuilt: false,
          errorCode: 'INPUT_EVIDENCE_MODEL_FIELD_NOT_FOUND_OR_AMBIGUOUS', error: error.message,
          hint: 'Review the evidence against these candidate IDs, then build again. This preview is not an accepted model. / 请按候选模型的实际 ID 复核证据后重新建模；此预览不是已接受的模型。',
          availableNodes: preview(candidate.nodes, ['id', 'x', 'y', 'z']),
          availableElements: preview(candidate.elements, ['id', 'nodes']),
        }));
      }

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
