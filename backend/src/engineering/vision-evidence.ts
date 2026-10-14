import { z } from 'zod';
import { contentHash, isRecord, type ModelRecord } from './model-state.js';
import { mergeInputEvidence } from './input-evidence.js';

export const imageRegionSchema = z.tuple([z.number().min(0).max(1), z.number().min(0).max(1),
  z.number().positive().max(1), z.number().positive().max(1)])
  .refine(([x, y, width, height]) => x + width <= 1 && y + height <= 1, 'Region exceeds image / 区域超出图像');
export type ImageRegion = z.infer<typeof imageRegionSchema>;
const category = z.enum(['geometry', 'connectivity', 'supports', 'loads', 'materials', 'sections']);
export const visionRequestSchema = z.object({ region: imageRegionSchema.optional(),
  requiredFields: z.array(z.string().min(1)).optional() });
export type VisionRequest = z.infer<typeof visionRequestSchema>;

const observationSchema = z.object({ field: z.string().min(1), category,
  status: z.enum(['observed', 'missing', 'ambiguous']), value: z.unknown().optional(), unit: z.string().optional(),
  required: z.boolean(), region: imageRegionSchema.optional(), evidenceText: z.string() });
const visionSchema = z.object({ summary: z.string(), fields: z.array(observationSchema),
  coverage: z.record(category, z.enum(['observed','missing','ambiguous','not_applicable'])) });

/** Recognition candidates carry evidence; no candidate edits a physical model itself. */
export function parseVisionEvidence(text: string, source: ModelRecord, request: VisionRequest = {}) {
  const parsed = visionSchema.parse(JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')));
  const fields: ModelRecord[] = parsed.fields.map(field => {
    if (field.status === 'observed' && (field.value === undefined || !field.region)) throw new Error('VISION_OBSERVATION_VALUE_AND_REGION_REQUIRED');
    const crop = request.region ?? [0, 0, 1, 1];
    const region = field.region ? [crop[0] + field.region[0]*crop[2], crop[1] + field.region[1]*crop[3],
      field.region[2]*crop[2], field.region[3]*crop[3]] : undefined;
    const explicitlyRequired = request.requiredFields?.some(name => field.field === name || field.field.startsWith(`${name}.`));
    const evidence = { field: field.field, category: field.category, value: field.value, unit: field.unit, status: field.status,
      required: explicitlyRequired || field.required, reason: field.evidenceText, source: { ...source, region, coordinateFrame: 'image-normalized-xywh' } };
    return { ...evidence, id: `vision:${contentHash(evidence)}` };
  });
  for (const field of request.requiredFields ?? []) {
    if (fields.some(item => item.field === field || String(item.field).startsWith(`${field}.`))) continue;
    const missing = { field, status: 'missing', required: true, reason: 'Required field has no localized observation / 必需字段没有可定位的识别证据', source };
    fields.push({ ...missing, id: `vision:${contentHash(missing)}` });
  }
  for (const [name, status] of Object.entries(parsed.coverage)) {
    const emptyObserved = status === 'observed' && !fields.some(item => item.category === name
      && item.status === 'observed' && isRecord(item.source) && Array.isArray(item.source.region));
    if ((!['missing', 'ambiguous'].includes(status) && !emptyObserved) || fields.some(item => item.required
      && item.status !== 'observed' && (item.category === name || String(item.field).startsWith(`${name}.`)))) continue;
    const missing = { field: `coverage.${name}`, category: name, status: emptyObserved ? 'missing' : status, required: true,
      reason: emptyObserved ? `Coverage has no localized fields: ${name} / 已声明识别该类信息，但没有可定位的字段`
        : `Incomplete visual coverage: ${name} / 图纸该类信息尚不完整`, source };
    fields.push({ ...missing, id: `vision:${contentHash(missing)}` });
  }
  return { summary: parsed.summary, coverage: parsed.coverage, inputEvidence: fields,
    interpretationStatus: fields.some(f => f.required && f.status !== 'observed') ? 'needs_review' : 'candidate' };
}

export function collectVisionEvidence(analysis: unknown): ModelRecord[] {
  if (!isRecord(analysis)) return [];
  let own = Array.isArray(analysis.inputEvidence) ? analysis.inputEvidence.filter(isRecord) : [];
  if (typeof analysis.visionSummary === 'string') {
    try { own = mergeInputEvidence(own, collectVisionEvidence(JSON.parse(analysis.visionSummary))) ?? []; } catch { /* Legacy text has no structured observations. */ }
  }
  const pages = Array.isArray(analysis.pages) ? analysis.pages.flatMap(collectVisionEvidence) : [];
  return mergeInputEvidence(own, pages) ?? [];
}
