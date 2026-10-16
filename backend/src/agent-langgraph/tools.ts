/**
 * LangGraph tool definitions for the StructureClaw ReAct agent.
 *
 * Tools read dependencies from config.configurable (AgentConfigurable)
 * and state from the graph state via config.configurable.agentState.
 *
 * Artifact-writing tools (build_model, run_analysis, etc.) return
 * Command({ update }) objects to write directly into graph state channels,
 * eliminating the need for an extract_artifacts intermediary node.
 *
 * Custom streaming events are emitted via config.writer for real-time
 * tool status updates to the frontend.
 */
import { randomUUID } from 'node:crypto';
import { normalizeClarificationOptions } from '../utils/clarification-options.js';
import { nativeDesignRecord, resolveCheckProvider, type CodeCheckProvider } from '../engineering/native-design.js';
import { savedNativeDesignRecord } from '../engineering/native-design-options.js';
import { resultEngine } from '../engineering/result-data.js';
import { computeDraftMissing } from '../agent-runtime/draft-readiness.js';
import { ANALYSIS_SKILL_IDS } from '../agent-skills/analysis/catalog.js';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { AgentSkillRuntime } from '../agent-runtime/index.js';
import { type LangGraphRunnableConfig, Command, interrupt } from '@langchain/langgraph';
import { getLogger, logToolCall } from '../utils/agent-logger.js';
import type { AgentState } from './state.js';
import type { AgentConfigurable } from './configurable.js';
import type { DraftState } from '../shared/types/agent.js';
import { isFreshGenericStructuralRoute } from '../agent-runtime/plugin-helpers.js';
import { loadAnalysisRun, analysisSettingsHash } from '../engineering/analysis-runs.js';
import { resultSelectionSchema, selectedSavedResult, quantityMatchesSelection, type ResultSelection } from '../engineering/result-selection.js';
import { createEngineeringReport, attachNativeReport } from '../agent-runtime/engineering-report.js';
import { beginAnalysisRequest, beginNativeDesignRequest, currentAnalysisError, invalidateAnalysis, modelHash, publishAnalysis, publishNativeDesign } from '../engineering/model-state.js';
import { normalizeEngineeringModel } from '../engineering/model-boundary.js';
import { engineeringModelSchema, draftDesignSchema, hasDraftDesignInputs, assertDraftDesignInputs, draftSectionShapeSchema, normalizeDraftSectionInputs } from '../engineering/model-edit-contract.js';
import { createLocalStructureProtocolClient } from '../skill-shared/structure-protocol-execution.js';
import { checkRunResults, codeCheckFeedback, validateServiceabilitySelection } from '../engineering/code-checks.js';
import { assertAnalysisInputEvidenceMatchesRequest, assertInputEvidenceMatchesModel, mergeInputEvidence } from '../engineering/input-evidence.js';
import { currentRunContext, currentRunPolicy, recordRunEvent, reserveToolCall, recordToolOutcome } from '../runtime/run-context.js';
import { createQueryResultsTool } from './model-tools.js';
import { requestScopeSchema, resolveExtractedScope, forceOnlyScope, missingInputReason, type RequestScope, type ScopeDiagnostic } from '../engineering/request-scope.js';
import { equilibriumModel } from '../engineering/beam-equilibrium.js';
import { resolveRequestedAnalysisSkillId, resolveRequestedAnalysisEngineId, resolveUnselectedRequestedAnalysisSkillId, buildAnalysisProviderNotSelectedPayload, normalizeAnalysisType, inferAnalysisTypeFromResult, codeCheckSkillIdFromResult, analysisTraceIdFromResult, hasValidChinaSeismicCodeCheck, analysisWorkflowInputModeFromResult } from './tools/analysis-resolution.js';
import { buildAnalysisToolSummary, buildModelToolSummary, buildModelToolStateUpdate } from './tools/compaction/analysis.js';
import { buildDraftProgress, buildClarificationQuestions, hasStableDraftType, shouldPreserveExistingDraftState, resolveRetryTaskMessage, buildPreservedDraftExtractionResult, resolveExistingDraftPlugin, detectStructuralTypeWithConfiguredLlm, resolveDetectedStructuralTypeMatch } from './tools/draft-helpers.js';
import { messageRole, messageText, resolveToolInputMessage, resolveExtractionInputMessage } from './tools/input-message.js';
import { parseJsonObjectInput, hasStructuredSeismicWorkflow, hasSemanticSeismicWorkflowInput, mergeSeismicWorkflowInputs } from './tools/seismic-workflow/merge.js';
import { validateSeismicWorkflowInput } from './tools/seismic-workflow/validate-design.js';
import { getConfigurable, getToolCallId, toolResult, nestedLlmUsageCollector, isRecord, pickStringLike } from './tools/shared.js';

/** Exact requested scalars use the same query service and server-side tool budget. */
async function queryRequestedOutputs(state: AgentState, scope: RequestScope | null | undefined, config: LangGraphRunnableConfig) {
  const quantities: Record<string, Record<string, unknown>> = {};
  const missing: Array<Record<string, unknown>> = [];
  const outputs = scope?.outputs ?? [];
  for (const [index, selection] of outputs.entries()) {
    if (resultEngine(state.analysisResult ?? {}) === 'equilibrium' && !['forces', 'reactions'].includes(String(selection.field))) {
      missing.push({ selection, reason: 'RESPONSE_NOT_CALCULATED / 该响应尚未计算，需要对应分析属性' });
      continue;
    }
    const callId = `output-${randomUUID()}`;
    let reserved = false;
    try {
      reserveToolCall('query_results', callId);
      reserved = true;
      const command = await createQueryResultsTool().invoke(selection, {
        ...config, toolCall: { id: callId, name: 'query_results', args: selection }, configurable: { ...config.configurable, agentState: { ...state, resultQuantities: { ...state.resultQuantities, ...quantities } } },
      });
      if (command instanceof Command) Object.assign(quantities, command.update?.resultQuantities ?? {});
      recordToolOutcome('query_results', callId);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (reserved) recordToolOutcome('query_results', callId, reason);
      else recordRunEvent({ kind: 'requested_output_unavailable', selection, reason });
      missing.push({ selection, reason });
      // Do not spend further recovery attempts on a failed automatic query.
      missing.push(...outputs.slice(index + 1).map(selection => ({ selection, reason: 'NOT_QUERIED_AFTER_DELIVERY_FAILURE / 前项交付失败，尚未查询' })));
      break;
    }
  }
  return { resultQuantities: quantities, requestedQuantities: Object.values(quantities), missingRequestedOutputs: missing };
}

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

