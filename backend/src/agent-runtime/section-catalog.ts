import type { DraftIssue, EngineeringDraft } from '../shared/types/agent.js';
import { draftFieldValues } from './draft-diagnostics.js';
import { validDraftValue } from '../engineering/draft-contract.js';
import { assertReviewedSectionProvenance, completeReviewedSectionRecord, reviewedSectionNames } from '../engineering/section-tables.js';

export {
  assertReviewedSectionProvenance,
  completeReviewedSectionRecord,
  reviewedSectionName,
  reviewedSectionNames,
  reviewedSectionRecord,
} from '../engineering/section-tables.js';

/** A missing-only diagnostic cannot block values supplied by the same reviewed catalog as the builder. */
export function catalogResolvesMissingSectionIssue(draft: EngineeringDraft | undefined, issue: DraftIssue): boolean {
  if (issue.severity !== 'ambiguous' || issue.value != null || typeof issue.field !== 'string') return false;
  const field = issue.field.replace(/^engineeringDraft\./, '');
  if (!field.startsWith('sectionRecords') || !field.includes('.properties')) return false;
  const records = (draft?.sectionRecords ?? []).map(record => {
    const completed = completeReviewedSectionRecord(record, reviewedSectionNames(record, draft));
    if (!completed) return { id: record.id };
    assertReviewedSectionProvenance(completed);
    return completed;
  });
  // Read old grouped diagnostics at the boundary; new diagnostics name one field.
  const split = field.lastIndexOf('.'), prefix = field.slice(0, split + 1);
  return field.slice(split + 1).split('/').every(component => {
    const values = draftFieldValues({ ...draft, sectionRecords: records }, prefix + component);
    return values.length > 0 && values.every(item => validDraftValue(item.schema, item.value));
  });
}
