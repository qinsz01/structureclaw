import { attachNativeReport, createEngineeringReport } from '../agent-runtime/engineering-report.js';
import { nativeDesignRecord, resolveCheckProvider, type CodeCheckProvider } from '../engineering/native-design.js';
import { resultEngine } from '../engineering/result-data.js';
import { checkRunResults, validateServiceabilitySelection } from '../engineering/code-checks.js';
import { modelHash, isRecord as isReportResult } from '../engineering/model-state.js';
import { analysisSettingsHash } from '../engineering/analysis-runs.js';
import { randomUUID } from 'node:crypto';
import { prisma } from '../utils/database.js';
import { Prisma } from '../generated/prisma/client.js';
import { cache } from '../utils/cache.js';
import { ensureConversationId } from '../utils/demo-conversation.js';
import { AnalysisExecutionService } from './analysis-execution.js';
import { CodeCheckExecutionService, createLocalCodeCheckClient } from './code-check-execution.js';
import {
  buildCodeCheckInput,
  executeCodeCheckDomain,
} from '../agent-skills/code-check/entry.js';
import { resolveCodeCheckRule } from '../agent-skills/code-check/registry.js';
import type { AppLocale } from '../shared/locale.js';
import { normalizeEngineeringModel } from '../engineering/model-boundary.js';
import { createLocalStructureProtocolClient } from '../skill-shared/structure-protocol-execution.js';
import {
  assertCanonicalCoordinateModel,
  buildStructuralCoordinateSystem,
  STRUCTURAL_COORDINATE_CONTRACT_VERSION,
  STRUCTURAL_COORDINATE_SEMANTICS,
} from '../engineering/coordinate-semantics.js';

interface CreateModelParams {
  [key: string]: unknown;
  name: string;
  coordinate_system?: ReturnType<typeof buildStructuralCoordinateSystem>;
  source_frame?: 'y-up' | 'z-up' | Record<string, string>;
  nodes: any[];
  elements: any[];
  materials: any[];
  sections: any[];
  load_cases?: unknown[];
  load_combinations?: unknown[];
  conversationId?: string;
}

interface CreateAnalysisParams {
  name: string;
  type: string;
  modelId: string;
  parameters: any;
  engineId?: string;
}

const DEFAULT_CHINA_SEISMIC_CODE = 'GB/T 50011-2010-2024';

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function withDirectModelCoordinateContract<T extends Record<string, unknown>>(model: T): T & {
  coordinate_system: ReturnType<typeof buildStructuralCoordinateSystem>;
  metadata: Record<string, unknown>;
} {
  const coordinateSystem = asRecord(model.coordinate_system ?? model.coordinateSystem);
  const dimension = coordinateSystem.dimension;
  if (dimension !== '2d' && dimension !== '3d') {
    throw new Error('Direct structural models must include a typed coordinate_system contract; legacy geometry cannot be classified safely from coordinates alone');
  }
  const metadata = asRecord(model.metadata);
  const canonical = {
    ...model,
    schema_version: typeof model.schema_version === 'string' ? model.schema_version : '2.2.0',
    unit_system: typeof model.unit_system === 'string' ? model.unit_system : 'SI',
    coordinate_system: coordinateSystem,
    metadata: {
      ...metadata,
      coordinateSemantics: STRUCTURAL_COORDINATE_SEMANTICS,
      coordinateContractVersion: STRUCTURAL_COORDINATE_CONTRACT_VERSION,
      frameDimension: dimension,
      source: typeof metadata.source === 'string' ? metadata.source : 'direct-analysis-api',
    },
  };
  assertCanonicalCoordinateModel(canonical, dimension);
  return {
    ...canonical,
    coordinate_system: buildStructuralCoordinateSystem(dimension),
  };
}

function codeCheckPayload(codeCheck: unknown): Record<string, unknown> {
  const record = asRecord(codeCheck);
  const data = asRecord(record.data);
  return Object.keys(data).length > 0 ? data : record;
}


function directReportLocale(parameters: Record<string, unknown>): AppLocale {
  return parameters.locale === 'en' ? 'en' : 'zh';
}

export function buildDirectSeismicReport(options: {
  analysisName: string;
  analysisType: string;
  analysisResults: Record<string, unknown>;
  codeCheck: unknown;
  parameters: Record<string, unknown>;
}): { summary: string; json: Record<string, unknown>; markdown: string } {
  const locale = directReportLocale(options.parameters);
  const message = typeof options.parameters.message === 'string' ? options.parameters.message
    : typeof options.parameters.intent === 'string' ? options.parameters.intent
      : locale === 'zh' ? `直接分析任务：${options.analysisName}` : `Direct analysis task: ${options.analysisName}`;
  return createEngineeringReport({ message, analysisType: 'seismic', analysis: options.analysisResults,
    codeCheck: codeCheckPayload(options.codeCheck), locale, reportSource: 'direct-analysis-api' });
}

