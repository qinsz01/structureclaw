import type { AppLocale } from '../../../shared/locale.js';
import type { DraftState } from '../../../shared/types/agent.js';
import {
  assertCanonicalCoordinateModel,
  buildStructuralCoordinateSystem,
  STRUCTURAL_COORDINATE_CONTRACT_VERSION,
  STRUCTURAL_COORDINATE_SEMANTICS,
} from '../../../agent-runtime/coordinate-semantics.js';
import { logger } from '../../../utils/logger.js';
import { llmContentText } from '../../../utils/llm-content.js';
import type { StructureClawChatModel } from '../../../utils/llm.js';
import { buildGenericModelPrompt, buildRetrySuffix } from './llm-model-prompt.js';
import { validateExplicitModel } from '../../../agent-runtime/explicit-model.js';
import { canRecover, requestRecovery } from '../../../runtime/run-context.js';
import { applyDraftAnalysisControl, applyDraftTemplateDesign, projectDraftMaterialDesign } from '../../../agent-runtime/engineering-draft.js';
import { completeReviewedSectionRecord, reviewedSectionName, reviewedSectionNames } from '../../../engineering/section-tables.js';

export class ModelInputRequiredError extends Error {
  constructor(readonly missingFields: Array<string | { field: string; reason?: string }>) {
    super(`MODEL_INPUT_REQUIRED: ${JSON.stringify(missingFields)}`);
    this.name = 'ModelInputRequiredError';
  }
}

export async function tryBuildGenericModelWithLlm(
  llm: StructureClawChatModel | null,
  message: string,
  state: DraftState,
  locale: AppLocale,
  conversationHistory?: string,
  signal?: AbortSignal,
  currentModel?: Record<string, unknown>,
  validateCandidate?: (candidate: Record<string, unknown>) => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown> | undefined> {
  if (!llm) {
    return undefined;
  }

  const basePrompt = buildGenericModelPrompt(message, state, locale, conversationHistory, currentModel);
  let failure: { error: string; candidate: string } | undefined;
  const stateHint = JSON.stringify(state);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) {
      if (!canRecover()) break;
      requestRecovery('generic model: invalid candidate');
    }
    const prompt = failure ? basePrompt + buildRetrySuffix(locale, failure.error, failure.candidate) : basePrompt;
    const startedAt = Date.now();
    logger.info({
      attempt: attempt + 1,
      locale,
      promptChars: prompt.length,
      stateHintChars: stateHint.length,
      messagePreview: message.slice(0, 160),
    }, 'generic llm model attempt started');

    // Provider/transport failures propagate; only invalid candidates below may be corrected.
    const aiMessage = await llm.invoke(prompt, { signal });
    const content = llmContentText(aiMessage.content);
    try {
      const parsed = parseJsonObject(content);
      if (!parsed) {
        logger.warn({
          attempt: attempt + 1,
          durationMs: Date.now() - startedAt,
          responseChars: content.length,
          responsePreview: content.slice(0, 200),
        }, 'generic llm model returned non-json content');
        throw new Error('MODEL_JSON_REQUIRED: response must be a JSON object / 必须输出JSON对象');
      }

      if (Array.isArray(parsed.missing_fields) && parsed.missing_fields.length
        && parsed.missing_fields.every(field => typeof field === 'string' && field.trim()
          || field && typeof field === 'object' && typeof field.field === 'string' && field.field.trim())) {
        throw new ModelInputRequiredError(parsed.missing_fields);
      }

      if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.elements) || !Array.isArray(parsed.load_cases)) {
        logger.warn({
          attempt: attempt + 1,
          durationMs: Date.now() - startedAt,
          hasNodes: Array.isArray(parsed.nodes),
          hasElements: Array.isArray(parsed.elements),
          hasLoadCases: Array.isArray(parsed.load_cases),
        }, 'generic llm model returned json without required structural arrays');
        throw new Error('MODEL_ARRAYS_REQUIRED: nodes, elements and load_cases must be arrays / 节点、构件和工况必须为数组');
      }

      canonicalizeGenericModel(parsed);
      if (!currentModel) projectConfirmedGeometricSections(parsed, state);
      const dimension = stampCanonicalMetadata(parsed, state);
      const controlled = applyDraftAnalysisControl(parsed, state.engineeringDraft);
      const candidate = currentModel ? controlled
        : projectDraftMaterialDesign(applyDraftTemplateDesign(controlled, state.engineeringDraft), state.engineeringDraft);
      assertCanonicalCoordinateModel(candidate, dimension);
      validateExplicitModel(candidate);
      const validated = validateCandidate ? await validateCandidate(candidate) : candidate;

      logger.info({
        attempt: attempt + 1,
        durationMs: Date.now() - startedAt,
        nodeCount: parsed.nodes.length,
        elementCount: parsed.elements.length,
        loadCaseCount: parsed.load_cases.length,
      }, 'generic llm model attempt succeeded');

      return validated;
    } catch (error) {
      logger.warn({
        attempt: attempt + 1,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      }, 'generic llm model attempt failed with upstream error');
      if (error instanceof ModelInputRequiredError || error instanceof Error && /BUDGET_EXHAUSTED/.test(error.message)) throw error;
      failure = { error: error instanceof Error ? error.message : String(error), candidate: content };
      continue;
    }
  }

  logger.warn({
    locale,
    promptChars: basePrompt.length,
    messagePreview: message.slice(0, 160),
  }, 'generic llm model exhausted all attempts without a valid model');

  throw new Error(`LLM_MODEL_VALIDATION_FAILED: ${failure?.error ?? 'No valid model / 无有效模型'}`);
}

