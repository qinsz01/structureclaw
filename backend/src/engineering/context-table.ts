import type { ModelRecord } from './model-state.js';

/** Lossless column dictionaries for large repeated tool rows; -1 denotes an absent field. */
export function contextTable(rows: ModelRecord[]) {
  const columns: ModelRecord = Object.create(null);
  for (const field of new Set(rows.flatMap(row => Object.keys(row)))) {
    const values: unknown[] = [], positions = new Map<string, number>();
    const indexes = rows.map(row => {
      if (!Object.hasOwn(row, field)) return -1;
      const value = row[field], key = JSON.stringify(value);
      let index = positions.get(key);
      if (index === undefined) { index = values.length; positions.set(key, index); values.push(value); }
      return index;
    });
    columns[field] = values.length === 1 && indexes.every(index => index === 0)
      ? { shared: values[0] } : { values, indexes };
  }
  return { rowCount: rows.length, columns };
}
