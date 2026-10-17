/** Record access and markdown helpers shared by the default report narrative sections. */
import type { SkillReportNarrativeInput } from '../../shared/types/agent.js';

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function analysisData(input: SkillReportNarrativeInput): Record<string, unknown> {
  const analysis = asRecord(input.analysis);
  return asRecord(analysis['data']);
}

export function traceDisplayValue(value: unknown): string {
  if (value === undefined || value === null) {
    return 'N/A';
  }
  if (typeof value === 'string') {
    return value.trim().length > 0 ? value : 'N/A';
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(traceDisplayValue).join(', ');
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}

export function markdownTableCell(value: unknown, maxLength = 160): string {
  const normalized = traceDisplayValue(value)
    .split('\r\n').join('<br>')
    .split('\n').join('<br>')
    .split('|').join('\\|');
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}
