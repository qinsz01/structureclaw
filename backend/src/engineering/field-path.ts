/** Shared field addresses for draft diagnostics and explicit updates. */
export type FieldToken = { key: string; index?: boolean; wildcard?: boolean };

export function fieldTokens(field: string): FieldToken[] {
  const result: FieldToken[] = [];
  const pattern = /(?:^|\.)([^.[\]]+)|\[("(?:[^"\\]|\\.)*"|'[^']*'|[^\]]*)\]/g;
  let consumed = 0;
  for (const match of field.matchAll(pattern)) {
    if (match.index !== consumed) return [];
    consumed += match[0].length;
    const raw = match[1] ?? match[2]!, quoted = /^['"]/.test(raw);
    let key = raw;
    if (raw.startsWith('"')) { try { key = JSON.parse(raw); } catch { return []; } }
    else if (quoted) key = raw.slice(1, -1);
    if (['__proto__', 'prototype', 'constructor'].includes(key)) return [];
    result.push({ key, index: match[2] !== undefined && !quoted && /^\d+$/.test(raw), wildcard: !quoted && (key === '' || key === '*') });
  }
  return consumed === field.length ? result : [];
}
