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
