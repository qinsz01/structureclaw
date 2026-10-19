import { isRecord } from './model-record.js';

export const SECTION_RECALL_LABEL = {
  en: 'assistant-recalled table value, please verify',
  zh: '助手记忆的标准表值，请核对',
};

/** Pending recall is draft data, never calculation input. Confirmed values must be
 * supplied as user-sourced input; a free-form "confirmed" flag cannot bypass this gate. */
export function sectionConfirmationCandidates(sections: unknown): Record<string, unknown>[] {
  if (!Array.isArray(sections)) return [];
  return sections.filter(isRecord).flatMap(raw => {
    const section = enforceSectionProvenance(raw);
    const extra = isRecord(section.extra) ? section.extra : {};
    const provenance = isRecord(extra.provenance) ? extra.provenance : {};
    const recalled = (field: string) => provenance[field] === 'llm-table'
      || provenance[field] == null && typeof extra.source === 'string' && /^LLM\s*:/i.test(extra.source);
    const pending = ['shape', 'dimensions', 'properties'].filter(field => isRecord(section[field])
      && (recalled(field) || field === 'dimensions' && recalled('shape')));
    if (!pending.length) return [];
    return [{ id: section.id, name: section.name, fields: pending,
      ...(section.shape ? { shape: section.shape } : {}),
      ...(section.dimensions ? { dimensions: section.dimensions } : {}),
      ...(section.properties ? { properties: section.properties } : {}), label: SECTION_RECALL_LABEL }];
  });
}

export class SectionConfirmationRequiredError extends Error {
  readonly code = 'SECTION_CONFIRMATION_REQUIRED';
  readonly statusCode = 422;
  readonly detail: Record<string, unknown>;

  constructor(candidates: Record<string, unknown>[]) {
    const detail = { success: false, status: 'input_required', recoverable: true,
      errorCode: 'SECTION_CONFIRMATION_REQUIRED', modelBuilt: false,
      error: 'Assistant-recalled section values require user confirmation. / 助手记忆的截面数值须先由用户确认。',
      hint: 'Ask once for the section dimensions together with any other missing inputs. Offer the labelled candidates for verification if useful. Do not calculate or relabel them as user-supplied before an actual user answer. After confirmation, record user-sourced dimensions and derive sharp-corner properties. / 请将截面尺寸与其他缺项合并询问一次，可提供带标签的候选值供核对；收到用户答复前不得计算或改标为用户提供。确认后记录用户来源尺寸，由系统按尖角几何推导属性。',
      nextAction: 'ask_user_clarification', candidates };
    super(JSON.stringify(detail));
    this.name = 'SectionConfirmationRequiredError';
    this.detail = detail;
  }
}

export function assertConfirmedSectionInputs(model: Record<string, unknown>): void {
  const candidates = sectionConfirmationCandidates(model.sections);
  if (candidates.length) throw new SectionConfirmationRequiredError(candidates);
}

/** User dimensions cannot be overridden by assistant-generated or unattributed properties.
 * Explicit user properties still win, including when both sources are present.
 */
export function enforceSectionProvenance(section: Record<string, unknown>): Record<string, unknown> {
  const extra = isRecord(section.extra) ? section.extra : {};
  const provenance = isRecord(extra.provenance) ? extra.provenance : {};
  if (!isRecord(section.shape) || provenance.shape !== 'user' || provenance.properties === 'user') return section;
  const alreadyDerived = provenance.properties === 'geometry' && isRecord(extra.derived_properties);
  const { properties: _properties, ...rest } = section;
  const { source: _source, ...retainedExtra } = extra;
  return { ...rest, extra: { ...retainedExtra,
    provenance: { ...provenance, properties: 'geometry' },
    ...(!alreadyDerived && isRecord(section.properties) ? { discarded_nonuser_properties: section.properties } : {}),
  } };
}
