import { getAnalysisSkillCatalogEntry } from '../../providers/analysis-catalog.js';
import { providerAccessError } from '../../providers/access.js';
import { randomUUID } from 'node:crypto';
import { ANALYSIS_SKILL_IDS } from '../../providers/analysis-catalog.js';
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
import { assertConfirmedSectionInputs } from '../../engineering/section-provenance.js';
import { conversationSectionEvidence } from './input-message.js';
import { recordRunEvent, reserveToolCall, recordToolOutcome } from '../../runtime/run-context.js';
import { createQueryResultsTool } from '../model-tools.js';
import { requestScopeSchema, type RequestScope } from '../../engineering/request-scope.js';
import { stiffnessPlaceholderOf, withoutPlaceholderDisplacements, type StiffnessPlaceholder } from '../../engineering/stiffness-placeholder.js';
import { resolveRequestedAnalysisSkillId } from './analysis-resolution.js';
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

interface RunAnalysisInput {
  analysisType: string;
  analysisSkillId?: string;
  loadCombinationId?: string;
  loadCaseIds?: string[];
  loadCombinationIds?: string[];
  floorLoadTransferMode?: 'auto_code_cn' | 'node_tributary' | 'one_way_slab' | 'two_way_slab';
  seismicWorkflowJson?: string;
  method?: 'modal' | 'time_history';
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
}

type AnalysisType = 'static' | 'dynamic' | 'seismic' | 'nonlinear';
type ToolPayloadOutcome<T> = { errorPayload: Record<string, unknown> } | T;

/** China seismic workflow: parsed tool argument, else the draft's, else the uploaded context; validated before solving. */
function resolveSeismicWorkflowInput(input: RunAnalysisInput, state: AgentState | undefined, analysisType: AnalysisType):
  ToolPayloadOutcome<{ seismicWorkflow: ReturnType<typeof mergeSeismicWorkflowInputs> }> {
  const parsedSeismicWorkflow = parseJsonObjectInput(input.seismicWorkflowJson, 'seismicWorkflowJson');
  if (parsedSeismicWorkflow && !parsedSeismicWorkflow.ok) {
    return {
      errorPayload: {
        success: false,
        error_code: 'INVALID_SEISMIC_WORKFLOW_JSON',
        message: parsedSeismicWorkflow.error,
      },
    };
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
    return {
      errorPayload: {
        success: false,
        error_code: 'SEISMIC_WORKFLOW_REQUIRED',
        message: 'China seismic analysis requires a non-empty structured seismicWorkflow from LLM semantic understanding before run_analysis.',
        messageZh: '中国抗震分析必须先由 LLM 语义理解形成非空 seismicWorkflow 结构化对象，不能直接按关键词进入计算。',
        nextAction: 'Call extract_draft_params or pass seismicWorkflowJson, then retry run_analysis.',
      },
    };
  }
  if (analysisType === 'seismic' && hasStructuredSeismicWorkflow(seismicWorkflow)) {
    const workflowErrors = validateSeismicWorkflowInput(seismicWorkflow);
    if (workflowErrors.length > 0) {
      return {
        errorPayload: {
          success: false,
          error_code: 'INVALID_SEISMIC_WORKFLOW',
          message: 'China seismic workflow contains invalid structured fields.',
          messageZh: '中国抗震 seismicWorkflow 存在无效结构化字段。',
          errors: workflowErrors,
          nextAction: 'Correct seismicWorkflowJson or rerun extract_draft_params to produce valid structured fields.',
        },
      };
    }
  }
  return { seismicWorkflow };
}

/** A requested load combination must exist in the current model. */
function resolveLoadCombinationId(model: Record<string, unknown>, requestedId: string | undefined):
  ToolPayloadOutcome<{ loadCombinationId: string | undefined }> {
  const rawLoadCombinations = Array.isArray(model.load_combinations)
    ? model.load_combinations
    : Array.isArray(model.loadCombinations)
      ? model.loadCombinations
      : [];
  const loadCombinationIds = rawLoadCombinations
    .filter(isRecord)
    .map((combination) => pickStringLike(combination, 'id'))
    .filter((id): id is string => !!id);
  const requestedLoadCombinationId = requestedId?.trim();
  if (requestedLoadCombinationId && !loadCombinationIds.includes(requestedLoadCombinationId)) {
    return {
      errorPayload: {
        success: false,
        error_code: 'LOAD_COMBINATION_NOT_FOUND',
        message: `Load combination '${requestedLoadCombinationId}' is not present in the current model.`,
        availableLoadCombinationIds: loadCombinationIds,
      },
    };
  }
  return { loadCombinationId: requestedLoadCombinationId };
}

