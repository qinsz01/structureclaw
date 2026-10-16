import type { LocalStructureProtocolClient } from '../skill-shared/structure-protocol-execution.js';
import { isRecord, validateModelReferences, type ModelRecord } from './model-state.js';
import { assertResolvedInput, assertInputEvidenceMatchesModel } from './input-evidence.js';
import { assertReviewedSectionProvenance } from './section-tables.js';

/** All template, imported and edited models enter the same V2 validator. */
export async function normalizeEngineeringModel(model: ModelRecord, client: LocalStructureProtocolClient, sourceFormat = 'structuremodel-v2'): Promise<ModelRecord> {
  assertResolvedInput(isRecord(model.metadata) ? model.metadata.inputEvidence : undefined);
  for (const section of Array.isArray(model.sections) ? model.sections : []) if (isRecord(section)) assertReviewedSectionProvenance(section);
  const response = await client.post('/convert', {
    model, source_format: sourceFormat, target_format: 'structuremodel-v2', target_schema_version: '2.2.0',
  }).catch((error: unknown) => {
    if (error instanceof Error && 'detail' in error) {
      const detail = error.detail;
      const errors = isRecord(detail) && Array.isArray(detail.errors) ? detail.errors : [];
      const fields = errors.filter(isRecord).slice(0, 20).map(item => `${Array.isArray(item.loc) ? item.loc.join('.') : 'model'}: ${String(item.msg)}`);
      if (fields.length) error.message += `: ${fields.join('; ')} / 具体字段校验失败，原模型未变`;
    }
    throw error;
  });
  if (!isRecord(response.data) || !isRecord(response.data.model)) throw new Error('MODEL_CONVERSION_FAILED');
  const normalized = structuredClone(response.data.model);
  for (const loadCase of (normalized.load_cases ?? []) as ModelRecord[]) {
    const loads = (loadCase.loads ?? []) as ModelRecord[];
    // Python's exclude_unset serialization may omit the legitimate [] default.
    // Materialize it before the reference checker; never invent an applied load.
    loadCase.loads = loads;
    const used = new Set(loads.map((load) => load.id).filter(Boolean));
    for (let i = 0; i < loads.length; i++) {
      if (loads[i]!.id) continue;
      let id = `${String(loadCase.id)}:load:${i + 1}`;
      while (used.has(id)) id += '_';
      loads[i]!.id = id;
      used.add(id);
    }
  }
  for (const section of Array.isArray(normalized.sections) ? normalized.sections : []) if (isRecord(section)) assertReviewedSectionProvenance(section);
  validateModelReferences(normalized);
  assertInputEvidenceMatchesModel(normalized, isRecord(model.metadata) ? model.metadata.inputEvidence : undefined);
  return normalized;
}
