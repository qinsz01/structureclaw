import { EngineeringValidationError } from '../engineering/validation-error.js';
import { assertDraftSectionPurposes } from '../engineering/draft-sections.js';
import { normalizeMaterialDensity } from '../engineering/material-density.js';
import { modelSelectorSchema, floorTransferSchema, isGlobalFrameNodeRole, frameNodeRoleSchema } from '../engineering/model-selection.js';
import { mergeInputEvidence } from '../engineering/input-evidence.js';
import { isDeepStrictEqual } from 'node:util';
import { normalizeMemberReleases } from '../engineering/member-releases.js';
import type {
  AgentAnalysisType,
  EngineeringDraft,
  EngineeringDraftTemplateAssignment,
  EngineeringDraftLoad,
  EngineeringDraftLoadCaseType,
  EngineeringDraftLoadCombination,
  EngineeringDraftLoadDirection,
  EngineeringDraftLoadKind,
  EngineeringDraftLoadUnit,
  EngineeringDraftTopology,
  EngineeringDraftTopologyMember,
  EngineeringDraftTopologyNode,
  DraftWindParams,
  MaterialFamily,
} from '../shared/types/agent.js';
import {
  asRecord,
  finiteNumber,
  firstPositiveNumber,
  isLineLoad,
  isPointLikeLoad,
  nonNegativeNumberArray,
  normalizeFrameBaseSupportType,
  normalizeString,
  normalizeSupportType,
  normalizeWindTerrainRoughness,
  positiveInteger,
  positiveNumber,
  positiveNumberArray,
} from './draft/normalize.js';

function normalizeTopologyNode(value: unknown): EngineeringDraftTopologyNode | undefined {
  const raw = asRecord(value);
  if (!raw) return undefined;
  const id = normalizeString(raw.id);
  const x = finiteNumber(raw.x);
  const y = finiteNumber(raw.y);
  const z = finiteNumber(raw.z);
  if (!id || x === undefined || y === undefined || z === undefined) return undefined;
  const restraints = Array.isArray(raw.restraints)
    && raw.restraints.length === 6
    && raw.restraints.every((item) => typeof item === 'boolean')
    ? [...raw.restraints] as boolean[]
    : undefined;
  if (raw.restraints != null && !restraints) {
    throw new EngineeringValidationError(`INVALID_EXPLICIT_TOPOLOGY: node '${id}' needs six boolean restraints / 节点约束必须为六个布尔值`);
  }
  return { ...structuredClone(raw), id, x, y, z, restraints };
}

function normalizeMemberRecordReleases(raw: Record<string, unknown>): Record<string, unknown> {
  if (raw.releases === null) {
    const { releases: _absent, ...record } = raw;
    return record;
  }
  return raw.releases === undefined ? raw : { ...raw, releases: normalizeMemberReleases(raw.releases,
    `engineeringDraft.topology.members[${JSON.stringify(String(raw.id ?? '?'))}].releases`, raw.type) };
}

/** Stored draft metadata uses the same boundary as newly extracted definitions. */
export function normalizeDraftTopologyReleases(topology: EngineeringDraftTopology | undefined): EngineeringDraftTopology | undefined {
  return topology ? { ...topology, ...(topology.members ? {
    members: topology.members.map(member => normalizeMemberRecordReleases(member) as EngineeringDraftTopologyMember),
  } : {}) } : undefined;
}

function normalizeTopologyMember(value: unknown): EngineeringDraftTopologyMember | undefined {
  const input = asRecord(value);
  const raw = input ? normalizeMemberRecordReleases(input) : undefined;
  if (!raw || !Array.isArray(raw.nodes) || raw.nodes.length !== 2) return undefined;
  const start = normalizeString(raw.nodes[0]);
  const end = normalizeString(raw.nodes[1]);
  if (!start || !end || start === end) return undefined;
  return {
    ...structuredClone(raw),
    id: normalizeString(raw.id),
    nodes: [start, end],
    ...(raw.type !== undefined && { type: raw.type as EngineeringDraftTopologyMember['type'] }),
    ...(raw.material !== undefined && { material: normalizeString(raw.material) }),
    ...(raw.section !== undefined && { section: normalizeString(raw.section) }),
    ...(raw.rotation_angle !== undefined && { rotation_angle: finiteNumber(raw.rotation_angle) }),
    ...(asRecord(raw.releases) && { releases: structuredClone(asRecord(raw.releases)!) }),
    ...(asRecord(raw.offsets) && { offsets: structuredClone(asRecord(raw.offsets)!) as Record<string, number> }),
  };
}

/** Validate partial records using their accepted fields, never guessed coordinates or load units. */
function hydrateDraftRecord(value: unknown, existing: Array<Record<string, unknown>> | undefined, member = false, load = false): unknown {
  const input = asRecord(value);
  if (!input || typeof input.id !== 'string') return value;
  const matches = existing?.filter(record => record.id === input.id) ?? [];
  if (matches.length > 1) throw new EngineeringValidationError(`AMBIGUOUS_DRAFT_RECORD_ID: ${input.id} / 无法唯一定位草稿对象`);
  // V2 permits null on a new/full record. It must never erase an existing release definition.
  if (member && input.releases === null && matches[0]?.releases != null) normalizeMemberReleases(null,
    `engineeringDraft.topology.members[${JSON.stringify(input.id)}].releases`, input.type);
  const patch = member ? normalizeMemberRecordReleases(input) : input;
  if (!matches.length) return patch;
  const previous = { ...(member ? normalizeMemberRecordReleases(matches[0]!) : matches[0]!) };
  // A newly supplied scope arm replaces the old target expression atomically.
  // Positions and storey scope remain confirmed; they are never discarded here.
  if (load && patch.selector !== undefined && patch.target === undefined) delete previous.target;
  if (load && patch.target !== undefined && patch.selector === undefined) delete previous.selector;
  if (load && normalizeString(patch.scopeDescription) && patch.target === undefined && patch.selector === undefined) {
    delete previous.target; delete previous.selector;
  }
  return mergeDraftRecord(previous, patch);
}

