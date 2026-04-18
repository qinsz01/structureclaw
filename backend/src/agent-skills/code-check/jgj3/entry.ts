import type { ExecutionRequestOptions } from '../../analysis/types.js';
import type { CodeCheckDomainInput } from '../types.js';
import type { CodeCheckClient } from '../rule.js';

const JGJ3_ALIASES = new Set(['JGJ3', 'JGJ3-2010']);

export function matchesJGJ3Code(code: string): boolean {
  return JGJ3_ALIASES.has(code.trim().toUpperCase());
}

export async function executeJGJ3CodeCheckDomain(
  engineClient: CodeCheckClient,
  input: CodeCheckDomainInput,
  engineId?: string,
  requestOptions?: ExecutionRequestOptions,
): Promise<unknown> {
  const response = await engineClient.post('/code-check', {
    model_id: input.modelId,
    code: 'JGJ3',
    elements: input.elements,
    context: input.context,
    engineId,
  }, requestOptions);
  return response.data;
}
