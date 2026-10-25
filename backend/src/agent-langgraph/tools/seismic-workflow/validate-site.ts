import { validateIntegerRangeValue, validatePositiveNumberValue, validatePositiveFractionValue, validateDesignGroupValue, validateSiteCategoryValue, validateStructuredBooleanValue } from './validate-values.js';
import { isRecord } from '../shared.js';

function hasGroundMotionSource(record: Record<string, unknown>): boolean {
  if (isRecord(record.fileReference) && record.fileReference.format === 'sclaw-parsed-input-v1'
    && ['path', 'sha256', 'parsedPath', 'parsedSha256'].every(key => typeof (record.fileReference as Record<string, unknown>)[key] === 'string')) return true;
  if (
    Array.isArray(record['values'])
    || Array.isArray(record['accelerations'])
    || Array.isArray(record['accel'])
    || Array.isArray(record['rows'])
  ) {
    return true;
  }
  for (const key of ['content', 'text', 'csv', 'at2', 'data'] as const) {
    if (typeof record[key] === 'string' && record[key].trim().length > 0) {
      return true;
    }
  }
  for (const key of ['fileAnalysis', 'analysis', 'parsedFile', 'file'] as const) {
    const nested = record[key];
    if (isRecord(nested) && hasGroundMotionSource(nested)) {
      return true;
    }
  }
  return false;
}

export function validateGroundMotionRecords(value: unknown, fieldPath: string, errors: string[]): void {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    errors.push(`${fieldPath} must be an array when provided.`);
    return;
  }
  value.forEach((item, index) => {
    if (!isRecord(item)) {
      errors.push(`${fieldPath}[${index}] must be an object.`);
      return;
    }
    if (!hasGroundMotionSource(item)) {
      errors.push(`${fieldPath}[${index}] must include values, rows, text/content, or parsed file data.`);
    }
  });
}

export function localCatalogRecordIds(records: unknown): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(records)) {
    return ids;
  }
  records.forEach((item) => {
    if (!isRecord(item)) {
      return;
    }
    const id = item['id'] ?? item['catalogId'] ?? item['name'];
    if (typeof id === 'string' && id.trim()) {
      ids.add(id.trim());
    }
  });
  return ids;
}

// Field names consumed by the seismic design-basis reader, plus its zonation input.
// This is a structured protocol boundary, not interpretation of user prose.
const siteSeismicFields = new Set([
  'intensity', 'accelerationG', 'acceleration_g', 'basicAccelerationG', 'designBasicAccelerationG',
  'designGroup', 'design_group', 'siteCategory', 'site_category', 'siteClass',
  'dampingRatio', 'damping_ratio', 'characteristicPeriod', 'characteristic_period', 'Tg',
  'rareCharacteristicPeriod', 'rare_characteristic_period', 'maxInfluenceCoefficient', 'max_influence_coefficient',
  'earthquakeLevel', 'earthquake_level', 'region', 'city', 'extra', 'zonationRecord',
]);

export function validateSiteSeismicFields(siteSeismic: Record<string, unknown>, fieldPath: string, errors: string[]): void {
  for (const key of Object.keys(siteSeismic)) {
    if (!siteSeismicFields.has(key)) errors.push(`${fieldPath}.${key} is unsupported and would not be executed; use a supported field (numeric accelerationG in g for acceleration), never omit a supplied requirement. / 未支持的场地参数不能忽略后计算；请改用已接通的正式字段（地震加速度用以g为单位的数值accelerationG），不得丢弃已给要求。`);
  }
  validateIntegerRangeValue(siteSeismic['intensity'], `${fieldPath}.intensity`, 6, 9, errors);
  validatePositiveNumberValue(siteSeismic['accelerationG'], `${fieldPath}.accelerationG`, errors);
  validatePositiveNumberValue(siteSeismic['acceleration_g'], `${fieldPath}.acceleration_g`, errors);
  validatePositiveNumberValue(siteSeismic['basicAccelerationG'], `${fieldPath}.basicAccelerationG`, errors);
  validatePositiveNumberValue(siteSeismic['designBasicAccelerationG'], `${fieldPath}.designBasicAccelerationG`, errors);
  validateDesignGroupValue(siteSeismic['designGroup'], `${fieldPath}.designGroup`, errors);
  validateDesignGroupValue(siteSeismic['design_group'], `${fieldPath}.design_group`, errors);
  validateSiteCategoryValue(siteSeismic['siteCategory'], `${fieldPath}.siteCategory`, errors);
  validateSiteCategoryValue(siteSeismic['site_category'], `${fieldPath}.site_category`, errors);
  validateSiteCategoryValue(siteSeismic['siteClass'], `${fieldPath}.siteClass`, errors);
  validatePositiveFractionValue(siteSeismic['dampingRatio'], `${fieldPath}.dampingRatio`, errors);
  validatePositiveFractionValue(siteSeismic['damping_ratio'], `${fieldPath}.damping_ratio`, errors);
  const zonationRecord = isRecord(siteSeismic['zonationRecord']) ? siteSeismic['zonationRecord'] : undefined;
  if (zonationRecord) {
    validateZonationTableValue(zonationRecord, `${fieldPath}.zonationRecord`, errors);
  }
}

