import type { ExecutionRequestOptions } from '../analysis/types.js';
import type { BaseSkillProvider } from '../../skill-shared/provider.js';
import type { CodeCheckDomainInput } from './types.js';

export interface CodeCheckClient {
  post<T = any>(path: string, payload?: Record<string, unknown>, requestOptions?: ExecutionRequestOptions): Promise<{ data: T }>;
}

export interface CodeCheckRule {
  skillId: string;
  designCode?: string;
  matches: (code: string) => boolean;
  execute: (engineClient: CodeCheckClient, input: CodeCheckDomainInput, engineId?: string, requestOptions?: ExecutionRequestOptions) => Promise<unknown>;
}

export interface CodeCheckRuleProvider extends BaseSkillProvider<'code-check'> {
  fallback?: boolean;
  rule: CodeCheckRule;
}