function normalizeEngineeringTopology(value: unknown, existing?: EngineeringDraftTopology): EngineeringDraftTopology | undefined {
  const raw = asRecord(value);
  if (!raw) return undefined;
  const nodes = Array.isArray(raw.nodes)
    ? raw.nodes.map(item => normalizeTopologyNode(hydrateDraftRecord(item, existing?.nodes))).filter((node): node is EngineeringDraftTopologyNode => node !== undefined)
    : undefined;
  const members = Array.isArray(raw.members)
    ? raw.members.map(item => normalizeTopologyMember(hydrateDraftRecord(item, existing?.members, true))).filter((member): member is EngineeringDraftTopologyMember => member !== undefined)
    : undefined;
  if ((Array.isArray(raw.nodes) && nodes?.length !== raw.nodes.length)
    || (Array.isArray(raw.members) && members?.length !== raw.members.length)) {
    throw new EngineeringValidationError('INVALID_EXPLICIT_TOPOLOGY: invalid nodes or member endpoints / 显式节点或构件端点无效，不能丢弃后继续建模');
  }
  if (nodes?.length && members?.length) {
    const available = new Set([...(existing?.nodes ?? []), ...nodes].map(node => node.id));
    const mergedMembers = new Map([...(existing?.members ?? []), ...members].map(member => [member.id, member]));
    const invalid = [...mergedMembers.values()].filter(member => member.nodes.some(id => !available.has(id)));
    if (invalid.length) throw new EngineeringValidationError(`INVALID_EXPLICIT_TOPOLOGY: members reference unknown nodes: ${JSON.stringify(invalid.map(member => ({ id: member.id, nodes: member.nodes })))}; available node IDs: ${JSON.stringify([...available])} / 构件引用不存在的节点，请修正拓扑，不得改变已确认几何`);
  }
  return nodes?.length || members?.length ? { nodes, members } : undefined;
}

function normalizeMaterialFamily(value: unknown): MaterialFamily | undefined {
  const raw = normalizeString(value)?.toLowerCase();
  if (!raw) return undefined;
  if (['steel', 'concrete', 'composite', 'timber', 'masonry', 'generic'].includes(raw)) {
    return raw as MaterialFamily;
  }
  return undefined;
}

function normalizeAnalysisType(value: unknown): AgentAnalysisType | undefined {
  if (value === undefined) return undefined;
  const raw = normalizeString(value);
  if (raw === 'static' || raw === 'dynamic' || raw === 'seismic' || raw === 'nonlinear') return raw;
  throw new EngineeringValidationError(`INVALID_ANALYSIS_TYPE: engineeringDraft.analysis.type=${JSON.stringify(value)}; expected static/dynamic/seismic/nonlinear / 分析类型无效，不得丢弃`);
}

function normalizeEngineTarget(value: unknown): 'opensees' | 'pkpm' | 'yjk' | undefined {
  if (value === undefined) return undefined;
  const raw = normalizeString(value)?.toLowerCase();
  if (raw === 'opensees' || raw === 'pkpm' || raw === 'yjk') return raw;
  throw new EngineeringValidationError(`INVALID_ANALYSIS_ENGINE: engineeringDraft.analysis.engineTarget=${JSON.stringify(value)}; expected opensees/pkpm/yjk / 分析引擎无效，不得丢弃`);
}

function normalizeWindParams(value: unknown): DraftWindParams | undefined {
  const raw = asRecord(value);
  if (!raw) return undefined;
  const wind: DraftWindParams = {
    ...(positiveNumber(raw.basicPressureKNM2 ?? raw.basic_pressure ?? raw.basicPressure ?? raw.windPressure) !== undefined && {
      basicPressureKNM2: positiveNumber(raw.basicPressureKNM2 ?? raw.basic_pressure ?? raw.basicPressure ?? raw.windPressure),
    }),
    ...(normalizeWindTerrainRoughness(raw.terrainRoughness ?? raw.terrain_roughness) !== undefined && {
      terrainRoughness: normalizeWindTerrainRoughness(raw.terrainRoughness ?? raw.terrain_roughness),
    }),
    ...(positiveNumber(raw.shapeFactor ?? raw.shape_factor) !== undefined && {
      shapeFactor: positiveNumber(raw.shapeFactor ?? raw.shape_factor),
    }),
    ...(positiveNumber(raw.heightVariationFactor ?? raw.height_variation_factor) !== undefined && {
      heightVariationFactor: positiveNumber(raw.heightVariationFactor ?? raw.height_variation_factor),
    }),
  };
  return Object.keys(wind).length ? wind : undefined;
}

function normalizeLoadKind(value: unknown): EngineeringDraftLoadKind | undefined {
  const raw = normalizeString(value)?.toLowerCase();
  if (!raw) return undefined;
  if (raw === 'point' || raw === 'nodal' || raw === 'area' || raw === 'distributed') {
    return raw;
  }
  if (raw === 'line' || raw === 'uniform' || raw === 'udl') {
    return 'line';
  }
  return undefined;
}

function normalizeLoadUnit(value: unknown, _kind: EngineeringDraftLoadKind): EngineeringDraftLoadUnit {
  const raw = normalizeString(value)?.toLowerCase().replace(/\s+/g, '');
  if (raw === 'kn/m2' || raw === 'kn/m^2' || raw === 'kn/㎡' || raw === 'kn/m²') {
    return 'kN/m2';
  }
  if (raw === 'kn/m') {
    return 'kN/m';
  }
  if (raw === 'kn') {
    return 'kN';
  }
  if (raw === 'n') return 'kN';
  if (raw === 'n/m') return 'kN/m';
  if (raw === 'n/m2' || raw === 'n/m^2' || raw === 'n/m²' || raw === 'kpa') return 'kN/m2';
  throw new EngineeringValidationError('LOAD_UNIT_REQUIRED: load units must be explicit and supported / 荷载单位必须明确且受支持');
}

