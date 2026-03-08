import axios, { AxiosInstance } from 'axios';
import { ChatOpenAI } from '@langchain/openai';
import { randomUUID } from 'crypto';
import { config } from '../config/index.js';

export type AgentToolName = 'text-to-model-draft' | 'convert' | 'validate' | 'analyze' | 'code-check';
export type AgentRunMode = 'chat' | 'execute' | 'auto';

export interface AgentRunParams {
  message: string;
  mode?: AgentRunMode;
  context?: {
    model?: Record<string, unknown>;
    modelFormat?: string;
    analysisType?: 'static' | 'dynamic' | 'seismic' | 'nonlinear';
    parameters?: Record<string, unknown>;
    autoAnalyze?: boolean;
  };
}

export interface AgentToolSpec {
  name: AgentToolName;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  errorCodes: string[];
}

export interface AgentProtocol {
  version: string;
  runRequestSchema: Record<string, unknown>;
  runResultSchema: Record<string, unknown>;
  streamEventSchema: Record<string, unknown>;
  tools: AgentToolSpec[];
  errorCodes: string[];
}

export interface AgentToolCall {
  tool: AgentToolName;
  input: Record<string, unknown>;
  output?: unknown;
  error?: string;
}

export interface AgentRunResult {
  traceId: string;
  durationMs: number;
  success: boolean;
  mode: 'rule-based' | 'llm-assisted';
  needsModelInput: boolean;
  plan: string[];
  toolCalls: AgentToolCall[];
  model?: Record<string, unknown>;
  analysis?: unknown;
  clarification?: {
    missingFields: string[];
    question: string;
  };
  response: string;
}

export interface AgentStreamChunk {
  type: 'start' | 'result' | 'done' | 'error';
  content?: unknown;
  error?: string;
}

export class AgentService {
  private readonly engineClient: AxiosInstance;
  private readonly llm: ChatOpenAI | null;

  constructor() {
    this.engineClient = axios.create({
      baseURL: config.analysisEngineUrl,
      timeout: 300000,
    });

    this.llm = config.openaiApiKey
      ? new ChatOpenAI({
          modelName: config.openaiModel,
          temperature: 0.1,
          openAIApiKey: config.openaiApiKey,
          configuration: {
            baseURL: config.openaiBaseUrl,
          },
        })
      : null;
  }

