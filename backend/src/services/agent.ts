import axios, { AxiosInstance } from 'axios';
import { ChatOpenAI } from '@langchain/openai';
import { config } from '../config/index.js';

export type AgentToolName = 'convert' | 'validate' | 'analyze' | 'code-check';
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
}

export interface AgentProtocol {
  version: string;
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
  success: boolean;
  mode: 'rule-based' | 'llm-assisted';
  needsModelInput: boolean;
  plan: string[];
  toolCalls: AgentToolCall[];
  model?: Record<string, unknown>;
  analysis?: unknown;
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
    return {
      version: '1.0.0',
      tools: [
        {
          name: 'convert',
          description: '模型格式转换，统一转为 structuremodel-v1 或导出到目标格式',
          inputSchema: {
            model: 'object',
            source_format: 'string',
            target_format: 'string',
            target_schema_version: 'string',
          },
        },
        {
          name: 'validate',
          description: '校验结构模型字段合法性与引用完整性',
          inputSchema: {
            model: 'object',
          },
        },
        {
          name: 'analyze',
          description: '执行结构分析（static/dynamic/seismic/nonlinear）',
          inputSchema: {
            type: 'string',
            model: 'object',
            parameters: 'object',
          },
        },
        {
          name: 'code-check',
          description: '结构规范校核（预留）',
          inputSchema: {
            modelId: 'string',
            code: 'string',
            elements: 'string[]',
          },
        },
      ],
      errorCodes: [
        'UNSUPPORTED_SOURCE_FORMAT',
        'UNSUPPORTED_TARGET_FORMAT',
        'INVALID_STRUCTURE_MODEL',
        'INVALID_ANALYSIS_TYPE',
        'ANALYSIS_EXECUTION_FAILED',
      ],
    };
  }

  async run(params: AgentRunParams): Promise<AgentRunResult> {
    const runMode: AgentRunMode = params.mode || 'auto';
    if (runMode === 'chat') {
      const response = await this.renderSummary(params.message, '已收到你的问题。当前为纯聊天模式，未触发结构工具调用。');
      return {
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

    if (!modelInput) {
      return {
        success: false,
        mode,
        needsModelInput: true,
        plan: [
          '需要结构模型输入（JSON）后再调用工具链',
          '拿到模型后执行 validate，再根据意图执行 analyze',
        ],
        toolCalls,
        response: '当前 Agent 已接入工具编排，但你的请求缺少结构模型数据。请先提供 StructureModel v1 JSON（或 simple-1）。',
      };
    }

    let normalizedModel = modelInput;
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
    try {
      yield {
        type: 'start',
        content: {
          mode: params.mode || 'auto',
        },
      };

      const result = await this.run(params);
      yield {
        type: 'result',
        content: result,
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
}