function normalizeLoadDirection(value: unknown, path: string): EngineeringDraftLoadDirection | undefined {
  const raw = normalizeString(value)?.toLowerCase();
  if (!raw) return undefined;
  if (raw === 'gravity' || raw === 'vertical' || raw === 'downward') return 'gravity';
  if (raw === 'globalx' || raw === 'x' || raw === 'fx') return 'globalX';
  if (raw === 'globaly' || raw === 'y' || raw === 'fy') return 'globalY';
  if (raw === 'globalz' || raw === 'z' || raw === 'fz') return 'globalZ';
  throw new EngineeringValidationError(`LOAD_DIRECTION_INVALID: ${path}=${JSON.stringify(value)}; declare gravity or globalX/globalY/globalZ / 荷载方向不明确，请修正上述字段与值`);
}

function normalizeLoadCaseType(value: unknown): EngineeringDraftLoadCaseType | undefined {
  const raw = normalizeString(value)?.toLowerCase();
  if (!raw) return undefined;
  if (raw === 'dead' || raw === 'live' || raw === 'wind' || raw === 'seismic' || raw === 'other') {
    return raw;
  }
  return undefined;
}

function normalizeLoadLocation(value: unknown): EngineeringDraftLoad['location'] | undefined {
  const raw = asRecord(value);
  if (!raw) return undefined;
  const location = {
    xM: finiteNumber(raw.xM ?? raw.x ?? raw.positionM),
    spanIndex: positiveInteger(raw.spanIndex ?? raw.span),
    story: positiveInteger(raw.story ?? raw.storyIndex ?? raw.level),
    nodeRole: normalizeString(raw.nodeRole ?? raw.node),
  };
  return location.xM !== undefined
    || location.spanIndex !== undefined
    || location.story !== undefined
    || location.nodeRole !== undefined
    ? location
    : undefined;
}

function normalizeEngineeringLoad(value: unknown, path: string): EngineeringDraftLoad | undefined {
  const raw = asRecord(value);
  if (!raw) return undefined;
  const kind = normalizeLoadKind(raw.kind ?? raw.type ?? raw.loadType);
  const magnitude = finiteNumber(raw.magnitude ?? raw.value ?? raw.loadKN ?? raw.forceKN ?? raw.intensity);
  if (!kind || magnitude === undefined) return undefined;
  const sourceUnit = normalizeString(raw.unit)?.toLowerCase().replace(/\s+/g, '');
  const forceScale = sourceUnit && /^n(?:\/m(?:2|\^2|²)?)?$/.test(sourceUnit) ? 0.001 : 1;
  const selector = raw.selector === undefined ? undefined : modelSelectorSchema.safeParse(raw.selector);
  if (raw.scopeDescription !== undefined && !normalizeString(raw.scopeDescription)) throw new EngineeringValidationError(`LOAD_SCOPE_DESCRIPTION_INVALID: ${path}.scopeDescription / 荷载分组描述须为非空字符串`);
  const floorTransfer = raw.floorTransfer === undefined ? undefined : floorTransferSchema.safeParse(raw.floorTransfer);
  if (floorTransfer && (!floorTransfer.success || normalizeLoadUnit(raw.unit, kind) !== 'kN/m2')) {
    throw new EngineeringValidationError(`FLOOR_TRANSFER_INVALID: ${path}.floorTransfer; preserve explicit distribution and rectangular bounds for an area load / 面荷载传荷需明确方向和矩形范围`);
  }
  if (selector && !selector.success) throw new EngineeringValidationError(`LOAD_SELECTOR_INVALID: ${path}.selector ${JSON.stringify(selector.error.issues)} / 荷载选择器无效，不得丢弃`);
  const location = normalizeLoadLocation(raw.location);
  if (selector && (normalizeString(raw.target) || location && (selector.data?.story !== undefined
    || Object.entries(location).some(([key, value]) => key !== 'story' && value !== undefined)))) {
    throw new EngineeringValidationError(`LOAD_SELECTOR_CONFLICT: ${path} cannot combine target/position with selector, or two storey representations / 选择器不能混入另一目标或荷载位置；楼层仅选准确story ID或location.story层号之一`);
  }
  return {
    ...(normalizeString(raw.id) && { id: normalizeString(raw.id) }),
    kind,
    magnitude: magnitude * forceScale,
    unit: normalizeLoadUnit(raw.unit, kind),
    direction: normalizeLoadDirection(raw.direction ?? raw.axis, `${path}.direction`),
    target: normalizeString(raw.target),
    scopeDescription: normalizeString(raw.scopeDescription),
    ...(selector?.success ? { selector: selector.data } : {}),
    ...(floorTransfer?.success ? { floorTransfer: floorTransfer.data } : {}),
    location,
    caseId: normalizeString(raw.caseId ?? raw.loadCaseId),
    caseType: normalizeLoadCaseType(raw.caseType ?? raw.loadCaseType),
  };
}

