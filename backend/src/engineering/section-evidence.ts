import { contentHash, isRecord, type ModelRecord } from './model-record.js';
import { activeInputEvidence, mergeInputEvidence, modelFieldUnit } from './input-evidence.js';

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
    if (Array.isArray(record.candidates)) {
      const { id, ...parsed } = record;
      if (record.requirement !== 'field-mapping' || id !== `file:${contentHash(parsed)}`) return [];
      return record.candidates.filter(isRecord).map(candidate => ({
        ...candidate, evidenceId: record.id, source: record.source,
      }));
    }
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
  const sameField = (other: unknown) => other === field || ['shape', 'dimensions'].includes(field)
    && typeof other === 'string' && ['shape', 'dimensions'].includes(other);
  return (context.confirmations ?? []).some(receipt => typeof receipt.answer === 'string' && receipt.answer.trim()
    && Array.isArray(receipt.sectionCandidates) && receipt.sectionCandidates.filter(isRecord).some(candidate => {
      if (candidate.sectionId !== section.id || !sameField(candidate.field) || !isRecord(candidate.values)
        || candidate.values[key] !== value) return false;
      const selected = typeof receipt.selectedOptionId === 'string' && Array.isArray(candidate.optionIds)
        && candidate.optionIds.includes(receipt.selectedOptionId);
      // Free-text acceptance is interpreted by the extractor, never by keyword matching.
      const accepted = binding.clarificationId === receipt.clarificationId && Array.isArray(binding.candidateIds)
        && binding.candidateIds.includes(candidate.id);
      // A semantic acceptance may name the receipt but omit its redundant candidate hash.
      // Resolve that omission only for a single candidate for this section/field, with identical numbers.
      const values = isRecord(section[field]) ? section[field] : {};
      const numeric = Object.entries(values).filter(([, item]) => typeof item === 'number');
      const candidateValues = candidate.values;
      const unique = binding.clarificationId === receipt.clarificationId && binding.candidateIds === undefined
        && (receipt.sectionCandidates as unknown[]).filter(item => isRecord(item)
          && item.sectionId === section.id && sameField(item.field)).length === 1
        && numeric.length === Object.values(candidateValues).filter(item => typeof item === 'number').length
        && numeric.every(([name, item]) => candidateValues[name] === item);
      return selected || accepted || unique;
    }));
}

/** Complete numeric tables need no second semantic review after every cell has a verified field citation. */
export function bindVerifiedSectionTable(sections: ModelRecord[], evidence: ModelRecord[] = []): ModelRecord[] {
  const candidates = attachmentSectionCandidates(evidence);
  const sourceKey = (source: unknown) => {
    const record = isRecord(source) ? source : {};
    return contentHash([record.file, record.sha256, record.parser, record.sheet]);
  };
  const mapped = new Map<string, { paths: Set<string>; fields: Set<string> }>();
  const additions: ModelRecord[] = [];
  for (const section of sections) {
    const extra = isRecord(section.extra) ? section.extra : {};
    const provenance = isRecord(extra.provenance) ? extra.provenance : {};
    for (const [field, citation] of Object.entries(isRecord(extra.evidence) ? extra.evidence : {})) {
      const [group, key] = field.split('.');
      if (provenance[group!] !== 'attachment' || !isRecord(citation) || !isRecord(section[group!])) continue;
      const value = (section[group!] as ModelRecord)[key!];
      const candidate = candidates.find(item => item.evidenceId === citation.evidenceId && item.path === citation.path);
      if (!candidate || typeof value !== 'number') continue;
      const unit = modelFieldUnit(['sections', group!, key!]);
      if (!unit) continue;
      const modelField = `sections.${section.id}.${field}`;
      const binding = mapped.get(sourceKey(candidate.source)) ?? { paths: new Set<string>(), fields: new Set<string>() };
      binding.paths.add(String(candidate.path)); binding.fields.add(modelField);
      mapped.set(sourceKey(candidate.source), binding);
      if (evidence.some(item => item.field === modelField && item.status === 'observed')) continue;
      const observed = { field: modelField, status: 'observed', required: true, value, unit,
        source: { ...(isRecord(candidate.source) ? candidate.source : {}), path: candidate.path,
          ...(candidate.row !== undefined ? { row: candidate.row, column: candidate.column } : {}) } };
      additions.push({ ...observed, id: `section-map:${contentHash(observed)}` });
    }
  }
  const active = activeInputEvidence(evidence);
  for (const field of new Set(active.filter(record => record.requirement === 'field-mapping').map(record => record.field))) {
    const records = active.filter(record => record.field === field);
    if (records.some(record => record.status === 'resolved')) continue;
    const complete = records.every(record => {
      const binding = mapped.get(sourceKey(record.source));
      return binding && Array.isArray(record.tableLabels) && record.tableLabels.every(label => sections.some(section =>
        [section.id, section.name, section.type, isRecord(section.shape) ? section.shape.kind : undefined].includes(label)))
        && isRecord(record.source) && record.source.complete === true && Array.isArray(record.candidates)
        && record.candidates.length > 0 && record.candidates.every(candidate => isRecord(candidate) && binding.paths.has(String(candidate.path)));
    });
    if (!complete) continue;
    const fields = [...new Set(records.flatMap(record => [...mapped.get(sourceKey(record.source))!.fields]))];
    const resolved = { field, status: 'resolved', required: true, source: records[0]!.source,
      resolution: { value: 'mapped', mappedFields: fields, evidenceHashes: records.map(contentHash),
        reason: 'Every numeric parser candidate has a verified section field citation / 每个数值解析候选均已绑定核实的截面字段' } };
    additions.push({ ...resolved, id: `section-map:${contentHash(resolved)}` });
  }
  return mergeInputEvidence(evidence, additions)!;
}