/** Solver parameters: selectors, floor-load transfer, seismic workflow and explicit dynamic settings. */
function buildAnalysisParameters(
  input: RunAnalysisInput,
  analysisType: AnalysisType,
  seismicWorkflow: ReturnType<typeof mergeSeismicWorkflowInputs>,
  loadCombinationId: string | undefined,
): Record<string, unknown> {
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
  return parameters;
}

/** The solver result must belong to the reserved request; its meta records the binding, trace and scope. */
function bindAnalysisResult(
  raw: unknown,
  analysisRequest: ReturnType<typeof beginAnalysisRequest>['analysisRequest'],
  traceId: string,
  scope: RequestScope | null | undefined,
): Record<string, unknown> {
  const analysisResult: Record<string, unknown> = isRecord(raw)
    ? { ...raw }
    : { result: raw };
  const analysisMeta = isRecord(analysisResult.meta) ? analysisResult.meta : {};
  for (const key of ['modelRevision', 'modelHash', 'settingsHash', 'requestSequence'] as const) {
    if (analysisMeta[key] !== undefined && analysisMeta[key] !== analysisRequest[key]) {
      throw new Error(`ANALYSIS_RESULT_BINDING_MISMATCH: ${key}`);
    }
  }
  analysisResult.meta = {
    ...analysisMeta,
    traceId,
    ...analysisRequest,
    ...(scope ? { requestScope: scope } : {}),
  };
  return analysisResult;
}

/** What the agent must say about a placeholder-stiffness run: the equal-EI assumption, and no displacements. */
function placeholderDelivery(placeholder: StiffnessPlaceholder | undefined, locale: 'zh' | 'en') {
  if (!placeholder) return {};
  return { stiffnessPlaceholder: { material: placeholder.material, section: placeholder.section,
    staticIndeterminacy: placeholder.staticIndeterminacy, equalStiffnessAssumed: placeholder.equalStiffnessAssumed,
    notice: placeholder.notice[locale], availableResponses: ['forces', 'reactions'] } };
}

/** Tool message: compact summary plus the declared output deliveries and next action. */
function analysisResponsePayload(
  analysisSummary: ReturnType<typeof buildAnalysisToolSummary>,
  delivery: Awaited<ReturnType<typeof queryRequestedOutputs>> | undefined,
  scope: RequestScope | null | undefined,
  placeholder: Record<string, unknown> = {},
) {
  if (analysisSummary.success === false) return { ...analysisSummary, nextAction: 'report_failure',
    instruction: 'Report this analysis failure once with its diagnostics. No requested results were delivered; do not query missing results or repeat the same solve without corrected inputs. / 请一次性说明本次分析失败及诊断；未交付所求结果，不查询缺失结果，也不在输入未修正时重复求解。' };
  return { ...analysisSummary, ...placeholder, ...(delivery ? { requestedQuantities: delivery.requestedQuantities, missingRequestedOutputs: delivery.missingRequestedOutputs,
    deliveryScope: 'declared-output-selections',
    deliveryStatus: !scope?.outputs?.length ? 'not-specified' : delivery.missingRequestedOutputs.length ? 'partial' : 'complete' } : {}), ...(scope ? { requestScope: scope, requestedOutputs: scope.outputs,
    nextAction: 'query_results', instruction: 'Deliver the requested result locations, cases and units; code design/report only when explicitly requested. / 按指定位置、工况、单位交付；规范设计和报告分别按需。' } : {}) };
}

