/** One bounded punctuation repair; quoted answer text is never changed or completed. */
function repairOptionArray(text: string): unknown {
  text = text.trim();
  if (!text.startsWith('[') || text.length > 16384) return undefined;
  let result = '', quoted = false, escaped = false, edits = 0;
  const closers: string[] = [];
  for (const char of text) {
    if (quoted) {
      result += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') {
      quoted = true;
      result += char;
    } else if (char === '[' || char === '{') {
      closers.push(char === '[' ? ']' : '}');
      result += char;
    } else if (char === ']' || char === '}') {
      if (closers.at(-1) === char) {
        if (result.trimEnd().endsWith(',')) { result = result.trimEnd().slice(0, -1); edits++; }
        closers.pop();
        result += char;
      } else edits++;
    } else if (char === ',' && (!closers.length || /[[{,]$/.test(result.trimEnd()))) {
      edits++;
    } else result += char;
    if (edits > 8) return undefined;
  }
  if (quoted) return undefined;
  if (result.trimEnd().endsWith(',')) { result = result.trimEnd().slice(0, -1); edits++; }
  if (edits + closers.length > 8) return undefined;
  result += closers.reverse().join('');
  try { return JSON.parse(result); } catch { return undefined; }
}

/** Provider and historical choices must cross public boundaries as displayable answer strings. */
export function normalizeClarificationOptions(value: unknown): string[] {
  if (typeof value === 'string') {
    const text = value;
    try { value = JSON.parse(text); } catch { value = repairOptionArray(text); }
  }
  // Redundant outer brackets are unambiguous only around a single option array.
  for (let depth = 0; depth < 8 && Array.isArray(value) && value.length === 1 && Array.isArray(value[0]); depth++) value = value[0];
  if (!Array.isArray(value)) return [];
  return [...new Set(value.flatMap((item): string[] => {
    if (typeof item === 'string') return item.trim() ? [item.trim()] : [];
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    for (const key of ['label', 'text', 'value']) {
      if (typeof item[key] === 'string' && item[key].trim()) return [item[key].trim()];
    }
    return [];
  }))];
}
