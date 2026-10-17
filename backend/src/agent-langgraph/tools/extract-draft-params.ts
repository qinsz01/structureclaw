import { computeDraftMissing } from '../../agent-runtime/draft-readiness.js';
import { projectDraftState } from '../../agent-runtime/draft/boundary.js';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { AgentSkillRuntime } from '../../agent-runtime/index.js';
import type { LangGraphRunnableConfig, Command } from '@langchain/langgraph';
import { getLogger, logToolCall } from '../../utils/agent-logger.js';
import type { AgentState } from '../state.js';
import type { AgentConfigurable } from '../configurable.js';
import type { DraftState } from '../../shared/types/agent.js';
import { isFreshGenericStructuralRoute } from '../../agent-runtime/plugin-helpers.js';
import { invalidateStaleResults } from '../../engineering/model-state.js';
import { engineeringModelSchema, draftDesignSchema, hasDraftDesignInputs, assertDraftDesignInputs, draftSectionShapeSchema, normalizeDraftSectionInputs } from '../../engineering/model-edit-contract.js';
import { createLocalStructureProtocolClient } from '../../skill-shared/structure-protocol-execution.js';
import { currentRunPolicy, recordRunEvent } from '../../runtime/run-context.js';
import { requestScopeSchema, resolveExtractedScope, missingInputReason, type RequestScope, type ScopeDiagnostic } from '../../engineering/request-scope.js';
import { equilibriumModel } from '../../engineering/beam-equilibrium.js';
import { buildDraftProgress, buildClarificationQuestions, hasStableDraftType, shouldPreserveExistingDraftState, resolveRetryTaskMessage, buildPreservedDraftExtractionResult, resolveExistingDraftPlugin, detectStructuralTypeWithConfiguredLlm, resolveDetectedStructuralTypeMatch } from './draft-helpers.js';
import { resolveExtractionInputMessage } from './input-message.js';
import { getConfigurable, getToolCallId, toolResult, nestedLlmUsageCollector, toolSkillScope } from './shared.js';

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
          const { withStructuralTypeState } = await import('../../agent-runtime/plugin-helpers.js');
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
          const stateUpdate: Partial<AgentState> = { ...(resetToGeneric ? { ...invalidateStaleResults(state), modelPending: true } : {}),
            draftState: nextState, structuralTypeKey: match.key };
          logToolCall(log, { tool: 'extract_draft_params', durationMs: Date.now() - start, extra: { skillId: plugin.id, extractionMode: 'deterministic', criticalMissing: missing.critical.length, routingSource: match.routingSource } });
          return extractionToolResult(JSON.stringify(responseJson), stateUpdate);
        }

        // Step 3: Sub-agent extracts parameters (skill manifest driven)
        const { invokeParamExtractor } = await import('../param-extractor.js');
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
        const { withStructuralTypeState } = await import('../../agent-runtime/plugin-helpers.js');
        const scopeDiagnostics: ScopeDiagnostic[] = [];
        const requestScope = resolveExtractedScope(input.requestScope, draftPatch?.requestScope, state?.requestScope, scopeDiagnostics);
        if (scopeDiagnostics.length) recordRunEvent({ kind: 'request_scope_diagnostic', source: 'parameter-extractor', diagnostics: scopeDiagnostics,
          resolvedBy: input.requestScope ? 'declared-request' : state?.requestScope ? 'accepted-request' : 'clarification' });
        let nextState = { ...withStructuralTypeState(plugin.handler.mergeState(existingState, patch), match),
          ...(requestScope ? { requestScope } : {}) };
        if (nextState.engineeringDraft?.sectionRecords?.length || Array.isArray(nextState.engineeringDraft?.model?.sections)) {
          designContract ??= await engineeringModelSchema(protocolClient);
          nextState = projectDraftState(normalizeDraftSectionInputs(nextState.engineeringDraft!, designContract), nextState);
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
          Object.assign(stateUpdate, invalidateStaleResults(state));
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