  static getProtocol(): AgentProtocol {
    const commonErrorCodes = [
      'UNSUPPORTED_SOURCE_FORMAT',
      'UNSUPPORTED_TARGET_FORMAT',
      'INVALID_STRUCTURE_MODEL',
      'INVALID_ANALYSIS_TYPE',
      'ANALYSIS_EXECUTION_FAILED',
      'AGENT_MISSING_MODEL_INPUT',
    ];

    return {
      version: '1.0.0',
      runRequestSchema: {
        type: 'object',
        required: ['message'],
        properties: {
          message: { type: 'string' },
          mode: { enum: ['chat', 'execute', 'auto'] },
          context: {
            type: 'object',
            properties: {
              model: { type: 'object' },
              modelFormat: { type: 'string' },
              analysisType: { enum: ['static', 'dynamic', 'seismic', 'nonlinear'] },
              parameters: { type: 'object' },
              autoAnalyze: { type: 'boolean' },
            },
          },
        },
      },
      runResultSchema: {
        type: 'object',
        required: ['traceId', 'durationMs', 'success', 'mode', 'needsModelInput', 'plan', 'toolCalls', 'response'],
        properties: {
          success: { type: 'boolean' },
          traceId: { type: 'string' },
          durationMs: { type: 'number' },
          mode: { enum: ['rule-based', 'llm-assisted'] },
          needsModelInput: { type: 'boolean' },
          plan: { type: 'array', items: { type: 'string' } },
          toolCalls: { type: 'array', items: { type: 'object' } },
          model: { type: 'object' },
          analysis: { type: 'object' },
          response: { type: 'string' },
        },
      },
      streamEventSchema: {
        oneOf: [
          {
            type: 'object',
            properties: {
              type: { const: 'start' },
              content: { type: 'object' },
            },
            required: ['type'],
          },
          {
            type: 'object',
            properties: {
              type: { const: 'result' },
              content: { type: 'object' },
            },
            required: ['type', 'content'],
          },
          {
            type: 'object',
            properties: { type: { const: 'done' } },
            required: ['type'],
          },
          {
            type: 'object',
            properties: {
              type: { const: 'error' },
              error: { type: 'string' },
            },
            required: ['type', 'error'],
          },
        ],
      },
      tools: [
        {
          name: 'text-to-model-draft',
          description: '从自然语言生成最小可计算 StructureModel v1 草案（规则版）',
          inputSchema: {
            type: 'object',
            required: ['message'],
            properties: {
              message: { type: 'string' },
            },
          },
          outputSchema: {
            type: 'object',
            properties: {
              inferredType: { type: 'string' },
              missingFields: { type: 'array', items: { type: 'string' } },
              model: { type: 'object' },
            },
          },
          errorCodes: ['AGENT_MISSING_MODEL_INPUT'],
        },
        {
          name: 'convert',
          description: '模型格式转换，统一转为 structuremodel-v1 或导出到目标格式',
          inputSchema: {
            type: 'object',
            required: ['model'],
            properties: {
              model: { type: 'object' },
              source_format: { type: 'string' },
              target_format: { type: 'string' },
              target_schema_version: { type: 'string' },
            },
          },
          outputSchema: {
            type: 'object',
            properties: {
              sourceFormat: { type: 'string' },
              targetFormat: { type: 'string' },
              sourceSchemaVersion: { type: 'string' },
              targetSchemaVersion: { type: 'string' },
              model: { type: 'object' },
            },
          },
          errorCodes: ['UNSUPPORTED_SOURCE_FORMAT', 'UNSUPPORTED_TARGET_FORMAT', 'INVALID_STRUCTURE_MODEL'],
        },
        {
          name: 'validate',
          description: '校验结构模型字段合法性与引用完整性',
          inputSchema: {
            type: 'object',
            required: ['model'],
            properties: {
              model: { type: 'object' },
            },
          },
          outputSchema: {
            type: 'object',
            properties: {
              valid: { type: 'boolean' },
              schemaVersion: { type: 'string' },
              stats: { type: 'object' },
            },
          },
          errorCodes: ['INVALID_STRUCTURE_MODEL'],
        },
        {
          name: 'analyze',
          description: '执行结构分析（static/dynamic/seismic/nonlinear）',
          inputSchema: {
            type: 'object',
            required: ['type', 'model', 'parameters'],
            properties: {
              type: { enum: ['static', 'dynamic', 'seismic', 'nonlinear'] },
              model: { type: 'object' },
              parameters: { type: 'object' },
            },
          },
          outputSchema: {
            type: 'object',
            properties: {
              schema_version: { type: 'string' },
              analysis_type: { type: 'string' },
              success: { type: 'boolean' },
              error_code: { type: ['string', 'null'] },
              message: { type: 'string' },
              data: { type: 'object' },
              meta: { type: 'object' },
            },
          },
          errorCodes: ['INVALID_ANALYSIS_TYPE', 'ANALYSIS_EXECUTION_FAILED'],
        },
        {
          name: 'code-check',
          description: '结构规范校核（预留）',
          inputSchema: {
            type: 'object',
            required: ['modelId', 'code', 'elements'],
            properties: {
              modelId: { type: 'string' },
              code: { type: 'string' },
              elements: { type: 'array', items: { type: 'string' } },
            },
          },
          outputSchema: {
            type: 'object',
          },
          errorCodes: [],
        },
      ],
      errorCodes: commonErrorCodes,
    };
  }

