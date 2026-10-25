import { canonicalDraftPath } from '../../agent-runtime/draft/legacy-fields.js';
import { computeDraftMissing, draftSectionConfirmations } from '../../agent-runtime/draft-readiness.js';
import { projectDraftState, verifyDraftSectionEvidence } from '../../agent-runtime/draft/boundary.js';
import { mergeDraftDiagnostics } from '../../agent-runtime/draft-diagnostics.js';
import { draftChangedFields, unappliedDraftFields, unresolvedAppliedFields } from '../../agent-runtime/draft/changes.js';
import { sectionMaterialNotes } from '../../agent-runtime/draft/materials.js';
import { templatePropertyIssues } from '../../agent-runtime/template-properties.js';
import { compactDraftToolPayload } from '../draft-tool-summary.js';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { AgentSkillRuntime } from '../../agent-runtime/index.js';
import type { LangGraphRunnableConfig, Command } from '@langchain/langgraph';
import { getLogger, logToolCall } from '../../utils/agent-logger.js';
import type { AgentState } from '../state.js';
import type { AgentConfigurable } from '../configurable.js';
import type { AgentSkillPlugin, DraftExtraction, DraftState, StructuralTypeMatch } from '../../shared/types/agent.js';
import { invalidateStaleResults } from '../../engineering/model-state.js';
import { isRecord } from '../../engineering/model-record.js';
import { EngineeringValidationError } from '../../engineering/validation-error.js';
import { bindVerifiedSectionTable } from '../../engineering/section-evidence.js';
import { mergeInputEvidence } from '../../engineering/input-evidence.js';
import { engineeringModelSchema, draftDesignSchema, hasDraftDesignInputs, assertDraftDesignInputs, draftSectionShapeSchema, normalizeDraftSectionInputs } from '../../engineering/model-edit-contract.js';
import { createLocalStructureProtocolClient } from '../../skill-shared/structure-protocol-execution.js';
import { currentRunPolicy, recordRunEvent } from '../../runtime/run-context.js';
import { requestScopeSchema, resolveExtractedScope, missingInputReason, type RequestScope, type ScopeDiagnostic } from '../../engineering/request-scope.js';
import { buildDraftProgress, buildClarificationQuestions, resolveRetryTaskMessage, detectStructuralTypeWithConfiguredLlm, semanticFailurePayload } from './draft-helpers.js';
import { conversationSectionEvidence, resolveExtractionInputMessage, resolveStructuralRoutingInputMessage, messageRole, messageText } from './input-message.js';
import { getConfigurable, getToolCallId, toolResult, nestedLlmUsageCollector, toolSkillScope } from './shared.js';

type ExtractionLocale = 'zh' | 'en';
type SkillMissing = ReturnType<typeof computeDraftMissing>;

type UsageListener = ReturnType<typeof nestedLlmUsageCollector>['onUsage'];

/** A saved type is reusable only after routing this turn's input. */
function currentTurnDetection(state: AgentState | undefined): StructuralTypeMatch | null {
  for (const message of [...(state?.messages ?? [])].reverse()) {
    const role = messageRole(message);
    const record = message as { name?: string; kwargs?: { name?: string } };
    const name = record.name ?? record.kwargs?.name;
    if (role === 'human' || role === 'user') return null;
    if (role === 'tool' && name === 'ask_user_clarification') return null;
    if (role === 'tool' && name === 'detect_structure_type') {
      try {
        const result = JSON.parse(messageText(message));
        if (result.success === false && !result.key) {
          throw new Error(typeof result.message === 'string' ? result.message
            : `${result.errorCode ?? 'LLM_STRUCTURAL_ROUTER_INVALID_OUTPUT'}: Structural routing failed / 结构路由失败`);
        }
        if (result.supportLevel === 'unsupported' && result.key && result.mappedType) return result;
        if (result.success !== false && result.key && result.mappedType && result.routingSource
          && result.supportLevel === 'supported' && result.skillId) return result;
        throw new Error('LLM_STRUCTURAL_ROUTER_INVALID_OUTPUT: Current routing result is incomplete; saved draft is unchanged / 本轮路由结果不完整，原草稿未修改。');
      } catch (error) {
        if (error instanceof SyntaxError) throw new Error('LLM_STRUCTURAL_ROUTER_INVALID_OUTPUT: Stored routing result is invalid; saved draft is unchanged / 已保存路由结果无效，原草稿未修改。', { cause: error });
        throw error;
      }
    }
  }
  return null;
}

