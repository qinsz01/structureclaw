import type { EngineeringDraft } from '../shared/types/agent.js';
import catalogData from './reviewed-sections.json' with { type: 'json' };

/** Reviewed numerical catalog data. Rolled/tapered I sections are not rectangular-flange H sections. */
const catalogEntries: Array<Record<string, any>> = catalogData;
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const supplementalProperties = new Set(['S', 'Sz', 'Wnx', 'As', 'Asy', 'Asz', 'b', 't', 'tz']);

export function reviewedSectionName(name: unknown): string | undefined {
  if (typeof name !== 'string') return;
  const normalized = name.trim().replace(/Ⅰ/g, 'I');
  const found = catalogEntries.filter(entry => {
    if (entry.name.toLowerCase() === normalized.toLowerCase()) return true;
    const escaped = entry.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, 'i').test(normalized)
      && /(?:GB\s*\/\s*T\s*706(?!\d)|热轧工字钢|hot[- ]rolled\s+I[- ]sections?)/i.test(normalized);
  });
  return found.length === 1 ? found[0]!.name : undefined;
}

/** Designations the reviewed catalog can complete; nothing else may be offered as a catalog choice. */
export function reviewedSectionCatalogNames(): string[] {
  return catalogEntries.map(entry => String(entry.name));
}

/** Only reviewed rows are accepted. No dimensions, torsion, net modulus or code coefficients are inferred. */
export function reviewedSectionRecord(name: string, id: string, purpose: 'beam' | 'column'): Record<string, unknown> | undefined {
  const identity = reviewedSectionName(name);
  const entry = catalogEntries.find(row => row.name === identity);
  return entry ? { ...structuredClone(entry), id, purpose } : undefined;
}

/** A stable assignment or one unambiguous declared role may identify a labeled record. */
export function reviewedSectionNames(record: Record<string, unknown>, draft: EngineeringDraft | undefined): unknown[] {
  const names: unknown[] = [record.name];
  for (const role of ['beam', 'column', 'member'] as const) {
    const mapping = draft?.templateAssignments?.[role] ?? draft?.templateAssignments?.member;
    if (mapping?.sectionId === record.id) names.push(draft?.sections?.[role] ?? draft?.sections?.member);
  }
  const declarations = [...new Set(Object.values(draft?.sections ?? {}).filter(value => typeof value === 'string'))];
  if (draft?.sectionRecords?.length === 1 && declarations.length === 1) names.push(declarations[0]);
  return names;
}

/** Supplementary design properties do not replace a named catalog's elastic section definition.
 * Explicit basic properties, dimensions and custom-source declarations are never overwritten.
 */
export function completeReviewedSectionRecord(record: Record<string, unknown>, names: unknown[] = []): Record<string, unknown> | undefined {
  const properties = record.properties ?? {};
  if (!isRecord(properties)) return;
  if (Object.keys(properties ?? {}).some(key => !supplementalProperties.has(key))) return;
  if (['shape', 'dimensions'].some(key => isRecord(record[key]) && Object.keys(record[key]).length)
    || ['width', 'height', 'diameter', 'thickness', 'standard_steel_name'].some(key => record[key] != null)) return;
  const extra = isRecord(record.extra) ? record.extra : {};
  // Existing provenance (including an explicit custom-source release) is not rewritten.
  if ('catalogSource' in extra || 'catalogDimensionsMM' in extra || 'customSectionBasis' in extra) return;
  const identity = [record.name, ...names].map(reviewedSectionName).find(Boolean);
  if (!identity || typeof record.id !== 'string') return;
  const catalog = reviewedSectionRecord(identity, record.id, record.purpose === 'column' ? 'column' : 'beam')!;
  const completed: Record<string, unknown> = { ...catalog, ...structuredClone(record),
    width: catalog.width, height: catalog.height,
    name: typeof record.name === 'string' && record.name.trim() ? record.name : catalog.name,
    type: record.type ?? catalog.type,
    properties: { ...(catalog.properties as Record<string, unknown>), ...structuredClone(properties ?? {}) },
    extra: { ...structuredClone(extra), ...(catalog.extra as Record<string, unknown>) } };
  if (record.purpose === undefined) delete completed.purpose;
  delete completed.shape;
  delete completed.dimensions;
  return completed;
}

/** Provenance is a verifiable claim, not a label that can survive unrelated numeric edits. */
export function assertReviewedSectionProvenance(section: Record<string, unknown>): void {
  const extra = isRecord(section.extra) ? section.extra : {};
  if (!('catalogSource' in extra) && !('catalogDimensionsMM' in extra)) return;
  const fail = (field: string): never => { throw new Error(`CATALOG_SECTION_CONFLICT: sections.${String(section.id)}.${field}; retained reviewed catalog provenance must match its source. To declare a custom section, explicitly set extra.catalogSource and extra.catalogDimensionsMM to null and supply nonempty extra.customSectionBasis / 保留目录来源时数值必须与来源一致；改用自定义截面须明确清空两项目录来源并说明依据。`); };
  if (extra.catalogSource === null) {
    if (extra.catalogDimensionsMM !== null || typeof extra.customSectionBasis !== 'string' || !extra.customSectionBasis.trim()) fail('extra.customSectionBasis');
    return;
  }
  const claim = extra.catalogSource;
  const entry = isRecord(claim) ? catalogEntries.find(row => row.extra.catalogSource.recordId === claim.recordId) : undefined;
  if (!entry || !isRecord(claim) || claim.sha256 !== entry.extra.catalogSource.sha256) {
    throw new Error(`CATALOG_SECTION_SOURCE_UNVERIFIED: sections.${String(section.id)}.extra.catalogSource; this catalog source is not registered as reviewed / 该目录来源尚未登记核定。Explicit custom sections require both catalog claims set to null and a nonempty customSectionBasis / 自定义截面须明确清空两项目录来源并说明依据。`);
  }
  if (Object.entries(entry.extra.catalogSource).some(([key, value]) => claim[key] !== value)) fail('extra.catalogSource');
  const identity = isRecord(claim) && typeof claim.recordId === 'string' ? claim.recordId : section.name;
  if (reviewedSectionName(identity) !== entry.name) fail('extra.catalogSource.recordId');
  const catalog = reviewedSectionRecord(entry.name, String(section.id), 'beam')!;
  // Match the existing physical validator's serialization tolerance; no alternative table values.
  const same = (actual: unknown, expected: unknown) => typeof actual === 'number' && Number.isFinite(actual)
    && typeof expected === 'number' && Math.abs(actual - expected) <= Math.max(1e-14, 1e-6 * Math.abs(expected));
  for (const field of ['width', 'height']) if (!same(section[field], catalog[field])) fail(field);
  const props = isRecord(section.properties) ? section.properties : {};
  for (const [field, expected] of Object.entries(catalog.properties as Record<string, unknown>)) {
    if (!same(props[field], expected)) fail(`properties.${field}`);
  }
  const dimensions = isRecord(extra.catalogDimensionsMM) ? extra.catalogDimensionsMM : {};
  for (const [field, expected] of Object.entries((catalog.extra as Record<string, unknown>).catalogDimensionsMM as Record<string, unknown>)) {
    if (!same(dimensions[field], expected)) fail(`extra.catalogDimensionsMM.${field}`);
  }
  if (section.shape != null) fail('shape');
}
