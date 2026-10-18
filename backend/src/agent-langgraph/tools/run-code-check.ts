import { randomUUID } from 'node:crypto';
import { nativeDesignRecord, resolveCheckProvider, type CodeCheckProvider } from '../../engineering/native-design.js';
import { resultEngine } from '../../engineering/result-data.js';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { AgentSkillRuntime } from '../../agent-runtime/index.js';
import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import { getLogger, logToolCall } from '../../utils/agent-logger.js';
import type { AgentConfigurable } from '../configurable.js';
import { beginNativeDesignRequest, currentAnalysisError, modelHash, publishNativeDesign } from '../../engineering/model-state.js';
import { analysisSettingsHash } from '../../engineering/analysis-runs.js';
import { checkRunResults, codeCheckFeedback, validateServiceabilitySelection } from '../../engineering/code-checks.js';
import { recordRunEvent } from '../../runtime/run-context.js';
import { requestScopeSchema, type RequestScope } from '../../engineering/request-scope.js';
import { analysisTraceIdFromResult } from './analysis-resolution.js';
import { stiffnessPlaceholderOf } from '../../engineering/stiffness-placeholder.js';
import { getConfigurable, getToolCallId, toolResult, isRecord, toolSkillScope } from './shared.js';

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
      // Whether to check is the agent's decision; this tool validates only the state it needs.
      if (resultEngine(state?.analysisResult ?? {}) === 'equilibrium') throw new Error('DESIGN_REQUIRES_FULL_MODEL / 规范设计需要真实材料截面及完整模型，不能使用无刚度平衡投影');
      if (stiffnessPlaceholderOf(state?.model)) return toolResult(toolCallId, 'run_code_check', JSON.stringify({ success: false,
        errorCode: 'STIFFNESS_PLACEHOLDER_MODEL', nextAction: 'ask_user_clarification',
        message: 'The current model used unit placeholder stiffness for a force-only request. A code check needs the real material grade and section: ask the user for them, extract the answer, rebuild, reanalyze, then check. Do not reuse the placeholder results.',
        messageZh: '当前模型仅为内力计算使用了单位刚度占位。规范验算需要实际材料牌号和截面：请向用户询问，提取答复后重新建模、分析再验算；不要沿用占位结果。' }));
      const skillIds = toolSkillScope(config);
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
          nextAction: 'Use provider auto/builtin without native design arguments; report missing design inputs instead of asking.' }));
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
        'Call when the user asks for a code check; designing a member is not such a request. ' +
        'Missing design inputs never interrupt: report the performed checks and list the checks not performed with their missing inputs in the final reply; do not ask clarification questions or loop. When the user later supplies values, write them via edit_model, reanalyze if the model changed, then check again. Never invent design conditions. ' +
        'Only if the user explicitly requests selected checks, set elements[id].design.requested_checks via edit_model; omit for all implemented checks. GB50017 IDs: normal_stress, shear_stress, equivalent_stress, lateral_stability, axial_stability, local_stability, slenderness, deflection. Exact item names also work. A selected subset is not full design compliance. / 仅按用户明确要求选择专项校核，不能为通过而缩小范围。',
      schema: z.object({
        designCode: z
          .string()
          .describe('Design code to check against (GB50010, GB50011, GB/T 50011-2010-2024, GB50017, JGJ3)'),
        provider: z.enum(['auto', 'native', 'builtin']).optional().describe('Commercial engines prefer native design; OpenSees uses builtin checks / 商业引擎优先原生设计，OpenSees采用公共校核。'),
        design: z.record(z.string(), z.unknown()).optional().describe('Explicit native design conditions / 明确的原生设计条件。'),
        engineId: z.string().optional().describe('Optional engine ID'),
        requestScope: requestScopeSchema.optional().describe('The current goal with design=true; preserve requested responses. / 当前目标（design=true），保留原有所求结果。'),
      }),
    },
  );
}
