import { isDeepStrictEqual } from 'node:util';
import { isRecord } from './model-record.js';

const DOFS = ['ux', 'uy', 'uz', 'rx', 'ry', 'rz'];
const MOMENT_ALIASES: Record<string, string> = { mx: 'rx', my: 'ry', mz: 'rz' };

export class MemberReleaseValidationError extends Error {
  readonly conflicting: boolean;
  constructor(readonly releaseField: string, readonly invalidField: string, reason: string) {
    super(`MODEL_EDIT_FIELD_INVALID: ${invalidField}: ${reason}. Use boolean local DOFs ux/uy/uz/rx/ry/rz under i/j; resolve conflicting definitions explicitly. / 构件端释放字段无效；请使用局部自由度布尔值，冲突定义必须明确解决。`);
    this.name = 'MemberReleaseValidationError';
    this.conflicting = reason.startsWith('conflicting');
  }
}

/** Normalize technical aliases without choosing between conflicting engineering inputs. */
export function normalizeMemberReleases(value: unknown, field: string): Record<string, unknown> {
  const fail = (suffix: string, reason: string): never => { throw new MemberReleaseValidationError(field, field + suffix, reason); };
  if (!isRecord(value)) return fail('', 'expected an end-release object');
  for (const key of Object.keys(value)) {
    if (!['i', 'j', 'releaseI', 'releaseJ', 'reference_frame'].includes(key)) fail(`[${JSON.stringify(key)}]`, 'unknown release field');
  }
  if (value.reference_frame !== undefined && value.reference_frame !== 'element-local') fail('.reference_frame', 'only element-local release axes are supported');
  const flags = (raw: unknown, end: string) => {
    if (!isRecord(raw)) return fail(`.${end}`, 'expected explicit boolean DOFs');
    const normalized: Record<string, boolean> = {};
    for (const [key, enabled] of Object.entries(raw)) {
      const dof = Object.hasOwn(MOMENT_ALIASES, key) ? MOMENT_ALIASES[key]! : key;
      if (!DOFS.includes(dof)) fail(`.${end}[${JSON.stringify(key)}]`, 'unknown release DOF');
      if (typeof enabled !== 'boolean') fail(`.${end}[${JSON.stringify(key)}]`, 'release flags must be booleans');
      if (Object.hasOwn(normalized, dof) && normalized[dof] !== enabled) fail(`.${end}[${JSON.stringify(key)}]`, 'conflicting moment/rotation aliases');
      normalized[dof] = enabled as boolean;
    }
    return Object.fromEntries(DOFS.filter(dof => Object.hasOwn(normalized, dof)).map(dof => [dof, normalized[dof]]));
  };
  const normalized: Record<string, unknown> = {};
  for (const [end, alias] of [['i', 'releaseI'], ['j', 'releaseJ']] as const) {
    const canonical = value[end] === undefined ? undefined : flags(value[end], end);
    const alternative = value[alias] === undefined ? undefined : flags(value[alias], alias);
    if (canonical && alternative && !isDeepStrictEqual(canonical, alternative)) fail(`.${end}`, 'conflicting end aliases');
    if (canonical || alternative) normalized[end] = canonical ?? alternative;
  }
  if (value.reference_frame !== undefined) normalized.reference_frame = value.reference_frame;
  return normalized;
}
