import { validateStructuredBooleanValue, validateOptionalNonEmptyStringValue, validateOptionalStringOrStringArrayValue } from './validate-values.js';
import { isRecord } from '../shared.js';

const STRUCTURED_REVIEW_TRACE_KEYS = [
  'overLimitReview',
  'specialReview',
  'specialSeismicReview',
  'overLimitSpecialReview',
] as const;

const STRUCTURED_REVIEW_BOOLEAN_KEYS = [
  'reviewRequired',
  'required',
  'requiresReview',
  'overLimitReviewRequired',
  'requiresOverLimitReview',
  'specialReviewRequired',
  'requiresSpecialReview',
  'specialSeismicReviewRequired',
  'approved',
  'reviewApproved',
  'approvalProvided',
  'reviewCompleted',
  'completed',
  'provided',
  'expertReviewProvided',
  'expertReviewCompleted',
] as const;

const STRUCTURED_REVIEW_STRING_KEYS = [
  'status',
  'reviewStatus',
  'approvalStatus',
  'conclusion',
  'reviewConclusion',
  'approvalConclusion',
  'reviewType',
  'type',
  'approvalId',
  'reviewId',
  'reportId',
  'authority',
  'reviewAuthority',
  'date',
  'reviewDate',
  'approvalDate',
] as const;

const STRUCTURED_REVIEW_REASON_KEYS = [
  'reasons',
  'reviewReasons',
  'overLimitReasons',
  'specialReviewReasons',
] as const;

function validateStructuredReviewTraceFields(review: Record<string, unknown>, fieldPath: string, errors: string[]): void {
  for (const key of STRUCTURED_REVIEW_BOOLEAN_KEYS) {
    validateStructuredBooleanValue(review[key], `${fieldPath}.${key}`, errors);
  }
  for (const key of STRUCTURED_REVIEW_STRING_KEYS) {
    validateOptionalNonEmptyStringValue(review[key], `${fieldPath}.${key}`, errors);
  }
  for (const key of STRUCTURED_REVIEW_REASON_KEYS) {
    validateOptionalStringOrStringArrayValue(review[key], `${fieldPath}.${key}`, errors);
  }
}

function validateStructuredReviewTraceValue(value: unknown, fieldPath: string, errors: string[]): void {
  if (value === undefined) {
    return;
  }
  if (!isRecord(value)) {
    errors.push(`${fieldPath} must be an object when provided.`);
    return;
  }
  validateStructuredReviewTraceFields(value, fieldPath, errors);
}

export function validateStructuredReviewTraceFieldsInRecord(record: Record<string, unknown>, fieldPath: string, errors: string[]): void {
  for (const key of STRUCTURED_REVIEW_TRACE_KEYS) {
    const reviewFieldPath = fieldPath ? `${fieldPath}.${key}` : key;
    validateStructuredReviewTraceValue(record[key], reviewFieldPath, errors);
  }
}

export function validateRegularityAssessmentReviewFields(value: unknown, fieldPath: string, errors: string[]): void {
  if (value === undefined) {
    return;
  }
  if (!isRecord(value)) {
    errors.push(`${fieldPath} must be an object when provided.`);
    return;
  }
  for (const key of STRUCTURED_REVIEW_BOOLEAN_KEYS) {
    validateStructuredBooleanValue(value[key], `${fieldPath}.${key}`, errors);
  }
  for (const key of STRUCTURED_REVIEW_REASON_KEYS) {
    validateOptionalStringOrStringArrayValue(value[key], `${fieldPath}.${key}`, errors);
  }
}
