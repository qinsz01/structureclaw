import { isRecord } from './model-state.js';
import { EngineeringValidationError } from './validation-error.js';

/** Explicit quantities only: natural-language interpretation belongs to the extractor. */
export const materialDensityContract = {
  type: 'object', additionalProperties: false, required: ['value', 'unit'],
  properties: { value: { type: 'number', exclusiveMinimum: 0 },
    unit: { type: 'string', enum: ['kg/m3', 't/m3', 'N/m3', 'kN/m3'] } },
};

export const MATERIAL_DENSITY_RULE = 'Density: materials[].density={value,unit:"kg/m3"|"t/m3"|"N/m3"|"kN/m3"} retains the original quantity; omit rho. Do not calculate the conversion. The system converts to rho (kg/m³) with standard gravity 9.80665 m/s² and keeps the source. Never infer units from magnitude or replace explicit density by grade defaults. Direct rho is kg/m³. / density保留原数值和单位，由系统按标准重力换算；不心算、不猜单位、不覆盖显式值。直接rho仅为kg/m³。';

export function normalizeMaterialDensity(material: Record<string, unknown>): Record<string, unknown> {
  if (material.density === undefined) return material;
  const quantity = material.density;
  const invalid = () => new EngineeringValidationError(`MATERIAL_DENSITY_INVALID: ${String(material.id ?? '?')}; provide density:{value:positive number,unit:kg/m3|t/m3|N/m3|kN/m3}; do not also supply rho / 密度需明确数值及单位，不同时填写rho`);
  if (!isRecord(quantity) || Object.keys(quantity).some(key => !['value', 'unit'].includes(key))
    || typeof quantity.value !== 'number' || !Number.isFinite(quantity.value) || quantity.value <= 0
    || typeof quantity.unit !== 'string' || material.rho !== undefined) throw invalid();
  const factors: Record<string, number> = { 'kg/m3': 1, 't/m3': 1000, 'N/m3': 1 / 9.80665, 'kN/m3': 1000 / 9.80665 };
  const factor = factors[quantity.unit];
  const rho = quantity.value * factor;
  if (factor === undefined || !Number.isFinite(rho) || rho <= 0) throw invalid();
  const { density: _density, ...record } = material;
  return { ...record, rho, extra: { ...(isRecord(material.extra) ? material.extra : {}), densityInput: { ...quantity } } };
}
