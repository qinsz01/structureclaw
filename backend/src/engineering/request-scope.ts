import { z } from 'zod';
import { resultSelectionSchema } from './result-selection.js';

/** Delivery requirements are separate from the writable physical model. */
export const requestScopeSchema = z.object({
  responses: z.array(z.enum(['forces', 'reactions', 'displacements', 'rotations', 'stress', 'dynamic'])).min(1),
  method: z.enum(['solver', 'equilibrium']).default('solver'),
  design: z.boolean().default(false),
  report: z.boolean().default(false),
  outputs: z.array(resultSelectionSchema.omit({ runId: true }).extend({
    field: resultSelectionSchema.shape.field.unwrap(), component: resultSelectionSchema.shape.component.unwrap(), unit: resultSelectionSchema.shape.unit.unwrap(),
  })).default([]).describe('Exact scalar queries after real object IDs are known. Before building leave outputs empty; never invent IDs. resultKey is a saved case:<ID>/combination:<ID>, not an output label. / 获得实际对象ID后填写标量查询；建模前留空，不编造ID。resultKey是工况/组合键，不是输出名称。'),
}).strict();
export type RequestScope = z.infer<typeof requestScopeSchema>;

/** Extraction reads the entire user request; a tool's partial plan must not omit a response family. */
export function resolveExtractedScope(declared: RequestScope | undefined, extracted: unknown, previous?: RequestScope | null): RequestScope | undefined {
  let extractedGoal: RequestScope | undefined;
  if (extracted && typeof extracted === 'object' && !Array.isArray(extracted)) {
    // Object IDs are not grounded yet. Scalar selectors are supplied by tools after projection/build.
    extractedGoal = requestScopeSchema.parse({ ...extracted, outputs: [] });
  }
  const goal = declared ?? extractedGoal ?? previous;
  if (!goal) return undefined;
  const responses = [...new Set([...goal.responses, ...(extractedGoal?.responses ?? [])])];
  return requestScopeSchema.parse({ ...goal, responses,
    method: responses.some(field => !['forces', 'reactions'].includes(field)) ? 'solver' : goal.method });
}

export function forceOnlyScope(scope: RequestScope | null | undefined): boolean {
  return !!scope && !scope.design && scope.responses.every(field => field === 'forces' || field === 'reactions');
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
