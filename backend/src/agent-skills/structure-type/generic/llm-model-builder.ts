import type { AppLocale } from '../../../shared/locale.js';
import type { DraftState } from '../../../shared/types/agent.js';
import {
  assertCanonicalCoordinateModel,
  buildStructuralCoordinateSystem,
  STRUCTURAL_COORDINATE_CONTRACT_VERSION,
  STRUCTURAL_COORDINATE_SEMANTICS,
} from '../../../engineering/coordinate-semantics.js';
import { logger } from '../../../utils/logger.js';
import { llmContentText } from '../../../utils/llm-content.js';
import type { StructureClawChatModel } from '../../../utils/llm.js';
import { buildGenericModelPrompt, buildRetrySuffix } from './llm-model-prompt.js';
import { validateExplicitModel } from '../../../agent-runtime/explicit-model.js';
import { canRecover, currentRunPolicy, requestRecovery } from '../../../runtime/run-context.js';
import { applyDraftAnalysisControl, applyDraftTemplateDesign, projectDraftMaterialDesign, normalizeDraftTopologyReleases } from '../../../agent-runtime/engineering-draft.js';
import { completeGenericModelProperties } from '../../../agent-runtime/template-properties.js';
import { ModelPhysicsError } from '../../../engineering/model-physics.js';
import { checkModelPhysicsWithAreaLoads, compileDeclaredModelLoads } from '../../../engineering/model-area-loads.js';
import { expandModellingOperations, assertUserTopologyIds } from '../../../skill-shared/modelling/operations.js';
import { ModellingOperationError } from '../../../skill-shared/modelling/contract.js';
import { isRecord } from '../../../engineering/model-state.js';
import { normalizeMemberReleases } from '../../../engineering/member-releases.js';

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
    throw new Error('LLM_MODEL_BUILDER_REQUIRED: Model generation requires a configured LLM; no template or rule fallback is available. / 模型生成需要已配置的 LLM；不会回退到模板或规则。');
  }

  signal?.throwIfAborted();
  if (state.engineeringDraft) state = { ...state, engineeringDraft: { ...state.engineeringDraft,
    topology: normalizeDraftTopologyReleases(state.engineeringDraft.topology) } };

  const basePrompt = buildGenericModelPrompt(message, state, locale, conversationHistory, currentModel);
  let failure: { error: string; candidate: string } | undefined;
  let lastError: unknown;
  const stateHint = JSON.stringify(state);

  const policy = currentRunPolicy();
  const repairs = policy ? policy.repair.enabled ? policy.repair.maxRecoveriesPerTurn : 0 : 2;
  for (let attempt = 0; attempt <= repairs; attempt += 1) {
    signal?.throwIfAborted();
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

    // Transport failures terminate this semantic operation; only invalid candidates below may be corrected.
    const aiMessage = await llm.invoke(prompt, { signal }).catch((cause: unknown) => {
      signal?.throwIfAborted();
      throw new Error('LLM_MODEL_BUILDER_INFRASTRUCTURE_ERROR: The model provider failed; model generation stopped. / 模型服务调用失败，已停止建模。', { cause });
    });
    const content = llmContentText(aiMessage.content);
    try {
      let parsed = parseJsonObject(content);
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

      parsed = await expandModellingOperations(parsed, currentModel ?? {
        nodes: state.engineeringDraft?.topology?.nodes ?? [], elements: state.engineeringDraft?.topology?.members ?? [],
        materials: state.engineeringDraft?.materials ?? [], sections: state.engineeringDraft?.sectionRecords ?? [],
      });
      if (isRecord(parsed.metadata) && parsed.metadata.compileDraftLoads === true) {
        if (currentModel) throw new Error('DRAFT_LOAD_COMPILATION_CONFLICT: compilation is for a new confirmed draft, not an existing model edit / 草稿编译不能重写已有模型荷载');
        parsed = await compileDeclaredModelLoads(parsed, state.engineeringDraft ?? {});
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
      if (!currentModel) {
        projectConfirmedGeometricSections(parsed, state);
        projectConfirmedAxialMembers(parsed, state);
        projectConfirmedConcreteGrades(parsed, state);
      }
      const dimension = stampCanonicalMetadata(parsed, state);
      const controlled = applyDraftAnalysisControl(parsed, state.engineeringDraft);
      const projected = currentModel ? controlled
        : projectDraftMaterialDesign(applyDraftTemplateDesign(controlled, state.engineeringDraft), state.engineeringDraft);
      const candidate = completeGenericModelProperties(projected, state);
      assertUserTopologyIds(candidate, state.engineeringDraft?.topology, !currentModel);
      const physics = await checkModelPhysicsWithAreaLoads(candidate, state.engineeringDraft);
      if (!physics.valid) throw new ModelPhysicsError(physics);
      assertCanonicalCoordinateModel(candidate, dimension);
      validateExplicitModel(candidate);
      const validated = validateCandidate ? await validateCandidate(candidate) : candidate;
      validated.metadata = { ...(validated.metadata as Record<string, unknown> ?? {}), physicsCheck: physics };

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
      lastError = error;
      continue;
    }
  }

  logger.warn({
    locale,
    promptChars: basePrompt.length,
    messagePreview: message.slice(0, 160),
  }, 'generic llm model exhausted all attempts without a valid model');

  if (lastError instanceof ModelPhysicsError || lastError instanceof ModellingOperationError) throw lastError;
  throw new Error(`LLM_MODEL_VALIDATION_FAILED: ${failure?.error ?? 'No valid model / 无有效模型'}`);
}

