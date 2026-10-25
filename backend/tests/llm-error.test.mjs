import { describe, expect, test } from '@jest/globals';
import { isLlmTimeoutError, toLlmApiError, toLlmStreamError } from '../dist/utils/llm-error.js';

describe('LLM error mapping', () => {
  test('missing LLM is an explicit configuration failure in both API and stream responses', () => {
    const error = new Error('LLM_NOT_CONFIGURED: model unavailable');
    const api = toLlmApiError(error);
    expect(api.statusCode).toBe(503);
    expect(api.body.error).toMatchObject({ code: 'LLM_NOT_CONFIGURED', retriable: false });
    expect(api.body.error.message).toContain('LLM is not configured');
    expect(api.body.error.message).toContain('LLM 未配置');
    expect(toLlmStreamError(error)).toMatchObject({ type: 'error', code: 'LLM_NOT_CONFIGURED', retriable: false });
  });
  test.each([
    ['MODEL_PHYSICS_INVALID', 422, false],
    ['FIELD_CONTRACT_UNRESOLVED', 500, false],
    ['VISION_INPUT_UNAVAILABLE', 400, false],
    ['STRUCTURE_TYPE_UNSUPPORTED', 422, false],
    ['STRUCTURE_SKILL_UNAVAILABLE', 503, false],
    ['FIXED_SKILL_NOT_A_MODELING_PROVIDER', 503, false],
    ['LLM_STRUCTURAL_ROUTER_REQUIRED', 503, false],
    ['LLM_PARAM_EXTRACTOR_CONFIGURATION_ERROR', 503, false],
    ['LLM_MODEL_BUILDER_REQUIRED', 503, false],
    ['VISION_MODEL_REQUIRED', 503, false],
    ['LLM_EMPTY_RESPONSE', 502, false],
    ['LLM_STRUCTURAL_ROUTER_INVALID_OUTPUT', 502, false],
    ['LLM_PARAM_EXTRACTOR_INVALID_OUTPUT', 502, false],
    ['LLM_MODEL_VALIDATION_FAILED', 502, false],
    ['LLM_STRUCTURAL_ROUTER_INFRASTRUCTURE_ERROR', 502, true],
    ['LLM_PARAM_EXTRACTOR_INFRASTRUCTURE_ERROR', 502, true],
    ['LLM_MODEL_BUILDER_INFRASTRUCTURE_ERROR', 502, true],
    ['VISION_MODEL_FAILED', 502, true],
  ])('preserves explicit operation failure %s in synchronous and streaming APIs', (code, statusCode, retriable) => {
    const error = new Error(`${code}: unavailable / 不可用`);
    expect(toLlmApiError(error)).toMatchObject({ statusCode, body: { error: { code, retriable } } });
    expect(toLlmStreamError(error)).toMatchObject({ type: 'error', code, retriable });
  });
  test('should classify timeout errors and map to 504', () => {
    const error = Object.assign(new Error('Request timed out.'), { name: 'TimeoutError' });
    expect(isLlmTimeoutError(error)).toBe(true);

    const mapped = toLlmApiError(error);
    expect(mapped.statusCode).toBe(504);
    expect(mapped.body.error.code).toBe('LLM_TIMEOUT');
    expect(mapped.body.error.retriable).toBe(true);
  });

  test('should map unknown errors to 500 internal error', () => {
    const error = new Error('database disconnected');
    expect(isLlmTimeoutError(error)).toBe(false);

    const mapped = toLlmApiError(error);
    expect(mapped.statusCode).toBe(500);
    expect(mapped.body.error.code).toBe('INTERNAL_ERROR');
    expect(mapped.body.error.retriable).toBe(false);
  });

  test('should classify timeout-like string errors', () => {
    expect(isLlmTimeoutError('ETIMEDOUT during request')).toBe(true);
    expect(isLlmTimeoutError('operation aborted by timeout')).toBe(true);
  });
});