function normalizeLoadCombination(value: unknown, index: number): EngineeringDraftLoadCombination {
  const path = `engineeringDraft.analysis.loadCombinations[${index}]`;
  const raw = asRecord(value);
  const id = normalizeString(raw?.id);
  const rawFactors = asRecord(raw?.factors);
  if (!id || !rawFactors || !Object.keys(rawFactors).length) {
    throw new EngineeringValidationError(`INVALID_LOAD_COMBINATION: ${path} must be {id:string,factors:{loadCaseId:number}} with nonempty factors, never a formula string / 荷载组合须为含ID和非空工况系数映射的对象，不能使用公式字符串或丢弃`);
  }
  const factors: Record<string, number> = Object.create(null);
  for (const [rawCaseId, rawFactor] of Object.entries(rawFactors)) {
    const caseId = rawCaseId.trim();
    const factor = finiteNumber(rawFactor);
    if (!caseId || factor === undefined || Object.hasOwn(factors, caseId)) {
      throw new EngineeringValidationError(`INVALID_LOAD_COMBINATION: ${path}.factors[${JSON.stringify(rawCaseId)}]=${JSON.stringify(rawFactor)}; expected unique nonempty case IDs and finite factors / 工况ID须非空且唯一，组合系数须为有限数值，不得丢弃或覆盖`);
    }
    factors[caseId] = factor;
  }
  return { id, factors };
}

function normalizeMezzanineHeight(rawGeometry: Record<string, unknown>): number | undefined {
  const direct = firstPositiveNumber([
    rawGeometry.mezzanineHeightM,
    rawGeometry.mezzanineHeight,
    rawGeometry.mezzanineLevelM,
    rawGeometry.mezzanineElevationM,
    rawGeometry.platformHeightM,
    rawGeometry.intermediateFloorHeightM,
  ]);
  if (direct !== undefined) return direct;

  const mezzanine = asRecord(rawGeometry.mezzanine);
  const platform = asRecord(rawGeometry.platform);
  const intermediateFloor = asRecord(rawGeometry.intermediateFloor);
  return firstPositiveNumber([
    mezzanine?.heightM,
    mezzanine?.height,
    mezzanine?.elevationM,
    platform?.heightM,
    platform?.height,
    platform?.elevationM,
    intermediateFloor?.heightM,
    intermediateFloor?.height,
    intermediateFloor?.elevationM,
  ]);
}

function normalizeMezzanineLength(rawGeometry: Record<string, unknown>): number | undefined {
  const direct = firstPositiveNumber([
    rawGeometry.mezzanineLengthM,
    rawGeometry.mezzanineLength,
    rawGeometry.platformLengthM,
  ]);
  if (direct !== undefined) return direct;

  const mezzanine = asRecord(rawGeometry.mezzanine);
  const platform = asRecord(rawGeometry.platform);
  return firstPositiveNumber([
    mezzanine?.lengthM,
    mezzanine?.length,
    platform?.lengthM,
    platform?.length,
  ]);
}

