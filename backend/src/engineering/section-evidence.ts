import { contentHash, isRecord, type ModelRecord } from './model-record.js';
import { activeInputEvidence } from './input-evidence.js';

export const SECTION_EVIDENCE_RULE = '\nSection evidence / 截面证据: Parsed attachment numbers are supplied input: mark extra.provenance.shape/properties="attachment"; extra.evidence may cite each numeric field, e.g. {"properties.A":{evidenceId:"file:...",path:"rows.0.1",unit:"m2"}}. The system verifies parser candidates; image values require a reviewed observation. For free-text acceptance of offered candidates, use extra.confirmation={clarificationId,candidateIds:[...]}, using ONLY the answered clarification receipt; confirmation covers exactly its stored values. For a stated ratio use extra.provenance.properties="rule" and extra.rules={"properties.Iy":{sourceSectionId:"B1",sourceField:"properties.Iy",factor:1.5,statement:"verbatim user rule"}}; the system recomputes from evidenced inputs. Never promote unconfirmed recall. / 附件解析数值属于输入，来源标 attachment，可逐字段引用解析证据ID与路径；图像必须已有复核观察记录。无数字的确认由语义理解后用 extra.confirmation 关联已回答的澄清ID和候选ID，仅确认原候选值。比例规则记录来源截面、字段、倍数及用户原文，系统用已证实输入重算；未确认记忆值不得进入求解。';

export interface SectionEvidenceContext {
  userTexts: readonly string[];
  inputEvidence?: ModelRecord[];
  confirmations?: ModelRecord[];
  sections?: ModelRecord[];
}
export type SectionEvidence = readonly string[] | SectionEvidenceContext;
export function sectionEvidenceContext(evidence: SectionEvidence): SectionEvidenceContext {
  return Array.isArray(evidence) ? { userTexts: evidence } : evidence as SectionEvidenceContext;
}

/** Only parser-owned scalar candidates and reviewed image observations are sources. */
export function attachmentSectionCandidates(evidence: ModelRecord[] = []): ModelRecord[] {
  const active = activeInputEvidence(evidence);
  return active.flatMap(record => {
    if (!isRecord(record.source) || typeof record.source.sha256 !== 'string') return [];
    if (Array.isArray(record.candidates)) return record.candidates.filter(isRecord).map(candidate => ({
      ...candidate, evidenceId: record.id, source: record.source,
    }));
    if (!String(record.id).startsWith('vision:') || record.status !== 'observed'
      || typeof record.value !== 'number' || !Array.isArray(record.source.region)) return [];
    const reviewed = active.some(item => item.status === 'resolved' && isRecord(item.resolution)
      && (item.resolution.selectedSource === record.id
        || Array.isArray(item.resolution.evidenceHashes) && item.resolution.evidenceHashes.includes(contentHash(record))));
    return reviewed ? [{ value: record.value, unit: record.unit, path: 'value', evidenceId: record.id, source: record.source }] : [];
  });
}

/** A receipt binds an actual answer to the immutable candidates offered in that question. */
export function confirmedSectionValue(section: ModelRecord, field: string, key: string, value: number,
  context: SectionEvidenceContext): boolean {
  const extra = isRecord(section.extra) ? section.extra : {};
  const binding = isRecord(extra.confirmation) ? extra.confirmation : {};
  return (context.confirmations ?? []).some(receipt => typeof receipt.answer === 'string' && receipt.answer.trim()
    && Array.isArray(receipt.sectionCandidates) && receipt.sectionCandidates.filter(isRecord).some(candidate => {
      if (candidate.sectionId !== section.id || candidate.field !== field || !isRecord(candidate.values)
        || candidate.values[key] !== value) return false;
      const selected = typeof receipt.selectedOptionId === 'string' && Array.isArray(candidate.optionIds)
        && candidate.optionIds.includes(receipt.selectedOptionId);
      // Free-text acceptance is interpreted by the extractor, never by keyword matching.
      const accepted = binding.clarificationId === receipt.clarificationId && Array.isArray(binding.candidateIds)
        && binding.candidateIds.includes(candidate.id);
      return selected || accepted;
    }));
}
