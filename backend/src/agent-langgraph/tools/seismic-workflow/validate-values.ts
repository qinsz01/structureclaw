import { isRecord } from '../shared.js';

export function isPositiveFiniteNumber(value: unknown): boolean {
  return Number.isFinite(Number(value)) && Number(value) > 0;
}

export function isPositiveIntegerLike(value: unknown): boolean {
  return Number.isInteger(Number(value)) && Number(value) > 0;
}

export function validateEarthquakeLevelValue(value: unknown, fieldPath: string, errors: string[]): void {
  if (value === undefined) {
    return;
  }
  const text = String(value).trim().toLowerCase();
  const allowed = new Set([
    'frequent',
    'minor',
    'small',
    'frequent_earthquake',
    'service',
    '多遇',
    '小震',
    '多遇地震',
    'fortification',
    'design',
    'moderate',
    'basic',
    'design_earthquake',
    '设防',
    '中震',
    '设防地震',
    'rare',
    'major',
    'large',
    'maximum',
    'rare_earthquake',
    'no_collapse',
    '罕遇',
    '大震',
    '罕遇地震',
  ]);
  if (!allowed.has(text)) {
    errors.push(`${fieldPath} must be frequent, fortification, or rare when provided.`);
  }
}

export function validateIntegerRangeValue(value: unknown, fieldPath: string, min: number, max: number, errors: string[]): void {
  if (value === undefined) {
    return;
  }
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < min || numeric > max) {
    errors.push(`${fieldPath} must be an integer from ${min} to ${max} when provided.`);
  }
}

export function validatePositiveNumberValue(value: unknown, fieldPath: string, errors: string[]): void {
  if (value === undefined) {
    return;
  }
  if (!isPositiveFiniteNumber(value)) {
    errors.push(`${fieldPath} must be a positive number when provided.`);
  }
}

export function validatePositiveFractionValue(value: unknown, fieldPath: string, errors: string[]): void {
  if (value === undefined) {
    return;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0 || numeric >= 1) {
    errors.push(`${fieldPath} must be greater than 0 and less than 1 when provided.`);
  }
}

export function validateDesignGroupValue(value: unknown, fieldPath: string, errors: string[]): void {
  if (value === undefined) {
    return;
  }
  const text = String(value).trim().toLowerCase();
  if (!['1', '2', '3', '一', '二', '三', '第一组', '第二组', '第三组', 'group1', 'group2', 'group3', 'group 1', 'group 2', 'group 3'].includes(text)) {
    errors.push(`${fieldPath} must be one of 1, 2, or 3 when provided.`);
  }
}

export function validateSiteCategoryValue(value: unknown, fieldPath: string, errors: string[]): void {
  if (value === undefined) {
    return;
  }
  const text = String(value).trim().toUpperCase().replace('类', '');
  if (!['0', '1', '2', '3', '4', 'I0', 'I1', 'I', 'II', 'III', 'IV'].includes(text)) {
    errors.push(`${fieldPath} must be one of I0, I1, I, II, III, or IV when provided.`);
  }
}

export function validateFortificationCategoryValue(value: unknown, fieldPath: string, errors: string[]): void {
  if (value === undefined) {
    return;
  }
  const text = String(value).trim().toLowerCase();
  const allowed = new Set([
    'special',
    'key',
    'standard',
    'moderate',
    '甲',
    '甲类',
    '特殊设防类',
    '乙',
    '乙类',
    '重点设防类',
    '丙',
    '丙类',
    '标准设防类',
    '丁',
    '丁类',
    '适度设防类',
  ]);
  if (!allowed.has(text)) {
    errors.push(`${fieldPath} must be special, key, standard, or moderate when provided.`);
  }
}

