import { z } from 'zod';
import { resultSelectionSchema } from './result-selection.js';

/** Delivery requirements are separate from the writable physical model. */
export const requestScopeSchema = z.object({
  responses: z.array(z.enum(['forces', 'reactions', 'displacements', 'rotations', 'stress', 'dynamic'])).min(1),
  method: z.enum(['solver', 'equilibrium']).default('solver'),
  design: z.boolean().default(false),
  report: z.boolean().optional().describe('true when the user asks for a report/calculation book or a full design/analysis deliverable ("design a beam", "analyse and report"); false for a narrow request for specific results (forces, reactions, displacement only) or when the user declines one. Omitted: forces/reactions-only requests get no report, other requests get one. / 用户要求报告/计算书或完整设计/分析交付（“设计一个…”“分析并出报告”）时为true；只求内力、反力、位移等具体结果或明确不要报告时为false。省略时仅求内力反力不出报告，其余出报告。'),
  outputs: z.array(resultSelectionSchema.omit({ runId: true }).extend({
    field: resultSelectionSchema.shape.field.unwrap(), component: resultSelectionSchema.shape.component.unwrap(), unit: resultSelectionSchema.shape.unit.unwrap(),
  })).default([]).describe('Exact scalar queries after real object IDs are known. Before building leave outputs empty; never invent IDs. resultKey is a saved case:<ID>/combination:<ID>, not an output label. / 获得实际对象ID后填写标量查询；建模前留空，不编造ID。resultKey是工况/组合键，不是输出名称。'),
}).strict();
export type RequestScope = z.infer<typeof requestScopeSchema>;
export type ScopeDiagnostic = { field: string; code: string };

/** Extraction reads the entire user request; a tool's partial plan must not omit a response family. */
export function resolveExtractedScope(declared: RequestScope | undefined, extracted: unknown, previous?: RequestScope | null,
  diagnostics: ScopeDiagnostic[] = []): RequestScope | undefined {
  if (extracted === undefined || extracted === null) return declared ?? previous ?? undefined;
  const fields: Record<string, unknown> = {};
  if (typeof extracted === 'object' && !Array.isArray(extracted)) {
    const raw = extracted as Record<string, unknown>;
    // Internal extraction is a patch, never a replacement for the validated tool request.
    // Validate supplied fields independently; empty/invalid responses cannot erase a known goal.
    for (const key of ['responses', 'method', 'design', 'report'] as const) {
      if (raw[key] === undefined) continue;
      const parsed = requestScopeSchema.shape[key].safeParse(raw[key]);
      if (parsed.success) fields[key] = parsed.data;
      else diagnostics.push({ field: `requestScope.${key}`, code: 'EXTRACTED_SCOPE_FIELD_IGNORED' });
    }
    for (const key of Object.keys(raw)) {
      if (!['responses', 'method', 'design', 'report', 'outputs'].includes(key)) {
        diagnostics.push({ field: `requestScope.${key}`, code: 'EXTRACTED_SCOPE_FIELD_UNKNOWN' });
      }
    }
  } else {
    diagnostics.push({ field: 'requestScope', code: 'EXTRACTED_SCOPE_OBJECT_REQUIRED' });
  }
  // Only grounded public-tool selectors may be executed. New extracted response
  // families have no object IDs yet and cannot supply scalar output labels.
  const candidate = requestScopeSchema.safeParse(declared ?? { ...previous, ...fields, ...(fields.responses ? { outputs: [] } : {}) });
  if (!candidate.success) {
    diagnostics.push({ field: 'requestScope.responses', code: 'REQUEST_GOAL_REQUIRED' });
    return undefined;
  }
  const goal = candidate.data;
  const responses = [...new Set([...goal.responses, ...(fields.responses as RequestScope['responses'] | undefined ?? [])])];
  return requestScopeSchema.parse({ ...goal, responses,
    method: responses.some(field => !['forces', 'reactions'].includes(field)) ? 'solver' : goal.method });
}

export function forceOnlyScope(scope: RequestScope | null | undefined): boolean {
  return !!scope && !scope.design && scope.responses.every(field => field === 'forces' || field === 'reactions');
}

/** A report is a deliverable only when requested; an omitted flag means none for a forces/reactions-only request. */
export function reportRequested(scope: RequestScope | null | undefined): boolean {
  if (!scope) return true;
  return scope.report ?? !forceOnlyScope(scope);
}

export function missingInputReason(field: string, scope?: RequestScope | null, locale: 'zh' | 'en' = 'en'): string {
  const zh = locale === 'zh';
  if (/rho|density|mass/i.test(field)) return zh
    ? '该量用于自重或质量；请核对本次自重/动力设置，而不是设计强度。'
    : 'This quantity supplies self-weight or mass; check the requested self-weight/dynamic settings, not design strength.';
  if (/material|section|templateProperties|\bE\b|\bG\b/i.test(field)) return scope?.responses.some(r => ['displacements', 'rotations', 'dynamic'].includes(r))
    ? zh ? '所求位移、转角或动力响应需要对应材料与截面刚度；请提供缺失的分析属性。' : 'Requested displacement, rotation or dynamic response needs material/section stiffness; supply the missing analysis properties.'
    : zh ? '真实求解器建模或超静定内力分配需要分析属性；这些不是规范设计条件。' : 'Solver assembly or indeterminate force distribution needs analysis properties; these are not code-design conditions.';
  return zh ? '该字段决定几何、连接、边界、荷载或结果位置，会影响本次所求结果。'
    : 'This field determines geometry, connectivity, supports, loads or result location and affects the requested response.';
}
