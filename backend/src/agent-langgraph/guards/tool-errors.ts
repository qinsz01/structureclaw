/**
 * Consistent structured tool errors.
 *
 * A tool that throws is reported by LangGraph's ToolNode as plain text
 * ("Error: ...\n Please fix your mistakes."). The guard layer turns that text into the same JSON
 * shape that tools return themselves ({ success: false, errorCode, error, hint }), and adds the
 * valid alternatives from the current state when an error names an unknown ID. Neither changes
 * state: they only rewrite the message the LLM reads.
 */
import type { AgentState } from '../state.js';
import { failureCode } from './tool-guards.js';

const TOOL_NODE_SUFFIX = /\s*Please fix your mistakes\.?\s*$/;
const MAX_ALTERNATIVES = 50;

type Alternatives = Record<string, unknown>;
type RecordLike = Record<string, unknown>;

function isRecord(value: unknown): value is RecordLike {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function ids(collection: unknown): string[] {
  return Array.isArray(collection)
    ? collection.filter(isRecord).map(item => item.id).filter(id => id !== undefined && id !== null).map(String).slice(0, MAX_ALTERNATIVES)
    : [];
}

function currentModel(state: Partial<AgentState>): RecordLike | undefined {
  if (isRecord(state.model)) return state.model;
  const snapshot = isRecord(state.analysisResult) ? state.analysisResult.modelSnapshot : undefined;
  return isRecord(snapshot) ? snapshot : undefined;
}

/** Valid IDs for an "unknown ID" error code, read from the current state. */
export function idAlternatives(code: string, message: string, state: Partial<AgentState>): Alternatives | undefined {
  const model = currentModel(state);
  if (code === 'RUN_NOT_FOUND' || code === 'RUN_ID_INVALID') {
    const runIds = new Set(Object.keys(state.analysisRuns ?? {}));
    const current = isRecord(state.analysisResult) ? state.analysisResult.runId : undefined;
    if (typeof current === 'string') runIds.add(current);
    return { availableRunIds: [...runIds].slice(0, MAX_ALTERNATIVES) };
  }
  if (code === 'RESULT_NOT_FOUND') {
    const results = isRecord(state.analysisResult) ? state.analysisResult.results : undefined;
    return { availableResultKeys: isRecord(results) ? Object.keys(results).slice(0, MAX_ALTERNATIVES) : [] };
  }
  if (/^(RESULT_)?NODE_NOT_FOUND$/.test(code)) return { availableNodeIds: ids(model?.nodes) };
  if (/^(MEMBER|ELEMENT)_NOT_FOUND$/.test(code)) return { availableElementIds: ids(model?.elements) };
  if (/^(MODEL_)?(LOAD_)?CASE_NOT_FOUND$/.test(code)) return { availableLoadCaseIds: ids(model?.load_cases) };
  if (/^(LOAD_)?COMBINATION_NOT_FOUND$/.test(code)) return { availableCombinationIds: ids(model?.load_combinations) };
  if (code === 'MODEL_OBJECT_NOT_FOUND') {
    const collection = /MODEL_OBJECT_NOT_FOUND:\s*([a-z_]+):/.exec(message)?.[1];
    if (collection && model) return { collection, availableIds: ids(model[collection]) };
  }
  return undefined;
}

function hasAlternatives(payload: RecordLike): boolean {
  return Object.keys(payload).some(key => key.startsWith('available'));
}

function parseObject(text: string): RecordLike | undefined {
  try {
    const value = JSON.parse(text);
    return isRecord(value) ? value : undefined;
  } catch { return undefined; }
}

const SCHEMA_HINT = 'Correct the listed argument fields to match the tool schema, then call again. / 请按工具参数结构修正所列字段后再调用。';
const GENERIC_HINT = 'Read the error, change the arguments or the preceding step, and do not repeat the identical call. / 请根据错误修改参数或前置步骤，不要重复完全相同的调用。';
const ID_HINT = 'Use one of the listed existing IDs, or inspect the model/results first. / 请使用列出的现有 ID，或先查询模型/结果。';

/**
 * Structured replacement for a failed tool message's content, or undefined when it is already
 * structured and needs no alternatives. `failure` is the ledger interpretation of the message.
 */
export function structuredToolError(content: string, failure: string, state: Partial<AgentState>): string | undefined {
  const payload = parseObject(content);
  if (payload) {
    const code = typeof payload.errorCode === 'string' ? payload.errorCode : failureCode(failure);
    if (hasAlternatives(payload)) return undefined;
    const alternatives = idAlternatives(code, failure, state);
    return alternatives ? JSON.stringify({ ...payload, ...alternatives, ...(payload.hint ? {} : { hint: ID_HINT }) }) : undefined;
  }
  const error = content.replace(/^Error:\s*/, '').replace(TOOL_NODE_SUFFIX, '').trim();
  const structured = parseObject(error);
  if (structured?.errorCode === 'SECTION_CONFIRMATION_REQUIRED') return JSON.stringify(structured);
  const derived = failureCode(error);
  const errorCode = derived.startsWith('TOOL_FAILED_') ? 'TOOL_EXECUTION_FAILED' : derived;
  const alternatives = idAlternatives(errorCode, error, state);
  const hint = alternatives ? ID_HINT : errorCode === 'INVALID_TOOL_ARGUMENTS' ? SCHEMA_HINT : GENERIC_HINT;
  return JSON.stringify({ success: false, errorCode, error, hint, ...alternatives });
}
