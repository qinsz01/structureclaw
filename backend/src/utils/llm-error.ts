interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    retriable: boolean;
  };
}

const LLM_TIMEOUT_PATTERNS = [
  'request timed out',
  'timeout',
  'timed out',
  'etimedout',
  'aborterror',
];

const CONTEXT_OVERFLOW_PATTERNS = [
  'maximum context length',
  'context window',
  'too many tokens',
  'token limit exceeded',
  'reduce the length',
  'exceeds the maximum',
  'prompt exceeds max length',
  'exceeds max token',
  '上下文',
  'token 数',
];

function errorToText(error: unknown): string {
  if (!error) return '';
  if (error instanceof Error) {
    return `${error.name} ${error.message}`.toLowerCase();
  }
  return String(error).toLowerCase();
}

export function isLlmTimeoutError(error: unknown): boolean {
  const text = errorToText(error);
  return LLM_TIMEOUT_PATTERNS.some((pattern) => text.includes(pattern));
}

export function isContextOverflowError(error: unknown): boolean {
  const text = errorToText(error);
  return CONTEXT_OVERFLOW_PATTERNS.some((pattern) => text.includes(pattern));
}

export function toLlmApiError(error: unknown): { statusCode: number; body: ApiErrorBody } {
  const code = error instanceof Error ? error.message.split(':', 1)[0] ?? '' : '';
  if (code === 'MODEL_PHYSICS_INVALID') return { statusCode: 422, body: { error: { code,
    message: 'The generated model failed physical validation. No successful calculation was published. / 生成模型未通过物理校验，未发布成功的计算结果。',
    retriable: false } } };
  if (code === 'FIELD_CONTRACT_UNRESOLVED') return { statusCode: 500, body: { error: { code,
    message: 'The system could not apply the supplied input. This operation stopped without changing the saved model; do not repeat the same answer. / 系统未能应用已提供的输入，本次操作已停止且原模型未变；无需重复回答。',
    retriable: false } } };
  if (code === 'VISION_INPUT_UNAVAILABLE') return { statusCode: 400, body: { error: { code,
    message: 'The image cannot be supplied to the vision model. Provide a readable image within the supported size limit. / 无法将图片提供给视觉模型，请提供大小在支持范围内且可读取的图片。',
    retriable: false } } };
  if (code === 'STRUCTURE_TYPE_UNSUPPORTED') return { statusCode: 422, body: { error: { code,
    message: 'The requested structure is not supported by the enabled capabilities. This operation was not completed. / 已启用的能力不支持本次结构请求，本次操作未完成。',
    retriable: false } } };
  if (['STRUCTURE_SKILL_UNAVAILABLE', 'FIXED_SKILL_NOT_A_MODELING_PROVIDER'].includes(code)) return { statusCode: 503, body: { error: { code,
    message: 'No usable modelling skill is enabled for this operation. / 本次操作没有已启用且可用的建模技能。', retriable: false } } };
  const configurationFailures = new Set(['LLM_NOT_CONFIGURED', 'LLM_STRUCTURAL_ROUTER_REQUIRED',
    'LLM_PARAM_EXTRACTOR_CONFIGURATION_ERROR', 'LLM_MODEL_BUILDER_REQUIRED', 'VISION_MODEL_REQUIRED']);
  if (configurationFailures.has(code)) return { statusCode: 503, body: { error: { code,
    message: 'LLM is not configured; configure the model in Settings before continuing. / LLM 未配置，无法处理请求；请先在设置中配置模型。',
    retriable: false } } };
  if (isLlmTimeoutError(error)) {
    return {
      statusCode: 504,
      body: {
        error: {
          code: 'LLM_TIMEOUT',
          message: 'LLM request timed out. Please retry later.',
          retriable: true,
        },
      },
    };
  }

  if (isContextOverflowError(error)) {
    return {
      statusCode: 400,
      body: {
        error: {
          code: 'CONTEXT_OVERFLOW',
          message: 'Conversation exceeds model context limit.',
          retriable: false,
        },
      },
    };
  }

  const invalidOutputs = new Set(['LLM_EMPTY_RESPONSE', 'LLM_STRUCTURAL_ROUTER_INVALID_OUTPUT', 'LLM_PARAM_EXTRACTOR_INVALID_OUTPUT', 'LLM_MODEL_VALIDATION_FAILED']);
  if (invalidOutputs.has(code)) return { statusCode: 502, body: { error: { code,
    message: 'The language model did not return valid output. No substitute result was generated. / 语言模型未返回有效输出，未生成替代结果。',
    retriable: false } } };
  const upstreamFailures = new Set(['LLM_STRUCTURAL_ROUTER_INFRASTRUCTURE_ERROR', 'LLM_PARAM_EXTRACTOR_INFRASTRUCTURE_ERROR', 'LLM_MODEL_BUILDER_INFRASTRUCTURE_ERROR', 'VISION_MODEL_FAILED']);
  if (upstreamFailures.has(code)) return { statusCode: 502, body: { error: { code,
    message: 'The language model request failed. This operation could not be completed. / 语言模型请求失败，本次操作未能完成。',
    retriable: true } } };

  return {
    statusCode: 500,
    body: {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error.',
        retriable: false,
      },
    },
  };
}

/** The same failure contract applies before and during both chat stream endpoints. */
export function toLlmStreamError(error: unknown): { type: 'error'; error: string; code: string; retriable: boolean } {
  const mapped = toLlmApiError(error).body.error;
  const message = mapped.code === 'LLM_TIMEOUT'
    ? '模型响应超时，已完成的工具结果保留。可在当前对话继续；这不是计算失败，也不需要重新提交整个模型。 / Model response timed out. Completed tool results are retained; continue in this conversation. This is not a solver failure.'
    : error instanceof Error ? error.message : String(error);
  return { type: 'error', error: message, code: mapped.code, retriable: mapped.retriable };
}