export function validateSeismicSafetyEvaluationValue(value: unknown, fieldPath: string, errors: string[]): void {
  if (value === undefined) {
    return;
  }
  if (!isRecord(value)) {
    errors.push(`${fieldPath} must be an object when provided.`);
    return;
  }
  validateStructuredBooleanValue(value['approved'], `${fieldPath}.approved`, errors);
  validateIntegerRangeValue(value['intensity'], `${fieldPath}.intensity`, 6, 9, errors);
  validatePositiveNumberValue(value['accelerationG'], `${fieldPath}.accelerationG`, errors);
  validatePositiveNumberValue(value['acceleration_g'], `${fieldPath}.acceleration_g`, errors);
  validatePositiveNumberValue(value['basicAccelerationG'], `${fieldPath}.basicAccelerationG`, errors);
  validatePositiveNumberValue(value['designBasicAccelerationG'], `${fieldPath}.designBasicAccelerationG`, errors);
  validateDesignGroupValue(value['designGroup'], `${fieldPath}.designGroup`, errors);
  validateDesignGroupValue(value['design_group'], `${fieldPath}.design_group`, errors);
  validatePositiveNumberValue(value['characteristicPeriod'], `${fieldPath}.characteristicPeriod`, errors);
  validatePositiveNumberValue(value['characteristic_period'], `${fieldPath}.characteristic_period`, errors);
  validatePositiveNumberValue(value['Tg'], `${fieldPath}.Tg`, errors);
  validatePositiveNumberValue(value['rareCharacteristicPeriod'], `${fieldPath}.rareCharacteristicPeriod`, errors);
  validatePositiveNumberValue(value['rare_characteristic_period'], `${fieldPath}.rare_characteristic_period`, errors);
  validatePositiveNumberValue(value['rareTg'], `${fieldPath}.rareTg`, errors);
  validatePositiveNumberValue(value['maxInfluenceCoefficient'], `${fieldPath}.maxInfluenceCoefficient`, errors);
  validatePositiveNumberValue(value['alphaMax'], `${fieldPath}.alphaMax`, errors);
}

function zonationRecordHasParameter(record: Record<string, unknown>): boolean {
  return Boolean(
    record['accelerationG'] !== undefined
    || record['acceleration_g'] !== undefined
    || record['basicAccelerationG'] !== undefined
    || record['designBasicAccelerationG'] !== undefined
    || record['pgaG'] !== undefined
    || record['peakAccelerationG'] !== undefined
    || record['amaxG'] !== undefined
    || record['intensity'] !== undefined
    || record['seismicIntensity'] !== undefined
    || record['fortificationIntensity'] !== undefined
    || record['designGroup'] !== undefined
    || record['design_group'] !== undefined
    || record['earthquakeGroup'] !== undefined
    || record['characteristicPeriod'] !== undefined
    || record['characteristic_period'] !== undefined
    || record['Tg'] !== undefined
    || record['tg'] !== undefined
    || record['maxInfluenceCoefficient'] !== undefined
    || record['max_influence_coefficient'] !== undefined
    || record['alphaMax'] !== undefined
  );
}