export function normalizeEngineeringDraft(value: unknown, existing?: EngineeringDraft): EngineeringDraft | undefined {
  const raw = asRecord(value);
  if (!raw) return undefined;

  const rawGeometry = asRecord(raw.geometry);
  const geometry = rawGeometry ? {
    lengthM: positiveNumber(rawGeometry.lengthM),
    heightM: positiveNumber(rawGeometry.heightM),
    mezzanineHeightM: normalizeMezzanineHeight(rawGeometry),
    mezzanineLengthM: normalizeMezzanineLength(rawGeometry),
    spanLengthsM: positiveNumberArray(rawGeometry.spanLengthsM),
    storyHeightsM: positiveNumberArray(rawGeometry.storyHeightsM),
    bayWidthsM: positiveNumberArray(rawGeometry.bayWidthsM),
    bayWidthsXM: positiveNumberArray(rawGeometry.bayWidthsXM),
    bayWidthsYM: positiveNumberArray(rawGeometry.bayWidthsYM),
  } : undefined;

  const rawMaterial = asRecord(raw.material);
  const material = rawMaterial ? {
    family: normalizeMaterialFamily(rawMaterial.family),
    grade: normalizeString(rawMaterial.grade),
    rebarGrade: normalizeString(rawMaterial.rebarGrade),
  } : undefined;

  const rawSections = asRecord(raw.sections);
  const sections = rawSections ? {
    beam: normalizeString(rawSections.beam),
    column: normalizeString(rawSections.column),
    member: normalizeString(rawSections.member),
  } : undefined;

  const rawBoundary = asRecord(raw.boundary);
  const boundary = rawBoundary ? {
    supportType: normalizeSupportType(normalizeString(rawBoundary.supportType)),
    frameBaseSupportType: normalizeFrameBaseSupportType(normalizeString(rawBoundary.frameBaseSupportType)),
    supportPositionsM: nonNegativeNumberArray(rawBoundary.supportPositionsM),
  } : undefined;

  const loads = Array.isArray(raw.loads)
    ? raw.loads.map((item, index) => normalizeEngineeringLoad(hydrateDraftRecord(item, existing?.loads?.map(load => ({ ...load })), false, true), `engineeringDraft.loads[${index}]`)).filter((load): load is EngineeringDraftLoad => load !== undefined)
    : undefined;
  if (raw.loads !== undefined && (!Array.isArray(raw.loads) || raw.loads.length !== loads?.length)) {
    throw new EngineeringValidationError('INVALID_ENGINEERING_LOAD: every load needs supported type, finite signed magnitude and explicit unit / 每条荷载需有效类型、带符号有限数值及单位');
  }

  const rawAnalysis = asRecord(raw.analysis);
  if (raw.analysis !== undefined && !rawAnalysis) {
    throw new EngineeringValidationError('INVALID_ANALYSIS: engineeringDraft.analysis must be an object / 分析设置须为对象，不得丢弃');
  }
  if (rawAnalysis?.loadCombinations !== undefined && !Array.isArray(rawAnalysis.loadCombinations)) {
    throw new EngineeringValidationError('INVALID_LOAD_COMBINATION: engineeringDraft.analysis.loadCombinations must be an array of {id,factors} objects / 荷载组合须为对象数组，不得丢弃');
  }
  const analysis = rawAnalysis ? {
    type: normalizeAnalysisType(rawAnalysis.type),
    engineTarget: normalizeEngineTarget(rawAnalysis.engineTarget),
    loadCombinations: Array.isArray(rawAnalysis.loadCombinations)
      ? rawAnalysis.loadCombinations.map(normalizeLoadCombination)
      : undefined,
  } : undefined;

  const wind = normalizeWindParams(raw.wind ?? raw.windParams);
  const analysisControl = raw.analysisControl;
  if (analysisControl !== undefined && !asRecord(analysisControl)) {
    throw new EngineeringValidationError('INVALID_ANALYSIS_CONTROL: object required / 分析控制必须是对象');
  }

  if (raw.coordinateSystem !== undefined && !asRecord(raw.coordinateSystem)) {
    throw new EngineeringValidationError('INVALID_COORDINATE_SYSTEM: object required / 坐标定义必须是对象');
  }
  const draft: EngineeringDraft = {
    structureType: normalizeString(raw.structureType) as EngineeringDraft['structureType'],
    ...(raw.coordinateSystem !== undefined ? { coordinateSystem: structuredClone(asRecord(raw.coordinateSystem)!) } : {}),
    geometry,
    topology: normalizeEngineeringTopology(raw.topology, existing?.topology),
    materials: normalizeRecordArray(raw.materials, 'materials')?.map(normalizeMaterialDensity),
    sectionRecords: normalizeRecordArray(raw.sectionRecords ?? (Array.isArray(raw.sections) ? raw.sections : undefined), 'sections'),
    templateAssignments: normalizeTemplateAssignments(raw.templateAssignments),
    loadCases: normalizeRecordArray(raw.loadCases ?? raw.load_cases, 'loadCases'),
    model: asRecord(raw.model) ? structuredClone(asRecord(raw.model)!) : undefined,
    inputEvidence: normalizeRecordArray(raw.inputEvidence, 'inputEvidence'),
    material,
    sections,
    boundary,
    loads,
    wind,
    analysis,
    analysisControl: analysisControl === undefined ? undefined : structuredClone(asRecord(analysisControl)!),
    ...(asRecord(raw.metadata) || raw.designParameters !== undefined ? { metadata: {
      ...structuredClone(asRecord(raw.metadata) ?? {}),
      ...(raw.designParameters !== undefined ? { unmappedDesignParameters: {
        status: 'requires-confirmation', sourcePath: 'engineeringDraft.designParameters',
        values: structuredClone(raw.designParameters),
      } } : {}),
    } } : {}),
  };

  if (!draft.topology && !draft.model && (draft.loads ?? existing?.loads)?.length
    && draft.loadCases?.some(row => Array.isArray(row.loads) && row.loads.length)) {
    throw new EngineeringValidationError('DRAFT_LOAD_REPRESENTATION_CONFLICT: template source loads belong in engineeringDraft.loads. loadCases may declare id/type with loads=[]; do not duplicate loads or invent generated node/member IDs. For user-supplied explicit topology use complete topology and exact executable load records instead. / 模板源荷载保存在loads；loadCases仅声明工况且loads=[]，不得重复荷载或编造尚未生成的实体编号；用户提供显式拓扑时应使用完整拓扑及准确施加荷载。');
  }
  for (const load of draft.loads ?? []) {
    const geometry = draft.geometry ?? existing?.geometry;
    if (load.location?.nodeRole !== undefined && geometry?.storyHeightsM?.length
      && (geometry.bayWidthsM?.length || geometry.bayWidthsXM?.length || geometry.bayWidthsYM?.length)
      && !frameNodeRoleSchema.safeParse(load.location.nodeRole).success) {
      throw new EngineeringValidationError(`LOAD_NODE_ROLE_INVALID: ${load.id ?? '?'} location.nodeRole=${JSON.stringify(load.location.nodeRole)}; use a formal frame node role, with story in the separate location.story field, e.g. {"nodeRole":"all","story":1} or {"nodeRole":"node-x0y1","story":2}. Exact node IDs belong in target or selector.ids. Preserve every load and case. / 框架nodeRole须使用正式角色，层号单独写入location.story，不得拼入角色；准确节点编号写入target或selector.ids，保留全部荷载及工况。`);
    }
    if (load.unit === 'kN' && load.selector?.type !== undefined) {
      throw new EngineeringValidationError(`LOAD_NODE_SELECTOR_TYPE_INVALID: ${load.id ?? '?'}; nodes have no type field. Preserve the load group with ids/coordinates, not type:${JSON.stringify(load.selector.type)} / 节点没有type字段，请保留分组并使用准确ID或坐标选择器`);
    }
    if (['frame','concrete-frame'].includes(draft.structureType ?? existing?.structureType ?? '') && isGlobalFrameNodeRole(load.target)
      && !draft.topology?.nodes?.some(node => node.id === load.target)) {
      throw new EngineeringValidationError(`LOAD_NODE_ROLE_FIELD_INVALID: ${load.id ?? '?'}; put the formal node role ${JSON.stringify(load.target)} in location.nodeRole instead of target. Preserve all magnitudes, units and cases / 正式节点角色应写入location.nodeRole，不得当作实体ID；保留全部荷载数值、单位和工况`);
    }
  }

  return Object.values(draft).some((item) => item !== undefined) ? omitUndefined(draft) : undefined;
}

