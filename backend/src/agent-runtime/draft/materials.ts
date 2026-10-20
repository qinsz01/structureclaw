import type { EngineeringDraft, InferredModelType } from '../../shared/types/agent.js';
import { mergeEngineeringDraft } from '../engineering-draft.js';

/** A misplaced collection is never a section property or a material assignment. */
export function sectionMaterialNotes(draft: EngineeringDraft | undefined) {
  return (draft?.sectionRecords ?? []).filter(section => Object.hasOwn(section, 'materials')).map(section => ({
    field: `sectionRecords[${JSON.stringify(section.id)}].materials`,
    reason: 'MISPLACED_SECTION_MATERIALS',
    message: 'Ignored materials nested in a section; materials belong to the draft root. / 已忽略截面内错误嵌套的 materials；材料应位于草稿根级。',
  }));
}

export function cleanSectionMaterials(draft: EngineeringDraft | undefined): EngineeringDraft | undefined {
  if (!sectionMaterialNotes(draft).length) return draft;
  return { ...draft, sectionRecords: draft!.sectionRecords!.map(({ materials: _misplaced, ...section }) => section) };
}

/** Bridge grade metadata and property records at ingestion, without guessing among multiple materials.
 * A single material has the same meaning in either representation; explicit role/record IDs survive.
 */
export function reconcileDraftMaterials(patch: EngineeringDraft | undefined, existing: EngineeringDraft | undefined,
  inferredType?: InferredModelType): EngineeringDraft | undefined {
  if (!patch) return patch;
  const draft = cleanSectionMaterials(mergeEngineeringDraft(existing, patch))!;
  const recordStyle = Boolean(draft.sectionRecords?.length || draft.materials?.length);
  const material = { ...existing?.material, ...patch.material };
  let materials = draft.materials;
  let assignments = draft.templateAssignments;
  if (recordStyle && (material.grade || material.family)) {
    const ids = [...new Set(Object.values(assignments ?? {}).flatMap(row => row?.materialId ? [row.materialId] : []))];
    const id = ids.length === 1 ? ids[0] : materials?.length === 1 ? String(materials[0]!.id)
      : !materials?.length && !ids.length ? 'M1' : undefined;
    // An unscoped grade cannot overwrite several distinct materials. Keep the metadata as evidence.
    if (id) {
      const existingRecord = materials?.find(row => row.id === id);
      const incomingRecord = patch.materials?.find(row => row.id === id);
      const metadata = patch.material ?? (!existingRecord ? material : {});
      const record = { ...existingRecord, ...metadata, ...incomingRecord, id };
      materials = existingRecord ? materials!.map(row => row.id === id ? record : row) : [...(materials ?? []), record];
      const type = draft.structureType ?? inferredType;
      const role = type === 'beam' || type === 'double-span-beam' ? 'beam' : type === 'column' ? 'column' : 'member';
      if (!ids.length) assignments = { ...assignments, [role]: { ...assignments?.[role], materialId: id } };
    }
  }
  // Legacy consumers see the grade/family of a single record; never collapse heterogeneous records.
  if (materials?.length === 1) {
    const record = materials[0]!;
    if (typeof record.grade === 'string') material.grade = record.grade;
    if (typeof record.family === 'string') material.family = record.family as NonNullable<EngineeringDraft['material']>['family'];
  }
  return { ...patch,
    ...(Object.keys(material).length ? { material } : {}),
    ...(materials ? { materials } : {}),
    ...(assignments ? { templateAssignments: assignments } : {}),
    ...(draft.sectionRecords ? { sectionRecords: draft.sectionRecords } : {}),
  };
}
