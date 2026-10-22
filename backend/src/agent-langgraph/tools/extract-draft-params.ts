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
import { bindVerifiedSectionTable } from '../../engineering/section-evidence.js';
import { mergeInputEvidence } from '../../engineering/input-evidence.js';
import { engineeringModelSchema, draftDesignSchema, hasDraftDesignInputs, assertDraftDesignInputs, draftSectionShapeSchema, normalizeDraftSectionInputs } from '../../engineering/model-edit-contract.js';
import { createLocalStructureProtocolClient } from '../../skill-shared/structure-protocol-execution.js';
import { currentRunPolicy, recordRunEvent } from '../../runtime/run-context.js';
import { requestScopeSchema, resolveExtractedScope, missingInputReason, type RequestScope, type ScopeDiagnostic } from '../../engineering/request-scope.js';
import { buildDraftProgress, buildClarificationQuestions, shouldPreserveExistingDraftState, resolveRetryTaskMessage, buildPreservedDraftExtractionResult, resolveExistingDraftPlugin, detectStructuralTypeWithConfiguredLlm } from './draft-helpers.js';
import { conversationSectionEvidence, resolveExtractionInputMessage, messageRole, messageText } from './input-message.js';
import { getConfigurable, getToolCallId, toolResult, nestedLlmUsageCollector, toolSkillScope } from './shared.js';

type ExtractionLocale = 'zh' | 'en';
type SkillMissing = ReturnType<typeof computeDraftMissing>;

type UsageListener = ReturnType<typeof nestedLlmUsageCollector>['onUsage'];

/** A saved type is reusable only after routing this turn's input. */
function currentTurnDetection(state: AgentState | undefined): StructuralTypeMatch | null {
  for (const message of [...(state?.messages ?? [])].reverse()) {
    const role = messageRole(message);
    if (role === 'human' || role === 'user') return null;
    if (role === 'tool' && message.name === 'ask_user_clarification') return null;
    if (role === 'tool' && message.name === 'detect_structure_type') {
      try {
        const result = JSON.parse(messageText(message));
        return result.key && result.mappedType && result.routingSource && result.supportLevel ? result : null;
      } catch { return null; }
    }
  }
  return null;
}