export function createDetectStructureTypeTool(skillRuntime: AgentSkillRuntime) {
  return tool(
    async (input: { message?: string; locale?: string }, config: LangGraphRunnableConfig) => {
      const log = getLogger(config.configurable as Partial<AgentConfigurable> | undefined);
      const start = Date.now();
      const configurable = getConfigurable(config);
      const state = configurable.agentState;
      const toolCallId = getToolCallId(config);
      const skillIds = configurable.skillScope;
        const locale = (input.locale ?? state?.locale ?? 'zh') as 'en' | 'zh';
      const message = resolveToolInputMessage(input.message, state?.lastUserMessage, state?.messages);
      const detectionMessage = resolveRetryTaskMessage(message);
      const nestedUsage = nestedLlmUsageCollector();
      try {
        const match = await detectStructuralTypeWithConfiguredLlm(skillRuntime, {
          message: detectionMessage,
          locale,
          currentState: state?.draftState || undefined,
          skillIds,
          signal: config.signal,
          onUsage: nestedUsage.onUsage,
        });
        const unsupported = match.supportLevel === 'unsupported';
        const result = {
          key: match.key,
          mappedType: match.mappedType,
          skillId: match.skillId,
          routingSource: match.routingSource,
          supportLevel: match.supportLevel,
          supportNote: match.supportNote,
          nextAction: unsupported ? 'explain_capability_boundary' : 'extract_draft_params',
          instruction: unsupported
            ? (locale === 'zh'
              ? '当前技能或适配器不支持该请求。不得继续提取参数、构建模型或运行分析；请明确说明具体能力边界，并询问用户是否改用当前明确支持的替代工作流。'
              : 'The current skills or adapters do not support this request. Do not extract parameters, build a model, or run analysis. Explain the specific capability boundary and ask whether the user wants a currently supported alternative workflow.')
            : (locale === 'zh'
              ? '结构类型已识别。若用户请求建模、分析或报告，下一步调用 extract_draft_params；不要只输出结构类型后停止。'
              : 'Structural type detected. If the user requested modeling, analysis, or reporting, call extract_draft_params next; do not stop after reporting the type.'),
        };
        const stateUpdate: Partial<AgentState> = {};
        if (match.key) stateUpdate.structuralTypeKey = match.key;
        logToolCall(log, { tool: 'detect_structure_type', durationMs: Date.now() - start, extra: { matchedKey: match.key, skillId: match.skillId, routingSource: match.routingSource } });
        return toolResult(
          toolCallId,
          'detect_structure_type',
          JSON.stringify(result),
          stateUpdate,
          nestedUsage.total(),
        );
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logToolCall(log, { tool: 'detect_structure_type', durationMs: Date.now() - start, success: false, extra: { error: errorMessage } });
        if (
          errorMessage.startsWith('LLM_STRUCTURAL_ROUTER_INVALID_OUTPUT:')
        ) {
          return toolResult(
            toolCallId,
            'detect_structure_type',
            JSON.stringify({
              success: false,
              errorCode: 'LLM_STRUCTURAL_ROUTER_INVALID_OUTPUT',
              message: errorMessage,
              nextAction: 'retry_detection',
            }),
            undefined,
            nestedUsage.total(),
          );
        }
        throw error;
      }
    },
    {
      name: 'detect_structure_type',
      description:
        'Detect the structural type (beam, truss, frame, portal-frame, etc.) from a user description. ' +
        'Returns the matched type key, mapped model type, and the skill ID to use for further processing.',
      schema: z.object({
        message: z.string().describe('The user message describing the structure').optional(),
        locale: z.enum(['zh', 'en']).optional().describe('User locale (defaults to session locale)'),
      }),
    },
  );
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
      const skillIds = configurable.skillScope;
      const locale = (input.locale ?? state?.locale ?? 'zh') as 'zh' | 'en';
      const message = resolveExtractionInputMessage(input.message, state?.lastUserMessage, state?.messages);
      const extractionMessage = resolveRetryTaskMessage(message);
      const nestedUsage = nestedLlmUsageCollector();
      const extractionToolResult = (
        content: string,
        stateUpdate?: Partial<AgentState>,
      ): Command => toolResult(
        toolCallId,
        'extract_draft_params',
        content,
        { ...stateUpdate, ...(stateUpdate?.requestScope || requestedScope ? { requestScope: stateUpdate?.requestScope ?? requestedScope } : {}),
          ...(stateUpdate?.draftState ? { draftState: { ...stateUpdate.draftState,
            ...(stateUpdate.requestScope || requestedScope ? { requestScope: stateUpdate.requestScope ?? requestedScope } : {}) } } : {}) },
        nestedUsage.total(),
      );

      try {
        // Step 1: Detect structural type
        log.debug({
          hasLastUserMessage: !!state?.lastUserMessage,
          messageCount: Array.isArray(state?.messages) ? state.messages.length : 0,
          inputMessagePreview: input.message?.slice(0, 120),
          resolvedMessagePreview: message.slice(0, 120),
          extractionMessagePreview: extractionMessage.slice(0, 120),
        }, 'extract_draft_params resolved message');
        const detectedMatch = currentRunPolicy()?.routing.mode === 'fixed' ? null : await resolveDetectedStructuralTypeMatch(
          skillRuntime,
          state?.structuralTypeKey,
          skillIds,
        );
        const match = detectedMatch ?? await detectStructuralTypeWithConfiguredLlm(skillRuntime, {
          message: extractionMessage,
          locale,
          currentState: existingState,
          skillIds,
          signal: config.signal,
          onUsage: nestedUsage.onUsage,
        });
        const matchedPlugin = match.skillId
          ? await skillRuntime.resolvePluginForType(match.skillId, skillIds)
          : null;
        log.debug({
          detectedKey: match.key,
          detectedSkillId: match.skillId,
          routingSource: match.routingSource,
          reusedDetection: detectedMatch !== null,
          matchedPluginId: matchedPlugin?.id,
        }, 'extract_draft_params structural match');

        if (shouldPreserveExistingDraftState(existingState, match, message)) {
          const preservationPlugin = await resolveExistingDraftPlugin(
            skillRuntime,
            existingState,
            skillIds,
            matchedPlugin,
          );
          const preserved = buildPreservedDraftExtractionResult({
            existingState,
            structuralTypeMatch: match,
            plugin: preservationPlugin,
            locale,
          });
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
            skillId: undefined,
            routingSource: match.routingSource,
            extractionMode: 'not-applicable',
            ...buildDraftProgress(locale, ['inferredType']),
          };
          const stateUpdate: Partial<AgentState> = { draftState: nextState };
          if (match.key) stateUpdate.structuralTypeKey = match.key;
          logToolCall(log, { tool: 'extract_draft_params', durationMs: Date.now() - start, extra: { skillId: undefined, criticalMissing: 1, routingSource: match.routingSource } });
          return extractionToolResult(JSON.stringify(responseJson), stateUpdate);
        }

        // Step 2: Resolve plugin
        const plugin = matchedPlugin;
        if (!plugin) {
          const nextState: DraftState = existingState == null
            ? { inferredType: 'unknown' as const, routingSource: match.routingSource, updatedAt: Date.now() }
            : { ...(existingState as DraftState), routingSource: match.routingSource, updatedAt: Date.now() };
          const responseJson = {
            nextState,
            criticalMissing: ['inferredType'],
            optionalMissing: [],
            clarificationQuestions: [],
            structuralTypeMatch: match,
            skillId: undefined,
            routingSource: match.routingSource,
            extractionMode: 'unavailable',
            ...buildDraftProgress(locale, ['inferredType']),
          };
          logToolCall(log, { tool: 'extract_draft_params', durationMs: Date.now() - start, extra: { skillId: match.skillId, pluginResolved: false, routingSource: match.routingSource } });
          return extractionToolResult(JSON.stringify(responseJson), { draftState: nextState });
        }

        // Generic skill: deterministic path (no LLM extraction needed)
        const stableExistingState = hasStableDraftType(existingState) ? existingState : undefined;
        if (
          plugin.id === 'generic'
          && stableExistingState
        ) {
          const { withStructuralTypeState } = await import('../agent-runtime/plugin-helpers.js');
          const resetToGeneric = isFreshGenericStructuralRoute(match);
          const nextState = withStructuralTypeState(
            plugin.handler.mergeState(resetToGeneric ? undefined : stableExistingState, resetToGeneric ? { inferredType: 'unknown' } : {}),
            match,
          );
          const missing = computeDraftMissing(plugin, nextState, 'execution');
          const responseJson = {
            nextState,
            criticalMissing: missing.critical,
            optionalMissing: missing.optional,
            clarificationQuestions: buildClarificationQuestions(plugin, missing.critical, missing.optional, nextState, locale),
            structuralTypeMatch: match,
            skillId: plugin.id,
            routingSource: match.routingSource,
            extractionMode: 'deterministic',
            ...buildDraftProgress(locale, missing.critical),
          };
          const stateUpdate: Partial<AgentState> = { ...(resetToGeneric ? { ...invalidateAnalysis(state), modelPending: true } : {}),
            draftState: nextState, structuralTypeKey: match.key };
          logToolCall(log, { tool: 'extract_draft_params', durationMs: Date.now() - start, extra: { skillId: plugin.id, extractionMode: 'deterministic', criticalMissing: missing.critical.length, routingSource: match.routingSource } });
          return extractionToolResult(JSON.stringify(responseJson), stateUpdate);
        }

        // Step 3: Sub-agent extracts parameters (skill manifest driven)
        const { invokeParamExtractor } = await import('./param-extractor.js');
        // A force-only extraction does not need the Python model service. Design
        // extraction and any generated design fields use its authoritative schema.
        const protocolClient = configurable.structureProtocolClient ?? createLocalStructureProtocolClient();
        let designContract = requestedScope?.design || hasExistingDesign || requestedScope?.method === 'solver'
          ? await engineeringModelSchema(protocolClient) : undefined;
        const draftPatch = await invokeParamExtractor({
          message: extractionMessage,
          existingState,
          locale,
          plugin,
          traceLogger: log,
          signal: config.signal,
          onUsage: nestedUsage.onUsage,
          designSchema: designContract ? draftDesignSchema(designContract) : undefined,
          sectionShapeSchema: designContract ? draftSectionShapeSchema(designContract) : undefined,
        });

        // Step 4: Handler pipeline (extractDraft → mergeState → computeMissing)
        const patch = plugin.handler.extractDraft({
          message: extractionMessage,
          locale,
          currentState: existingState,
          llmDraftPatch: draftPatch,
          structuralTypeMatch: match,
        });
        const { withStructuralTypeState } = await import('../agent-runtime/plugin-helpers.js');
        const scopeDiagnostics: ScopeDiagnostic[] = [];
        const requestScope = resolveExtractedScope(input.requestScope, draftPatch?.requestScope, state?.requestScope, scopeDiagnostics);
        if (scopeDiagnostics.length) recordRunEvent({ kind: 'request_scope_diagnostic', source: 'parameter-extractor', diagnostics: scopeDiagnostics,
          resolvedBy: input.requestScope ? 'declared-request' : state?.requestScope ? 'accepted-request' : 'clarification' });
        const nextState = { ...withStructuralTypeState(plugin.handler.mergeState(existingState, patch), match),
          ...(requestScope ? { requestScope } : {}) };
        if (nextState.engineeringDraft?.sectionRecords?.length || Array.isArray(nextState.engineeringDraft?.model?.sections)) {
          designContract ??= await engineeringModelSchema(protocolClient);
          nextState.engineeringDraft = normalizeDraftSectionInputs(nextState.engineeringDraft!, designContract);
          if (nextState.skillState?.engineeringDraft) nextState.skillState = { ...nextState.skillState, engineeringDraft: nextState.engineeringDraft };
        }
        if (hasDraftDesignInputs(nextState.engineeringDraft)) {
          designContract ??= await engineeringModelSchema(protocolClient);
          assertDraftDesignInputs(nextState.engineeringDraft, designContract);
        }
        const goalRequired = scopeDiagnostics.some(issue => issue.code === 'REQUEST_GOAL_REQUIRED');
        const missing = goalRequired ? { critical: ['requestScope'], optional: [] } : computeDraftMissing(plugin, nextState, 'execution');
        const extractionMode = draftPatch ? 'llm' : 'deterministic';
        let equilibriumContext = requestScope?.method === 'equilibrium' && !missing.critical.length
          ? equilibriumModel(nextState) : undefined;
        let partialEquilibriumAvailable = false;
        if (requestScope?.method === 'solver' && !requestScope.design && missing.critical.length
          && requestScope.responses.some(field => ['forces', 'reactions'].includes(field))) {
          try { equilibriumContext = equilibriumModel(nextState); partialEquilibriumAvailable = true; } catch { /* Full-model missing conditions remain authoritative. */ }
        }

        // Missing engineering input is a clarification state, not a failed extraction.
        // Repeating the same evidence cannot supply user-omitted properties and must
        // not consume the semantic recovery budget. Invalid LLM output is handled
        // separately inside invokeParamExtractor.

        const responseJson = {
          nextState,
          criticalMissing: missing.critical,
          optionalMissing: missing.optional,
          clarificationQuestions: goalRequired ? [{ paramKey: 'requestScope', label: locale === 'zh' ? '所求结果' : 'Requested results',
            question: locale === 'zh' ? '你需要内力/反力、位移/挠度，还是还需要规范设计或报告？已提供的梁跨度与荷载会保留。'
              : 'Do you need forces/reactions, displacement/deflection, or also code design or a report? The supplied span and loads are retained.',
            required: true, critical: true }] : buildClarificationQuestions(plugin, missing.critical, missing.optional, nextState, locale),
          structuralTypeMatch: match,
          skillId: plugin.id,
          routingSource: match.routingSource,
          extractionMode,
          requestScope,
          ...(scopeDiagnostics.length ? { scopeDiagnostics } : {}),
          ...(partialEquilibriumAvailable ? { partialAnalysisAvailable: { method: 'equilibrium', allowPartial: true,
            availableResponses: ['forces', 'reactions'], missingForFullAnalysis: missing.critical,
            instruction: 'First run_analysis(method=equilibrium,allowPartial=true) for independently determined forces. Then ask for stiffness for displacement; the task remains partial. / 先计算可独立确定的内力，再询问位移所需刚度；不能宣布整题完成。' } } : {}),
          ...(equilibriumContext ? { calculationContext: { nodes: equilibriumContext.nodes, elements: equilibriumContext.elements,
            resultKeys: (equilibriumContext.load_cases as Record<string, unknown>[]).map(c => `case:${c.id}`),
            verticalBendingMomentComponent: 'M2', verticalShearComponent: 'V3', verticalReactionComponent: 'fz',
            note: 'Use these exact IDs and components. resultKey is the load case, not a label for a requested output. / 使用这些实际ID与分量；resultKey是工况键，不是所求结果名称。' } } : {}),
          missingReasons: missing.critical.map(field => ({ field, reason: missingInputReason(field, requestScope, locale) })),
          llmDraftPatch: draftPatch ?? null,
          appliedDraftUpdate: { clearedFields: patch.clearDraftFields ?? [], order: 'clear-then-merge' },
          engineeringDraft: nextState.engineeringDraft ?? patch.engineeringDraft ?? null,
          extractionSource: typeof nextState.skillState?.extractionSource === 'string'
            ? nextState.skillState.extractionSource
            : (draftPatch ? 'llm-draft-patch' : 'deterministic'),
          ...buildDraftProgress(locale, missing.critical),
          ...(partialEquilibriumAvailable ? { nextAction: 'run_analysis', canAnalyzePartial: true,
            instruction: locale === 'zh' ? '完整分析仍缺属性；先run_analysis(method=equilibrium,allowPartial=true)计算独立内力，再澄清位移所需刚度。不要build_model或编造材料截面。'
              : 'Full analysis lacks properties. First run_analysis(method=equilibrium,allowPartial=true) for independent forces, then clarify stiffness. Do not build_model or invent material/section.' } : {}),
          ...(requestScope?.method === 'equilibrium' && missing.critical.length === 0 ? {
            nextAction: 'run_analysis', instruction: locale === 'zh'
              ? '直接调用run_analysis(method=equilibrium)。仅计算内力和反力，不需要材料截面，不生成未请求的变形、规范校核或报告。'
              : 'Call run_analysis(method=equilibrium) directly. Forces/reactions only; no material/section, unrequested deformation, code checking or report.' } : {}),
        };

        const stateUpdate: Partial<AgentState> = {};
        if (requestScope) stateUpdate.requestScope = requestScope;
        if (nextState) {
          Object.assign(stateUpdate, invalidateAnalysis(state));
          stateUpdate.draftState = nextState;
          stateUpdate.modelPending = true;
        }
        if (match.key) stateUpdate.structuralTypeKey = match.key;

        logToolCall(log, { tool: 'extract_draft_params', durationMs: Date.now() - start, extra: { skillId: plugin.id, extractionMode: responseJson.extractionMode, criticalMissing: missing.critical.length, routingSource: match.routingSource } });
        return extractionToolResult(JSON.stringify(responseJson), stateUpdate);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logToolCall(log, { tool: 'extract_draft_params', durationMs: Date.now() - start, success: false, extra: { error: errorMessage } });
        if (
          (
            errorMessage.startsWith('LLM_PARAM_EXTRACTOR_INVALID_OUTPUT:')
            || errorMessage.startsWith('LLM_STRUCTURAL_ROUTER_INVALID_OUTPUT:')
          )
        ) {
          const errorCode = errorMessage.startsWith('LLM_PARAM_EXTRACTOR_INVALID_OUTPUT:')
            ? 'LLM_PARAM_EXTRACTOR_INVALID_OUTPUT'
            : 'LLM_STRUCTURAL_ROUTER_INVALID_OUTPUT';
          return extractionToolResult(JSON.stringify({
            success: false,
            errorCode,
            message: errorMessage,
            nextAction: 'retry_extraction',
          }));
        }
        throw error;
      }
    },
    {
      name: 'extract_draft_params',
      description:
        'Extract structural engineering parameters from a user message and merge them into the draft state. ' +
        'Reads existing draft state from conversation state automatically — do NOT pass it as a parameter. ' +
        'Returns updated draft state, missing fields, and the matched structural type. ' +
        'In a conversation, the original user message or latest clarification answer is authoritative. Do not invent material or section values or repeatedly rephrase missing input; ask the user for the returned missing fields.',
      schema: z.object({
        message: z.string().describe('The user message to extract parameters from').optional(),
        locale: z.enum(['zh', 'en']).optional().describe('User locale'),
        requestScope: requestScopeSchema.optional().describe('Current user goal, not the full engineering workflow. Use equilibrium only for an explicitly force-only, horizontal single-span simply-supported/left-fixed cantilever beam, without a specified engine. Preserve scope while receiving missing-input answers. / 本次用户所求结果；单跨简支或左固悬臂仅求内力且未指定引擎时可用equilibrium。补参数时保留范围。'),
      }),
    },
  );
}

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
      const skillIds = configurable.skillScope;

      let candidate: Record<string, unknown> | undefined;
      try {
        candidate = await skillRuntime.buildModel(draftState, skillIds, {
          message: state?.lastUserMessage || '',
          locale: state?.locale || 'zh',
          currentModel: state?.model ?? undefined,
          conversationHistory: state?.messages.map((message) => `${messageRole(message)}: ${messageText(message)}`).join('\n'),
        });
      } catch (error) {
        const { ModelInputRequiredError } = await import('../agent-skills/structure-type/generic/llm-model-builder.js');
        if (!(error instanceof ModelInputRequiredError)) throw error;
        // An identified missing fact is a normal clarification state, not an
        // invalid candidate or a reason to consume the automatic-repair budget.
        return toolResult(toolCallId, 'build_model', JSON.stringify({ status: 'input_required', modelBuilt: false,
          missingFields: error.missingFields, nextAction: 'ask_user_clarification',
          instruction: 'Ask for these missing facts, then extract the new answer before building. The saved model is unchanged. / 请询问这些缺失信息，收到新答复后再提取建模；原模型未变。' }));
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

export function createAskUserClarificationTool() {
  return tool(
    async (input: { question: string; optionsJson?: string }, config: LangGraphRunnableConfig) => {
      const options = input.optionsJson === undefined ? undefined : normalizeClarificationOptions(input.optionsJson);
      if (input.optionsJson && !options?.length) recordRunEvent({ kind: 'clarification_options_ignored', reason: 'OPTIONAL_CHOICES_UNAVAILABLE' });

      if (currentRunPolicy()?.executionOwner === 'external') {
        return JSON.stringify({ type: 'clarification_needed', question: input.question, options,
          nextAction: 'await_user_input', resume: 'Begin a new user turn with the actual user answer; the external host owns dialogue.' });
      }

      const userResponse = interrupt({
        type: 'clarification_needed',
        question: input.question,
        options,
      }) as string;

      const state = getConfigurable(config).agentState;
      const hasCurrentModel = Boolean(state?.model && !state.modelPending);
      return JSON.stringify({
        type: 'clarification_answered',
        question: input.question,
        ...(options ? { options } : {}),
        answer: userResponse,
        nextAction: hasCurrentModel ? 'query_model' : 'extract_draft_params',
        instruction: hasCurrentModel
          ? 'An existing model is current. Inspect it with query_model; if the answer changes engineering fields, apply only the confirmed changes with edit_model. If those values are already present, continue without rebuilding. / 已有当前模型：用 query_model 确认对象与版本，工程字段的已确认修改通过 edit_model 写入；重复确认已有值时继续执行，不重建草稿。'
          : 'Clarification answers are not merged into draftState automatically. Call extract_draft_params with this exact answer before build_model. / 澄清答案尚未自动合并到草稿；先用原文调用 extract_draft_params，再构建模型。',
      });
    },
    {
      name: 'ask_user_clarification',
      description:
        'Pause execution and ask the user a clarification question. ' +
        'Use this when you cannot proceed without user input. ' +
        'The graph will resume once the user provides an answer.',
      schema: z.object({
        question: z.string().trim().min(1).describe('The question to ask the user'),
        optionsJson: z
          .string()
          .optional()
          .describe('JSON array of suggested answer strings; each string must contain the complete answer to send when selected'),
      }),
    },
  );
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
          Object.assign(stateUpdate, invalidateAnalysis(state));
        } else if (input.designCode && input.designCode !== state?.policy?.designCode) {
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
      const skillIds = configurable.skillScope;
      const analysisType = normalizeAnalysisType(state?.policy?.analysisType);
      const unselectedRequestedSkillId = resolveUnselectedRequestedAnalysisSkillId(
        state?.lastUserMessage,
        skillIds,
        analysisType,
      );
      if (unselectedRequestedSkillId) {
        return JSON.stringify(buildAnalysisProviderNotSelectedPayload(unselectedRequestedSkillId));
      }
      const requestedEngineId = resolveRequestedAnalysisEngineId(state?.lastUserMessage, skillIds, analysisType);
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

export function createRunAnalysisTool(skillRuntime: AgentSkillRuntime) {
  return tool(
    async (input: {
      analysisType: string;
      analysisSkillId?: string;
      loadCombinationId?: string;
      loadCaseIds?: string[];
      loadCombinationIds?: string[];
      floorLoadTransferMode?: 'auto_code_cn' | 'node_tributary' | 'one_way_slab' | 'two_way_slab';
      seismicWorkflowJson?: string;
      method?: 'modal' | 'time_history' | 'equilibrium';
      allowPartial?: boolean;
      requestScope?: RequestScope;
      massSource?: 'nodal' | 'member-density' | 'floor-seismic';
      numModes?: number;
      direction?: 'x' | 'y' | 'z';
      timeStep?: number;
      duration?: number;
      dampingRatio?: number;
      groundMotion?: number[];
      groundMotionUnit?: 'm/s2' | 'g';
      monitorNodeIds?: string[];
      monitorElementIds?: string[];
      monitorSupportNodeIds?: string[];
      massDirections?: ('x' | 'y' | 'z')[];
    }, config: LangGraphRunnableConfig) => {
      const log = getLogger(config.configurable as Partial<AgentConfigurable> | undefined);
      const start = Date.now();
      const configurable = getConfigurable(config);
      const state = configurable.agentState;
      const toolCallId = getToolCallId(config);

      const equilibriumRequested = input.method !== undefined ? input.method === 'equilibrium'
        : input.requestScope !== undefined ? input.requestScope.method === 'equilibrium'
          : !input.analysisSkillId && state?.requestScope?.method === 'equilibrium';
      // A tool may select only available responses, but cannot erase the accepted goal.
      const partialGoal = equilibriumRequested && state?.requestScope?.responses.some(field => !['forces', 'reactions'].includes(field))
        ? state.requestScope : undefined;
      const goal = partialGoal
        ? { ...partialGoal, outputs: input.requestScope?.outputs.length ? input.requestScope.outputs : partialGoal.outputs }
        : input.requestScope ?? state?.requestScope;
      const scope = !equilibriumRequested && goal?.method === 'equilibrium' ? { ...goal, method: 'solver' as const } : goal;
      if (equilibriumRequested) {
        const partial = (input.allowPartial === true || !!partialGoal) && scope && !scope.design
          && scope.responses.some(field => !['forces', 'reactions'].includes(field))
          && !scope.responses.includes('dynamic') && scope.responses.some(field => ['forces', 'reactions'].includes(field));
        if (input.analysisType !== 'static' || !forceOnlyScope(scope) && !partial) throw new Error('EQUILIBRIUM_FORCE_ONLY_REQUIRED / 平衡计算仅适用于静力内力或反力');
        if (input.analysisSkillId || state?.model && !state.modelPending) throw new Error('EQUILIBRIUM_NOT_A_SOLVER_FALLBACK / 指定引擎或已有完整模型必须使用真实求解路径');
        if (!state?.draftState) throw new Error('ENGINEERING_DRAFT_REQUIRED');
        const projection = equilibriumModel(state.draftState, state.inputEvidence);
        const parameters = { ...(input.loadCaseIds ? { loadCaseIds: input.loadCaseIds } : {}),
          ...(input.loadCombinationIds ? { loadCombinationIds: input.loadCombinationIds } : {}),
          ...(input.loadCombinationId ? { loadCombinationId: input.loadCombinationId } : {}) };
        const reservation = beginAnalysisRequest(state, analysisSettingsHash('static', 'builtin-equilibrium', parameters), projection);
        configurable.agentState = { ...state, ...reservation };
        configurable.onAnalysisRequest?.(reservation);
        const requestId = randomUUID();
        recordRunEvent({ kind: 'analysis_request', requestId, operation: 'analysis', method: 'equilibrium' });
        const { data: run } = await configurable.engineClient.post<Record<string, unknown>>('/analyze', {
          type: 'static', engineId: 'builtin-equilibrium', model: projection, parameters, requestScope: scope,
          requestId, requestBinding: reservation.analysisRequest }, { signal: config.signal });
        run.meta = { ...(isRecord(run.meta) ? run.meta : {}), requestScope: scope };
        const update = publishAnalysis(getConfigurable(config).agentState ?? {}, reservation.analysisRequest, run);
        const delivery = update.analysisResult ? await queryRequestedOutputs({ ...state, ...reservation, ...update }, scope, config) : undefined;
        return toolResult(toolCallId, 'run_analysis', JSON.stringify({ ...buildAnalysisToolSummary({ result: run, model: projection }),
          method: 'equilibrium', availableResponses: ['forces', 'reactions'], requestScope: scope,
          ...(partial ? { deliveryStatus: 'partial', missingRequestedResponses: scope.responses.filter(field => !['forces', 'reactions'].includes(field)),
            nextAction: 'ask_user_clarification', message: 'Forces solved; displacement/other requested responses still need analysis properties. / 内力已算；位移等其余所求量仍需分析属性。' } : {}),
          ...(delivery ? { requestedQuantities: delivery.requestedQuantities, missingRequestedOutputs: delivery.missingRequestedOutputs } : {}),
          instruction: 'Query forces/reactions by physical position. Displacement, stress and design were not calculated. / 按物理位置查询内力反力；没有计算位移、应力或设计。' }),
          { ...update, ...(delivery ? { resultQuantities: delivery.resultQuantities } : {}), ...(scope ? { requestScope: scope } : {}) });
      }

      // Read model from graph state channel
      const model = state?.model;
      if (!model) {
        return toolResult(toolCallId, 'run_analysis', JSON.stringify({ error: 'No model available. Run build_model first.' }));
      }
      if (state?.modelPending) return toolResult(toolCallId, 'run_analysis', JSON.stringify({ success: false, error_code: 'MODEL_REBUILD_REQUIRED', message: 'Build the pending model first.', messageZh: '请先构建待确认的模型。' }));
      assertInputEvidenceMatchesModel(model, state?.inputEvidence);
      const skillIds = configurable.skillScope;
      const analysisType = (input.analysisType || 'static') as 'static' | 'dynamic' | 'seismic' | 'nonlinear';
      const unselectedRequestedSkillId = resolveUnselectedRequestedAnalysisSkillId(
        state?.lastUserMessage,
        skillIds,
        analysisType,
        input.analysisSkillId,
      );
      if (unselectedRequestedSkillId) {
        return toolResult(
          toolCallId,
          'run_analysis',
          JSON.stringify(buildAnalysisProviderNotSelectedPayload(unselectedRequestedSkillId)),
        );
      }
      const requestedAnalysisSkillId = resolveRequestedAnalysisSkillId(
        state?.lastUserMessage,
        skillIds,
        analysisType,
        input.analysisSkillId,
      );
      const traceId = `lg-${Date.now()}`;
      const parsedSeismicWorkflow = parseJsonObjectInput(input.seismicWorkflowJson, 'seismicWorkflowJson');
      if (parsedSeismicWorkflow && !parsedSeismicWorkflow.ok) {
        return toolResult(
          toolCallId,
          'run_analysis',
          JSON.stringify({
            success: false,
            error_code: 'INVALID_SEISMIC_WORKFLOW_JSON',
            message: parsedSeismicWorkflow.error,
          }),
        );
      }
      const draftSeismicWorkflow = isRecord(state?.draftState?.skillState?.seismicWorkflow)
        ? state?.draftState?.skillState?.seismicWorkflow as Record<string, unknown>
        : undefined;
      const contextSeismicWorkflow = isRecord(state?.contextSeismicWorkflow)
        ? state.contextSeismicWorkflow
        : undefined;
      const semanticSeismicWorkflow = parsedSeismicWorkflow?.ok
        ? parsedSeismicWorkflow.value
        : draftSeismicWorkflow ?? (
          hasSemanticSeismicWorkflowInput(contextSeismicWorkflow)
            ? contextSeismicWorkflow
            : undefined
        );
      const seismicWorkflow = mergeSeismicWorkflowInputs(
        semanticSeismicWorkflow,
        contextSeismicWorkflow,
      );
      assertAnalysisInputEvidenceMatchesRequest(state?.inputEvidence, analysisType === 'seismic' ? seismicWorkflow : undefined);
      if (analysisType === 'seismic' && !hasSemanticSeismicWorkflowInput(semanticSeismicWorkflow)) {
        return toolResult(
          toolCallId,
          'run_analysis',
          JSON.stringify({
            success: false,
            error_code: 'SEISMIC_WORKFLOW_REQUIRED',
            message: 'China seismic analysis requires a non-empty structured seismicWorkflow from LLM semantic understanding before run_analysis.',
            messageZh: '中国抗震分析必须先由 LLM 语义理解形成非空 seismicWorkflow 结构化对象，不能直接按关键词进入计算。',
            nextAction: 'Call extract_draft_params or pass seismicWorkflowJson, then retry run_analysis.',
          }),
        );
      }
      if (analysisType === 'seismic' && hasStructuredSeismicWorkflow(seismicWorkflow)) {
        const workflowErrors = validateSeismicWorkflowInput(seismicWorkflow);
        if (workflowErrors.length > 0) {
          return toolResult(
            toolCallId,
            'run_analysis',
            JSON.stringify({
              success: false,
              error_code: 'INVALID_SEISMIC_WORKFLOW',
              message: 'China seismic workflow contains invalid structured fields.',
              messageZh: '中国抗震 seismicWorkflow 存在无效结构化字段。',
              errors: workflowErrors,
              nextAction: 'Correct seismicWorkflowJson or rerun extract_draft_params to produce valid structured fields.',
            }),
          );
        }
      }

      const engineClient = configurable.engineClient;
      const rawLoadCombinations = Array.isArray(model.load_combinations)
        ? model.load_combinations
        : Array.isArray(model.loadCombinations)
          ? model.loadCombinations
          : [];
      const loadCombinationIds = rawLoadCombinations
        .filter(isRecord)
        .map((combination) => pickStringLike(combination, 'id'))
        .filter((id): id is string => !!id);
      const requestedLoadCombinationId = input.loadCombinationId?.trim();
      if (requestedLoadCombinationId && !loadCombinationIds.includes(requestedLoadCombinationId)) {
        return toolResult(
          toolCallId,
          'run_analysis',
          JSON.stringify({
            success: false,
            error_code: 'LOAD_COMBINATION_NOT_FOUND',
            message: `Load combination '${requestedLoadCombinationId}' is not present in the current model.`,
            availableLoadCombinationIds: loadCombinationIds,
          }),
        );
      }
      const loadCombinationId = requestedLoadCombinationId;
      const parameters: Record<string, unknown> = {
        ...(loadCombinationId ? { loadCombinationId } : {}),
        ...(input.loadCaseIds ? { loadCaseIds: input.loadCaseIds } : {}),
        ...(input.loadCombinationIds ? { loadCombinationIds: input.loadCombinationIds } : {}),
        ...(input.floorLoadTransferMode ? { floorLoadTransferMode: input.floorLoadTransferMode } : {}),
        ...(analysisType === 'seismic' && seismicWorkflow ? { seismicWorkflow } : {}),
      };
      if (input.method !== undefined) parameters.analysisType = input.method;
      for (const key of ['massSource', 'numModes', 'direction', 'timeStep', 'duration', 'dampingRatio',
        'groundMotion', 'groundMotionUnit', 'monitorNodeIds', 'monitorElementIds', 'monitorSupportNodeIds', 'massDirections'] as const) {
        if (input[key] !== undefined) parameters[key] = input[key];
      }
      let reservation = beginAnalysisRequest(state ?? {}, analysisSettingsHash(analysisType, requestedAnalysisSkillId, parameters));
      const reserve = () => {
        configurable.agentState = { ...configurable.agentState, ...reservation } as AgentState;
        configurable.onAnalysisRequest?.(reservation);
      };
      reserve();
      const postToEngineWithRetry = async (
        p: string,
        payload: Record<string, unknown>,
        opts: { retries: number; traceId: string; tool: 'run_analysis'; signal?: AbortSignal },
      ) => {
        reservation = { ...reservation, analysisRequest: { ...reservation.analysisRequest,
          settingsHash: analysisSettingsHash(payload.type, payload.engineId, parameters) } };
        reserve();
        payload = { ...payload, ...(scope ? { requestScope: scope } : {}), requestId: randomUUID(), requestBinding: reservation.analysisRequest };
        if (opts.signal?.aborted) throw opts.signal.reason ?? new Error('Analysis request aborted');
        recordRunEvent({ kind: 'analysis_request', requestId: payload.requestId, operation: 'analysis', engineId: payload.engineId });
        try {
          return await engineClient.post(p, payload, { signal: opts.signal });
        } catch (error) {
          if (opts.signal?.aborted) throw error;
          throw new Error(`SOLVER_OUTCOME_UNKNOWN: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
        }
      };

      // engineId is resolved by the selected analysis skill, not from LLM input
      const result = await skillRuntime.executeAnalysisSkill({
        traceId,
        analysisType,
        model,
        parameters,
        analysisSkillId: requestedAnalysisSkillId,
        skillIds,
        postToEngineWithRetry,
        signal: config.signal,
      });
      const analysisResult: Record<string, unknown> = isRecord(result.result)
        ? { ...result.result }
        : { result: result.result };
      const analysisMeta = isRecord(analysisResult.meta) ? analysisResult.meta : {};
      for (const key of ['modelRevision', 'modelHash', 'settingsHash', 'requestSequence'] as const) {
        if (analysisMeta[key] !== undefined && analysisMeta[key] !== reservation.analysisRequest[key]) {
          throw new Error(`ANALYSIS_RESULT_BINDING_MISMATCH: ${key}`);
        }
      }
      analysisResult.meta = {
        ...analysisMeta,
        traceId,
        ...reservation.analysisRequest,
        ...(scope ? { requestScope: scope } : {}),
      };

      // Store analysis result in graph state via Command.
      // Keep ToolMessage content compact — the full data lives in graph state.
      // The streaming layer reads analysisResult from nodeState for artifact_payload_sync.
      const analysisSummary = buildAnalysisToolSummary({
        result: analysisResult,
        skillId: result.skillId,
        model,
      });
      const analysisSucceeded = analysisSummary.success !== false;
      const update = publishAnalysis(getConfigurable(config).agentState ?? {}, reservation.analysisRequest, analysisResult);
      const delivery = update.analysisResult && analysisSucceeded ? await queryRequestedOutputs({ ...state, ...reservation, ...update } as AgentState, scope, config) : undefined;
      logToolCall(log, {
        tool: 'run_analysis',
        durationMs: Date.now() - start,
        success: analysisSucceeded,
        extra: { analysisType, skillId: result.skillId, requestedAnalysisSkillId, success: analysisSucceeded },
      });
      return toolResult(
        toolCallId,
        'run_analysis',
        JSON.stringify({ ...analysisSummary, ...(delivery ? { requestedQuantities: delivery.requestedQuantities, missingRequestedOutputs: delivery.missingRequestedOutputs,
          deliveryScope: 'declared-output-selections',
          deliveryStatus: !scope?.outputs?.length ? 'not-specified' : delivery.missingRequestedOutputs.length ? 'partial' : 'complete' } : {}), ...(scope ? { requestScope: scope, requestedOutputs: scope.outputs,
          nextAction: 'query_results', instruction: 'Deliver the requested result locations, cases and units; code design/report only when explicitly requested. / 按指定位置、工况、单位交付；规范设计和报告分别按需。' } : {}) }),
        { ...update, ...(delivery ? { resultQuantities: delivery.resultQuantities } : {}), ...(scope ? { requestScope: scope } : {}) },
      );
    },
    {
      name: 'run_analysis',
      description:
        'Execute a structural analysis (static, dynamic, seismic, or nonlinear). ' +
        'Reads the model from conversation state automatically — do NOT pass it as a parameter. ' +
        'Returns analysis results including displacements, forces, and reactions, plus compact normalized-model ' +
        'node coordinates and element connectivity for grounding result IDs to physical locations. ' +
        'The analysis engine is resolved from the selected analysis skill automatically. ' +
        'For China seismic analysis, pass seismicWorkflowJson only as the structured result of semantic understanding.',
      schema: z.object({
        analysisType: z
          .enum(['static', 'dynamic', 'seismic', 'nonlinear'])
          .default('static').describe('Type of analysis; default static, including equilibrium. method is separate. / 分析类型，缺省静力；equilibrium属于method。'),
        analysisSkillId: z
          .enum(ANALYSIS_SKILL_IDS)
          .optional()
          .describe('Optional structured analysis skill ID from LLM semantic understanding or UI selection. Do not infer it from keyword matching.'),
        loadCombinationId: z
          .string()
          .optional()
          .describe('Optional single load-combination ID. Without selectors, all declared static cases and combinations are run separately.'),
        loadCaseIds: z.array(z.string()).optional().describe('Explicit load cases to solve independently.'),
        loadCombinationIds: z.array(z.string()).optional().describe('Explicit combinations to solve independently.'),
        method: z.enum(['modal', 'time_history', 'equilibrium']).optional().describe('equilibrium: forces/reactions from accepted single-span beam draft, no stiffness or displacement; never substitutes for a specified solver. Otherwise modal/time_history / 平衡法只计算已接受单跨梁草稿的内力反力，不能替代指定引擎。'),
        allowPartial: z.boolean().optional().describe('Only for equilibrium: compute independently available forces first when the request also needs displacement but stiffness is missing. Missing responses remain explicit; never marks the full task complete. / 平衡法先交付独立内力；其余响应仍明确缺项，不能算整题完成。'),
        requestScope: requestScopeSchema.optional().describe('Requested response families and exact output locations/cases/units; design/report are independent opt-in deliverables. / 所求响应及明确位置、工况和单位；设计和报告分别按需。'),
        massSource: z.enum(['nodal', 'member-density', 'floor-seismic']).optional().describe('Explicit mass basis; sources are never silently added / 明确质量来源，不隐式叠加。'),
        numModes: z.number().int().positive().optional(),
        direction: z.enum(['x', 'y', 'z']).optional(),
        timeStep: z.number().positive().optional(),
        duration: z.number().positive().optional(),
        dampingRatio: z.number().min(0).lt(1).optional(),
        groundMotion: z.array(z.number().finite()).min(2).optional().describe('Actual acceleration samples / 实际加速度序列。'),
        groundMotionUnit: z.enum(['m/s2', 'g']).optional(),
        massDirections: z.array(z.enum(['x', 'y', 'z'])).min(1).optional().describe('Explicit mass directions / 明确质量方向。'),
        monitorElementIds: z.array(z.string().min(1)).optional().describe('Member end forces recorded at each step / 每步记录的构件端力。'),
        monitorSupportNodeIds: z.array(z.string().min(1)).optional().describe('Support reactions recorded at each step / 每步记录的支座反力。'),
        monitorNodeIds: z.array(z.string().min(1)).min(1).optional().describe('Nodes recorded at every time step / 每步记录的观测节点。'),
        floorLoadTransferMode: z
          .enum(['auto_code_cn', 'node_tributary', 'one_way_slab', 'two_way_slab'])
          .optional()
          .describe('Optional floor load transfer mode for OpenSees static analysis. Use auto_code_cn by default; set only when the user explicitly requests a method.'),
        seismicWorkflowJson: z
          .string()
          .optional()
          .describe('Optional JSON object produced by LLM semantic understanding for China seismic workflow. Used only when analysisType is seismic; do not infer this from keyword matching. It may include designBasis, designRequirements, structure, methodPreference, direction, and groundMotionSet.records with uploaded CSV headers/rows or AT2/TXT content returned by analyze_file.'),
      }),
    },
  );
}

export function createRunCodeCheckTool(skillRuntime: AgentSkillRuntime) {
  return tool(
    async (input: {
      designCode: string;
      engineId?: string;
      provider?: CodeCheckProvider;
      design?: Record<string, unknown>;
      requestScope?: RequestScope;
    }, config: LangGraphRunnableConfig) => {
      const log = getLogger(config.configurable as Partial<AgentConfigurable> | undefined);
      const start = Date.now();
      const configurable = getConfigurable(config);
      const state = configurable.agentState;
      const toolCallId = getToolCallId(config);
      const scope = input.requestScope ?? state?.requestScope;
      if (scope && !scope.design) return toolResult(toolCallId, 'run_code_check', JSON.stringify({ success: true,
        skipped: true, reason: 'DESIGN_NOT_REQUESTED', message: 'Analysis does not automatically request code design.',
        messageZh: '普通分析不自动进入规范设计；请只交付当前所求结果。' }));
      if (resultEngine(state?.analysisResult ?? {}) === 'equilibrium') throw new Error('DESIGN_REQUIRES_FULL_MODEL / 规范设计需要真实材料截面及完整模型，不能使用无刚度平衡投影');
      const skillIds = configurable.skillScope;
      const selectedDesignCode = skillRuntime.resolveCodeCheckDesignCodeFromSkillIds(skillIds);
      const explicitDesignCode = input.designCode || state?.policy?.designCode;
      const requestedDesignCode = explicitDesignCode || selectedDesignCode;
      const codeCheckSkillId = requestedDesignCode
        ? skillRuntime.resolveCodeCheckSkillId(requestedDesignCode)
        : undefined;
      if (!requestedDesignCode || (!codeCheckSkillId && input.provider === 'builtin')) {
        const skipped = {
          skipped: true,
          reason: requestedDesignCode
            ? `Unsupported code-check design code: ${requestedDesignCode}.`
            : 'No code-check design code is selected or provided.',
        };
        logToolCall(log, { tool: 'run_code_check', durationMs: Date.now() - start, extra: { skipped: true, reason: skipped.reason } });
        return toolResult(toolCallId, 'run_code_check', JSON.stringify(skipped));
      }

      // Read model and analysis from graph state channels
      const model = state?.model;
      if (!model) {
        return toolResult(toolCallId, 'run_code_check', JSON.stringify({ error: 'No model available. Run build_model first.' }));
      }
      const analysis = state?.analysisResult;
      if (!analysis) {
        return toolResult(toolCallId, 'run_code_check', JSON.stringify({ error: 'No analysis results available. Run run_analysis first.' }));
      }
      const freshnessError = currentAnalysisError(state);
      if (freshnessError) return toolResult(toolCallId, 'run_code_check', JSON.stringify({ success: false, error_code: freshnessError, message: 'Current model analysis is required.', messageZh: '需要当前模型的有效分析结果。' }));
      if (input.provider === 'native' && !['pkpm', 'yjk'].includes(resultEngine(analysis))) {
        return toolResult(toolCallId, 'run_code_check', JSON.stringify({ success: false,
          errorCode: 'NATIVE_DESIGN_ENGINE_REQUIRED', engine: resultEngine(analysis), allowedProviders: ['auto', 'builtin'],
          message: 'Native design requires a PKPM/YJK analysis. Use builtin checks for OpenSees; this is an engine mismatch, not a paid StructureClaw edition.',
          messageZh: '原生设计需要 PKPM/YJK 分析；当前 OpenSees 应使用内置校核。这是引擎不匹配，不是 StructureClaw 需要付费版本。',
          nextAction: 'Use provider auto/builtin without native design arguments; ask the user for missing model design inputs.' }));
      }
      if (resolveCheckProvider(input.provider, analysis) === 'native') {
        const meta = isRecord(analysis.meta) ? analysis.meta : {};
        const engineId = `builtin-${resultEngine(analysis)}`;
        if (input.engineId && input.engineId !== engineId) throw new Error('DESIGN_ENGINE_MISMATCH');
        const parameters = { ...(isRecord(meta.requestParameters) ? meta.requestParameters
          : isRecord(meta.effectiveParameters) ? meta.effectiveParameters : {}),
          design: { ...input.design, requested: true, code: requestedDesignCode } };
        const pending = beginNativeDesignRequest(state!, analysisSettingsHash('static', engineId, parameters));
        Object.assign(state!, pending.update, { analysisRuns: { ...state?.analysisRuns, ...pending.update.analysisRuns } });
        configurable.onAnalysisRequest?.(pending.update);
        const requestId = randomUUID();
        recordRunEvent({ kind: 'analysis_request', requestId, operation: 'native-design', engineId });
        const response = await configurable.engineClient.post<Record<string, unknown>>('/analyze', {
          type: 'static', engineId, model, parameters, requestId, requestBinding: pending.request }, { signal: config.signal })
          .catch((error: unknown) => {
            if (config.signal?.aborted) throw error;
            throw new Error(`SOLVER_OUTCOME_UNKNOWN: requestId=${requestId}; ${error instanceof Error ? error.message : String(error)}`, { cause: error });
          });
        const next = response.data;
        const designRecord = nativeDesignRecord(model, next, requestedDesignCode);
        const published = publishNativeDesign(getConfigurable(config).agentState ?? state!, pending.request, next, designRecord);
        return toolResult(toolCallId, 'run_code_check', JSON.stringify({ success: next.success === true,
          provider: 'native', runId: next.runId, completionStatus: designRecord.completionStatus,
          complianceStatus: designRecord.complianceStatus, summary: designRecord.summary,
          missingInputs: designRecord.missingInputs, designStatus: designRecord.designStatus }),
          published);
      }
      if (!codeCheckSkillId) throw new Error('BUILTIN_CODE_UNSUPPORTED / 公共规范未实现');
      if (skillIds && !skillIds.includes(codeCheckSkillId)) throw new Error('CODE_CHECK_OUTSIDE_SCOPE / 当前技能范围不允许此规范');
      if (input.design) throw new Error('BUILTIN_DESIGN_REQUEST_UNSUPPORTED / 公共校核不执行商业设计条件');
      validateServiceabilitySelection(model, analysis);
      const traceId = `lg-cc-${Date.now()}`;

      const codeCheckResult = await checkRunResults(analysis, async (caseResult) => {
        const result = await skillRuntime.executeCodeCheckSkill({
        codeCheckClient: configurable.codeCheckClient,
        traceId,
        designCode: requestedDesignCode,
        model,
        analysis: caseResult,
        analysisParameters: {},
        engineId: input.engineId,
        codeCheckSkillId,
        });
        return isRecord(result.result) ? result.result : { result: result.result };
      });

      const codeCheckPayload: Record<string, unknown> = { ...codeCheckResult };
      const meta = isRecord(codeCheckPayload.meta) ? codeCheckPayload.meta : {};
      const analysisTraceId = analysisTraceIdFromResult(analysis);
      codeCheckPayload.meta = {
        ...meta, codeCheckSkillId, ...(analysisTraceId ? { analysisTraceId } : {}),
        runId: analysis.runId, modelHash: modelHash(model), modelRevision: state?.modelRevision,
      };

      // Store code check result in graph state via Command
      logToolCall(log, { tool: 'run_code_check', durationMs: Date.now() - start, extra: { designCode: requestedDesignCode, skillId: codeCheckSkillId, success: true } });
      return toolResult(
        toolCallId,
        'run_code_check',
        JSON.stringify({ success: true, provider: 'builtin', engine: resultEngine(analysis), skillId: codeCheckSkillId, ...codeCheckFeedback(codeCheckPayload, model, analysis) }),
        { codeCheckResult: codeCheckPayload },
      );
    },
    {
      name: 'run_code_check',
      description:
        'Run code compliance check against a design code (e.g. GB50017, GB50010, GB50011, GB/T 50011-2010-2024). ' +
        'Reads model and analysis results from conversation state automatically — do NOT pass them as parameters. ' +
        'For China seismic analysis, call this after run_analysis and before generate_report with designCode GB/T 50011-2010-2024. ' +
        'Returns completion and compliance separately, with specific missing inputs. Incomplete is NOT pass. ' +
        'For OpenSees use auto/builtin, never native; native design belongs to PKPM/YJK. ' +
        'When inputs are missing, preserve supplied values, group genuinely missing design conditions into one clarification, and inspect analysis for missing computed responses. Update declared material/member design fields via edit_model, reanalyze, then check again. Never invent design conditions. ' +
        'Only if the user explicitly requests selected checks, set elements[id].design.requested_checks via edit_model; omit for all implemented checks. GB50017 IDs: normal_stress, shear_stress, equivalent_stress, lateral_stability, axial_stability, local_stability, slenderness, deflection. Exact item names also work. A selected subset is not full design compliance. / 仅按用户明确要求选择专项校核，不能为通过而缩小范围。',
      schema: z.object({
        designCode: z
          .string()
          .describe('Design code to check against (GB50010, GB50011, GB/T 50011-2010-2024, GB50017, JGJ3)'),
        provider: z.enum(['auto', 'native', 'builtin']).optional().describe('Commercial engines prefer native design; OpenSees uses builtin checks / 商业引擎优先原生设计，OpenSees采用公共校核。'),
        design: z.record(z.string(), z.unknown()).optional().describe('Explicit native design conditions / 明确的原生设计条件。'),
        engineId: z.string().optional().describe('Optional engine ID'),
        requestScope: requestScopeSchema.optional().describe('Update the goal only when the user now explicitly requests design; preserve requested outputs. / 仅在用户明确请求设计时更新目标，保留所求结果。'),
      }),
    },
  );
}

export function createGenerateReportTool(skillRuntime: AgentSkillRuntime) {
  return tool(
    async (input: {
      message: string;
      analysisType: string;
      locale?: string;
      selection?: ResultSelection;
      narrative?: 'structured' | 'assisted';
      requestScope?: RequestScope;
    }, config: LangGraphRunnableConfig) => {
      const log = getLogger(config.configurable as Partial<AgentConfigurable> | undefined);
      const start = Date.now();
      const configurable = getConfigurable(config);
      const state = configurable.agentState;
      const toolCallId = getToolCallId(config);
      const scope = input.requestScope ?? state?.requestScope;
      if (scope && !scope.report) return toolResult(toolCallId, 'generate_report', JSON.stringify({ success: true,
        skipped: true, reason: 'REPORT_NOT_REQUESTED', message: 'Deliver the requested results without a full report.',
        messageZh: '用户未要求计算书；交付所求结果及计算依据即可。' }));

      const selection = input.selection;
      if (selection?.timeIndex !== undefined && selection.modeNumber !== undefined) throw new Error('RESULT_INDEX_CONFLICT');
      const run = selection?.runId ? state?.analysisRuns?.[selection.runId]
        ?? (state?.analysisResult?.runId === selection.runId ? state.analysisResult : await loadAnalysisRun(selection.runId)) : state?.analysisResult;
      if (!run) return toolResult(toolCallId, 'generate_report', JSON.stringify({ error: 'RUN_NOT_FOUND' }));
      const freshnessError = currentAnalysisError(state);
      if (!selection?.runId && freshnessError) return toolResult(toolCallId, 'generate_report', JSON.stringify({ success: false,
        error_code: freshnessError, message: 'Current model analysis is required.', messageZh: '需要当前模型的有效分析结果。' }));
      const { resultKey, selected } = selectedSavedResult(run, selection?.resultKey);
      if (selected.success === false || selected.executionStatus === 'failed') throw new Error('RESULT_UNAVAILABLE');
      const quantities = Object.values(state?.resultQuantities ?? {}).filter(q => selection
        ? quantityMatchesSelection(q, selection, run.runId, resultKey) : q.runId === run.runId);
      if (selection && (selection.component || selection.timeIndex !== undefined || selection.modeNumber !== undefined) && !quantities.length) {
        throw new Error(`REPORT_SELECTION_QUERY_REQUIRED: call query_results first with the same run, result, location, component, unit and index, then retry this report. A full-field query does not save a scalar. quantityId is automatic; do not ask the user for it. / 请先用query_results查询同一运行、结果、位置、分量、单位和索引，再生成报告。整个字段的查询不会登记标量；quantityId自动生成，不需要询问用户。 query_results: ${JSON.stringify({ ...selection, runId: run.runId, resultKey })}`);
      }
      const analysis = { ...run, ...(selection ? selected : {}), runId: run.runId, selectedResultKey: resultKey,
        results: selection && resultKey ? { [resultKey]: selected } : run.results,
        requestedQuantities: quantities, requestedSelection: selection };
      const normalizedModel = isRecord(run.modelSnapshot) ? run.modelSnapshot : !freshnessError && run.runId === state?.analysisResult?.runId ? state?.model : undefined;
      if (!normalizedModel) throw new Error('RESULT_MODEL_SNAPSHOT_REQUIRED');
      const currentCheck = state?.codeCheckResult;
      const codeCheck = !selection || (isRecord(currentCheck?.meta) && currentCheck.meta.runId === run.runId)
        ? currentCheck : savedNativeDesignRecord(run) ?? undefined;
      const draftState = selection?.runId ? undefined : state?.draftState || undefined;
      const skillIds = configurable.skillScope;
      const locale = (input.locale ?? state?.locale ?? 'zh') as 'zh' | 'en';
      const analysisType = inferAnalysisTypeFromResult(run) ?? normalizeAnalysisType(input.analysisType) ?? 'static';
      const workflowInputMode = analysisWorkflowInputModeFromResult(analysis);
      if (analysisType === 'seismic' && workflowInputMode !== 'structured_seismic_workflow') {
        return toolResult(toolCallId, 'generate_report', JSON.stringify({
          success: false,
          error_code: 'SEISMIC_WORKFLOW_REQUIRED',
          error: 'China seismic reports require analysis results produced from a structured seismicWorkflow, not the lower-level legacy compatibility parameter path.',
          messageZh: '中国抗震计算书必须基于结构化 seismicWorkflow 分析结果生成，不能使用底层旧参数兼容路径生成正式计算书。',
          workflowInputMode: workflowInputMode ?? null,
          nextAction: 'Call extract_draft_params or pass seismicWorkflowJson, rerun run_analysis and run_code_check, then retry generate_report.',
        }));
      }
      if (analysisType === 'seismic' && scope?.design !== false && !hasValidChinaSeismicCodeCheck(codeCheck, analysis)) {
        return toolResult(toolCallId, 'generate_report', JSON.stringify({
          success: false,
          error_code: 'SEISMIC_CODE_CHECK_REQUIRED',
          error: 'China seismic reports require run_code_check with GB/T 50011-2010-2024 after run_analysis. Call run_code_check first, then retry generate_report.',
          messageZh: '中国抗震报告必须先完成 GB/T 50011-2010(2024) 抗震规范校核；请先调用 run_code_check，再重试 generate_report。',
          requiredCodeCheckSkillId: 'code-check-gb50011',
          actualCodeCheckSkillId: codeCheckSkillIdFromResult(codeCheck),
        }));
      }

      const result = input.narrative === 'structured' ? { report: createEngineeringReport({
        message: input.message, analysisType, normalizedModel, analysis, codeCheck, locale, reportSource: 'selected-result' }) }
        : await skillRuntime.executeReportSkill({
        message: input.message,
        analysisType,
        normalizedModel,
        analysis,
        codeCheck,
        format: 'both',
        locale,
        draft: draftState,
        skillIds,
      });

      // A valid analysis/report does not erase an unresolved query from this turn.
      // Keep the available results, while making partial delivery explicit in every format.
      const pendingQueryFailure = currentRunContext()?.usage.pendingFailures.query_results;
      if (pendingQueryFailure) {
        const warning = locale === 'zh'
          ? '本轮仍有未解决的结果查询失败。报告保留已有计算结果，但不能视为所有所求结果均已交付。'
          : 'This turn still has an unresolved result query failure. The report retains available analysis results, but does not establish that all requested results have been delivered.';
        result.report.summary = `${warning} ${result.report.summary}`;
        result.report.json = { ...result.report.json, workflowStatus: { completionStatus: 'incomplete',
          reasonCodes: ['UNRESOLVED_RESULT_QUERY'], pendingTools: ['query_results'], message: warning } };
        result.report.markdown = `> ${warning}\n\n${result.report.markdown ?? ''}`;
      }

      await attachNativeReport({ ...result.report, markdown: result.report.markdown ?? '' }, {
        message: input.message, analysisType, normalizedModel, analysis, codeCheck, locale,
      });

      // Store report in graph state via Command
      logToolCall(log, { tool: 'generate_report', durationMs: Date.now() - start, extra: { analysisType, locale, success: true } });
      return toolResult(
        toolCallId,
        'generate_report',
        JSON.stringify({ success: true, summary: result.report.summary, ...(result.report.json.workflowStatus ? { workflowStatus: result.report.json.workflowStatus } : {}), ...(selection ? { report: result.report } : {}) }),
        selection ? {} : { report: result.report as unknown as Record<string, unknown> },
      );
    },
    {
      name: 'generate_report',
      description:
        'Generate an engineering report with summary, key metrics, and compliance narrative. ' +
        'Reads analysis results, code check results, and draft state from conversation state automatically — ' +
        'do NOT pass them as parameters. ' +
        'Requires run_analysis to have been called first. For a scalar selection, first call query_results with the identical run/result, location, component, unit and index; reading a full field alone does not register the scalar. The query assigns quantityId automatically. / 指定标量selection前须先用query_results查询同一运行/结果、位置、分量、单位与索引；整个字段查询不会登记标量，数值ID自动生成。 ' +
        'For China seismic reports, run_code_check with GB/T 50011-2010-2024 must be called first.',
      schema: z.object({
        message: z.string().describe('Original user message / intent'),
        analysisType: z
          .enum(['static', 'dynamic', 'seismic', 'nonlinear'])
          .describe('Analysis type that was performed'),
        locale: z.enum(['zh', 'en']).optional().describe('Report language'),
        selection: resultSelectionSchema.optional().describe('Saved run/result and optional scalar already registered by query_results using exactly the same component, unit, location and index. Omit to report the current run. Does not replace the current report. / 保存的运行/结果及已由query_results登记的同分量、单位、位置、索引标量。省略则报告当前运行；指定selection不覆盖当前报告。'),
        narrative: z.enum(['structured', 'assisted']).optional().describe('structured produces a deterministic report without an extra language-model call. / structured直接生成结构化报告，不额外调用语言模型。'),
        requestScope: requestScopeSchema.optional().describe('Update the goal only when the user explicitly asks for a report. / 用户明确要求报告时更新目标。'),
      }),
    },
  );
}

export { resolveToolInputMessage, resolveExtractionInputMessage } from './tools/input-message.js';
export { resolveRequestedAnalysisSkillId, resolveRequestedAnalysisEngineId, resolveUnselectedRequestedAnalysisSkillId } from './tools/analysis-resolution.js';
export { shouldPreserveExistingDraftState, resolveRetryTaskMessage, buildPreservedDraftExtractionResult, resolveDetectedStructuralTypeMatch } from './tools/draft-helpers.js';
export { buildAnalysisToolSummary, buildModelToolSummary, buildModelToolStateUpdate } from './tools/compaction/analysis.js';