/** Step 1: reuse the accepted structural type unless routing is fixed, else ask the configured LLM router. */
async function detectStructuralMatch(skillRuntime: AgentSkillRuntime, options: {
  detectedMatch: StructuralTypeMatch | null;
  existingState: DraftState | undefined;
  skillIds: string[] | undefined;
  routingMessage: string;
  locale: ExtractionLocale;
  signal: AbortSignal | undefined;
  onUsage: UsageListener;
}) {
  const { existingState, skillIds, routingMessage, locale, signal, onUsage } = options;
  // The outer LLM selects detect_structure_type for a structural change. Parameter
  // updates and clarification answers can reuse its previously accepted LLM route.
  const acceptedMatch: StructuralTypeMatch | null = existingState
    && ['llm-suggested', 'scope-selected'].includes(existingState.routingSource ?? '')
    && existingState.skillId && existingState.supportLevel === 'supported'
    && (skillIds === undefined || skillIds.includes(existingState.skillId))
    ? { key: existingState.structuralTypeKey ?? existingState.inferredType,
        mappedType: existingState.inferredType, skillId: existingState.skillId,
        supportLevel: existingState.supportLevel, routingSource: existingState.routingSource }
    : null;
  const detectedMatch = currentRunPolicy()?.routing.mode === 'fixed' ? null : options.detectedMatch ?? acceptedMatch;
  if (detectedMatch && !options.detectedMatch) {
    recordRunEvent({ kind: 'structural_routing', path: 'reused', key: detectedMatch.key, skillId: detectedMatch.skillId, source: detectedMatch.routingSource });
  }
  const match = detectedMatch ?? await detectStructuralTypeWithConfiguredLlm(skillRuntime, {
    message: routingMessage,
    locale,
    currentState: existingState,
    skillIds,
    signal,
    onUsage,
  });
  const matchedPlugin = match.skillId
    ? await skillRuntime.resolvePluginForType(match.skillId, skillIds)
    : null;
  return { detectedMatch, match, matchedPlugin };
}

