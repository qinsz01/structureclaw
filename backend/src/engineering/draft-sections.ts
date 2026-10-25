import { modelContract, validDraftValue } from './draft-contract.js';
import { EngineeringValidationError } from './validation-error.js';

export class DraftSectionValidationError extends EngineeringValidationError {
  constructor(readonly field: string, value: unknown) {
    super(`DRAFT_SECTION_INVALID: ${field}=${JSON.stringify(value)}; expected ${JSON.stringify(modelContract.$defs.SectionV2.properties.purpose)} / 截面用途不符合正式协议，原草稿未变`);
  }
}

/** Optional draft fields may be absent, but declared enum values must already be valid. */
export function assertDraftSectionPurposes(sections: Array<Record<string, unknown>> | undefined): void {
  for (const [index, section] of (sections ?? []).entries()) {
    if (section.purpose == null || validDraftValue(modelContract.$defs.SectionV2.properties.purpose, section.purpose)) continue;
    const id = typeof section.id === 'string' ? JSON.stringify(section.id) : index;
    throw new DraftSectionValidationError(`sectionRecords[${id}].purpose`, section.purpose);
  }
}