/** Step 1: reuse the accepted structural type unless routing is fixed, else ask the configured LLM router. */
async function detectStructuralMatch(skillRuntime: AgentSkillRuntime, options: {
  detectedMatch: StructuralTypeMatch | null;
  existingState: DraftState | undefined;
  skillIds: string[] | undefined;
  extractionMessage: string;
  locale: ExtractionLocale;
  signal: AbortSignal | undefined;
  onUsage: UsageListener;
}) {
  const { existingState, skillIds, extractionMessage, locale, signal, onUsage } = options;
  // The outer LLM selects detect_structure_type for a structural change. Parameter
  // updates and clarification answers can reuse its previously accepted LLM route.
  const acceptedMatch: StructuralTypeMatch | null = existingState?.routingSource === 'llm-suggested'
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
    message: extractionMessage,
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

/** A conflicting route does not replace an accepted draft: answer from the existing draft's plugin. */
async function preserveExistingDraft(
  skillRuntime: AgentSkillRuntime,
  existingState: DraftState,
  match: StructuralTypeMatch,
  skillIds: string[] | undefined,
  matchedPlugin: AgentSkillPlugin | null,
  locale: ExtractionLocale,
) {
  const preservationPlugin = await resolveExistingDraftPlugin(
    skillRuntime,
    existingState,
    skillIds,
    matchedPlugin,
  );
  return buildPreservedDraftExtractionResult({
    existingState,
    structuralTypeMatch: match,
    plugin: preservationPlugin,
    locale,
  });
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
  const prepareDraft = async (draftPatch: Record<string, unknown> | null) => {
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
      const evidence = conversationSectionEvidence(state);
      const confirmed = result.nextState.engineeringDraft?.sectionRecords?.some(section =>
        isRecord(section.extra) && isRecord(section.extra.confirmation));
      const issues = confirmed && evidence.confirmations?.length ? templatePropertyIssues(result.nextState) : [];
      const missingAssignment = issues.find(issue => /(?:beam|column|member)\.sectionId/.test(issue));
      if (missingAssignment && !(Array.isArray(candidate.draftIssues) && candidate.draftIssues.length)) {
        throw new Error(`MODEL_EDIT_FIELD_INVALID: ${missingAssignment}. Accepted sections must include templateAssignments.beam/column/member.sectionId using the stored section IDs and the roles already stated in the answered question. Repair the extraction; do not ask the user to confirm the same assignment again. If the supplied roles are genuinely ambiguous, declare that ambiguity in draftIssues. / 已确认截面须同时写入已说明的构件角色引用；修复提取，不重复要求用户确认。`);
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

/** No skill matched the message: keep the draft and ask for the structure type. */
function unmatchedSkillOutcome(existingState: DraftState | undefined, match: StructuralTypeMatch, locale: ExtractionLocale) {
  const nextState = {
    ...(existingState || { inferredType: 'unknown' as const }),
    structuralTypeKey: match.key,
    supportLevel: match.supportLevel,
    supportNote: match.supportNote,
    routingSource: match.routingSource,
    updatedAt: Date.now(),
  };
  const responseJson = {
    nextState,
    criticalMissing: ['inferredType'],
    optionalMissing: [],
    clarificationQuestions: [],
    structuralTypeMatch: match,
    ...(match.scopeExclusion ? { scopeExclusion: match.scopeExclusion, supportNote: match.supportNote, userNotice: match.supportNote, mustDisclose: true } : {}),
    skillId: undefined,
    routingSource: match.routingSource,
    extractionMode: 'not-applicable',
    ...buildDraftProgress(locale, ['inferredType']),
    ...(match.scopeExclusion ? { success: false, errorCode: 'STRUCTURE_SKILL_DISABLED', criticalMissing: [], canProceed: false, nextAction: 'explain_capability_boundary', instruction: match.supportNote } : {}),
  };
  const stateUpdate: Partial<AgentState> = { draftState: nextState };
  if (match.key) stateUpdate.structuralTypeKey = match.key;
  return { responseJson, stateUpdate };
}

/** A skill matched but its plugin is not available in this scope. */
function unavailablePluginOutcome(existingState: DraftState | undefined, match: StructuralTypeMatch, locale: ExtractionLocale) {
  const nextState: DraftState = existingState == null
    ? { inferredType: 'unknown' as const, routingSource: match.routingSource, updatedAt: Date.now() }
    : { ...(existingState as DraftState), routingSource: match.routingSource, updatedAt: Date.now() };
  const responseJson = {
    nextState,
    criticalMissing: ['inferredType'],
    optionalMissing: [],
    clarificationQuestions: [],
    structuralTypeMatch: match,
    ...(match.scopeExclusion ? { scopeExclusion: match.scopeExclusion, supportNote: match.supportNote, userNotice: match.supportNote, mustDisclose: true } : {}),
    skillId: undefined,
    routingSource: match.routingSource,
    extractionMode: 'unavailable',
    ...buildDraftProgress(locale, ['inferredType']),
    ...(match.scopeExclusion ? { success: false, errorCode: 'STRUCTURE_SKILL_DISABLED', criticalMissing: [], canProceed: false, nextAction: 'explain_capability_boundary', instruction: match.supportNote } : {}),
  };
  return { responseJson, nextState };
}

/** Response of the LLM extraction path: draft, missing input, scope and the next action. */
function buildLlmExtractionResponse(options: {
  nextState: DraftState;
  missing: SkillMissing;
  goalRequired: boolean;
  locale: ExtractionLocale;
  plugin: AgentSkillPlugin;
  match: StructuralTypeMatch;
  extractionMode: 'llm' | 'deterministic';
  requestScope: RequestScope | undefined;
  scopeDiagnostics: ScopeDiagnostic[];
  draftPatch: Record<string, unknown> | null;
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
    unapplied: [...unappliedDraftFields(patch, nextState),
      ...(Array.isArray(draftPatch?.unapplied) ? draftPatch.unapplied : [])],
    engineeringDraft: nextState.engineeringDraft ?? patch.engineeringDraft ?? null,
    sectionConfirmations: draftSectionConfirmations(nextState),
    extractionSource: typeof nextState.skillState?.extractionSource === 'string'
      ? nextState.skillState.extractionSource
      : (draftPatch ? 'llm-draft-patch' : 'deterministic'),
    ...buildDraftProgress(locale, missing.critical),
  };
}

/** Invalid router/extractor output is returned to the model for a retry; other errors propagate. */
function invalidLlmOutputPayload(errorMessage: string): Record<string, unknown> | undefined {
  if (
    !(
      errorMessage.startsWith('LLM_PARAM_EXTRACTOR_INVALID_OUTPUT:')
      || errorMessage.startsWith('LLM_STRUCTURAL_ROUTER_INVALID_OUTPUT:')
    )
  ) {
    return undefined;
  }
  const errorCode = errorMessage.startsWith('LLM_PARAM_EXTRACTOR_INVALID_OUTPUT:')
    ? 'LLM_PARAM_EXTRACTOR_INVALID_OUTPUT'
    : 'LLM_STRUCTURAL_ROUTER_INVALID_OUTPUT';
  return {
    success: false,
    errorCode,
    message: errorMessage,
    nextAction: 'retry_extraction',
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
          { ...stateUpdate, ...(stateUpdate?.requestScope || requestedScope ? { requestScope: stateUpdate?.requestScope ?? requestedScope } : {}),
            ...(stateUpdate?.draftState ? { draftState: { ...stateUpdate.draftState,
              ...(stateUpdate.requestScope || requestedScope ? { requestScope: stateUpdate.requestScope ?? requestedScope } : {}) } } : {}) },
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
          detectedMatch: currentTurnDetection(state), existingState, skillIds, extractionMessage, locale,
          signal: config.signal, onUsage: nestedUsage.onUsage,
        });
        log.debug({
          detectedKey: match.key,
          detectedSkillId: match.skillId,
          routingSource: match.routingSource,
          reusedDetection: detectedMatch !== null,
          matchedPluginId: matchedPlugin?.id,
        }, 'extract_draft_params structural match');

        if (shouldPreserveExistingDraftState(existingState, match, message)) {
          const preserved = await preserveExistingDraft(skillRuntime, existingState, match, skillIds, matchedPlugin, locale);
          logToolCall(log, {
            tool: 'extract_draft_params',
            durationMs: Date.now() - start,
            extra: {
              preservedExistingDraft: true,
              previousSkillId: existingState.skillId,
              rejectedSkillId: match.skillId,
              rejectedKey: match.key,
              rejectedRoutingSource: match.routingSource,
            },
          });
          return extractionToolResult(
            JSON.stringify(preserved.responseJson),
            preserved.stateUpdate,
          );
        }

        // Early return when no skill matched
        if (!match.skillId) {
          const { responseJson, stateUpdate } = unmatchedSkillOutcome(existingState, match, locale);
          logToolCall(log, { tool: 'extract_draft_params', durationMs: Date.now() - start, extra: { skillId: undefined, criticalMissing: 1, routingSource: match.routingSource } });
          return extractionToolResult(JSON.stringify(responseJson), stateUpdate);
        }

        // Step 2: Resolve plugin
        const plugin = matchedPlugin;
        if (!plugin) {
          const { responseJson, nextState } = unavailablePluginOutcome(existingState, match, locale);
          logToolCall(log, { tool: 'extract_draft_params', durationMs: Date.now() - start, extra: { skillId: match.skillId, pluginResolved: false, routingSource: match.routingSource } });
          return extractionToolResult(JSON.stringify(responseJson), { draftState: nextState });
        }

        const { draftPatch, patch, scopeDiagnostics, requestScope, nextState, goalRequired, missing } = await extractAndMergeDraft({
          input, state, existingState, requestedScope, hasExistingDesign, configurable, signal: config.signal,
          plugin, match, extractionMessage, locale, log, onUsage: nestedUsage.onUsage,
        });
        const extractionMode = draftPatch ? 'llm' : 'deterministic';
        const previouslyMissing = new Set(existingState ? computeDraftMissing(plugin, existingState, 'execution').critical.map(canonicalDraftPath) : []);
        const unresolved = unresolvedAppliedFields(patch, nextState, missing.critical.filter(field => previouslyMissing.has(canonicalDraftPath(field))));
        if (unresolved.length) {
          const fault = { success: false, errorCode: 'FIELD_CONTRACT_UNRESOLVED', unresolved,
            criticalMissing: missing.critical, clarificationQuestions: [], nextAction: 'report_internal_error',
            message: locale === 'zh' ? '系统未能将你已提供的答案映射到必填字段，这是系统错误，不需要你重复回答。'
              : 'The system failed to map your supplied answer to a required field. This is a system error; do not repeat your answer.',
            instruction: 'Tell the user about this internal mapping failure and stop. Do not ask again or bypass validation. / 请说明内部映射失败并停止，不得再次追问或绕过校验。' };
          recordRunEvent({ kind: 'field_contract_unresolved', ...fault });
          return extractionToolResult(JSON.stringify(fault), llmExtractionStateUpdate(requestScope, nextState, state, match));
        }

        // Missing engineering input is a clarification state, not a failed extraction.
        // Repeating the same evidence cannot supply user-omitted properties and must
        // not consume the semantic recovery budget. Invalid LLM output is handled
        // separately inside invokeParamExtractor.

        const responseJson = buildLlmExtractionResponse({ nextState, missing, goalRequired, locale, plugin, match, extractionMode,
          requestScope, scopeDiagnostics, draftPatch, patch });

        const stateUpdate = llmExtractionStateUpdate(requestScope, nextState, state, match);

        logToolCall(log, { tool: 'extract_draft_params', durationMs: Date.now() - start, extra: { skillId: plugin.id, extractionMode: responseJson.extractionMode, criticalMissing: missing.critical.length, routingSource: match.routingSource } });
        return extractionToolResult(JSON.stringify(responseJson), stateUpdate);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logToolCall(log, { tool: 'extract_draft_params', durationMs: Date.now() - start, success: false, extra: { error: errorMessage } });
        const invalidOutput = invalidLlmOutputPayload(errorMessage);
        if (invalidOutput) return extractionToolResult(JSON.stringify(invalidOutput));
        throw error;
      }
    },
    {
      name: 'extract_draft_params',
      description:
        'Extract structural engineering parameters from a user message and merge them into the draft state. ' +
        'Reads existing draft state from conversation state automatically — do NOT pass it as a parameter. ' +
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