  async run(params: AgentRunParams): Promise<AgentRunResult> {
    const startedAt = Date.now();
    const traceId = randomUUID();
    const runMode: AgentRunMode = params.mode || 'auto';
    if (runMode === 'chat') {
      const response = await this.renderSummary(params.message, '已收到你的问题。当前为纯聊天模式，未触发结构工具调用。');
      return {
        traceId,
        durationMs: Date.now() - startedAt,
        success: true,
        mode: this.llm ? 'llm-assisted' : 'rule-based',
        needsModelInput: false,
        plan: ['纯聊天模式：不调用结构工具'],
        toolCalls: [],
        response,
      };
    }

    const modelInput = params.context?.model;
    const sourceFormat = params.context?.modelFormat || 'structuremodel-v1';
    const autoAnalyze = params.context?.autoAnalyze ?? true;
    const analysisType = params.context?.analysisType || this.inferAnalysisType(params.message);
    const analysisParameters = params.context?.parameters || {};

    const plan: string[] = [];
    const toolCalls: AgentToolCall[] = [];
    const mode: 'rule-based' | 'llm-assisted' = this.llm ? 'llm-assisted' : 'rule-based';

    let normalizedModel = modelInput;
    if (!normalizedModel) {
      plan.push('从自然语言生成结构模型草案');
      const draftCall: AgentToolCall = {
        tool: 'text-to-model-draft',
        input: { message: params.message },
      };
      toolCalls.push(draftCall);
      const draft = this.textToModelDraft(params.message);
      draftCall.output = draft;

      if (!draft.model) {
        return {
          traceId,
          durationMs: Date.now() - startedAt,
          success: false,
          mode,
          needsModelInput: true,
          plan,
          toolCalls,
          clarification: {
            missingFields: draft.missingFields,
            question: `请补充以下信息：${draft.missingFields.join('、')}`,
          },
          response: `无法从文本直接生成可计算模型，缺少：${draft.missingFields.join('、')}。`,
        };
      }

      normalizedModel = draft.model;
    }

    if (sourceFormat !== 'structuremodel-v1') {
      plan.push(`将输入模型从 ${sourceFormat} 转为 structuremodel-v1`);
      const convertInput = {
        model: modelInput,
        source_format: sourceFormat,
        target_format: 'structuremodel-v1',
        target_schema_version: '1.0.0',
      };
      const convertCall: AgentToolCall = { tool: 'convert', input: convertInput };
      toolCalls.push(convertCall);

      try {
        const converted = await this.engineClient.post('/convert', convertInput);
        convertCall.output = converted.data;
        normalizedModel = (converted.data?.model ?? {}) as Record<string, unknown>;
      } catch (error: any) {
        convertCall.error = this.stringifyError(error);
        return {
          traceId,
          durationMs: Date.now() - startedAt,
          success: false,
          mode,
          needsModelInput: false,
          plan,
          toolCalls,
          response: `模型格式转换失败：${convertCall.error}`,
        };
      }
    }

    plan.push('校验模型字段与引用完整性');
    const validateInput = { model: normalizedModel };
    const validateCall: AgentToolCall = { tool: 'validate', input: validateInput };
    toolCalls.push(validateCall);

    try {
      const validated = await this.engineClient.post('/validate', validateInput);
      validateCall.output = validated.data;
    } catch (error: any) {
      validateCall.error = this.stringifyError(error);
        return {
          traceId,
          durationMs: Date.now() - startedAt,
          success: false,
        mode,
        needsModelInput: false,
        plan,
        toolCalls,
        model: normalizedModel,
        response: `模型校验失败：${validateCall.error}`,
      };
    }

    if (!autoAnalyze) {
      const response = await this.renderSummary(
        params.message,
        '模型已通过校验。根据配置未自动执行 analyze。',
      );
      return {
        traceId,
        durationMs: Date.now() - startedAt,
        success: true,
        mode,
        needsModelInput: false,
        plan,
        toolCalls,
        model: normalizedModel,
        response,
      };
    }

    plan.push(`执行 ${analysisType} 分析并返回摘要`);
    const analyzeInput = {
      type: analysisType,
      model: normalizedModel,
      parameters: analysisParameters,
    };
    const analyzeCall: AgentToolCall = { tool: 'analyze', input: analyzeInput };
    toolCalls.push(analyzeCall);

    try {
      const analyzed = await this.engineClient.post('/analyze', analyzeInput);
      analyzeCall.output = analyzed.data;

      const response = await this.renderSummary(
        params.message,
        `分析完成。analysis_type=${analysisType}, success=${String(analyzed.data?.success ?? false)}`,
      );

      return {
        traceId,
        durationMs: Date.now() - startedAt,
        success: Boolean(analyzed.data?.success),
        mode,
        needsModelInput: false,
        plan,
        toolCalls,
        model: normalizedModel,
        analysis: analyzed.data,
        response,
      };
    } catch (error: any) {
      analyzeCall.error = this.stringifyError(error);
      return {
        traceId,
        durationMs: Date.now() - startedAt,
        success: false,
        mode,
        needsModelInput: false,
        plan,
        toolCalls,
        model: normalizedModel,
        response: `分析执行失败：${analyzeCall.error}`,
      };
    }
  }

  async *runStream(params: AgentRunParams): AsyncGenerator<AgentStreamChunk> {
    const traceId = randomUUID();
    try {
      yield {
        type: 'start',
        content: {
          traceId,
          mode: params.mode || 'auto',
        },
      };

      const result = await this.run(params);
      yield {
        type: 'result',
        content: { ...result, traceId: result.traceId || traceId },
      };
      yield { type: 'done' };
    } catch (error: any) {
      yield {
        type: 'error',
        error: this.stringifyError(error),
      };
    }
  }

