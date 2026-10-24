import { isRecord } from './model-state.js';
import { EngineeringValidationError } from './validation-error.js';

/** Explicit quantities only: natural-language interpretation belongs to the extractor. */
export const materialDensityContract = {
  type: 'object', additionalProperties: false, required: ['value', 'unit'],
  properties: { value: { type: 'number', exclusiveMinimum: 0 },
    unit: { type: 'string', enum: ['kg/m3', 't/m3', 'N/m3', 'kN/m3'] } },
};

export const MATERIAL_DENSITY_RULE = 'Density input: materials[].density={value,unit:"kg/m3"|"t/m3"|"N/m3"|"kN/m3"}; omit rho. Do not calculate the conversion. The system uses g=9.80665 m/s² for rho (kg/m³), retaining source. Never infer units from magnitude or overwrite explicit density. / 原数值及单位写density，由系统换算并保留来源；不猜单位，不用牌号默认值覆盖。';

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