/** Steps 3-4: LLM parameter extraction, then the handler pipeline (extractDraft → mergeState → computeMissing). */
async function extractAndMergeDraft(options: {
  input: { requestScope?: RequestScope };
  state: AgentState | undefined;
  existingState: DraftState | undefined;
  requestedScope: RequestScope | null | undefined;
  hasExistingDesign: boolean;
  configurable: ReturnType<typeof getConfigurable>;
  signal: AbortSignal | undefined;
  plugin: AgentSkillPlugin;
  match: StructuralTypeMatch;
  extractionMessage: string;
  locale: ExtractionLocale;
  log: ReturnType<typeof getLogger>;
  onUsage: UsageListener;
}) {
  const { input, state, existingState, requestedScope, hasExistingDesign, configurable, signal, plugin, match,
    extractionMessage, locale, log, onUsage } = options;
  // Step 3: Sub-agent extracts parameters (skill manifest driven)
  const { invokeParamExtractor } = await import('../param-extractor.js');
  // Only code-design input needs the full design schema in the extraction prompt.
  // Section inputs still cross the authoritative schema below before persistence.
  const protocolClient = configurable.structureProtocolClient ?? createLocalStructureProtocolClient();
  let designContract = requestedScope?.design === true || hasExistingDesign ? await engineeringModelSchema(protocolClient) : undefined;
  const { withStructuralTypeState } = await import('../../agent-runtime/plugin-helpers.js');
  const prepareDraft = async (draftPatch: Record<string, unknown>) => {
    const extracted = plugin.handler.extractDraft({ message: extractionMessage, locale, currentState: existingState,
      llmDraftPatch: draftPatch, structuralTypeMatch: match });
    // Bind draft reviews to the parser records before merge stamps resolution hashes.
    const patch = extracted.engineeringDraft ? { ...extracted, engineeringDraft: { ...extracted.engineeringDraft,
      inputEvidence: mergeInputEvidence(state?.inputEvidence, extracted.engineeringDraft.inputEvidence) } } : extracted;
    let nextState = withStructuralTypeState(plugin.handler.mergeState(existingState, patch), match);
    nextState = projectDraftState(verifyDraftSectionEvidence(nextState.engineeringDraft, { ...conversationSectionEvidence(state),
      inputEvidence: nextState.engineeringDraft?.inputEvidence ?? state?.inputEvidence }), nextState);
    if (nextState.engineeringDraft) {
      nextState = projectDraftState({ ...nextState.engineeringDraft,
        inputEvidence: bindVerifiedSectionTable([...(nextState.engineeringDraft.sectionRecords ?? []),
          ...(Array.isArray(nextState.engineeringDraft.model?.sections) ? nextState.engineeringDraft.model.sections.filter(isRecord) : [])],
        nextState.engineeringDraft.inputEvidence),
      }, nextState);
    }
    if (nextState.engineeringDraft?.sectionRecords?.length || Array.isArray(nextState.engineeringDraft?.model?.sections)) {
      designContract ??= await engineeringModelSchema(protocolClient);
      const normalized = normalizeDraftSectionInputs(nextState.engineeringDraft!, designContract);
      const projected = projectDraftState(normalized, nextState);
      nextState = { ...projected, ...mergeDraftDiagnostics(projected,
        { engineeringDraft: { sectionRecords: normalized.sectionRecords } }, projected) };
    }
    if (hasDraftDesignInputs(nextState.engineeringDraft)) {
      designContract ??= await engineeringModelSchema(protocolClient);
      assertDraftDesignInputs(nextState.engineeringDraft, designContract);
    }
    return { patch, nextState };
  };
  let prepared: Awaited<ReturnType<typeof prepareDraft>> | undefined;
  const draftPatch = await invokeParamExtractor({
    requestScope: requestedScope ?? undefined,
    message: extractionMessage,
    existingState,
    // Adding a response such as deflection still patches the same physical draft.
    // Only a changed design/report/output contract needs the full schema guidance.
    patchMode: Boolean(existingState?.engineeringDraft) && (!input.requestScope
      || input.requestScope.design === state?.requestScope?.design && input.requestScope.report === state?.requestScope?.report
        && JSON.stringify(input.requestScope.outputs) === JSON.stringify(state?.requestScope?.outputs)),
    locale,
    plugin,
    traceLogger: log,
    signal,
    onUsage,
    designSchema: designContract ? draftDesignSchema(designContract) : undefined,
    sectionShapeSchema: designContract ? draftSectionShapeSchema(designContract) : undefined,
    validatePatch: async candidate => {
      const result = await prepareDraft(candidate);
      const draft = result.nextState.engineeringDraft;
      if (plugin.structureType === 'frame' && plugin.id !== 'generic' && currentRunPolicy()?.builder !== 'llm'
        && !(Array.isArray(candidate.draftIssues) && candidate.draftIssues.length)) {
        const invalid = draft?.loads?.filter(load => load.target === 'column-top' && !load.location?.nodeRole && !load.selector
          && !draft.topology?.nodes?.some(node => node.id === load.target)
          && !(Array.isArray(state?.model?.nodes) && state.model.nodes.some(node => isRecord(node) && node.id === load.target)));
        if (invalid?.length) throw new EngineeringValidationError('FRAME_NODE_SELECTOR_INVALID: column-top is a single-column selector, not a frame node ID. Re-extract the supplied frame target into an exact node ID or location.nodeRole. If the user target is genuinely ambiguous, declare draftIssues instead of guessing an all-node group or asking for unrelated floor totals. / column-top仅限单柱；请把已给框架目标写为准确节点ID或nodeRole。只有用户目标确实不明确时才声明draftIssues，不得默认全节点或补问无关楼层总荷载');
      }
      if (plugin.id !== 'generic' && currentRunPolicy()?.builder !== 'llm' && !draft?.model
        && draft?.topology?.nodes?.length && draft.topology.members?.length && draft.loads?.length
        && draft.loads.every(load => load.direction !== undefined)
        && !draft.loadCases?.some(row => Array.isArray(row.loads) && row.loads.length)) {
        throw new EngineeringValidationError('DRAFT_EXPLICIT_LOAD_REPRESENTATION_INVALID: explicit topology already has confirmed source loads. Encode their exact node/member IDs, signs and positions in loadCases[].loads. Do not ask the user for internal identifiers or reconfirm the supplied force. / 显式拓扑已有已确认源荷载，请将准确实体编号、有符号分量及位置写入loadCases[].loads，不向用户索要内部编号或重复确认原荷载');
      }
      const evidence = conversationSectionEvidence(state);
      const confirmed = result.nextState.engineeringDraft?.sectionRecords?.some(section =>
        isRecord(section.extra) && isRecord(section.extra.confirmation));
      const issues = confirmed && evidence.confirmations?.length ? templatePropertyIssues(result.nextState) : [];
      const missingAssignment = issues.find(issue => /(?:beam|column|member)\.sectionId/.test(issue));
      if (missingAssignment && !(Array.isArray(candidate.draftIssues) && candidate.draftIssues.length)) {
        throw new Error(`MODEL_EDIT_FIELD_INVALID: ${missingAssignment}. Accepted sections must include templateAssignments.beam/column/member.sectionId using the stored section IDs and the roles already stated in the answered question. Repair the extraction; do not ask the user to confirm the same assignment again. If the supplied roles are genuinely ambiguous, declare that ambiguity in draftIssues. / 已确认截面须同时写入已说明的构件角色引用；修复提取，不重复要求用户确认。`);
      }
      // A complete template draft must also have valid generated references.
      // Feed representation errors back to the same LLM before publishing the
      // patch; internal node IDs and selectors are not new user facts.
      if (plugin.id !== 'generic' && plugin.manifest.domain === 'structure-type' && currentRunPolicy()?.builder !== 'llm'
        && computeDraftMissing(plugin, result.nextState, 'execution').critical.length === 0) {
        await plugin.handler.buildModel(structuredClone(result.nextState));
      }
      prepared = result;
    },
  });

  // Step 4: Handler pipeline (extractDraft → mergeState → computeMissing)
  const accepted = prepared ?? await prepareDraft(draftPatch);
  const patch = accepted.patch;
  const scopeDiagnostics: ScopeDiagnostic[] = [];
  const requestScope = resolveExtractedScope(input.requestScope, draftPatch?.requestScope, state?.requestScope, scopeDiagnostics);
  if (scopeDiagnostics.length) recordRunEvent({ kind: 'request_scope_diagnostic', source: 'parameter-extractor', diagnostics: scopeDiagnostics,
    resolvedBy: input.requestScope ? 'declared-request' : state?.requestScope ? 'accepted-request' : 'clarification' });
  const nextState = { ...accepted.nextState,
    ...(requestScope ? { requestScope } : {}) };
  const goalRequired = scopeDiagnostics.some(issue => issue.code === 'REQUEST_GOAL_REQUIRED');
  const missing = goalRequired ? { critical: ['requestScope'], optional: [] } : computeDraftMissing(plugin, nextState, 'execution');
  return { draftPatch, patch, scopeDiagnostics, requestScope, nextState, goalRequired, missing };
}