/** Topology generation must not replace confirmed geometry or reviewed catalog data with LLM arithmetic.
 * Explicit user properties remain on the source record and still undergo physics validation.
 */
export function projectConfirmedGeometricSections(model: Record<string, unknown>, state: DraftState): void {
  if (!Array.isArray(model.sections)) return;
  const generated = model.sections;
  const draft = state.engineeringDraft;
  let sources = draft?.sectionRecords ?? [];
  if (!sources.length) {
    const declarations = [...new Set(Object.values(draft?.sections ?? {}).filter(value => typeof value === 'string'))];
    const declaredCatalog = declarations.filter(value => reviewedSectionName(value));
    sources = generated.flatMap(value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
      const target = value as Record<string, unknown>;
      const assigned = (['beam', 'column', 'member'] as const).flatMap(role =>
        (draft?.templateAssignments?.[role] ?? draft?.templateAssignments?.member)?.sectionId === target.id
          ? [draft?.sections?.[role] ?? draft?.sections?.member] : []).find(name => reviewedSectionName(name));
      const name = assigned ?? (generated.length === 1 && declarations.length === 1 ? declaredCatalog[0] : undefined);
      return name && typeof target.id === 'string' ? [{ id: target.id, name, type: 'custom' }] : [];
    });
    if (declaredCatalog.length && !sources.length) throw new Error('REVIEWED_SECTION_ASSIGNMENT_REQUIRED: associate the confirmed catalog section with a stable section ID / 请明确目录截面与模型截面ID的对应关系');
  }
  if (!sources.length) return;
  model.sections = generated.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const section = value as Record<string, unknown>;
    const source = sources.find(item => item.id === section.id)
      ?? (sources.length === 1 && generated.length === 1 ? sources[0] : undefined);
    if (!source) return value;
    const catalog = completeReviewedSectionRecord(source, reviewedSectionNames(source, state.engineeringDraft));
    const confirmed = catalog ?? source;
    const hasShape = !!source.shape && typeof source.shape === 'object' && !Array.isArray(source.shape);
    const sourceExtra = source.extra && typeof source.extra === 'object' && !Array.isArray(source.extra)
      ? source.extra as Record<string, unknown> : {};
    const hasCatalog = !!catalog || !!sourceExtra.catalogSource;
    const hasProperties = !!source.properties && typeof source.properties === 'object'
      && !Array.isArray(source.properties) && Object.keys(source.properties).length > 0;
    // An unknown or explicitly custom numeric source stays explicit/incomplete;
    // topology generation cannot fill its missing mechanics from memory.
    if (!hasShape && !hasCatalog && !hasProperties) return value;
    return { ...structuredClone(confirmed), id: section.id, name: confirmed.name ?? section.name ?? section.id, type: confirmed.type ?? section.type };
  });
}

function canonicalizeGenericModel(model: Record<string, unknown>): void {
  model.schema_version = '2.2.0';
  model.unit_system = 'SI';
  if (!Array.isArray(model.load_cases)) {
    return;
  }
  model.load_cases = model.load_cases.map((loadCase) => {
    if (!loadCase || typeof loadCase !== 'object' || Array.isArray(loadCase)) {
      return loadCase;
    }
    const record = loadCase as Record<string, unknown>;
    return {
      ...record,
      loads: Array.isArray(record.loads)
        ? record.loads.map((load) => normalizeLoadRecord(load))
        : [],
    };
  });
}

