import { isRecord } from './model-record.js';

/** Section provenance is part of the delivered result, including unverified table values. */
export function sectionAssumptions(model: unknown): Array<{ sectionId: unknown; code: string; severity: string; message: { en: string; zh: string } }> {
  if (!isRecord(model) || !Array.isArray(model.sections)) return [];
  return model.sections.filter(isRecord).flatMap(section => {
    const extra = isRecord(section.extra) ? section.extra : {};
    const notes = (Array.isArray(extra.section_diagnostics) ? extra.section_diagnostics : []).filter(isRecord)
      .filter(row => isRecord(row.message) && typeof row.message.en === 'string' && typeof row.message.zh === 'string')
      .map(row => ({ sectionId: section.id, code: String(row.code), severity: String(row.severity), message: row.message as { en: string; zh: string } }));
    if (isRecord(extra.discarded_nonuser_properties) || isRecord(extra.discarded_table_properties)) notes.push({ sectionId: section.id, code: 'SECTION_USER_GEOMETRY', severity: 'info', message: {
      en: 'Properties not marked as user-supplied were discarded: the user supplied dimensions, so the system derives sharp-corner properties (no fillets).',
      zh: '已舍弃未标记为用户提供的截面属性：用户给出了尺寸，系统据此按尖角几何推导截面属性（不计圆角，sharp-corner）。',
    } });
    if (typeof extra.source === 'string') notes.push({ sectionId: section.id, code: 'SECTION_SOURCE', severity: 'info', message: {
      en: `Section ${String(section.name ?? section.id)}: ${JSON.stringify(section.properties ?? {})}; source: ${extra.source}. Verify the adopted values.`,
      zh: `截面 ${String(section.name ?? section.id)}：${JSON.stringify(section.properties ?? {})}；来源：${extra.source}。请核对采用的数值。`,
    } });
    if (isRecord(extra.derived_properties)) notes.push({ sectionId: section.id, code: 'SECTION_GEOMETRY_ASSUMPTION', severity: 'info', message: {
      en: `Section ${String(section.id)}: ${JSON.stringify(extra.derived_properties.fields)} derived from the supplied geometry (sharp corners, no fillets).`,
      zh: `截面 ${String(section.id)}：${JSON.stringify(extra.derived_properties.fields)} 按给定几何计算（尖角理想化，不计圆角）。`,
    } });
    return notes;
  });
}