/** Graph-state update of the LLM extraction path: new draft, pending model, stale results invalidated. */
function llmExtractionStateUpdate(requestScope: RequestScope | undefined, nextState: DraftState, state: AgentState | undefined,
  match: StructuralTypeMatch): Partial<AgentState> {
  const stateUpdate: Partial<AgentState> = {};
  if (requestScope) stateUpdate.requestScope = requestScope;
  if (nextState) {
    const changed = draftChangedFields(state?.draftState ?? undefined, nextState).length > 0;
    if (changed) Object.assign(stateUpdate, invalidateStaleResults(state), { modelPending: true });
    // Diagnostics and sanitation still persist; only changed inputs invalidate computed results.
    stateUpdate.draftState = nextState;
    if (nextState.engineeringDraft?.inputEvidence) stateUpdate.inputEvidence = nextState.engineeringDraft.inputEvidence;
  }
  if (match.key) stateUpdate.structuralTypeKey = match.key;
  return stateUpdate;
}

/** A rejected route is feedback only; it never replaces an accepted draft or type. */
function unavailableRoutePayload(match: StructuralTypeMatch, locale: ExtractionLocale) {
  return {
    success: false,
    errorCode: match.supportLevel === 'unsupported' ? 'STRUCTURE_TYPE_UNSUPPORTED' : 'STRUCTURE_SKILL_UNAVAILABLE',
    criticalMissing: [],
    optionalMissing: [],
    clarificationQuestions: [],
    structuralTypeMatch: match,
    ...(match.scopeExclusion ? { scopeExclusion: match.scopeExclusion, supportNote: match.supportNote, userNotice: match.supportNote, mustDisclose: true } : {}),
    skillId: undefined,
    routingSource: match.routingSource,
    extractionMode: 'not-applicable',
    canProceed: false,
    nextAction: 'explain_capability_boundary',
    instruction: locale === 'zh'
      ? '本轮结构请求没有可用的建模技能，原有草稿未修改。说明能力边界并停止，不得改用其他技能或规则解析。'
      : 'No modeling skill is available for this structural request; the saved draft is unchanged. Explain the capability boundary and stop; do not substitute another skill or rule parser.',
  };
}

