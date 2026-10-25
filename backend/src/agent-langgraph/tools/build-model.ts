import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import type { AgentSkillRuntime } from '../../agent-runtime/index.js';
import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import { getLogger, logToolCall } from '../../utils/agent-logger.js';
import type { AgentConfigurable } from '../configurable.js';
import { normalizeEngineeringModel } from '../../engineering/model-boundary.js';
import { assertConfirmedSectionInputs, SectionConfirmationRequiredError } from '../../engineering/section-provenance.js';
import { draftSectionConfirmations } from '../../agent-runtime/draft-readiness.js';
import { verifyDraftSectionEvidence, projectDraftState } from '../../agent-runtime/draft/boundary.js';
import { mergeInputEvidence } from '../../engineering/input-evidence.js';
import { normalizeDraftTopologyReleases } from '../../agent-runtime/engineering-draft.js';
import { MemberReleaseValidationError } from '../../engineering/member-releases.js';
import { assertDraftSectionPurposes, DraftSectionValidationError } from '../../engineering/draft-sections.js';
import { buildModelToolSummary, buildModelToolStateUpdate } from './compaction/analysis.js';
import { conversationSectionEvidence, modellingConversationHistory } from './input-message.js';
import { getConfigurable, getToolCallId, toolResult, isRecord, toolSkillScope, nextActionForMissingInput, clarificationAvailable } from './shared.js';