  private inferAnalysisType(message: string): 'static' | 'dynamic' | 'seismic' | 'nonlinear' {
    const text = message.toLowerCase();
    if (text.includes('地震') || text.includes('seismic')) {
      return 'seismic';
    }
    if (text.includes('动力') || text.includes('dynamic') || text.includes('时程')) {
      return 'dynamic';
    }
    if (text.includes('非线性') || text.includes('nonlinear')) {
      return 'nonlinear';
    }
    return 'static';
  }

  private async renderSummary(message: string, fallback: string): Promise<string> {
    if (!this.llm) {
      return fallback;
    }

    try {
      const prompt = [
        '你是结构工程 Agent 的结果解释器。',
        '请用中文在 80 字以内给出结论，不要杜撰未出现的数据。',
        `用户意图：${message}`,
        `系统结果：${fallback}`,
      ].join('\n');
      const aiMessage = await this.llm.invoke(prompt);
      const content = typeof aiMessage.content === 'string'
        ? aiMessage.content
        : JSON.stringify(aiMessage.content);
      return content || fallback;
    } catch {
      return fallback;
    }
  }

  private stringifyError(error: any): string {
    if (error?.response?.data) {
      return JSON.stringify(error.response.data);
    }
    if (error?.message) {
      return String(error.message);
    }
    return 'Unknown error';
  }

  private textToModelDraft(message: string): {
    inferredType: 'beam' | 'truss' | 'unknown';
    missingFields: string[];
    model?: Record<string, unknown>;
  } {
    const text = message.toLowerCase();
    const isBeam = text.includes('beam') || text.includes('梁') || text.includes('悬臂');
    const isTruss = text.includes('truss') || text.includes('桁架');

    const inferredType: 'beam' | 'truss' | 'unknown' = isBeam ? 'beam' : (isTruss ? 'truss' : 'unknown');
    const missingFields: string[] = [];

    const length = this.extractNumber(text, [
      /(\d+(?:\.\d+)?)\s*(?:m|米|meter|meters)/i,
    ]);
    const load = this.extractNumber(text, [
      /(\d+(?:\.\d+)?)\s*(?:kn|千牛)/i,
    ]);

    if (inferredType === 'unknown') {
      missingFields.push('结构类型（梁或桁架）');
    }
    if (length === null) {
      missingFields.push('跨度/长度（m）');
    }
    if (load === null) {
      missingFields.push('荷载大小（kN）');
    }

    if (missingFields.length > 0 || length === null || load === null) {
      return { inferredType, missingFields };
    }

    if (inferredType === 'truss') {
      return {
        inferredType,
        missingFields: [],
        model: {
          schema_version: '1.0.0',
          nodes: [
            { id: '1', x: 0, y: 0, z: 0, restraints: [true, false, true, false, false, false] },
            { id: '2', x: length, y: 0, z: 0, restraints: [false, false, true, false, false, false] },
          ],
          elements: [
            { id: '1', type: 'truss', nodes: ['1', '2'], material: '1', section: '1' },
          ],
          materials: [
            { id: '1', name: 'steel', E: 200000, nu: 0.3, rho: 7850 },
          ],
          sections: [
            { id: '1', name: 'A1', type: 'rod', properties: { A: 0.01 } },
          ],
          load_cases: [
            { id: 'LC1', type: 'other', loads: [{ node: '2', fx: load }] },
          ],
          load_combinations: [],
          metadata: { source: 'text-draft', inferredType },
        },
      };
    }

    return {
      inferredType: 'beam',
      missingFields: [],
      model: {
        schema_version: '1.0.0',
        nodes: [
          { id: '1', x: 0, y: 0, z: 0, restraints: [true, false, true, false, true, false] },
          { id: '2', x: length, y: 0, z: 0 },
        ],
        elements: [
          { id: '1', type: 'beam', nodes: ['1', '2'], material: '1', section: '1' },
        ],
        materials: [
          { id: '1', name: 'steel', E: 200000, nu: 0.3, rho: 7850 },
        ],
        sections: [
          { id: '1', name: 'B1', type: 'beam', properties: { A: 0.01, Iy: 0.0001 } },
        ],
        load_cases: [
          { id: 'LC1', type: 'other', loads: [{ node: '2', fz: -load }] },
        ],
        load_combinations: [],
        metadata: { source: 'text-draft', inferredType: 'beam' },
      },
    };
  }

  private extractNumber(text: string, patterns: RegExp[]): number | null {
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match && match[1]) {
        const value = Number.parseFloat(match[1]);
        if (Number.isFinite(value)) {
          return value;
        }
      }
    }
    return null;
  }
}
