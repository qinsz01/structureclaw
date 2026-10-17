/** Seismic report helpers: yield drift, GB 18306 status, time-history and review summaries, source trace rows. */
import type { AppLocale } from '../../shared/locale.js';
import { localize } from '../plugin-helpers.js';
import { asRecord } from './shared.js';

export function yieldDriftSummary(parameters: Record<string, unknown>, locale: AppLocale): string {
  const ratio = parameters['yieldDriftLimitRatioText'] ?? parameters['yieldDriftRatio'];
  if (ratio === undefined || ratio === null || String(ratio).trim().length === 0) {
    return '';
  }
  const family = parameters['yieldDriftLimitFamily'];
  const familySuffix = family !== undefined && family !== null && String(family).trim().length > 0
    ? ` / ${String(family)}`
    : '';
  const fallbackSuffix = parameters['yieldDriftIsFallback'] === true
    ? localize(locale, '，回退', ', fallback')
    : '';
  return `${String(ratio)}${familySuffix}${fallbackSuffix}`;
}

export function gb18306StatusLine(codeBasis: unknown[], locale: AppLocale): string {
  const record = codeBasis
    .map(asRecord)
    .find((entry) => String(entry['code'] ?? '').trim() === 'GB 18306-2015');
  if (!record) {
    return '';
  }
  const status = String(record['standardStatus'] ?? '').trim();
  const reviewConclusion = String(record['lastReviewConclusion'] ?? '').trim();
  const reviewDate = String(record['lastReviewDate'] ?? '').trim();
  const revisionPlan = asRecord(record['revisionPlan']);
  const revisionPlanNo = String(revisionPlan['planNo'] ?? '').trim();
  const revisionStatus = String(revisionPlan['status'] ?? '').trim();
  const latestAmendment = (Array.isArray(record['amendments'])
    ? record['amendments'].map(asRecord).find((item) => String(item['status'] ?? '').trim() === 'effective')
    : undefined) ?? {};
  const amendmentNo = String(latestAmendment['no'] ?? '').trim();
  const amendmentEffectiveDate = String(latestAmendment['effectiveDate'] ?? '').trim();
  const revisionStatusText = revisionStatus === 'drafting'
    ? localize(locale, '正在起草', 'drafting')
    : (revisionStatus || 'N/A');
  const statusText = status === 'current'
    ? localize(locale, '现行', 'current')
    : (status || 'N/A');
  const reviewText = reviewConclusion === 'continue_valid'
    ? localize(locale, '继续有效', 'continue valid')
    : (reviewConclusion || 'N/A');
  const reviewSuffix = reviewDate
    ? localize(locale, `，复审 ${reviewDate}: ${reviewText}`, `, review ${reviewDate}: ${reviewText}`)
    : '';
  const amendmentSuffix = amendmentNo
    ? localize(locale, `；${amendmentNo}修改单 ${amendmentEffectiveDate || 'N/A'} 起实施`, `; ${amendmentNo} amendment effective ${amendmentEffectiveDate || 'N/A'}`)
    : '';
  const revisionSuffix = revisionPlanNo
    ? localize(locale, `；修订计划 ${revisionPlanNo} ${revisionStatusText}，未作为当前正式设计依据`, `; revision plan ${revisionPlanNo} ${revisionStatusText}, not used as current formal design basis`)
    : '';
  return localize(
    locale,
    `- GB 18306 状态: ${statusText}${reviewSuffix}${amendmentSuffix}${revisionSuffix}`,
    `- GB 18306 status: ${statusText}${reviewSuffix}${amendmentSuffix}${revisionSuffix}`,
  );
}

export function directionTimeHistorySummaries(directionResults: unknown): Array<{
  direction: string;
  recordCount: number;
  minBaseShearRatio: number | null;
  combinedBaseShear: unknown;
}> {
  if (!Array.isArray(directionResults)) {
    return [];
  }
  const items: Array<{
    direction: string;
    recordCount: number;
    minBaseShearRatio: number | null;
    combinedBaseShear: unknown;
  }> = [];
  directionResults.forEach((rawResult, index) => {
    const result = asRecord(rawResult);
    const timeHistory = asRecord(result['timeHistory']);
    if (Object.keys(timeHistory).length === 0) {
      return;
    }
    const records = Array.isArray(timeHistory['records']) ? timeHistory['records'] : [];
    const ratios = records
      .map((record) => Number(asRecord(record)['baseShearRatioToResponseSpectrum']))
      .filter((value) => Number.isFinite(value));
    const combinationSummary = asRecord(timeHistory['combinationSummary']);
    items.push({
      direction: String(result['direction'] ?? `D${index + 1}`),
      recordCount: records.length,
      minBaseShearRatio: ratios.length > 0 ? Math.min(...ratios) : null,
      combinedBaseShear: combinationSummary['combinedBaseShear'] ?? timeHistory['combinedBaseShear'] ?? 'N/A',
    });
  });
  return items;
}

export function structuredReviewSummaries(data: Record<string, unknown>): Array<{
  reviewType: string;
  required: boolean;
  status: string;
  approvalId: string;
}> {
  return [
    ['overLimitReview', data['overLimitReview']],
    ['specialReview', data['specialReview']],
    ['specialSeismicReview', data['specialSeismicReview']],
    ['overLimitSpecialReview', data['overLimitSpecialReview']],
  ].map(([key, raw]) => {
    const record = asRecord(raw);
    if (Object.keys(record).length === 0) {
      return null;
    }
    const required = record['reviewRequired'] === true || record['required'] === true;
    const status = String(record['status'] ?? record['reviewStatus'] ?? record['approvalStatus'] ?? '').trim();
    const reviewType = String(record['reviewType'] ?? record['type'] ?? key).trim();
    const approvalId = String(record['approvalId'] ?? record['reviewId'] ?? record['reportId'] ?? '').trim();
    if (!required && !status && !approvalId) {
      return null;
    }
    return {
      reviewType,
      required,
      status,
      approvalId,
    };
  }).filter((item): item is {
    reviewType: string;
    required: boolean;
    status: string;
    approvalId: string;
  } => item !== null);
}

export function seismicSourceTraceRows(
  data: Record<string, unknown>,
  designBasis: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const topLevelTrace = Array.isArray(data['sourceTrace'])
    ? data['sourceTrace']
    : [];
  const basisTrace = Array.isArray(designBasis['sourceTrace'])
    ? designBasis['sourceTrace']
    : [];
  const rawRows = topLevelTrace.length > 0 ? topLevelTrace : basisTrace;
  return rawRows.map(asRecord).filter((row) => {
    const field = String(row['field'] ?? '').trim();
    return field.length > 0;
  });
}
