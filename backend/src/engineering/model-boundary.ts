import type { LocalStructureProtocolClient } from '../services/structure-protocol-execution.js';
import { isRecord, validateModelReferences, type ModelRecord } from './model-state.js';
import { assertResolvedInput } from './input-evidence.js';

/** All template, imported and edited models enter the same V2 validator. */
export async function normalizeEngineeringModel(model: ModelRecord, client: LocalStructureProtocolClient, sourceFormat = 'structuremodel-v2'): Promise<ModelRecord> {
  assertResolvedInput(isRecord(model.metadata) ? model.metadata.inputEvidence : undefined);
  const response = await client.post('/convert', {
    model, source_format: sourceFormat, target_format: 'structuremodel-v2', target_schema_version: '2.2.0',
  });
  if (!isRecord(response.data) || !isRecord(response.data.model)) throw new Error('MODEL_CONVERSION_FAILED');
  const normalized = structuredClone(response.data.model);
  for (const loadCase of (normalized.load_cases ?? []) as ModelRecord[]) {
    const loads = (loadCase.loads ?? []) as ModelRecord[];
    const used = new Set(loads.map((load) => load.id).filter(Boolean));
    for (let i = 0; i < loads.length; i++) {
      if (loads[i]!.id) continue;
      let id = `${String(loadCase.id)}:load:${i + 1}`;
      while (used.has(id)) id += '_';
      loads[i]!.id = id;
      used.add(id);
    }
  }
  validateModelReferences(normalized);
  return normalized;
}
