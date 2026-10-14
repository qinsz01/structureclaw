/** Provider and historical choices must cross public boundaries as displayable answer strings. */
export function normalizeClarificationOptions(value: unknown): string[] {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return []; }
  }
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
