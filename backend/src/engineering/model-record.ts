import { createHash } from 'node:crypto';

export type ModelRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is ModelRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function ordered(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(ordered);
    return items.length > 0 && items.every((item) => isRecord(item) && typeof item.id === 'string')
      ? items.sort((a, b) => String((a as ModelRecord).id).localeCompare(String((b as ModelRecord).id)))
      : items;
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.keys(value).sort().filter((key) => value[key] !== undefined)
      .map((key) => [key, ordered(value[key])]));
  }
  return value;
}

export function contentHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(ordered(value)) ?? 'null').digest('hex');
}
