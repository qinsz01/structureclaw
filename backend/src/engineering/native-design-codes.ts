import { isRecord, type ModelRecord } from './model-state.js';

/** Codes with calibrated native request/readback contracts, shared by routing and UI. */
export function nativeDesignCodes(engine: string, model: ModelRecord | null | undefined): string[] {
  if (!['pkpm', 'yjk'].includes(engine)) return [];
  const families = new Set(Array.isArray(model?.materials) ? model.materials.filter(isRecord).map(row => row.category ?? row.type) : []);
  const concrete = families.size === 1 && families.has('concrete');
  const steel = families.size === 1 && families.has('steel');
  return engine === 'pkpm' ? ['PKPM-2025R2.5-native', ...(steel ? ['GB50017-2017'] : [])]
    : steel ? ['GB50017-2017'] : concrete ? ['GB/T50010-2010(2024)'] : [];
}