export function validateRegularityValue(value: unknown, fieldPath: string, errors: string[]): void {
  if (value === undefined) {
    return;
  }
  const text = String(value).trim().toLowerCase();
  const allowed = new Set([
    'regular',
    'regularity_regular',
    '规则',
    'irregular',
    'general_irregular',
    '不规则',
    '一般不规则',
    'particularly_irregular',
    'special_irregular',
    'severe',
    'serious',
    '特别不规则',
    '严重不规则',
    'unknown',
  ]);
  if (!allowed.has(text)) {
    errors.push(`${fieldPath} must be regular, irregular, or particularly_irregular when provided.`);
  }
}

export function validateSeismicGradeValue(value: unknown, fieldPath: string, errors: string[]): void {
  if (value === undefined) {
    return;
  }
  const numeric = Number(value);
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= 4) {
    return;
  }
  const text = String(value).trim().toLowerCase();
  const allowed = new Set([
    'i',
    'ii',
    'iii',
    'iv',
    'grade1',
    'grade2',
    'grade3',
    'grade4',
    'grade 1',
    'grade 2',
    'grade 3',
    'grade 4',
    'first',
    'second',
    'third',
    'fourth',
    '一级',
    '二级',
    '三级',
    '四级',
    '一',
    '二',
    '三',
    '四',
  ]);
  if (!allowed.has(text)) {
    errors.push(`${fieldPath} must be an integer from 1 to 4 when provided.`);
  }
}

export function validateStoryCountValue(value: unknown, fieldPath: string, errors: string[]): void {
  if (value === undefined) {
    return;
  }
  if (!isPositiveIntegerLike(value)) {
    errors.push(`${fieldPath} must be a positive integer when provided.`);
  }
}

export function validateStructuredBooleanValue(value: unknown, fieldPath: string, errors: string[]): void {
  if (value === undefined) {
    return;
  }
  if (typeof value === 'boolean') {
    return;
  }
  if (typeof value === 'string' && ['true', 'false', 'yes', 'no', '1', '0'].includes(value.trim().toLowerCase())) {
    return;
  }
  errors.push(`${fieldPath} must be a boolean when provided.`);
}

export function validateOptionalNonEmptyStringValue(value: unknown, fieldPath: string, errors: string[]): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== 'string' || !value.trim()) {
    errors.push(`${fieldPath} must be a non-empty string when provided.`);
  }
}

export function validateOptionalStringOrStringArrayValue(value: unknown, fieldPath: string, errors: string[]): void {
  if (value === undefined) {
    return;
  }
  if (typeof value === 'string') {
    if (!value.trim()) {
      errors.push(`${fieldPath} must be a string or an array of non-empty strings when provided.`);
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.some((item) => typeof item !== 'string' || !item.trim())) {
      errors.push(`${fieldPath} must contain only non-empty strings when provided.`);
    }
    return;
  }
  errors.push(`${fieldPath} must be a string or an array of non-empty strings when provided.`);
}

export function validatePositiveIntegerValue(value: unknown, fieldPath: string, errors: string[]): void {
  if (value === undefined) {
    return;
  }
  if (!isPositiveIntegerLike(value)) {
    errors.push(`${fieldPath} must be a positive integer when provided.`);
  }
}

export function validateNonlinearModelValue(value: unknown, fieldPath: string, errors: string[]): void {
  if (value === undefined) {
    return;
  }
  if (!isRecord(value)) {
    errors.push(`${fieldPath} must be an object when provided.`);
    return;
  }
  const hinges = value['memberPlasticHinges'];
  if (hinges !== undefined) {
    if (!Array.isArray(hinges)) {
      errors.push(`${fieldPath}.memberPlasticHinges must be an array when provided.`);
    } else if (hinges.some((item) => !isRecord(item))) {
      errors.push(`${fieldPath}.memberPlasticHinges must contain only objects when provided.`);
    }
  }
}

export function validateOptionalRecordValue(value: unknown, fieldPath: string, errors: string[]): void {
  if (value === undefined) {
    return;
  }
  if (!isRecord(value)) {
    errors.push(`${fieldPath} must be an object when provided.`);
  }
}
