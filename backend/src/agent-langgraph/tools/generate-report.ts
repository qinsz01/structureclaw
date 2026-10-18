import { savedNativeDesignRecord } from '../../engineering/native-design-options.js';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { AgentSkillRuntime } from '../../agent-runtime/index.js';
import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import { getLogger, logToolCall } from '../../utils/agent-logger.js';
import type { AgentConfigurable } from '../configurable.js';
import { loadAnalysisRun } from '../../engineering/analysis-runs.js';
import { resultSelectionSchema, selectedSavedResult, quantityMatchesSelection, type ResultSelection } from '../../engineering/result-selection.js';
import { createEngineeringReport, attachNativeReport } from '../../agent-runtime/engineering-report.js';
import { currentAnalysisError } from '../../engineering/model-state.js';
import { currentRunContext, currentRunPolicy } from '../../runtime/run-context.js';
import { runFeatures } from '../../runtime/ablation-profiles.js';
import { requestScopeSchema, type RequestScope } from '../../engineering/request-scope.js';
import { stiffnessPlaceholderOf } from '../../engineering/stiffness-placeholder.js';
import { normalizeAnalysisType, inferAnalysisTypeFromResult, codeCheckSkillIdFromResult, hasValidChinaSeismicCodeCheck, analysisWorkflowInputModeFromResult } from './analysis-resolution.js';
import { getConfigurable, getToolCallId, toolResult, isRecord, toolSkillScope } from './shared.js';

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
      // Whether to report is the agent's decision; this tool validates only the state it needs.
      const scope = input.requestScope ?? state?.requestScope;

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
      // A placeholder-stiffness run has forces only; a report would present stiffness-dependent content.
      if (stiffnessPlaceholderOf(run)) return toolResult(toolCallId, 'generate_report', JSON.stringify({ success: false,
        errorCode: 'STIFFNESS_PLACEHOLDER_RUN', nextAction: 'ask_user_clarification',
        message: 'This run used unit placeholder stiffness for forces only. Deliver the forces in the reply; a report needs the real material and section: ask for them, extract the answer, rebuild and reanalyze first.',
        messageZh: '本次运行仅为内力计算使用了单位刚度占位。请在回复中交付内力；如需报告，须先询问实际材料和截面，提取后重新建模分析。' }));
      const analysis = { ...run, ...(selection ? selected : {}), runId: run.runId, selectedResultKey: resultKey,
        results: selection && resultKey ? { [resultKey]: selected } : run.results,
        requestedQuantities: quantities, requestedSelection: selection };
      // Evidence-binding ablation: pair the session's current model and check with the selected run
      // without verifying that they belong together; the report records meta.evidenceBinding='off'.
      const evidenceBinding = runFeatures(currentRunPolicy()).evidenceBinding;
      const normalizedModel = evidenceBinding === 'off' ? state?.model ?? (isRecord(run.modelSnapshot) ? run.modelSnapshot : undefined)
        : isRecord(run.modelSnapshot) ? run.modelSnapshot : !freshnessError && run.runId === state?.analysisResult?.runId ? state?.model : undefined;
      if (!normalizedModel) throw new Error('RESULT_MODEL_SNAPSHOT_REQUIRED');
      const currentCheck = state?.codeCheckResult;
      const codeCheck = evidenceBinding === 'off' ? currentCheck ?? savedNativeDesignRecord(run) ?? undefined
        : !selection || (isRecord(currentCheck?.meta) && currentCheck.meta.runId === run.runId)
          ? currentCheck : savedNativeDesignRecord(run) ?? undefined;
      const draftState = selection?.runId ? undefined : state?.draftState || undefined;
      const skillIds = toolSkillScope(config);
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
        message: input.message, analysisType, normalizedModel, analysis, codeCheck, locale, reportSource: 'selected-result', evidenceBinding }) }
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
        evidenceBinding,
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
        message: input.message, analysisType, normalizedModel, analysis, codeCheck, locale, evidenceBinding,
      });

      // Store report in graph state via Command. A selection on the current run is also the current
      // report; a selection on an archived run never replaces it.
      const currentRunReport = !selection || (!freshnessError && run.runId === state?.analysisResult?.runId);
      logToolCall(log, { tool: 'generate_report', durationMs: Date.now() - start, extra: { analysisType, locale, success: true } });
      return toolResult(
        toolCallId,
        'generate_report',
        JSON.stringify({ success: true, summary: result.report.summary, ...(result.report.json.workflowStatus ? { workflowStatus: result.report.json.workflowStatus } : {}), ...(selection ? { report: result.report } : {}) }),
        currentRunReport ? { report: result.report as unknown as Record<string, unknown> } : {},
      );
    },
    {
      name: 'generate_report',
      description:
        'Generate an engineering report with summary, key metrics, and compliance narrative. ' +
        'Reads analysis results, code check results, and draft state from conversation state automatically — ' +
        'do NOT pass them as parameters. ' +
        'Requires run_analysis to have been called first. Call only when the user asks for a report, a calculation book or another deliverable document; "design a beam" and requests for specific results are not report requests. For a scalar selection, first call query_results with the identical run/result, location, component, unit and index; reading a full field alone does not register the scalar. The query assigns quantityId automatically. / 指定标量selection前须先用query_results查询同一运行/结果、位置、分量、单位与索引；整个字段查询不会登记标量，数值ID自动生成。 ' +
        'A China seismic report that includes a check needs run_code_check with GB/T 50011-2010-2024 first.',
      schema: z.object({
        message: z.string().describe('Original user message / intent'),
        analysisType: z
          .enum(['static', 'dynamic', 'seismic', 'nonlinear'])
          .describe('Analysis type that was performed'),
        locale: z.enum(['zh', 'en']).optional().describe('Report language'),
        selection: resultSelectionSchema.optional().describe('Saved run/result and optional scalar already registered by query_results using exactly the same component, unit, location and index. Omit to report the current run. Does not replace the current report. / 保存的运行/结果及已由query_results登记的同分量、单位、位置、索引标量。省略则报告当前运行；指定selection不覆盖当前报告。'),
        narrative: z.enum(['structured', 'assisted']).optional().describe('structured produces a deterministic report without an extra language-model call. / structured直接生成结构化报告，不额外调用语言模型。'),
        requestScope: requestScopeSchema.optional().describe('The current goal. / 当前目标。'),
      }),
    },
  );
}