function normalizeTemplateAssignments(value: unknown): EngineeringDraft['templateAssignments'] {
  if (value === undefined || value === null) return undefined;
  const mappings = asRecord(value);
  if (!mappings) throw new EngineeringValidationError('INVALID_TEMPLATE_ASSIGNMENTS: object required / 请提供构件角色属性映射');
  const normalized: NonNullable<EngineeringDraft['templateAssignments']> = {};
  for (const [role, raw] of Object.entries(mappings)) {
    if (['beam', 'column', 'member'].includes(role) && raw == null) continue;
    const entry = asRecord(raw);
    if (!['beam', 'column', 'member'].includes(role) || !entry
      || Object.keys(entry).some(key => !['materialId', 'sectionId', 'design'].includes(key))
      || entry.design !== undefined && !asRecord(entry.design)
      || ['materialId', 'sectionId'].some(key => entry[key] != null && typeof entry[key] !== 'string')) {
      throw new EngineeringValidationError(`INVALID_TEMPLATE_ASSIGNMENTS: ${role} requires supplied materialId/sectionId strings and an optional design object / 角色映射只接受明确的材料、截面ID及设计输入对象`);
    }
    const materialId = normalizeString(entry.materialId), sectionId = normalizeString(entry.sectionId);
    if (materialId || sectionId || entry.design !== undefined) normalized[role as keyof typeof normalized] = {
      ...(materialId ? { materialId } : {}), ...(sectionId ? { sectionId } : {}),
      ...(entry.design !== undefined ? { design: structuredClone(asRecord(entry.design)!) } : {}),
    };
  }
  return normalized;
}

/** A role-specific assignment amends the explicit uniform member assignment. */
export function resolveDraftTemplateAssignment(draft: EngineeringDraft | undefined,
  role: 'beam' | 'column' | 'member'): EngineeringDraftTemplateAssignment | undefined {
  const uniform = draft?.templateAssignments?.member;
  const specific = role === 'member' ? undefined : draft?.templateAssignments?.[role];
  if (!uniform && !specific) return undefined;
  return mergeDraftRecord({ ...uniform }, { ...specific }) as EngineeringDraftTemplateAssignment;
}

/** Preserve canonical material design records when the LLM only generates their topology references. */
export function projectDraftMaterialDesign(model: Record<string, unknown>, draft: EngineeringDraft | undefined): Record<string, unknown> {
  const sources = (draft?.materials ?? []).filter(material => material.design != null);
  if (!sources.length) return model;
  if (!Array.isArray(model.materials) || model.materials.some(material => !asRecord(material))) {
    throw new EngineeringValidationError('DRAFT_MATERIAL_DESIGN_TARGET_UNRESOLVED / 材料设计输入需要明确的模型材料');
  }
  const materials = structuredClone(model.materials) as Array<Record<string, unknown>>;
  const mapped = new Set<Record<string, unknown>>();
  for (const source of sources) {
    const matches = materials.filter(material => material.id === source.id);
    const target = matches.length === 1 ? matches[0]
      : !matches.length && draft?.materials?.length === 1 && materials.length === 1 ? materials[0] : undefined;
    if (!target || mapped.has(target)) throw new EngineeringValidationError(`DRAFT_MATERIAL_DESIGN_TARGET_UNRESOLVED: ${source.id} / 无法唯一对应已确认材料的设计输入`);
    if (!asRecord(source.design) || target.design != null && !asRecord(target.design)) {
      throw new EngineeringValidationError(`INVALID_MATERIAL_DESIGN: ${source.id} / 材料设计输入必须是对象`);
    }
    target.design = mergeDraftRecord(asRecord(target.design) ?? {}, source.design as Record<string, unknown>);
    mapped.add(target);
  }
  return { ...model, materials };
}

/** Project confirmed role-wide design inputs onto newly generated geometry, never infer them from mesh length. */
export function applyDraftTemplateDesign(model: Record<string, unknown>, draft: EngineeringDraft | undefined): Record<string, unknown> {
  const assignments = draft?.templateAssignments;
  const declaredRoles = Object.entries(assignments ?? {}).filter(([, assignment]) => assignment?.design !== undefined)
    .map(([role]) => role);
  if (!declaredRoles.length) return model;
  if (!Array.isArray(model.elements) || model.elements.some(element => !asRecord(element))) {
    throw new EngineeringValidationError('TEMPLATE_DESIGN_TARGET_UNRESOLVED: model elements are required / 构件设计输入需要明确的模型构件');
  }
  const roleOf = (element: Record<string, unknown>) => element.type === 'column' ? 'column'
    : element.type === 'beam' ? 'beam' : 'member';
  const elements = model.elements as Array<Record<string, unknown>>;
  for (const role of declaredRoles) {
    if (role !== 'member' && !elements.some(element => roleOf(element) === role)) {
      throw new EngineeringValidationError(`TEMPLATE_DESIGN_TARGET_UNRESOLVED: ${role} / 所声明设计条件的构件角色在模型中不存在，不能丢弃或改用于其他构件`);
    }
  }
  return { ...model, elements: elements.map(element => {
    const design = resolveDraftTemplateAssignment(draft, roleOf(element))?.design;
    if (design === undefined) return element;
    if (!asRecord(design) || element.design != null && !asRecord(element.design)) {
      throw new EngineeringValidationError(`INVALID_TEMPLATE_DESIGN: ${element.id} requires an object / 构件设计输入必须是对象`);
    }
    return { ...element, design: mergeDraftRecord(asRecord(element.design) ?? {}, design) };
  }) };
}

function normalizeRecordArray(value: unknown, label: string): Array<Record<string, unknown>> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => !asRecord(item))) {
    throw new EngineeringValidationError(`INVALID_EXPLICIT_MODEL: ${label} must contain complete records / 必须提供完整对象记录`);
  }
  const records = structuredClone(value) as Array<Record<string, unknown>>;
  if (label === 'sections') assertDraftSectionPurposes(records);
  return records;
}

/** A partial update must not overwrite confirmed nested fields with undefined. */
function omitUndefined<T>(value: T): T {
  if (Array.isArray(value)) return value.map(omitUndefined) as T;
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)
    .map(([key, item]) => [key, omitUndefined(item)])) as T;
}