function validateZonationRecordFields(record: Record<string, unknown>, fieldPath: string, errors: string[]): void {
  if (!zonationRecordHasParameter(record)) {
    errors.push(`${fieldPath} must include acceleration, intensity, design group, characteristic period, or alphaMax.`);
  }
  validateIntegerRangeValue(record['intensity'], `${fieldPath}.intensity`, 6, 9, errors);
  validateIntegerRangeValue(record['seismicIntensity'], `${fieldPath}.seismicIntensity`, 6, 9, errors);
  validateIntegerRangeValue(record['fortificationIntensity'], `${fieldPath}.fortificationIntensity`, 6, 9, errors);
  validatePositiveNumberValue(record['accelerationG'], `${fieldPath}.accelerationG`, errors);
  validatePositiveNumberValue(record['acceleration_g'], `${fieldPath}.acceleration_g`, errors);
  validatePositiveNumberValue(record['basicAccelerationG'], `${fieldPath}.basicAccelerationG`, errors);
  validatePositiveNumberValue(record['designBasicAccelerationG'], `${fieldPath}.designBasicAccelerationG`, errors);
  validatePositiveNumberValue(record['pgaG'], `${fieldPath}.pgaG`, errors);
  validatePositiveNumberValue(record['peakAccelerationG'], `${fieldPath}.peakAccelerationG`, errors);
  validatePositiveNumberValue(record['amaxG'], `${fieldPath}.amaxG`, errors);
  validateDesignGroupValue(record['designGroup'], `${fieldPath}.designGroup`, errors);
  validateDesignGroupValue(record['design_group'], `${fieldPath}.design_group`, errors);
  validateDesignGroupValue(record['earthquakeGroup'], `${fieldPath}.earthquakeGroup`, errors);
  validatePositiveNumberValue(record['characteristicPeriod'], `${fieldPath}.characteristicPeriod`, errors);
  validatePositiveNumberValue(record['characteristic_period'], `${fieldPath}.characteristic_period`, errors);
  validatePositiveNumberValue(record['Tg'], `${fieldPath}.Tg`, errors);
  validatePositiveNumberValue(record['tg'], `${fieldPath}.tg`, errors);
  validatePositiveNumberValue(record['maxInfluenceCoefficient'], `${fieldPath}.maxInfluenceCoefficient`, errors);
  validatePositiveNumberValue(record['max_influence_coefficient'], `${fieldPath}.max_influence_coefficient`, errors);
  validatePositiveNumberValue(record['alphaMax'], `${fieldPath}.alphaMax`, errors);
}

function validateZonationRecords(records: unknown, fieldPath: string, errors: string[]): void {
  if (!Array.isArray(records)) {
    errors.push(`${fieldPath} must be an array when provided.`);
    return;
  }
  if (records.length === 0) {
    errors.push(`${fieldPath} must contain at least one record.`);
    return;
  }
  records.forEach((item, index) => {
    if (!isRecord(item)) {
      errors.push(`${fieldPath}[${index}] must be an object.`);
      return;
    }
    validateZonationRecordFields(item, `${fieldPath}[${index}]`, errors);
  });
}

function isZonationParameterKey(value: unknown): boolean {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return false;
  }
  const key = String(value).trim();
  return [
    'accelerationG',
    'acceleration_g',
    'basicAccelerationG',
    'designBasicAccelerationG',
    'pgaG',
    'peakAccelerationG',
    'amaxG',
    'intensity',
    'seismicIntensity',
    'fortificationIntensity',
    'designGroup',
    'design_group',
    'earthquakeGroup',
    'characteristicPeriod',
    'characteristic_period',
    'Tg',
    'tg',
    'maxInfluenceCoefficient',
    'max_influence_coefficient',
    'alphaMax',
  ].includes(key);
}

export function validateZonationTableValue(value: unknown, fieldPath: string, errors: string[]): void {
  if (value === undefined) {
    return;
  }
  if (Array.isArray(value)) {
    validateZonationRecords(value, fieldPath, errors);
    return;
  }
  if (!isRecord(value)) {
    errors.push(`${fieldPath} must be an object or an array of records when provided.`);
    return;
  }
  if (value['records'] !== undefined) {
    validateZonationRecords(value['records'], `${fieldPath}.records`, errors);
    return;
  }
  if (value['headers'] !== undefined || value['rows'] !== undefined) {
    if (!Array.isArray(value['headers']) || !Array.isArray(value['rows'])) {
      errors.push(`${fieldPath}.headers and ${fieldPath}.rows must both be arrays when provided.`);
      return;
    }
    if ((value['headers'] as unknown[]).length === 0 || (value['rows'] as unknown[]).length === 0) {
      errors.push(`${fieldPath}.headers and ${fieldPath}.rows must not be empty when provided.`);
    }
    if (!(value['headers'] as unknown[]).some((header) => isZonationParameterKey(header))) {
      errors.push(`${fieldPath}.headers must include acceleration, intensity, design group, characteristic period, or alphaMax.`);
    }
    if (!(value['rows'] as unknown[]).every((row) => Array.isArray(row))) {
      errors.push(`${fieldPath}.rows must contain row arrays.`);
    }
    return;
  }
  validateZonationRecordFields(value, fieldPath, errors);
}