/** Response of the LLM extraction path: draft, missing input, scope and the next action. */
function buildLlmExtractionResponse(options: {
  nextState: DraftState;
  missing: SkillMissing;
  goalRequired: boolean;
  locale: ExtractionLocale;
  plugin: AgentSkillPlugin;
  match: StructuralTypeMatch;
  extractionMode: 'llm';
  requestScope: RequestScope | undefined;
  scopeDiagnostics: ScopeDiagnostic[];
  draftPatch: Record<string, unknown>;
  patch: DraftExtraction;
}) {
  const { nextState, missing, goalRequired, locale, plugin, match, extractionMode, requestScope, scopeDiagnostics,
    draftPatch, patch } = options;
  return {
    nextState,
    criticalMissing: missing.critical,
    optionalMissing: missing.optional,
    clarificationQuestions: goalRequired ? [{ paramKey: 'requestScope', label: locale === 'zh' ? '所求结果' : 'Requested results',
      question: locale === 'zh' ? '你需要内力/反力、位移/挠度，还是还需要规范设计或报告？已提供的梁跨度与荷载会保留。'
        : 'Do you need forces/reactions, displacement/deflection, or also code design or a report? The supplied span and loads are retained.',
      required: true, critical: true }] : buildClarificationQuestions(plugin, missing.critical, missing.optional, nextState, locale),
    structuralTypeMatch: match,
    ...(match.scopeExclusion ? { scopeExclusion: match.scopeExclusion, supportNote: match.supportNote, userNotice: match.supportNote, mustDisclose: true } : {}),
    skillId: plugin.id,
    routingSource: match.routingSource,
    extractionMode,
    requestScope,
    ...(scopeDiagnostics.length ? { scopeDiagnostics } : {}),
    missingReasons: missing.critical.map(field => ({ field, reason: missingInputReason(field, requestScope, locale) })),
    llmDraftPatch: draftPatch ?? null,
    appliedDraftUpdate: { clearedFields: patch.clearDraftFields ?? [], order: 'clear-then-merge' },
    unapplied: [...unappliedDraftFields(patch, nextState, draftPatch ?? undefined),
      ...(Array.isArray(draftPatch?.unapplied) ? draftPatch.unapplied : [])],
    engineeringDraft: nextState.engineeringDraft ?? patch.engineeringDraft ?? null,
    sectionConfirmations: draftSectionConfirmations(nextState),
    extractionSource: typeof nextState.skillState?.extractionSource === 'string'
      ? nextState.skillState.extractionSource
      : 'llm-draft-patch',
    ...buildDraftProgress(locale, missing.critical),
  };
}

