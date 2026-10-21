import { isRecord } from './model-record.js';
import { attachmentSectionCandidates, confirmedSectionValue, sectionEvidenceContext, type SectionEvidence } from './section-evidence.js';

type Quantity = { value: number; power?: number; scale?: number };
const NUMBER = String.raw`[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?`;
const UNIT = String.raw`(?:mm|cm|m|毫米|厘米|米)(?:\s*(?:\^?[234]|[²³⁴]))?`;
const TERM = `${NUMBER}(?:\\s*${UNIT})?`;

/** Numeric evidence only; no interpretation of agreement, intent, or a designation. */
export function quantities(text: string): Quantity[] {
  const result: Quantity[] = [];
  const groups = new RegExp(`${TERM}(?:\\s*[×xX*]\\s*${TERM})*`, 'g');
  for (const group of text.matchAll(groups)) {
    const terms = [...group[0].matchAll(new RegExp(`(${NUMBER})(?:\\s*(${UNIT}))?`, 'g'))];
    const before = text[(group.index ?? 0) - 1] ?? '';
    const after = text[(group.index ?? 0) + group[0].length] ?? '';
    // Schema field notation H200, B100, tw7 is numeric input; Q235 / I20a are identifiers.
    const labelled = /\b(?:H|B|tw|tf|r|A|As|Asy|Asz|Iy|Iz|J|Wx|Wz|Wnx|S|Sz|tz|t|imin)$/i.test(text.slice(0, group.index));
    if ((terms.length === 1 && /[A-Za-z0-9_.]/.test(before) && !labelled) || /[A-Za-z_]/.test(after)) continue;
    const sharedUnit = terms.at(-1)?.[2];
    for (const term of terms) {
      const unit = (term[2] ?? sharedUnit)?.replace(/\s|\^/g, '').replace('²', '2').replace('³', '3').replace('⁴', '4')
        .replace('毫米', 'mm').replace('厘米', 'cm').replace('米', 'm');
      result.push({ value: Number(term[1]), ...(unit ? {
        power: Number(unit.match(/[234]$/)?.[0] ?? 1),
        scale: unit.startsWith('mm') ? .001 : unit.startsWith('cm') ? .01 : 1,
      } : {}) });
    }
  }
  return result;
}

const PROPERTY_POWER: Record<string, number> = {
  A: 2, As: 2, Asy: 2, Asz: 2, Iy: 4, Iz: 4, J: 4,
  Wx: 3, Wz: 3, Wnx: 3, S: 3, Sz: 3, tw: 1, tz: 1, b: 1, t: 1, imin: 1,
};

