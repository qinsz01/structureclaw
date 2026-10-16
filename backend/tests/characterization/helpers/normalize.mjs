// Normalization of volatile data (ids, timestamps, durations, absolute paths, hashes) so
// characterization snapshots pin behaviour rather than per-run identity.
import { createHash } from 'node:crypto';
import os from 'node:os';

const ISO_TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const CUID = /\bc[a-z0-9]{24}\b/g;
const SHA256 = /\b[0-9a-f]{64}\b/g;
const VOLATILE_KEYS = new Set(['startedAt', 'completedAt', 'createdAt', 'updatedAt', 'at', 'timestamp', 'durationMs', 'created']);

export function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

export function normalizeText(text, { dataDir } = {}) {
  let result = String(text);
  for (const directory of [dataDir, os.tmpdir()].filter(Boolean)) {
    for (const variant of [directory, directory.replaceAll('\\', '/'), directory.replaceAll('\\', '\\\\')]) {
      result = result.split(variant).join('<TMP>');
    }
  }
  return result.replace(ISO_TIME, '<TIME>').replace(UUID, '<UUID>').replace(CUID, '<CUID>').replace(SHA256, '<SHA256>');
}

/** Deeply replace volatile values; keys in VOLATILE_KEYS become '<volatile>'. */
export function normalizeVolatile(value, options = {}) {
  if (Array.isArray(value)) return value.map(item => normalizeVolatile(item, options));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      VOLATILE_KEYS.has(key) && item !== null && item !== undefined ? '<volatile>' : normalizeVolatile(item, options)]));
  }
  return typeof value === 'string' ? normalizeText(value, options) : value;
}

/** Compact, id-free SSE event type sequence: e.g. `step:run_analysis:done`, `artifact:analysis:invalidated`. */
export function eventSignature(events) {
  return events.map(event => {
    if (event.type === 'step_upsert') return `step:${event.step?.tool}:${event.step?.status}`;
    if (event.type === 'artifact_payload_sync') return `artifact:${event.artifact}${event.invalidated ? ':invalidated' : ''}`;
    return event.type;
  });
}

/** Final status per tool step id (step ids derive from scripted tool-call ids). */
export function stepStatuses(steps) {
  const latest = new Map();
  for (const step of steps) latest.set(step.id, { tool: step.tool, status: step.status });
  return [...latest.values()];
}

export function parseStepOutput(steps, tool) {
  const step = [...steps].reverse().find(item => item.tool === tool && item.status === 'done' && typeof item.output === 'string');
  if (!step) throw new Error(`No completed ${tool} step`);
  try { return JSON.parse(step.output); } catch { throw new Error(`${tool} output is not complete JSON (possibly truncated): ${step.output.slice(0, 200)}`); }
}