export function createExtractDraftParamsTool(skillRuntime: AgentSkillRuntime) {
  return tool(
    async (input: {
      message?: string;
      locale?: string;
      requestScope?: RequestScope;
    }, config: LangGraphRunnableConfig) => {
      const log = getLogger(config.configurable as Partial<AgentConfigurable> | undefined);
      const start = Date.now();
      const configurable = getConfigurable(config);
      const state = configurable.agentState;
      const toolCallId = getToolCallId(config);

      const requestedScope = input.requestScope ?? state?.requestScope;
      const existingState = state?.draftState ? { ...state.draftState, ...(requestedScope ? { requestScope: requestedScope } : {}) } : undefined;
      const hasExistingDesign = hasDraftDesignInputs(existingState?.engineeringDraft);
      const skillIds = toolSkillScope(config);
      const locale = (input.locale ?? state?.locale ?? 'zh') as 'zh' | 'en';
      const message = resolveExtractionInputMessage(input.message, state?.lastUserMessage, state?.messages);
      const extractionMessage = resolveRetryTaskMessage(message);
      const routingMessage = resolveRetryTaskMessage(resolveStructuralRoutingInputMessage(input.message, state?.lastUserMessage, state?.messages));
      const nestedUsage = nestedLlmUsageCollector();
      const extractionToolResult = (
        content: string,
        stateUpdate?: Partial<AgentState>,
      ): Command => {
        const payload = JSON.parse(content) as Record<string, unknown>;
        const rawDraft = payload.llmDraftPatch as { engineeringDraft?: DraftState['engineeringDraft'] } | undefined;
        const notes = [...sectionMaterialNotes(existingState?.engineeringDraft), ...sectionMaterialNotes(rawDraft?.engineeringDraft)];
        const summary = compactDraftToolPayload({ ...payload, ...(notes.length ? { notes } : {}) }, state?.draftState ?? undefined,
          stateUpdate?.draftState ?? undefined);
        recordRunEvent({ kind: 'draft_extraction_result', applied: summary.applied ?? [], unapplied: summary.unapplied ?? [],
          status: summary.status ?? 'failed', payloadChars: JSON.stringify(summary).length });
        return toolResult(
          toolCallId,
          'extract_draft_params',
          JSON.stringify(summary),
          stateUpdate,
          nestedUsage.total(),
        );
      };

      try {
        // Step 1: Detect structural type
        log.debug({
          hasLastUserMessage: !!state?.lastUserMessage,
          messageCount: Array.isArray(state?.messages) ? state.messages.length : 0,
          inputMessagePreview: input.message?.slice(0, 120),
          resolvedMessagePreview: message.slice(0, 120),
          extractionMessagePreview: extractionMessage.slice(0, 120),
        }, 'extract_draft_params resolved message');
        const { detectedMatch, match, matchedPlugin } = await detectStructuralMatch(skillRuntime, {
          detectedMatch: currentTurnDetection(state), existingState, skillIds, routingMessage, locale,
          signal: config.signal, onUsage: nestedUsage.onUsage,
        });
        log.debug({
          detectedKey: match.key,
          detectedSkillId: match.skillId,
          routingSource: match.routingSource,
          reusedDetection: detectedMatch !== null,
          matchedPluginId: matchedPlugin?.id,
        }, 'extract_draft_params structural match');

        // Early return when no skill matched
        if (!match.skillId || match.supportLevel !== 'supported') {
          logToolCall(log, { tool: 'extract_draft_params', durationMs: Date.now() - start, success: false, extra: { skillId: undefined, routingSource: match.routingSource } });
          return extractionToolResult(JSON.stringify(unavailableRoutePayload(match, locale)));
        }

        // Step 2: Resolve plugin
        const plugin = matchedPlugin;
        if (!plugin) {
          logToolCall(log, { tool: 'extract_draft_params', durationMs: Date.now() - start, success: false, extra: { skillId: match.skillId, pluginResolved: false, routingSource: match.routingSource } });
          return extractionToolResult(JSON.stringify(unavailableRoutePayload(match, locale)));
        }

        const { draftPatch, patch, scopeDiagnostics, requestScope, nextState, goalRequired, missing } = await extractAndMergeDraft({
          input, state, existingState, requestedScope, hasExistingDesign, configurable, signal: config.signal,
          plugin, match, extractionMessage, locale, log, onUsage: nestedUsage.onUsage,
        });
        const extractionMode = 'llm';
        const previouslyMissing = new Set(existingState ? computeDraftMissing(plugin, existingState, 'execution').critical.map(canonicalDraftPath) : []);
        const unresolved = unresolvedAppliedFields(patch, nextState, missing.critical.filter(field => previouslyMissing.has(canonicalDraftPath(field))));
        if (unresolved.length) {
          const fault = { success: false, errorCode: 'FIELD_CONTRACT_UNRESOLVED', unresolved,
            criticalMissing: missing.critical, clarificationQuestions: [], nextAction: 'report_internal_error',
            message: locale === 'zh' ? '系统未能将你已提供的答案映射到必填字段，这是系统错误，不需要你重复回答。'
              : 'The system failed to map your supplied answer to a required field. This is a system error; do not repeat your answer.',
            instruction: 'Tell the user about this internal mapping failure and stop. Do not ask again or bypass validation. / 请说明内部映射失败并停止，不得再次追问或绕过校验。' };
          recordRunEvent({ kind: 'field_contract_unresolved', ...fault });
          return extractionToolResult(JSON.stringify(fault));
        }

        // Missing engineering input is a clarification state, not a failed extraction.
        // Repeating the same evidence cannot supply user-omitted properties and must
        // not consume the semantic recovery budget. Invalid LLM output is handled
        // separately inside invokeParamExtractor.

        const extractedResponse = buildLlmExtractionResponse({ nextState, missing, goalRequired, locale, plugin, match, extractionMode,
          requestScope, scopeDiagnostics, draftPatch, patch });
        const responseJson = state?.model && extractedResponse.canProceed ? {
          ...extractedResponse, nextAction: 'query_model', instruction: locale === 'zh'
            ? '先 query_model 获取最新版本与对象 ID。已有模型的局部修改通过 edit_model 完成；若用户明确授权整体重建，保留全部已确认输入，再调用 build_model({mode:"rebuild",baseRevision:最新版本})。不要把整体重建当作局部编辑，也不要仅因草稿变化就默认重建。'
            : 'First query_model for the latest revision and object IDs. Apply local changes through edit_model. If the user authorized complete reconstruction, preserve all confirmed inputs, then call build_model({mode:"rebuild",baseRevision:latestRevision}). Do not treat reconstruction as a local edit or infer rebuild authorization merely from changed draft fields.',
        } : extractedResponse;

        const stateUpdate = llmExtractionStateUpdate(requestScope, nextState, state, match);

        logToolCall(log, { tool: 'extract_draft_params', durationMs: Date.now() - start, extra: { skillId: plugin.id, extractionMode: responseJson.extractionMode, criticalMissing: missing.critical.length, routingSource: match.routingSource } });
        return extractionToolResult(JSON.stringify(responseJson), stateUpdate);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logToolCall(log, { tool: 'extract_draft_params', durationMs: Date.now() - start, success: false, extra: { error: errorMessage } });
        const failure = semanticFailurePayload(errorMessage);
        if (failure) return extractionToolResult(JSON.stringify(failure));
        throw error;
      }
    },
    {
      name: 'extract_draft_params',
      description:
        'Extract structural engineering parameters from a user message and merge them into the draft state. ' +
        'Reads existing draft state from conversation state automatically — do NOT pass it as a parameter. ' +
        'For a user-authorized complete rebuild, merge the full confirmed input history and the requested changes; then use build_model mode="rebuild" with the latest queried model revision. Ordinary local edits use query_model/edit_model. / 用户授权整体重建时，合并完整已确认历史输入及新要求，再以最新查询版本调用 build_model 的 rebuild 模式；局部修改走 query_model/edit_model。 ' +
        'Returns applied field paths, unapplied values/reasons, missing fields and the next action; full state stays in conversation state. A no_change result means do not repeat extraction with the same evidence. / 返回已应用字段、未应用原因、缺项和下一步；完整草稿保留在会话状态。no_change 时不要用相同证据重复提取。 ' +
        'Use actual user answers as evidence. Explicit user properties win; dimensions alone use shape with provenance.shape="user" and system-derived sharp-corner properties. A designation alone needs one dimension question together with other missing inputs. Assistant-recalled shape/properties are pending llm-table candidates, labelled "assistant-recalled table value, please verify"; never use them before actual user confirmation. After confirmation retain user-sourced dimensions, omit recalled properties. Known grades get elastic constants and density; unmentioned self-weight is not a question (default excluded). / 仅使用真实用户答复；用户属性优先，仅尺寸由系统按尖角推导。仅型号须将尺寸与其他缺项合并询问一次；记忆值标记llm-table及“助手记忆的标准表值，请核对”，实际确认前不可计算，确认后尺寸标记user并省略记忆属性。已知牌号补弹性常数和密度；未提自重不追问，默认不计。',
      schema: z.object({
        message: z.string().describe('The user message to extract parameters from').optional(),
        locale: z.enum(['zh', 'en']).optional().describe('User locale'),
        requestScope: requestScopeSchema.optional().describe('Current user goal, not the full engineering workflow. Preserve scope while receiving missing-input answers. / 本次用户所求结果；补参数时保留范围。'),
      }),
    },
  );
}
