import { isRecord } from './model-record.js';

/** User dimensions cannot be overridden by assistant-supplied catalogue properties.
 * Explicit user properties still win, including when both sources are present.
 */
export function enforceSectionProvenance(section: Record<string, unknown>): Record<string, unknown> {
  const extra = isRecord(section.extra) ? section.extra : {};
  const provenance = isRecord(extra.provenance) ? extra.provenance : {};
  const tableProperties = provenance.properties === 'llm-table'
    || provenance.properties == null && typeof extra.source === 'string' && /LLM|assistant|模型|助手/i.test(extra.source);
  if (!isRecord(section.shape) || provenance.shape !== 'user' || !tableProperties || !isRecord(section.properties)) return section;
  const { properties: _properties, ...rest } = section;
  const { source: _source, ...retainedExtra } = extra;
  return { ...rest, extra: { ...retainedExtra,
    provenance: { ...provenance, properties: 'geometry' },
    discarded_table_properties: section.properties,
  } };
}