export function shouldRunDirectSeismicCodeCheck(
  analysisType: string,
  parameters: unknown,
): boolean {
  const params = asRecord(parameters);
  return analysisType === 'seismic'
    && params.autoCodeCheck !== false
    && Object.keys(asRecord(params.seismicWorkflow)).length > 0;
}

export function buildDirectAnalysisModelForCodeCheck(model: {
  coordinate_system?: unknown;
  coordinateSystem?: unknown;
  nodes: unknown;
  elements: unknown;
  materials: unknown;
  sections: unknown;
}): Record<string, unknown> {
  return withDirectModelCoordinateContract({
    ...model,
    schemaVersion: asRecord(model).schema_version ?? asRecord(model).schemaVersion ?? '2.2.0',
    schema_version: asRecord(model).schema_version ?? asRecord(model).schemaVersion ?? '2.2.0',
    coordinate_system: model.coordinate_system ?? model.coordinateSystem,
    nodes: Array.isArray(model.nodes) ? model.nodes : [],
    elements: Array.isArray(model.elements) ? model.elements : [],
    materials: Array.isArray(model.materials) ? model.materials : [],
    sections: Array.isArray(model.sections) ? model.sections : [],
    load_cases: asRecord(model).load_cases ?? [],
    load_combinations: asRecord(model).load_combinations ?? [],
  });
}

export function resolveDirectChinaSeismicDesignCode(parameters: Record<string, unknown>): string {
  const designCode = typeof parameters.designCode === 'string' && parameters.designCode.trim()
    ? parameters.designCode.trim()
    : DEFAULT_CHINA_SEISMIC_CODE;
  try {
    const rule = resolveCodeCheckRule(designCode);
    if (rule.skillId === 'code-check-gb50011') {
      return designCode;
    }
  } catch {
    // Fall through to the explicit China seismic configuration error below.
  }
  throw new Error(
    `China seismic direct analysis requires a GB50011-compatible designCode (${DEFAULT_CHINA_SEISMIC_CODE}); received ${designCode}. `
    + `中国抗震直接分析必须使用兼容 GB50011 的设计规范（${DEFAULT_CHINA_SEISMIC_CODE}）。`,
  );
}

export class AnalysisService {
  private readonly executionService: AnalysisExecutionService;
  private readonly codeCheckExecutionService: CodeCheckExecutionService;

  constructor() {
    this.executionService = new AnalysisExecutionService();
    this.codeCheckExecutionService = new CodeCheckExecutionService();
  }

  // 创建结构模型
  async createModel(params: CreateModelParams) {
    const conversationId = await ensureConversationId(params.conversationId, params.name);
    const { conversationId: _conversationId, ...inputModel } = params;
    const rawInput = {
      ...inputModel,
      load_cases: params.load_cases ?? [],
      load_combinations: params.load_combinations ?? [],
    };
    const canonicalInput = await normalizeEngineeringModel(
      rawInput.source_frame !== undefined ? { schema_version: '2.2.0', ...rawInput } : withDirectModelCoordinateContract(rawInput),
      createLocalStructureProtocolClient());

    const model = await prisma.structuralModel.create({
      data: {
        name: params.name,
        nodes: params.nodes,
        elements: params.elements,
        materials: params.materials,
        sections: params.sections,
        coordinateSystem: canonicalInput.coordinate_system as any,
        physicalModel: canonicalInput as any,
        conversationId,
      },
    });
    const canonicalModel = withDirectModelCoordinateContract({ ...model, ...canonicalInput, id: model.id });

    // 缓存模型数据
    await cache.setex(
      `model:${model.id}`,
      3600,
      JSON.stringify(canonicalModel)
    );

    return canonicalModel;
  }

