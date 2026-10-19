import { isRecord } from './model-record.js';

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
