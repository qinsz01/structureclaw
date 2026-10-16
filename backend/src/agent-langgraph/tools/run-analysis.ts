import { randomUUID } from 'node:crypto';
import { resultEngine } from '../../engineering/result-data.js';
import { ANALYSIS_SKILL_IDS } from '../../agent-skills/analysis/catalog.js';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { AgentSkillRuntime } from '../../agent-runtime/index.js';
import { type LangGraphRunnableConfig, Command } from '@langchain/langgraph';
import { getLogger, logToolCall } from '../../utils/agent-logger.js';
import type { AgentState } from '../state.js';
import type { AgentConfigurable } from '../configurable.js';
import { beginAnalysisRequest, publishAnalysis } from '../../engineering/model-state.js';
import { analysisSettingsHash } from '../../engineering/analysis-runs.js';
import { assertAnalysisInputEvidenceMatchesRequest, assertInputEvidenceMatchesModel } from '../../engineering/input-evidence.js';
import { recordRunEvent, reserveToolCall, recordToolOutcome } from '../../runtime/run-context.js';
import { createQueryResultsTool } from '../model-tools.js';
import { requestScopeSchema, forceOnlyScope, type RequestScope } from '../../engineering/request-scope.js';
import { equilibriumModel } from '../../engineering/beam-equilibrium.js';
import { resolveRequestedAnalysisSkillId, resolveUnselectedRequestedAnalysisSkillId, buildAnalysisProviderNotSelectedPayload } from './analysis-resolution.js';
import { buildAnalysisToolSummary } from './compaction/analysis.js';
import { parseJsonObjectInput, hasStructuredSeismicWorkflow, hasSemanticSeismicWorkflowInput, mergeSeismicWorkflowInputs } from './seismic-workflow/merge.js';
import { validateSeismicWorkflowInput } from './seismic-workflow/validate-design.js';
import { getConfigurable, getToolCallId, toolResult, isRecord, pickStringLike, toolSkillScope } from './shared.js';

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
      const skillIds = toolSkillScope(config);
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
