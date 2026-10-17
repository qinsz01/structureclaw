/** Carries seismic member evidence from the draft into the built model metadata. */
import { asRecord } from './readers.js';
import type { DraftState } from '../../shared/types/agent.js';

const SEISMIC_MEMBER_EVIDENCE_KEYS = [
  'seismicCapacity',
  'capacityChecks',
  'capacityDesign',
  'strongShearWeakBending',
  'shearCompression',
  'jointCore',
  'jointData',
  'flatBeam',
  'columnPosition',
  'columnCategory',
  'wallData',
  'shearWallData',
  'boundaryElement',
  'boundaryElements',
  'steelSeismicDetailing',
  'steelDetailing',
  'seismicDetailing',
] as const;

function pickSeismicMemberEvidenceFields(value: unknown): Record<string, unknown> {
  const record = asRecord(value);
  return Object.fromEntries(
    SEISMIC_MEMBER_EVIDENCE_KEYS
      .filter((key) => record[key] !== undefined)
      .map((key) => [key, record[key]]),
  );
}

function collectSeismicMemberEvidence(
  value: unknown,
  evidenceById: Map<string, Record<string, unknown>>,
  unmatched: Record<string, unknown>[],
): void {
  const record = asRecord(value);
  if (!Object.keys(record).length) {
    return;
  }
  const byElementId = asRecord(record['byElementId']);
  for (const [elementId, evidence] of Object.entries(byElementId)) {
    const picked = pickSeismicMemberEvidenceFields(evidence);
    if (Object.keys(picked).length) {
      evidenceById.set(elementId, { ...(evidenceById.get(elementId) ?? {}), ...picked });
    }
  }
  for (const collectionKey of ['elements', 'members', 'items']) {
    const collection = record[collectionKey];
    if (!Array.isArray(collection)) {
      continue;
    }
    for (const item of collection) {
      const itemRecord = asRecord(item);
      const elementId = typeof itemRecord['elementId'] === 'string'
        ? itemRecord['elementId']
        : typeof itemRecord['id'] === 'string'
          ? itemRecord['id']
          : undefined;
      const picked = pickSeismicMemberEvidenceFields(itemRecord);
      if (elementId && Object.keys(picked).length) {
        evidenceById.set(elementId, { ...(evidenceById.get(elementId) ?? {}), ...picked });
      } else if (Object.keys(picked).length) {
        unmatched.push(picked);
      }
    }
  }
  const direct = pickSeismicMemberEvidenceFields(record);
  if (Object.keys(direct).length) {
    const elementId = typeof record['elementId'] === 'string'
      ? record['elementId']
      : typeof record['id'] === 'string'
        ? record['id']
        : undefined;
    if (elementId) {
      evidenceById.set(elementId, { ...(evidenceById.get(elementId) ?? {}), ...direct });
    } else {
      unmatched.push(direct);
    }
  }
}

function collectSeismicMemberEvidenceFromState(state: DraftState): {
  byElementId: Map<string, Record<string, unknown>>;
  unmatched: Record<string, unknown>[];
} {
  const byElementId = new Map<string, Record<string, unknown>>();
  const unmatched: Record<string, unknown>[] = [];
  const engineeringDraft = asRecord(state.engineeringDraft);
  const skillState = asRecord(state.skillState);
  const seismicWorkflow = asRecord(skillState['seismicWorkflow']);
  collectSeismicMemberEvidence(engineeringDraft['seismicMemberEvidence'], byElementId, unmatched);
  collectSeismicMemberEvidence(skillState['seismicMemberEvidence'], byElementId, unmatched);
  collectSeismicMemberEvidence(skillState['memberEvidence'], byElementId, unmatched);
  collectSeismicMemberEvidence(seismicWorkflow['seismicMemberEvidence'], byElementId, unmatched);
  collectSeismicMemberEvidence(seismicWorkflow['memberEvidence'], byElementId, unmatched);
  return { byElementId, unmatched };
}

export function attachSeismicMemberEvidence(model: Record<string, unknown>, state: DraftState): Record<string, unknown> {
  const { byElementId, unmatched } = collectSeismicMemberEvidenceFromState(state);
  if (byElementId.size === 0 && unmatched.length === 0) {
    return model;
  }
  const elements = Array.isArray(model.elements)
    ? model.elements.map((element) => {
      const elementRecord = asRecord(element);
      const id = typeof elementRecord['id'] === 'string' ? elementRecord['id'] : undefined;
      const evidence = id ? byElementId.get(id) : undefined;
      if (!evidence) {
        return element;
      }
      return {
        ...elementRecord,
        ...Object.fromEntries(Object.entries(evidence).filter(([key]) => elementRecord[key] === undefined)),
      };
    })
    : model.elements;
  const matchedIds = Array.from(byElementId.keys()).filter((id) => (
    Array.isArray(model.elements)
      && model.elements.some((element) => asRecord(element)['id'] === id)
  ));
  const unmatchedById = Object.fromEntries(
    Array.from(byElementId.entries()).filter(([id]) => !matchedIds.includes(id)),
  );
  const metadata = {
    ...asRecord(model.metadata),
    ...(matchedIds.length ? { seismicMemberEvidenceElementIds: matchedIds } : {}),
    ...((unmatched.length || Object.keys(unmatchedById).length)
      ? { unmatchedSeismicMemberEvidence: { byElementId: unmatchedById, items: unmatched } }
      : {}),
  };
  return {
    ...model,
    elements,
    metadata,
  };
}