export function createBuildModelTool(skillRuntime: AgentSkillRuntime) {
  return tool(
    async (input: { mode?: 'preserve' | 'rebuild'; baseRevision?: number }, config: LangGraphRunnableConfig) => {
      const log = getLogger(config.configurable as Partial<AgentConfigurable> | undefined);
      const start = Date.now();
      const configurable = getConfigurable(config);
      const state = configurable.agentState;
      const toolCallId = getToolCallId(config);
      const rebuilding = input.mode === 'rebuild';
      if (rebuilding && state?.model && (input.baseRevision === undefined || input.baseRevision !== (state.modelRevision ?? 0))) {
        return toolResult(toolCallId, 'build_model', JSON.stringify({ success: false, modelBuilt: false,
          errorCode: 'MODEL_VERSION_CONFLICT', expectedRevision: state.modelRevision ?? 0, nextAction: 'query_model',
          instruction: 'Read the current model revision with query_model before rebuilding. Rebuild only when the user authorized replacing the complete model, preserving all confirmed inputs. / 重建前先用 query_model 获取当前模型版本。仅在用户明确要求整体重建时使用，并保留全部已确认输入。' }));
      }

      // Read draft state from graph state channel
      const storedDraft = state?.draftState;
      if (!storedDraft) {
        throw new Error('No draft state available. Run extract_draft_params first.');
      }
      let savedDraft = storedDraft;
      try {
        assertDraftSectionPurposes(storedDraft.engineeringDraft?.sectionRecords);
        if (storedDraft.engineeringDraft) savedDraft = projectDraftState({ ...storedDraft.engineeringDraft,
          topology: normalizeDraftTopologyReleases(storedDraft.engineeringDraft.topology) }, storedDraft);
      } catch (error) {
        if (error instanceof DraftSectionValidationError) return toolResult(toolCallId, 'build_model', JSON.stringify({
          success: false, modelBuilt: false, errorCode: 'DRAFT_PROTOCOL_INVALID', field: error.field, error: error.message,
          nextAction: 'extract_draft_params', repair: { clearDraftFields: [error.field] },
          instruction: 'Repair this invalid draft field from the original user input with extract_draft_params before building. Clear only this invalid field and provide its corrected definition; preserve all other confirmed inputs. Do not ask the user to repeat known input. / 建模前依据原始用户输入修正该草稿协议字段，只清除上述无效字段并合并正确定义，保留其余已确认输入，不重复追问已知信息。',
        }));
        if (!(error instanceof MemberReleaseValidationError)) throw error;
        return toolResult(toolCallId, 'build_model', JSON.stringify({ success: false, modelBuilt: false,
          errorCode: 'DRAFT_PROTOCOL_INVALID', field: error.releaseField, error: error.message,
          nextAction: 'extract_draft_params', repair: { clearDraftFields: error.clearable ? [error.invalidField] : [], conflicting: error.conflicting },
          instruction: 'Repair this invalid draft representation from the original user input with extract_draft_params. Clear only a reported clearable field before merging its corrected definition; preserve all other release flags, geometry, supports, loads and section values. Do not ask the user to repeat known input. Conflicting definitions and unsupported release axes require authoritative resolution; never choose values or drop reference axes automatically. / 请依据原始用户输入修复草稿协议，只显式清除报告中可清除的无效字段再合并正确定义，保留其余释放标记、几何、支承、荷载和截面数值，不重复追问已知输入；冲突定义和不支持的释放坐标轴须核对原始依据，不得自行选择数值或删除坐标轴定义。' }));
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
          currentModel: rebuilding ? undefined : state?.model ?? undefined,
          conversationHistory: modellingConversationHistory(state?.messages),
          sectionEvidence: userTexts,
          signal: config.signal,
        });
      } catch (error) {
        const { ModelInputRequiredError } = await import('../../agent-skills/structure-type/generic/llm-model-builder.js');
        const { ModelPhysicsError } = await import('../../engineering/model-physics.js');
        const { ModellingOperationError } = await import('../../skill-shared/modelling/contract.js');
        if (error instanceof ModellingOperationError) return toolResult(toolCallId, 'build_model', JSON.stringify({ success: false,
          errorCode: error.code, modelBuilt: false, terminal: true, error: error.message, details: error.details, nextAction: 'explain_failure',
          instruction: 'Modelling operations remain invalid after repair. Explain the unresolved geometry, targets or identities; do not claim a successful calculation. / 修正后建模操作仍无效，请说明未解决的几何、目标或标识，不得声称计算成功。' }));
        if (error instanceof ModelPhysicsError) return toolResult(toolCallId, 'build_model', JSON.stringify({
          success: false, errorCode: error.code, modelBuilt: false, terminal: true, ...error.check, nextAction: 'explain_failure',
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
      const summary: Record<string, unknown> = { ...buildModelToolSummary(model, state?.locale || 'zh'), ...(rebuilding ? { buildMode: 'rebuild' } : {}) };
      const success = summary.success !== false;
      logToolCall(log, { tool: 'build_model', durationMs: Date.now() - start, success, extra: summary });
      return toolResult(
        toolCallId,
        'build_model',
        JSON.stringify(summary),
        { ...buildModelToolStateUpdate(model, summary, state),
          ...(success && !isDeepStrictEqual(savedDraft, storedDraft) ? { draftState: savedDraft } : {}) },
      );
    },
    {
      name: 'build_model',
      description:
        'Build a computable structural model from the current draft state. ' +
        'Reads draft state from conversation state automatically — do NOT pass it as a parameter. ' +
        'For a user-authorized complete reconstruction (e.g. a changed spatial topology), extract all confirmed inputs, query_model for the latest revision, then set mode="rebuild" and baseRevision. This builds a new candidate and replaces the saved model only after validation succeeds. Ordinary local changes use query_model/edit_model; never use rebuild to bypass a failed edit or silently replace loads. / 用户明确要求整体重建时，先提取全部已确认输入、查询最新版本，再传 mode="rebuild" 与 baseRevision；仅校验成功后替换原模型。局部修改使用 query_model/edit_model，不得借重建绕过失败编辑或静默替换荷载。 ' +
        'Returns the model if all critical parameters are present, or an error if the draft is incomplete.',
      schema: z.object({
        mode: z.enum(['preserve', 'rebuild']).optional().describe('Defaults to preserve. Choose rebuild only for user-authorized complete reconstruction from the confirmed draft; it does not inherit the existing model. / 默认保留已有模型上下文；仅用户授权整体重建时选 rebuild，依据已确认草稿生成新模型。'),
        baseRevision: z.number().int().nonnegative().optional().describe('Required with mode="rebuild" when a model exists: latest revision from query_model. / 已有模型整体重建时必填，使用 query_model 返回的最新版本。'),
      }),
    },
  );
}