function mergeDraftRecord(existing: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const merged = structuredClone(existing);
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new EngineeringValidationError('DRAFT_INVALID_FIELD / 草稿字段无效');
    const before = asRecord(merged[key]);
    const after = asRecord(value);
    const idRecords = Array.isArray(value) && value.length > 0
      && value.every(item => asRecord(item) && typeof item.id === 'string');
    merged[key] = idRecords ? mergeDraftPropertyRecords(Array.isArray(merged[key]) ? merged[key] as Array<Record<string, unknown>> : undefined, value as Array<Record<string, unknown>>)
      : before && after ? mergeDraftRecord(before, after) : structuredClone(value);
  }
  return merged;
}

/** Clarification patches amend draft records by ID; an explicit [] still clears the collection. */
function mergeDraftPropertyRecords(existing: Array<Record<string, unknown>> | undefined,
  patch: Array<Record<string, unknown>> | undefined): Array<Record<string, unknown>> | undefined {
  if (!patch) return existing;
  if (!patch.length) return [];
  const updated = structuredClone(existing ?? []);
  const seen = new Set<string>();
  for (const record of patch) {
    const id = typeof record.id === 'string' ? record.id : undefined;
    if (id && seen.has(id)) throw new EngineeringValidationError(`DUPLICATE_DRAFT_RECORD_ID: ${id} / 草稿属性记录 ID 重复`);
    if (id) seen.add(id);
    const matches = id ? updated.flatMap((item, index) => item.id === id ? [index] : []) : [];
    if (matches.length > 1) throw new EngineeringValidationError(`AMBIGUOUS_DRAFT_RECORD_ID: ${id} / 无法唯一定位草稿属性记录`);
    const index = matches[0];
    if (index === undefined) { updated.push(structuredClone(record)); continue; }
    updated[index] = mergeDraftRecord(updated[index]!, record);
  }
  return updated;
}

export function mergeEngineeringDraft(
  existing: EngineeringDraft | undefined,
  patch: EngineeringDraft | undefined,
): EngineeringDraft | undefined {
  if (!existing && !patch) return undefined;
  if (existing?.topology) existing = { ...existing, topology: normalizeDraftTopologyReleases(existing.topology) };
  if (patch?.topology) patch = { ...patch, topology: { ...normalizeDraftTopologyReleases(patch.topology),
    ...(patch.topology.members ? { members: patch.topology.members.map(member => hydrateDraftRecord(member, existing?.topology?.members, true) as EngineeringDraftTopologyMember) } : {}) } };
  if (!patch) return existing;
  if (!existing) {
    return {
      ...patch,
      loads: mergeEngineeringDraftLoads(undefined, patch.loads, {
        structureType: patch.structureType,
        geometry: patch.geometry,
        analysis: patch.analysis,
      }),
    };
  }
  const structureType = patch.structureType ?? existing.structureType;
  const geometry = { ...(existing.geometry ?? {}), ...(patch.geometry ?? {}) };
  const analysis = mergeDraftRecord({ ...existing.analysis }, { ...patch.analysis }) as EngineeringDraft['analysis'];
  const wind = existing.wind || patch.wind
    ? { ...(existing.wind ?? {}), ...(patch.wind ?? {}) }
    : undefined;
  const loads = mergeEngineeringDraftLoads(existing.loads, patch.loads, {
    structureType,
    geometry,
    analysis,
  });
  return {
    structureType,
    ...(existing.coordinateSystem || patch.coordinateSystem ? { coordinateSystem: { ...existing.coordinateSystem, ...patch.coordinateSystem } } : {}),
    geometry,
    topology: mergeDraftRecord({ ...existing.topology }, { ...patch.topology }) as EngineeringDraftTopology,
    materials: mergeDraftPropertyRecords(existing.materials, patch.materials),
    sectionRecords: mergeDraftPropertyRecords(existing.sectionRecords, patch.sectionRecords),
    templateAssignments: Object.fromEntries([...new Set([...Object.keys(existing.templateAssignments ?? {}), ...Object.keys(patch.templateAssignments ?? {})])]
      .map(role => { const key = role as keyof NonNullable<EngineeringDraft['templateAssignments']>;
        return [role, mergeDraftRecord({ ...existing.templateAssignments?.[key] }, { ...patch.templateAssignments?.[key] })]; })),
    loadCases: mergeDraftPropertyRecords(existing.loadCases, patch.loadCases),
    model: patch.model ?? existing.model,
    inputEvidence: mergeInputEvidence(existing.inputEvidence, patch.inputEvidence),
    material: { ...(existing.material ?? {}), ...(patch.material ?? {}) },
    sections: { ...(existing.sections ?? {}), ...(patch.sections ?? {}) },
    boundary: { ...(existing.boundary ?? {}), ...(patch.boundary ?? {}) },
    loads,
    wind,
    analysis,
    analysisControl: mergeAnalysisControl(existing.analysisControl, patch.analysisControl),
    ...(existing.metadata || patch.metadata ? { metadata: mergeDraftRecord(existing.metadata ?? {}, patch.metadata ?? {}) } : {}),
  };
}

function mergeAnalysisControl(existing: Record<string, unknown> | undefined, patch: Record<string, unknown> | undefined,
  rejectConflicts = false, field = 'analysis_control'): Record<string, unknown> | undefined {
  if (!existing && !patch) return undefined;
  const merged = structuredClone(existing ?? {});
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value === undefined) continue;
    const before = merged[key];
    if (asRecord(before) && asRecord(value)) merged[key] = mergeAnalysisControl(asRecord(before), asRecord(value), rejectConflicts, `${field}.${key}`);
    else {
      if (rejectConflicts && before !== undefined && !isDeepStrictEqual(before, value)) {
        throw new EngineeringValidationError(`ANALYSIS_CONTROL_CONFLICT: ${field}.${key} / 显式模型与草稿的分析控制冲突`);
      }
      merged[key] = structuredClone(value);
    }
  }
  return merged;
}