/** Reclassify unsupported user claims before any recall properties can be discarded or derived. */
export function enforceSectionUserEvidence(section: Record<string, unknown>, input: SectionEvidence, visiting = new Set<string>()): Record<string, unknown> {
  const context = sectionEvidenceContext(input);
  const extra = isRecord(section.extra) ? section.extra : {};
  const provenance = isRecord(extra.provenance) ? extra.provenance : {};
  const evidence = context.userTexts.flatMap(quantities);
  const attachments = attachmentSectionCandidates(context.inputEvidence);
  const bindings = { ...(isRecord(extra.evidence) ? extra.evidence : {}) };
  const matchedSources = new Map<string, string>();
  const supported = (field: string, key: string, value: number) => {
    const power = field === 'properties' ? PROPERTY_POWER[key] : 1;
    const target = field === 'properties' ? value : value / 1000;
    const matches = (item: Quantity) => {
      if (item.power !== undefined && item.power !== power) return false;
      const numeric = item.scale === undefined ? (field === 'properties' ? item.value : item.value / 1000)
        : item.value * item.scale ** (power ?? 1);
      return Math.abs(numeric - target) <= Math.max(Math.abs(numeric), Math.abs(target), Number.MIN_VALUE) * 1e-4;
    };
    if (evidence.some(matches) || confirmedSectionValue(section, field, key, value, context)) return true;
    const name = `${field}.${key}`;
    const citation = isRecord(bindings[name]) ? bindings[name] : undefined;
    const candidate = attachments.find(item => (!citation || item.evidenceId === citation.evidenceId && item.path === citation.path)
      && quantities(`${item.value}${item.unit ?? ''}`).some(matches));
    if (candidate) {
      bindings[name] = { evidenceId: candidate.evidenceId, path: candidate.path, ...(candidate.unit ? { unit: candidate.unit } : {}) };
      matchedSources.set(field, 'attachment');
      return true;
    }
    const rule = isRecord(extra.rules) && isRecord(extra.rules[name]) ? extra.rules[name] : undefined;
    const token = `${String(section.id)}.${name}`;
    if (!rule || visiting.has(token) || typeof rule.factor !== 'number' || !Number.isFinite(rule.factor)
      || typeof rule.statement !== 'string' || !context.userTexts.some(text => text.replace(/\s/g, '').includes(String(rule.statement).replace(/\s/g, '')))
      || ![...rule.statement.matchAll(new RegExp(NUMBER, 'g'))].some(term => Number(term[0]) === rule.factor)
      || typeof rule.sourceSectionId !== 'string' || typeof rule.sourceField !== 'string') return false;
    const [sourceField, sourceKey] = rule.sourceField.split('.');
    if (sourceField !== field || (field === 'properties' && PROPERTY_POWER[sourceKey!] !== power)) return false;
    const source = context.sections?.find(item => item.id === rule.sourceSectionId);
    if (!source) return false;
    const verified = enforceSectionUserEvidence(source, context, new Set([...visiting, token]));
    const sourceExtra = isRecord(verified.extra) ? verified.extra : {};
    const sourceProvenance = isRecord(sourceExtra.provenance) ? sourceExtra.provenance : {};
    const rawValues = verified[sourceField!];
    const sourceValues = isRecord(rawValues) ? rawValues : {};
    if (!['user', 'attachment', 'rule'].includes(String(sourceProvenance[sourceField!])) || typeof sourceValues[sourceKey!] !== 'number') return false;
    const recomputed = (sourceValues[sourceKey!] as number) * rule.factor;
    if (!Number.isFinite(recomputed) || Math.abs(recomputed - value) > 32 * Number.EPSILON * Math.max(Math.abs(value), Math.abs(recomputed), Number.MIN_VALUE)) return false;
    matchedSources.set(field, 'rule');
    return true;
  };
  const nextProvenance = { ...provenance };
  // Mixed records must rederive their geometry fields at every model write.
  // A claimed per-field source never authorizes supplied numerical properties.
  if (['user', 'attachment', 'rule'].includes(String(provenance.properties)) && isRecord(provenance.propertyFields) && isRecord(section.properties)) {
    const sources = { ...provenance.propertyFields };
    const properties = Object.fromEntries(Object.entries(section.properties).filter(([key, value]) => {
      if (sources[key] !== 'geometry') return true;
      if (typeof value !== 'number' || !supported('properties', key, value)) return false;
      sources[key] = 'user';
      return true;
    }));
    nextProvenance.propertyFields = sources;
    if (Object.keys(properties).length !== Object.keys(section.properties).length) {
      const { derived_properties: _derived, ...retainedExtra } = extra;
      section = { ...section, properties, extra: retainedExtra };
    }
    section = { ...section, extra: { ...(isRecord(section.extra) ? section.extra : {}), provenance: nextProvenance } };
  }
  const unsupported: string[] = [];
  for (const field of ['shape', 'dimensions', 'properties']) {
    if (!isRecord(section[field])) continue;
    const numbers = Object.entries(section[field]).filter((entry): entry is [string, number] => typeof entry[1] === 'number');
    // A verified answer supersedes the old recall label, without relying on the extractor to relabel it.
    if (provenance[field] === 'llm-table' && numbers.length
      && numbers.every(([key, value]) => confirmedSectionValue(section, field, key, value, context))) {
      nextProvenance[field] = 'user';
      matchedSources.set(field, 'user');
    }
    if (!['user', 'attachment', 'rule'].includes(String(nextProvenance[field]))) continue;
    for (const [key, value] of Object.entries(section[field])) {
      if (typeof value !== 'number') continue;
      if (!supported(field, key, value)) {
        nextProvenance[field] = 'llm-table';
        unsupported.push(`${field}.${key}`);
      }
    }
    if (nextProvenance[field] !== 'llm-table' && matchedSources.has(field)) nextProvenance[field] = matchedSources.get(field);
  }
  if (!unsupported.length && !matchedSources.size) return section;
  return { ...section, extra: { ...(isRecord(section.extra) ? section.extra : {}), provenance: nextProvenance,
    ...(Object.keys(bindings).length ? { evidence: bindings } : {}) } };
}