function normalizeLoadRecord(load: unknown): unknown {
  if (!load || typeof load !== 'object' || Array.isArray(load)) {
    return load;
  }

  const record = { ...(load as Record<string, unknown>) };
  if (record.type === 'nodal_force') {
    record.type = 'nodal';
  } else if (record.type === 'line_load' || record.type === 'element_uniform_load' || record.type === 'uniform_load') {
    record.type = 'distributed';
  }

  const unit = firstString(record.unit, record.forceUnit, record.force_unit, record.units);
  if (unit && isNewtonUnit(unit)) {
    const scale = 1 / 1000;
    const numericFields = isDistributedLoad(record)
      ? ['wx', 'wy', 'wz', 'qx', 'qy', 'qz', 'w', 'q', 'value', 'magnitude']
      : ['fx', 'fy', 'fz', 'px', 'py', 'pz', 'mx', 'my', 'mz', 'value', 'magnitude'];
    for (const field of numericFields) {
      if (record[field] === undefined) continue;
      record[field] = scaleNumber(record[field], scale);
    }
    if (Array.isArray(record.forces)) {
      record.forces = record.forces.map((value) => scaleNumber(value, scale));
    }
    record.unit = canonicalNewtonUnit(unit);
  }
  delete record.forceUnit;
  delete record.force_unit;
  delete record.units;
  if (record.reference_frame === undefined) {
    record.reference_frame = 'global';
  }

  return record;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function isNewtonUnit(unit: string): boolean {
  const normalized = unit.trim().toLowerCase().replace(/\s+/g, '');
  return normalized === 'n' || normalized === 'n/m' || normalized === 'npermeter';
}

function canonicalNewtonUnit(unit: string): 'kN' | 'kN/m' {
  const normalized = unit.trim().toLowerCase().replace(/\s+/g, '');
  return normalized === 'n/m' || normalized === 'npermeter' ? 'kN/m' : 'kN';
}

function isDistributedLoad(load: Record<string, unknown>): boolean {
  if (load.type === 'point') return false;
  return load.type === 'distributed' || load.element !== undefined || load.elementId !== undefined || load.element_id !== undefined;
}

function scaleNumber(value: unknown, scale: number): unknown {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value * scale;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') {
      return value;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed * scale : value;
  }
  return value;
}

function parseJsonObject(content: string): Record<string, unknown> | null {
  const trimmed = content.trim();
  const direct = tryParseJson(trimmed);
  if (direct) {
    return direct;
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    return tryParseJson(fenced[1]);
  }

  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) {
    return tryParseJson(trimmed.slice(first, last + 1));
  }
  return null;
}

function tryParseJson(content: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function stampCanonicalMetadata(model: Record<string, unknown>, state: DraftState): '2d' | '3d' {
  const nextMetadata = (
    model.metadata && typeof model.metadata === 'object' && !Array.isArray(model.metadata)
      ? { ...(model.metadata as Record<string, unknown>) }
      : {}
  );

  nextMetadata.coordinateSemantics = STRUCTURAL_COORDINATE_SEMANTICS;
  nextMetadata.coordinateContractVersion = STRUCTURAL_COORDINATE_CONTRACT_VERSION;
  const declaredCoordinateSystem = (
    model.coordinate_system && typeof model.coordinate_system === 'object' && !Array.isArray(model.coordinate_system)
      ? model.coordinate_system as Record<string, unknown>
      : {}
  );
  const declaredDimension = declaredCoordinateSystem.dimension;
  if (declaredDimension !== '2d' && declaredDimension !== '3d') {
    throw new Error('Generic V2 models must explicitly declare coordinate_system.dimension');
  }
  const expectedCoordinateSystem = buildStructuralCoordinateSystem(declaredDimension);
  if (
    declaredCoordinateSystem.semantics !== expectedCoordinateSystem.semantics
    || declaredCoordinateSystem.version !== expectedCoordinateSystem.version
    || declaredCoordinateSystem.plane !== expectedCoordinateSystem.plane
    || !Array.isArray(declaredCoordinateSystem.dof_order)
    || declaredCoordinateSystem.dof_order.length !== expectedCoordinateSystem.dof_order.length
    || declaredCoordinateSystem.dof_order.some(
      (value, index) => value !== expectedCoordinateSystem.dof_order[index]
    )
  ) {
    throw new Error('Generic V2 models must provide the complete canonical coordinate_system contract');
  }
  if (state.frameDimension && state.frameDimension !== declaredDimension) {
    throw new Error('Generic V2 coordinate_system.dimension conflicts with the confirmed frameDimension');
  }
  const dimension = declaredDimension;
  nextMetadata.frameDimension = dimension;
  if (
    (typeof nextMetadata.inferredType !== 'string' || nextMetadata.inferredType.trim().length === 0)
    && typeof state.inferredType === 'string'
    && state.inferredType !== 'unknown'
  ) {
    nextMetadata.inferredType = state.inferredType;
  }
  if (typeof nextMetadata.source !== 'string' || nextMetadata.source.trim().length === 0) {
    nextMetadata.source = 'generic-llm-draft';
  }

  model.coordinate_system = buildStructuralCoordinateSystem(dimension);
  model.metadata = nextMetadata;
  return dimension;
}