/** Confirmed controls are projected once; generated candidates cannot silently omit them. */
export function applyDraftAnalysisControl(model: Record<string, unknown>, draft: EngineeringDraft | undefined,
  preserveExplicitModel = false): Record<string, unknown> {
  if (draft?.analysisControl === undefined) return model;
  if (!asRecord(draft.analysisControl) || (model.analysis_control != null && !asRecord(model.analysis_control))) {
    throw new EngineeringValidationError('INVALID_ANALYSIS_CONTROL: object required / 分析控制必须是对象');
  }
  return { ...model, analysis_control: mergeAnalysisControl(asRecord(model.analysis_control), draft.analysisControl, preserveExplicitModel) };
}

function stableJson(value: unknown): string {
  if (value === undefined) return '';
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return JSON.stringify(value);
  }
  const record = value as Record<string, unknown>;
  return JSON.stringify(Object.keys(record).sort().reduce<Record<string, unknown>>((acc, key) => {
    acc[key] = record[key];
    return acc;
  }, {}));
}

function isSingleSpanBeam(draft: Pick<EngineeringDraft, 'structureType' | 'geometry'>): boolean {
  if (draft.structureType !== 'beam') return false;
  const spans = draft.geometry?.spanLengthsM;
  return !spans?.length || spans.length === 1;
}

function loadLocationMergeValue(
  load: EngineeringDraftLoad,
  draft: Pick<EngineeringDraft, 'structureType' | 'geometry'>,
): EngineeringDraftLoad['location'] {
  const location = load.location;
  if (!location || !isSingleSpanBeam(draft) || location.spanIndex !== 1) {
    return location;
  }
  const { spanIndex: _spanIndex, ...rest } = location;
  return Object.values(rest).some((value) => value !== undefined) ? rest : undefined;
}

function engineeringLoadMergeKey(
  load: EngineeringDraftLoad,
  draft: Pick<EngineeringDraft, 'structureType' | 'geometry' | 'analysis'>,
): string {
  if (load.id) return `id:${load.id}`;
  const location = loadLocationMergeValue(load, draft);
  const hasStructuredPointLocation = isPointLikeLoad(load)
    && Boolean(
      location?.nodeRole
      || location?.xM !== undefined
      || location?.story !== undefined,
    );
  const hasPlanarLineLocation = isLineLoad(load)
    && Boolean(location)
    && !(draft.geometry?.bayWidthsYM?.length);
  const normalizedTarget = hasStructuredPointLocation || hasPlanarLineLocation
    ? ''
    : load.target?.trim().toLowerCase().replace(/\s+/g, ' ') ?? '';
  const caseIds = new Set(
    draft.analysis?.loadCombinations
      ?.flatMap((combination) => Object.keys(combination.factors)) ?? [],
  );
  const soleCaseId = caseIds.size === 1 ? Array.from(caseIds)[0] : undefined;
  const caseKey = load.caseId?.trim().toLowerCase()
    ?? soleCaseId?.trim().toLowerCase()
    ?? load.caseType
    ?? '';
  return [
    isLineLoad(load) ? 'line' : isPointLikeLoad(load) ? 'point' : load.kind,
    load.unit,
    load.direction ?? '',
    caseKey,
    normalizedTarget,
    load.scopeDescription ?? '',
    stableJson(load.selector),
    stableJson(location),
  ].join('|');
}

/** A clarification may identify one unnamed force without introducing a second load. */
export function engineeringLoadClarifiesExisting(
  existing: EngineeringDraftLoad,
  patch: EngineeringDraftLoad,
  draft: Pick<EngineeringDraft, 'structureType' | 'geometry' | 'analysis'>,
): boolean {
  if (existing.id || patch.id) return false;
  if (existing.direction !== undefined && patch.direction !== undefined && existing.direction !== patch.direction) return false;
  const undirected = (load: EngineeringDraftLoad) => engineeringLoadMergeKey({ ...load, direction: undefined }, draft);
  if (undirected(existing) === undirected(patch)) return true;
  // Assigning a case to an unclassified force is a refinement only when the
  // physical force is unchanged. Two explicit cases must always stay distinct.
  if (existing.caseId || existing.caseType || !(patch.caseId || patch.caseType) || existing.magnitude !== patch.magnitude) return false;
  return undirected({ ...existing, caseId: undefined, caseType: undefined })
    === undirected({ ...patch, caseId: undefined, caseType: undefined });
}

function mergeEngineeringDraftLoads(
  existing: EngineeringDraftLoad[] | undefined,
  patch: EngineeringDraftLoad[] | undefined,
  draft: Pick<EngineeringDraft, 'structureType' | 'geometry' | 'analysis'>,
): EngineeringDraftLoad[] | undefined {
  if (patch?.length === 0) return [];
  if (!existing?.length && !patch?.length) return undefined;
  const merged = new Map<string, EngineeringDraftLoad>();
  for (const load of existing ?? []) {
    merged.set(engineeringLoadMergeKey(load, draft), load);
  }
  for (const load of patch ?? []) {
    const key = engineeringLoadMergeKey(load, draft);
    let prior = merged.get(key);
    // Supplying an omitted direction or case refines exactly one existing load.
    // Ambiguous candidates and explicitly different forces/cases stay separate.
    if (!prior && !load.id) {
      const candidates = Array.from(merged.entries()).filter(([, candidate]) =>
        engineeringLoadClarifiesExisting(candidate, load, draft));
      if (candidates.length === 1) {
        const [priorKey, candidate] = candidates[0];
        prior = candidate;
        merged.delete(priorKey);
      }
    }
    const next = prior ? { ...prior, ...load,
      direction: load.direction ?? prior.direction,
      location: load.location ?? prior.location } : load;
    if (load.target !== undefined && !load.selector) delete next.selector;
    if (load.selector && load.target === undefined) delete next.target;
    if (load.scopeDescription && !load.selector && load.target === undefined) { delete next.target; delete next.selector; }
    merged.set(engineeringLoadMergeKey(next, draft), next);
  }
  return Array.from(merged.values());
}