  // 获取模型
  async getModel(id: string) {
    // 先从缓存获取
    const cached = await cache.get(`model:${id}`);
    if (cached) {
      const cachedModel = JSON.parse(cached) as Record<string, unknown>;
      return withDirectModelCoordinateContract(cachedModel);
    }

    const model = await prisma.structuralModel.findUnique({
      where: { id },
      include: {
        analyses: {
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
      },
    });

    if (model) {
      const modelRecord = model as unknown as Record<string, unknown>;
      const canonicalModel = withDirectModelCoordinateContract({ ...modelRecord, ...asRecord(modelRecord.physicalModel), id: modelRecord.id });
      await cache.setex(`model:${id}`, 3600, JSON.stringify(canonicalModel));
      return canonicalModel;
    }

    return null;
  }

  // 创建分析任务
  async createAnalysisTask(params: CreateAnalysisParams) {
    return prisma.analysis.create({
      data: {
        name: params.name,
        type: params.type,
        modelId: params.modelId,
        parameters: params.engineId ? { ...(params.parameters || {}), engineId: params.engineId } : params.parameters,
        status: 'pending',
      },
    });
  }

  // 运行分析
  async runAnalysis(analysisId: string) {
    const analysis = await prisma.analysis.findUnique({
      where: { id: analysisId },
      include: { model: true },
    });

    if (!analysis) {
      throw new Error('分析任务不存在');
    }

    // A task is not a solver request. Claim it atomically so concurrent HTTP
    // calls cannot launch duplicate native jobs or publish out of order.
    const reservation = { requestId: randomUUID(), modelVersion: analysis.model.updatedAt?.toISOString(),
      parameters: analysis.parameters, type: analysis.type };
    const currentInput = { id: analysisId, type: analysis.type,
      parameters: { equals: analysis.parameters === null ? Prisma.JsonNull : analysis.parameters as Prisma.InputJsonValue },
      model: { updatedAt: analysis.model.updatedAt } };
    const claimed = await prisma.analysis.updateMany({ where: { ...currentInput, status: { not: 'running' } },
      data: { status: 'running', startedAt: new Date(), completedAt: null, error: null, results: reservation } });
    if (claimed.count !== 1) throw new Error('ANALYSIS_TASK_RUNNING_OR_CHANGED / 分析任务正在运行或输入已变化');
    const owned = { id: analysisId, status: 'running', results: { equals: reservation } };

    try {
      const persistedModel = {
        ...analysis.model,
        coordinate_system: analysis.model.coordinateSystem,
        ...asRecord(analysis.model.physicalModel),
      };
      const canonicalAnalysisModel = buildDirectAnalysisModelForCodeCheck(persistedModel);
      const results = await this.executionService.analyze({
        type: analysis.type,
        engineId: (analysis.parameters as Record<string, unknown> | null)?.engineId,
        model: canonicalAnalysisModel,
        parameters: analysis.parameters,
        requestId: reservation.requestId,
      });
      if (results && results.success === false) {
        const errorCode = results.error_code || 'ANALYSIS_EXECUTION_FAILED';
        const message = results.message || 'Analysis execution failed';
        throw new Error(`[${errorCode}] ${message}`);
      }
      const parameters = asRecord(analysis.parameters);
      const shouldRunSeismicCodeCheck = shouldRunDirectSeismicCodeCheck(analysis.type, parameters);
      const analysisResults = asRecord(results);
      let finalResults: Record<string, unknown> = shouldRunSeismicCodeCheck
        ? analysisResults
        : (results as Record<string, unknown>);
      if (shouldRunSeismicCodeCheck) {
        const codeCheck = await this.runDirectSeismicCodeCheck({
          analysisId,
          model: canonicalAnalysisModel,
          analysisResults,
          parameters,
        });
        finalResults = {
          ...analysisResults,
          codeCheck,
          report: buildDirectSeismicReport({
            analysisName: analysis.name,
            analysisType: analysis.type,
            analysisResults,
            codeCheck,
            parameters,
          }),
        };
      }

      // 保存结果
      const updatedAnalysis = await prisma.analysis.update({
        where: { ...currentInput, ...owned },
        data: {
          status: 'completed',
          completedAt: new Date(),
          results: finalResults as any,
        },
      });

      return updatedAnalysis;
    } catch (error: any) {
      const failure = error?.code === 'P2025' ? new Error('ANALYSIS_RUN_SUPERSEDED / 分析期间输入或当前作业已变化') : error;
      await prisma.analysis.updateMany({
        where: owned,
        data: {
          status: 'failed',
          error: failure.message,
          completedAt: new Date(),
        },
      });

      throw failure;
    }
  }

  private async runDirectSeismicCodeCheck(options: {
    analysisId: string;
    model: Record<string, unknown>;
    analysisResults: Record<string, unknown>;
    parameters: Record<string, unknown>;
  }): Promise<unknown> {
    const designCode = resolveDirectChinaSeismicDesignCode(options.parameters);
    const model = options.model;
    return this.checkAnalysisRun({ analysisId: options.analysisId, model, analysis: options.analysisResults,
      parameters: options.parameters, analysisType: 'seismic', code: designCode });
  }

  private async checkAnalysisRun(options: {
    analysisId: string; model: Record<string, unknown>; analysis: Record<string, unknown>;
    parameters: Record<string, unknown>; analysisType: string; code: string; elements?: string[]; engineId?: string;
  }): Promise<Record<string, unknown>> {
    const runId = options.analysis.runId;
    const fingerprint = modelHash(options.model);
    if (typeof runId !== 'string' || !runId || options.analysis.success !== true) {
      throw new Error('CURRENT_ANALYSIS_RUN_REQUIRED');
    }
    const meta = asRecord(options.analysis.meta);
    if (meta.modelHash !== fingerprint || meta.runId !== runId) throw new Error('ANALYSIS_MODEL_MISMATCH');
    const settingsHash = analysisSettingsHash(options.analysisType, options.parameters.engineId, options.parameters);
    if (meta.settingsHash !== settingsHash) throw new Error('ANALYSIS_SETTINGS_MISMATCH');
    const knownIds = new Set((Array.isArray(options.model.elements) ? options.model.elements : [])
      .map(element => asRecord(element).id));
    if (options.elements?.some(id => !knownIds.has(id))) throw new Error('CODE_CHECK_ELEMENT_NOT_FOUND');
    validateServiceabilitySelection(options.model, options.analysis);
    const result = await checkRunResults(options.analysis, async caseResult => {
      const caseMeta = asRecord(caseResult.meta);
      if (caseResult.success !== true || caseMeta.runId !== runId || caseMeta.modelHash !== fingerprint || caseMeta.settingsHash !== settingsHash) {
        throw new Error('ANALYSIS_RESULT_PROVENANCE_MISMATCH');
      }
      const input = buildCodeCheckInput({
        traceId: typeof options.model.id === 'string' ? options.model.id : options.analysisId,
        designCode: options.code, model: options.model, analysis: caseResult,
        analysisParameters: options.parameters, codeCheckElements: options.elements,
      });
      input.context.source = { ...input.context.source, modelId: options.model.id, analysisId: options.analysisId };
      const response = asRecord(await executeCodeCheckDomain(createLocalCodeCheckClient(this.codeCheckExecutionService), input, options.engineId));
      const data = asRecord(response.data);
      return Object.keys(data).length ? data : response;
    });
    return { ...result, meta: { ...asRecord(result.meta), runId, modelHash: fingerprint, analysisId: options.analysisId } };
  }

  // 获取分析结果
  async generateReport(analysisId: string, input: { runId: string; locale?: AppLocale; resultKey?: string }) {
    const stored = await prisma.analysis.findUnique({ where: { id: analysisId }, include: { model: true } });
    if (!stored || stored.status !== 'completed') throw new Error('CURRENT_ANALYSIS_RUN_REQUIRED');
    const run = asRecord(stored.results);
    const model = buildDirectAnalysisModelForCodeCheck({ ...stored.model,
      coordinate_system: stored.model.coordinateSystem, ...asRecord(stored.model.physicalModel) });
    const meta = asRecord(run.meta);
    if (run.runId !== input.runId || meta.modelHash !== modelHash(model)) throw new Error('REPORT_MODEL_MISMATCH');
    if (meta.settingsHash !== analysisSettingsHash(stored.type, asRecord(stored.parameters).engineId, asRecord(stored.parameters))) {
      throw new Error('ANALYSIS_SETTINGS_MISMATCH');
    }
    const selected = input.resultKey === undefined ? run : asRecord(run.results)[input.resultKey];
    if (!isReportResult(selected)) throw new Error('RESULT_NOT_FOUND');
    const analysis = input.resultKey ? { ...run, ...selected, runId: run.runId, results: run.results, selectedResultKey: input.resultKey } : run;
    const codeCheck = Object.keys(asRecord(run.codeCheck)).length ? run.codeCheck : undefined;
    const options = { message: stored.name, analysisType: (['static','dynamic','seismic','nonlinear'].includes(stored.type) ? stored.type : 'static') as 'static'|'dynamic'|'seismic'|'nonlinear',
      normalizedModel: model, analysis, codeCheck, locale: input.locale ?? 'zh' as AppLocale };
    const report = createEngineeringReport(options);
    await attachNativeReport(report, options);
    return report;
  }

  async getResults(analysisId: string) {
    const analysis = await prisma.analysis.findUnique({
      where: { id: analysisId },
      select: {
        id: true,
        name: true,
        type: true,
        status: true,
        results: true,
        error: true,
        createdAt: true,
        completedAt: true,
      },
    });

    return analysis;
  }

  // 规范校核
  async codeCheck(params: {
    modelId: string;
    analysisId?: string;
    runId?: string;
    code: string;
    elements: string[];
    context?: Record<string, unknown>;
    engineId?: string;
    provider?: CodeCheckProvider;
    design?: Record<string, unknown>;
  }) {
    if (!params.analysisId || !params.runId) throw new Error('ANALYSIS_ID_AND_RUN_ID_REQUIRED');
    if (Object.keys(asRecord(params.context)).length) throw new Error('CODE_CHECK_CONTEXT_OVERRIDE_UNSUPPORTED');
    const analysis = await prisma.analysis.findUnique({ where: { id: params.analysisId }, include: { model: true } });
    if (!analysis || analysis.modelId !== params.modelId) throw new Error('ANALYSIS_MODEL_NOT_FOUND');
    const results = asRecord(analysis.results);
    if (analysis.status !== 'completed' || results.runId !== params.runId) throw new Error('CURRENT_ANALYSIS_RUN_REQUIRED');
    const model = buildDirectAnalysisModelForCodeCheck({ ...analysis.model,
      coordinate_system: analysis.model.coordinateSystem, ...asRecord(analysis.model.physicalModel) });
    const sourceParameters = asRecord(analysis.parameters);
    const sourceMeta = asRecord(results.meta);
    if (results.success === false) throw new Error('CURRENT_ANALYSIS_RUN_REQUIRED');
    if (sourceMeta.modelHash !== modelHash(model)) throw new Error('ANALYSIS_MODEL_MISMATCH');
    if (sourceMeta.settingsHash !== analysisSettingsHash(analysis.type, sourceParameters.engineId, sourceParameters)) throw new Error('ANALYSIS_SETTINGS_MISMATCH');
    const currentInput = { id: analysis.id, type: analysis.type, model: { updatedAt: analysis.model.updatedAt },
      parameters: { equals: analysis.parameters === null ? Prisma.JsonNull : analysis.parameters as Prisma.InputJsonValue } };
    if (resolveCheckProvider(params.provider, results) === 'native') {
      const engineId = `builtin-${resultEngine(results)}`;
      if (params.engineId && params.engineId !== engineId) throw new Error('DESIGN_ENGINE_MISMATCH');
      const parameters = { ...sourceParameters, engineId, design: { ...params.design, requested: true, code: params.code } };
      const reservation = { requestId: randomUUID(), previousRunId: params.runId, purpose: 'native-design' };
      const claimed = await prisma.analysis.updateMany({ where: { ...currentInput, status: 'completed',
        results: { equals: JSON.parse(JSON.stringify(analysis.results)) } },
        data: { status: 'running', results: reservation, startedAt: new Date(), completedAt: null, error: null } });
      if (claimed.count !== 1) throw new Error('DESIGN_RUN_SUPERSEDED');
      const owned = { id: analysis.id, status: 'running', results: { equals: reservation } };
      try {
      const designRun = await this.executionService.analyze({ type: 'static', engineId, model, parameters, requestId: reservation.requestId });
      const record = nativeDesignRecord(model, designRun, params.code);
      const published = await prisma.analysis.updateMany({ where: { ...currentInput, ...owned }, data: {
        results: JSON.parse(JSON.stringify({ ...designRun, codeCheck: record })),
        parameters: JSON.parse(JSON.stringify({ ...parameters, engineId })),
        status: designRun.success === true ? 'completed' : 'failed', completedAt: new Date(),
      } });
      if (published.count !== 1) throw new Error('DESIGN_RUN_SUPERSEDED');
      return record;
      } catch (error) {
        await prisma.analysis.updateMany({ where: owned, data: {status:'failed', completedAt:new Date(),
          error: error instanceof Error ? error.message : String(error)} });
        throw error;
      }
    }
    if (params.design) throw new Error('BUILTIN_DESIGN_REQUEST_UNSUPPORTED');
    const checked = await this.checkAnalysisRun({ analysisId: analysis.id, model, analysis: results,
      parameters: asRecord(analysis.parameters), analysisType: analysis.type, code: params.code, elements: params.elements, engineId: params.engineId });
    const published = await prisma.analysis.updateMany({ where: { ...currentInput, status:'completed',
      results: { equals: JSON.parse(JSON.stringify(analysis.results)) } }, data: {
      results: JSON.parse(JSON.stringify({ ...results, codeCheck: checked })),
    } });
    if (published.count !== 1) throw new Error('DESIGN_RUN_SUPERSEDED');
    return checked;
  }
}