/** Compile explicit concrete/reinforcement grades onto their referenced concrete members. */
function projectConfirmedConcreteGrades(model: Record<string, unknown>, state: DraftState): void {
  const source = state.engineeringDraft?.material;
  if (source?.family !== 'concrete' || !Array.isArray(model.elements) || !Array.isArray(model.materials)) return;
  const concreteIds = new Set(model.materials.filter(isRecord).filter(material => material.family === 'concrete'
    || material.category === 'concrete' || source.grade && material.grade === source.grade).map(material => material.id));
  model.elements = model.elements.map(value => {
    if (!isRecord(value) || !concreteIds.has(value.material)) return value;
    const member = state.engineeringDraft?.topology?.members?.find(row => row.id === value.id);
    const concrete = typeof member?.concrete_grade === 'string' ? member.concrete_grade : source.grade;
    const rebar = typeof member?.rebar_grade === 'string' ? member.rebar_grade : source.rebarGrade;
    return { ...value, ...(concrete ? { concrete_grade: concrete } : {}), ...(rebar ? { rebar_grade: rebar } : {}) };
  });
}

function projectConfirmedAxialMembers(model: Record<string, unknown>, state: DraftState): void {
  if (!Array.isArray(model.elements)) return;
  model.elements = model.elements.map(value => {
    if (!isRecord(value)) return value;
    const source = state.engineeringDraft?.topology?.members?.find(member => member.id === value.id);
    if (!source || !['truss', 'brace'].includes(String(source.type)) || !['truss', 'brace'].includes(String(value.type))) return value;
    const noOffsets = (offsets: unknown) => offsets === undefined || isRecord(offsets) && !Object.keys(offsets).length;
    if (!noOffsets(source.offsets) || !noOffsets(value.offsets)) return value;
    // Both names use the same axial formulation. Retain authored metadata instead
    // of rejecting omitted, physically redundant rotational release flags.
    const member = { ...value, type: source.type };
    if (source.releases !== undefined && axialRotationReleases(source.releases) && axialRotationReleases(value.releases)) {
      return { ...member, releases: structuredClone(source.releases) };
    }
    return member;
  });
}

function axialRotationReleases(value: unknown): boolean {
  return value === undefined || isRecord(value) && Object.entries(value).every(([end, flags]) =>
    end === 'reference_frame' ? flags === 'element-local' : ['i', 'j', 'releaseI', 'releaseJ'].includes(end) && isRecord(flags) && Object.entries(flags).every(([dof, flag]) =>
      ['ux', 'uy', 'uz', 'rx', 'ry', 'rz'].includes(dof) && typeof flag === 'boolean' && (!flag || ['rx', 'ry', 'rz'].includes(dof))));
}

/** Topology generation must not replace confirmed section geometry with LLM arithmetic.
 * Explicit user properties remain on the source record and still undergo physics validation.
 */
function projectConfirmedGeometricSections(model: Record<string, unknown>, state: DraftState): void {
  if (!Array.isArray(model.sections)) return;
  const generated = model.sections;
  const sources = state.engineeringDraft?.sectionRecords ?? [];
  if (!sources.length) return;
  model.sections = generated.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const section = value as Record<string, unknown>;
    const source = sources.find(item => item.id === section.id)
      ?? (sources.length === 1 && generated.length === 1 ? sources[0] : undefined);
    if (!source) return value;
    const hasShape = !!source.shape && typeof source.shape === 'object' && !Array.isArray(source.shape);
    const hasProperties = !!source.properties && typeof source.properties === 'object'
      && !Array.isArray(source.properties) && Object.keys(source.properties).length > 0;
    // An unknown numeric source stays explicit/incomplete;
    // topology generation cannot fill its missing mechanics from memory.
    if (!hasShape && !hasProperties) return value;
    return { ...structuredClone(source), id: section.id, name: source.name ?? section.name ?? section.id, type: source.type ?? section.type };
  });
}

function canonicalizeGenericModel(model: Record<string, unknown>): void {
  model.schema_version = '2.2.0';
  model.unit_system = 'SI';
  if (Array.isArray(model.elements)) model.elements = model.elements.map(value => !isRecord(value) || value.releases === undefined ? value
    : { ...value, releases: normalizeMemberReleases(value.releases, `model.elements[${JSON.stringify(String(value.id ?? '?'))}].releases`, value.type) });
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