export function createRunAnalysisTool(skillRuntime: AgentSkillRuntime) {
  return tool(
    async (input: RunAnalysisInput, config: LangGraphRunnableConfig) => {
      const log = getLogger(config.configurable as Partial<AgentConfigurable> | undefined);
      const start = Date.now();
      const configurable = getConfigurable(config);
      const state = configurable.agentState;
      const toolCallId = getToolCallId(config);

      const scope = input.requestScope ?? state?.requestScope;

      // Read model from graph state channel
      const model = state?.model;
      if (model) assertConfirmedSectionInputs(model, conversationSectionEvidence(state));
      if (!model) {
        return toolResult(toolCallId, 'run_analysis', JSON.stringify({ error: 'No model available. Run build_model first.' }));
      }
      if (state?.modelPending) return toolResult(toolCallId, 'run_analysis', JSON.stringify({ success: false, error_code: 'MODEL_REBUILD_REQUIRED', message: 'Build the pending model first.', messageZh: '请先构建待确认的模型。' }));
      assertInputEvidenceMatchesModel(model, state?.inputEvidence);
      const skillIds = toolSkillScope(config);
      const analysisType = (input.analysisType || 'static') as 'static' | 'dynamic' | 'seismic' | 'nonlinear';
      const requestedAnalysisSkillId = resolveRequestedAnalysisSkillId(
        state?.lastUserMessage,
        skillIds,
        analysisType,
        input.analysisSkillId ?? (getAnalysisSkillCatalogEntry(state?.policy?.analysisProviderPreference)?.analysisType === analysisType
          ? state?.policy?.analysisProviderPreference : undefined),
      );
      const provider = getAnalysisSkillCatalogEntry(requestedAnalysisSkillId);
      const denied = requestedAnalysisSkillId && providerAccessError(requestedAnalysisSkillId, state?.runPolicy);
      if (denied) return toolResult(toolCallId, 'run_analysis', JSON.stringify(denied));
      if (!provider || provider.analysisType !== analysisType) return toolResult(toolCallId, 'run_analysis', JSON.stringify({
        success: false, error_code: 'ENGINE_UNAVAILABLE', providerId: requestedAnalysisSkillId,
        message: 'No enabled solver supports the requested analysis type.', messageZh: '没有已启用的求解器支持请求的分析类型。',
      }));
      const traceId = `lg-${Date.now()}`;
      const seismic = resolveSeismicWorkflowInput(input, state, analysisType);
      if ('errorPayload' in seismic) return toolResult(toolCallId, 'run_analysis', JSON.stringify(seismic.errorPayload));
      const { seismicWorkflow } = seismic;

      const engineClient = configurable.engineClient;
      const loadCombination = resolveLoadCombinationId(model, input.loadCombinationId);
      if ('errorPayload' in loadCombination) return toolResult(toolCallId, 'run_analysis', JSON.stringify(loadCombination.errorPayload));
      const parameters = buildAnalysisParameters(input, analysisType, seismicWorkflow, loadCombination.loadCombinationId);
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
      const analysisResult = bindAnalysisResult(result.result, reservation.analysisRequest, traceId, scope);
      const placeholder = stiffnessPlaceholderOf(model);
      if (placeholder) analysisResult.meta = { ...(isRecord(analysisResult.meta) ? analysisResult.meta : {}), stiffnessPlaceholder: placeholder };

      // Store analysis result in graph state via Command.
      // Keep ToolMessage content compact — the full data lives in graph state.
      // The streaming layer reads analysisResult from nodeState for artifact_payload_sync.
      const analysisSummary = buildAnalysisToolSummary({
        result: placeholder ? withoutPlaceholderDisplacements(analysisResult, placeholder) : analysisResult,
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
        JSON.stringify(analysisResponsePayload(analysisSummary, delivery, scope, placeholderDelivery(placeholder, state?.locale === 'en' ? 'en' : 'zh'))),
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
        'Select a solver provider with analysisSkillId, independently of structure-skill restrictions. An explicit unavailable provider fails without substitution. ' +
        'For China seismic analysis, pass seismicWorkflowJson only as the structured result of semantic understanding.',
      schema: z.object({
        analysisType: z
          .enum(['static', 'dynamic', 'seismic', 'nonlinear'])
          .default('static').describe('Type of analysis; default static. / 分析类型，缺省静力。'),
        analysisSkillId: z
          .enum(ANALYSIS_SKILL_IDS)
          .optional()
          .describe('Solver provider ID selected by LLM semantic understanding; independent of structure skills. / 求解器 Provider ID，由大模型理解需求后选择，与结构技能范围独立。'),
        loadCombinationId: z
          .string()
          .optional()
          .describe('Optional single load-combination ID. Without selectors, all declared static cases and combinations are run separately.'),
        loadCaseIds: z.array(z.string()).optional().describe('Explicit load cases to solve independently.'),
        loadCombinationIds: z.array(z.string()).optional().describe('Explicit combinations to solve independently.'),
        method: z.enum(['modal', 'time_history']).optional().describe('Dynamic method: modal or time_history. / 动力分析方法：modal或time_history。'),
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
