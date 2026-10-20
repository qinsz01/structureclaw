import { isRecord } from './model-record.js';

type Quantity = { value: number; power?: number; scale?: number };
const NUMBER = String.raw`[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?`;
const UNIT = String.raw`(?:mm|cm|m|毫米|厘米|米)(?:\s*(?:\^?[234]|[²³⁴]))?`;
const TERM = `${NUMBER}(?:\\s*${UNIT})?`;

/** Numeric evidence only; no interpretation of agreement, intent, or a designation. */
function quantities(text: string): Quantity[] {
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
export function enforceSectionUserEvidence(section: Record<string, unknown>, userTexts: readonly string[]): Record<string, unknown> {
  const extra = isRecord(section.extra) ? section.extra : {};
  const provenance = isRecord(extra.provenance) ? extra.provenance : {};
  const evidence = userTexts.flatMap(quantities);
  const supported = (field: string, key: string, value: number) => {
    const power = field === 'properties' ? PROPERTY_POWER[key] : 1;
    const target = field === 'properties' ? value : value / 1000;
    return evidence.some(item => {
      if (item.power !== undefined && item.power !== power) return false;
      const numeric = item.scale === undefined ? (field === 'properties' ? item.value : item.value / 1000)
        : item.value * item.scale ** (power ?? 1);
      return Math.abs(numeric - target) <= Math.max(Math.abs(numeric), Math.abs(target), Number.MIN_VALUE) * 1e-4;
    });
  };
  const nextProvenance = { ...provenance };
  // Mixed records must rederive their geometry fields at every model write.
  // A claimed per-field source never authorizes supplied numerical properties.
  if (provenance.properties === 'user' && isRecord(provenance.propertyFields) && isRecord(section.properties)) {
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
    if (provenance[field] !== 'user' || !isRecord(section[field])) continue;
    for (const [key, value] of Object.entries(section[field])) {
      if (typeof value !== 'number') continue;
      if (!supported(field, key, value)) {
        nextProvenance[field] = 'llm-table';
        unsupported.push(`${field}.${key}`);
      }
    }
  }
  if (!unsupported.length) return section;
  return { ...section, extra: { ...(isRecord(section.extra) ? section.extra : {}), provenance: nextProvenance } };
}
