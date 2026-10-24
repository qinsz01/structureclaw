import { EngineeringValidationError } from '../../engineering/validation-error.js';

/** Group compiled records by their source identity, never by name or magnitude. */
export function compileTemplateLoadCases<T>(sources: readonly T[], declarations: Array<Record<string, unknown>> | undefined,
  compile: (source: T) => Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const cases = new Map<string, Record<string, unknown>>();
  for (const declaration of declarations ?? []) {
    if (typeof declaration.id !== 'string' || !declaration.id.trim()
      || declaration.loads !== undefined && (!Array.isArray(declaration.loads) || declaration.loads.length)) {
      throw new EngineeringValidationError('DRAFT_LOAD_REPRESENTATION_CONFLICT: source compilation accepts case declarations with empty loads only / 源荷载编译只接受施加荷载为空的工况声明');
    }
    if (cases.has(declaration.id)) throw new EngineeringValidationError('DRAFT_LOAD_CASE_ID_DUPLICATE / 工况编号重复');
    cases.set(declaration.id, { ...structuredClone(declaration), loads: [] });
  }
  const knownIds = new Set([...cases.keys(), ...sources.flatMap(source => {
    const id = (source as { caseId?: unknown }).caseId;
    return typeof id === 'string' && id.trim() ? [id] : [];
  })]);
  const implicitId = knownIds.size === 1 ? [...knownIds][0] : knownIds.size === 0 ? 'LC1' : undefined;
  for (const source of sources) {
    const identity = source as { caseId?: string; caseType?: string };
    const id = identity.caseId ?? implicitId;
    if (!id) throw new EngineeringValidationError('LOAD_MAPPING_CASE_REQUIRED: source load needs an explicit case among multiple declarations / 存在多个工况时必须明确每条源荷载所属工况');
    let loadCase = cases.get(id);
    if (!loadCase) {
      loadCase = { id, type: identity.caseType ?? 'other', loads: [] };
      cases.set(id, loadCase);
    } else if (identity.caseType && loadCase.type && loadCase.type !== 'other' && loadCase.type !== identity.caseType && identity.caseType !== 'other') {
      throw new EngineeringValidationError(`DRAFT_LOAD_CASE_TYPE_CONFLICT: ${id} / 工况类别冲突`);
    } else if (identity.caseType && (!loadCase.type || loadCase.type === 'other')) loadCase.type = identity.caseType;
    (loadCase.loads as Array<Record<string, unknown>>).push(...compile(source));
  }
  return [...cases.values()];
}
