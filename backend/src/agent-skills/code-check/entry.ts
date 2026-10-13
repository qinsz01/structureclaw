import {
  resolveCodeCheckRule,
} from './registry.js';
import type { CodeCheckDomainInput } from './types.js';
import type { CodeCheckClient } from './rule.js';
import type { ExecutionRequestOptions } from '../analysis/types.js';
import { withGB50011CodeCheckMetadata } from './gb50011/metadata.js';
import { recoverAnalysisMembers } from '../result-postprocess/member-response.js';
import type { RecoveryModel, RecoveryResult } from '../../skill-shared/member-response.js';

export type { CodeCheckDomainInput } from './types.js';
export {
  listCodeCheckRuleProviders,
  resolveCodeCheckDesignCodeFromSkillIds,
} from './registry.js';

function extractElementIds(model: Record<string, unknown> | undefined): string[] {
  if (!model) {
    return [];
  }
  const elements = model['elements'];
  if (!Array.isArray(elements)) {
    return [];
  }
  return elements
    .map((item) => (item && typeof item === 'object' ? (item as Record<string, unknown>).id : undefined))
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** Historical concrete-frame templates inserted unconfirmed minimum rebar as facts. */
function acceptedReinforcement(value: unknown, requiresConfirmation: boolean): Record<string, unknown> | undefined {
  const reinforcement = asRecord(value);
  if (Object.keys(reinforcement).length === 0 || reinforcement['confirmed'] === false
    || (requiresConfirmation && reinforcement['confirmed'] !== true)
    || (reinforcement['status'] === 'unconfirmed' && reinforcement['confirmed'] !== true)) return undefined;
  return reinforcement;
}

const REBAR_FIELDS = ['As', 'Asv', 'stirrup_dia', 'stirrup_spacing', 'main_dia', 'bar_count', 'sn', 'cover', 'crack_cover'];

/** Keep raw context/extra paths from bypassing the same reinforcement provenance gate. */
function withConfirmedReinforcement(model: Record<string, unknown>): Record<string, unknown> {
  const template = asRecord(model['metadata'])['source'] === 'concrete-frame-skill-draft';
  function clean(value: unknown, member: boolean): Record<string, unknown> {
    const source = asRecord(value);
    const result = { ...source };
    const reinforcement = acceptedReinforcement(source['reinforcement'], template);
    if (reinforcement) result['reinforcement'] = reinforcement;
    else if (source['reinforcement'] !== undefined) result['reinforcement'] = { confirmed: false };
    if (member && (template || source['reinforcement'] !== undefined && !reinforcement)) {
      for (const key of REBAR_FIELDS) delete result[key];
    }
    for (const key of ['metadata', 'extra', 'properties', 'design']) {
      if (source[key] && typeof source[key] === 'object') result[key] = clean(source[key], member && key !== 'properties');
    }
    return result;
  }
  return {
    ...model,
    ...(Array.isArray(model['elements']) ? { elements: model['elements'].map(element => clean(element, true)) } : {}),
    ...(Array.isArray(model['sections']) ? { sections: model['sections'].map(section => clean(section, false)) } : {}),
  };
}

function extractAnalysisSummary(analysis: unknown): Record<string, unknown> {
  const root = asRecord(analysis);
  const nestedData = asRecord(root['data']);
  const data = Object.keys(nestedData).length > 0 ? nestedData : root;
  return {
    analysisType: root['analysis_type'],
    success: root['success'],
    errorCode: root['error_code'],
    message: root['message'],
    analysisMode: data['analysisMode'],
    workflowInputMode: data['workflowInputMode'] ?? root['workflowInputMode'],
    summary: data['summary'],
    envelope: data['envelope'],
    modelSummary: data['modelSummary'],
    designBasis: data['designBasis'],
    methodDecision: data['methodDecision'],
    regularityAssessment: data['regularityAssessment'],
    specialSystemReview: data['specialSystemReview'],
    overLimitReview: data['overLimitReview'],
    specialReview: data['specialReview'],
    specialSeismicReview: data['specialSeismicReview'],
    overLimitSpecialReview: data['overLimitSpecialReview'],
    responseSpectrum: data['responseSpectrum'],
    timeHistory: data['timeHistory'],
    elasticPlasticTimeHistory: data['elasticPlasticTimeHistory'],
    seismicDesignActions: data['seismicDesignActions'],
    gravityDesignActions: data['gravityDesignActions'],
    memberDesignActionCombinations: data['memberDesignActionCombinations'],
    verticalSeismic: data['verticalSeismic'],
    groundMotionRequirement: data['groundMotionRequirement'],
    directionResults: data['directionResults'],
    pushover: data['pushover'],
    missingInputs: data['missingInputs'],
    missingCapabilities: data['missingCapabilities'],
    capabilityAssessment: data['capabilityAssessment'],
    isPreliminary: data['isPreliminary'],
    warnings: data['warnings'],
  };
}

function isGB50011DesignCode(code: string): boolean {
  const normalized = code.trim().toUpperCase().replace(/\s+/g, '');
  return normalized === 'GB50011'
    || normalized === 'GB50011-2010'
    || normalized === 'GBT50011'
    || normalized === 'GB/T50011'
    || normalized === 'GBT50011-2010'
    || normalized === 'GB/T50011-2010'
    || normalized === 'GBT50011-2010-2024'
    || normalized === 'GB/T50011-2010-2024'
    || normalized === 'GB55002+GBT50011'
    || normalized === 'GB55002+GB/T50011';
}

function hasSeismicAnalysisResult(analysis: unknown): boolean {
  const root = asRecord(analysis);
  const nestedData = asRecord(root['data']);
  const data = Object.keys(nestedData).length > 0 ? nestedData : root;
  return data['analysisMode'] === 'opensees_china_seismic_workflow'
    || Boolean(data['designBasis'] && data['methodDecision'] && data['envelope']);
}

function appendGlobalSeismicElement(elements: string[], designCode: string, analysis: unknown): string[] {
  if (!isGB50011DesignCode(designCode) || !hasSeismicAnalysisResult(analysis)) {
    return elements;
  }
  return elements.includes('__global_seismic__')
    ? elements
    : ['__global_seismic__', ...elements];
}

function extractElementContextById(model: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!model) {
    return {};
  }

  const elements = model['elements'];
  if (!Array.isArray(elements)) {
    return {};
  }
  const materials = Array.isArray(model['materials']) ? model['materials'] : [];
  const sections = Array.isArray(model['sections']) ? model['sections'] : [];
  const materialById = materials.reduce<Map<string, Record<string, unknown>>>((acc, item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return acc;
    const record = item as Record<string, unknown>;
    const id = String(record['id'] ?? '');
    if (id.length > 0) acc.set(id, record);
    return acc;
  }, new Map());
  const sectionById = sections.reduce<Map<string, Record<string, unknown>>>((acc, item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return acc;
    const record = item as Record<string, unknown>;
    const id = String(record['id'] ?? '');
    if (id.length > 0) acc.set(id, record);
    return acc;
  }, new Map());

  return elements.reduce<Record<string, unknown>>((acc, item) => {
    if (!item || typeof item !== 'object') {
      return acc;
    }
    const element = item as Record<string, unknown>;
    const id = typeof element['id'] === 'string' ? element['id'] : undefined;
    if (!id) {
      return acc;
    }
    const metadata = asRecord(element['metadata']);
    const extra = asRecord(element['extra']);
    const structuredMemberSources = [asRecord(element['design']), element, metadata, extra];
    const materialId = typeof element['material'] === 'string' ? element['material'] : undefined;
    const sectionId = typeof element['section'] === 'string' ? element['section'] : undefined;

    acc[id] = {
      id,
      type: element['type'],
      material: materialId ? (materialById.get(materialId) ?? materialId) : element['material'],
      section: sectionId ? (sectionById.get(sectionId) ?? sectionId) : element['section'],
      materialId,
      sectionId,
      startNode: element['startNode'],
      endNode: element['endNode'],
      nodes: element['nodes'],
      story: element['story'],
      concreteGrade: element['concrete_grade'],
      steelGrade: element['steel_grade'],
      rebarGrade: element['rebar_grade'],
      seismicGrade: element['seismic_grade'],
      storyHeightMm: pickFirstDefined(structuredMemberSources, ['storyHeightMm', 'floorHeightMm', 'heightBetweenFloorsMm']),
      storyHeight: pickFirstDefined(structuredMemberSources, ['storyHeight', 'floorHeight', 'heightBetweenFloors']),
      reinforcement: pickFirstDefined(structuredMemberSources, ['reinforcement']),
      shearWall: pickFirstDefined(structuredMemberSources, ['shearWall']),
      seismicWall: pickFirstDefined(structuredMemberSources, ['seismicWall']),
      wallData: pickFirstDefined(structuredMemberSources, ['wallData']),
      shearWallData: pickFirstDefined(structuredMemberSources, ['shearWallData']),
      boundaryElement: pickFirstDefined(structuredMemberSources, ['boundaryElement', 'boundaryMember', 'edgeMember']),
      boundaryElements: pickFirstDefined(structuredMemberSources, ['boundaryElements', 'boundaryMembers', 'edgeMembers']),
      seismicCapacity: pickFirstDefined(structuredMemberSources, ['seismicCapacity']),
      capacityDesign: pickFirstDefined(structuredMemberSources, ['capacityDesign']),
      strongShearWeakBending: pickFirstDefined(structuredMemberSources, ['strongShearWeakBending']),
      shearCompression: pickFirstDefined(structuredMemberSources, ['shearCompression', 'shearCompressionLimit', 'shearCompressionCheck']),
      jointCore: pickFirstDefined(structuredMemberSources, ['jointCore', 'jointCoreStirrup', 'jointCoreStirrups']),
      jointData: pickFirstDefined(structuredMemberSources, ['jointData', 'beamJointData']),
      flatBeam: pickFirstDefined(structuredMemberSources, ['flatBeam', 'wideBeam']),
      columnPosition: pickFirstDefined(structuredMemberSources, ['columnPosition']),
      columnCategory: pickFirstDefined(structuredMemberSources, ['columnCategory']),
      steelSeismicDetailing: pickFirstDefined(structuredMemberSources, ['steelSeismicDetailing', 'steelSeismicChecks']),
      steelDetailing: pickFirstDefined(structuredMemberSources, ['steelDetailing']),
      seismicDetailing: pickFirstDefined(structuredMemberSources, ['seismicDetailing', 'seismicDetailingChecks']),
      extra: element['extra'],
      metadata: element['metadata'],
    };
    return acc;
  }, {});
}

function extractModelSummary(model: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!model) {
    return {};
  }

  const metadata = model['metadata'];
  const metadataObject = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {};

  return {
    modelType: model['type'] ?? metadataObject['modelType'] ?? null,
    elementCount: extractElementIds(model).length,
    units: metadataObject['units'] ?? null,
    designCode: metadataObject['designCode'] ?? null,
  };
}

/**
 * Take the larger absolute value of two numbers; returns undefined if both are falsy.
 */
const finiteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

type ForceState = { source: string; station: string | number; positionM?: number; segmentId?: string; side?: string; forces: Record<string, number>; unsupportedReason?: string };

/** A rigid translation/rotation of the member is not its serviceability deflection. */
function memberDeflection(member: ReturnType<typeof recoverAnalysisMembers>[number] | undefined) {
  if (!member || member.state !== 'recovered' || !member.axes || !member.samples.length || member.length <= 0) return undefined;
  const first = member.samples[0]!, last = member.samples.at(-1)!;
  let governing: { valueMm: number; positionM: number; componentsLocalMm: number[] } | undefined;
  for (const sample of member.samples) {
    const ratio = sample.x / member.length;
    const relative = sample.displacement.map((value, i) => value - (1 - ratio) * first.displacement[i]! - ratio * last.displacement[i]!);
    const transverse = [member.axes[1]!, member.axes[2]!].map(axis => axis.reduce((sum, value, i) => sum + value * relative[i]!, 0) * 1000);
    const valueMm = Math.hypot(...transverse);
    if (!governing || valueMm > governing.valueMm) governing = { valueMm, positionM: sample.x, componentsLocalMm: transverse };
  }
  return governing && { ...governing, source: 'mechanics-recovery',
    definition: 'transverse-displacement-relative-to-endpoint-chord', numericalScope: 'sampled-member-response' };
}

function forceUnitFactors(analysis: Record<string, unknown>, data: Record<string, unknown>): { force: number; moment: number } | undefined {
  const meta = asRecord(analysis['meta']);
  const units = asRecord(meta['units'] ?? data['units']);
  if (units['force'] === 'kN' && ['kN.m', 'kN·m'].includes(String(units['moment']))) return { force: 1000, moment: 1e6 };
  if (units['force'] === 'N' && ['N.mm', 'N·mm'].includes(String(units['moment']))) return { force: 1, moment: 1 };
  // Documented compatibility for old built-in responses, never infer units from value size.
  if (!hasRecordKeys(units) && ['builtin-opensees', 'builtin-pkpm'].includes(String(meta['analysisAdapterKey'] ?? meta['engineId']))) return { force: 1000, moment: 1e6 };
  return undefined;
}

function codeCheckForceState(raw: Record<string, unknown>, factors: { force: number; moment: number }, source: string, station: string | number): ForceState {
  const forces: Record<string, number> = {};
  for (const name of ['N', 'V2', 'V3', 'V']) if (finiteNumber(raw[name])) forces[name] = raw[name] * factors.force;
  for (const name of ['T', 'M2', 'M3', 'M', 'Mx', 'M_service']) if (finiteNumber(raw[name])) forces[name] = raw[name] * factors.moment;
  const canonical = finiteNumber(raw['M2']) || finiteNumber(raw['V3']);
  if (canonical) {
    // The implemented uniaxial checks bend about local 2; never use 3-D vector magnitudes.
    if (finiteNumber(forces['M2'])) forces['Mx'] = forces['M2'];
    if (finiteNumber(forces['V3'])) forces['V'] = forces['V3'];
  } else if (finiteNumber(forces['M'])) forces['Mx'] = forces['M'];
  const biaxial = canonical && ['M3', 'T', 'V2'].some(key => finiteNumber(raw[key]) && Math.abs(raw[key]) > 1e-12);
  return { source, station, forces, ...(biaxial ? { unsupportedReason: 'Biaxial bending, transverse shear or torsion requires a supported combined check / 双向弯曲、横向剪切或扭转尚缺相应组合验算。' } : {}) };
}

function hasRecordKeys(value: Record<string, unknown>): boolean {
  return Object.keys(value).length > 0;
}

function pickFirstDefined(sources: Array<Record<string, unknown>>, keys: string[]): unknown {
  for (const source of sources) {
    for (const key of keys) {
      if (source[key] !== undefined) {
        return source[key];
      }
    }
  }
  return undefined;
}

/**
 * 从模型和分析结果中提取 elementData，供 Python code-check 层消费。
 *
 * 合并三项数据源:
 *   1. model.elements[] — 构件类型、截面/材料 ID、始末节点
 *   2. model.sections[] / model.materials[] — 截面/材料属性
 *   3. analysisResult.data.forces[] — 每构件内力；PKPM/OpenSees 的 kN/kN·m 会转为 N/N·mm
 *
 * 返回格式与 gb50017 `_compute_utilization_overrides()` 期望的 elementData 一致。
 */
function extractElementDataForCodeCheck(
  model: Record<string, unknown> | undefined,
  analysisResult: unknown,
): Record<string, Record<string, unknown>> {
  if (!model) return {};

  const elements = Array.isArray(model['elements']) ? model['elements'] as Record<string, unknown>[] : [];
  const sections = Array.isArray(model['sections']) ? model['sections'] as Record<string, unknown>[] : [];
  const materials = Array.isArray(model['materials']) ? model['materials'] as Record<string, unknown>[] : [];
  const nodes = Array.isArray(model['nodes']) ? model['nodes'] as Record<string, unknown>[] : [];

  // unwrap AnalysisResponse: { data: { forces: { ... } } }; direct result objects are also accepted.
  const analysis = asRecord(analysisResult);
  const dataObject = asRecord(analysis['data']);
  const data = Object.keys(dataObject).length > 0 ? dataObject : analysis;
  const rawForces = asRecord(data['forces']);
  const factors = forceUnitFactors(analysis, data);
  const meta = asRecord(analysis['meta']);
  const engine = String(meta['analysisAdapterKey'] ?? meta['engineId'] ?? '').replace('builtin-', '');
  const nativeEnvelope = engine === 'pkpm' || engine === 'yjk' || /^(pkpm|yjk)/.test(String(data['analysisMode']));
  const recoveredById = new Map<string, ReturnType<typeof recoverAnalysisMembers>[number]>();
  if (engine === 'opensees' && factors?.force === 1000 && model['unit_system'] === 'SI'
    && hasRecordKeys(asRecord(model['coordinate_system'])) && hasRecordKeys(asRecord(data['displacements']))) {
    const recoveryResult = { ...data, units: asRecord(meta['units'] ?? data['units']) };
    for (const member of recoverAnalysisMembers(model as unknown as RecoveryModel, recoveryResult as RecoveryResult, engine)) {
      if (member.state === 'recovered' || member.state === 'truss') recoveredById.set(member.id, member);
    }
  }

  // lookup tables: section/material/node by id (supports both string and number IDs)
  const sectionById: Record<string, Record<string, unknown>> = {};
  for (const s of sections) {
    if (s && typeof s === 'object' && (typeof s['id'] === 'string' || typeof s['id'] === 'number')) {
      sectionById[String(s['id'])] = s;
    }
  }
  const materialById: Record<string, Record<string, unknown>> = {};
  for (const m of materials) {
    if (m && typeof m === 'object' && (typeof m['id'] === 'string' || typeof m['id'] === 'number')) {
      materialById[String(m['id'])] = m;
    }
  }
  const nodeById: Record<string, Record<string, unknown>> = {};
  for (const n of nodes) {
    if (n && typeof n === 'object' && (typeof n['id'] === 'string' || typeof n['id'] === 'number')) {
      nodeById[String(n['id'])] = n;
    }
  }

  const elementData: Record<string, Record<string, unknown>> = {};

  for (const elem of elements) {
    if (!elem || typeof elem !== 'object') continue;
    const elemId = typeof elem['id'] === 'string' ? elem['id'] : '';
    if (!elemId) continue;

    // section properties
    const sectionId = String(elem['section'] ?? '');
    const sectionObj = sectionById[sectionId];
    const sourceSectionProps = asRecord(sectionObj?.['properties']);
    const swappedPrincipalAxes = asRecord(model['coordinate_system'])['dimension'] === '2d'
      && Math.abs(Math.round(Number(elem['rotation_angle'] ?? 0) / 90) % 2) === 1;
    const sectionProps = swappedPrincipalAxes ? { ...sourceSectionProps, Iy: sourceSectionProps['Iz'], Iz: sourceSectionProps['Iy'] } : sourceSectionProps;
    const sectionExtra = asRecord(sectionObj?.['extra']);
    const sectionShapeRecord = asRecord(sectionObj?.['shape']);
    const sectionShape = hasRecordKeys(sectionShapeRecord) ? sectionShapeRecord : undefined;

    // material properties
    const materialId = String(elem['material'] ?? '');
    const materialObj = materialById[materialId];

    // Retain simultaneous signed vectors at each station; never splice component envelopes.
    const elemForces = asRecord(rawForces[elemId]);
    const incompatibleFrame = elemForces['referenceFrame'] !== undefined && elemForces['referenceFrame'] !== 'element-local';
    const forceStates: ForceState[] = [];
    const recovered = recoveredById.get(elemId);
    if (recovered) {
      for (const sample of recovered.samples) {
        forceStates.push({ ...codeCheckForceState(sample as unknown as Record<string, unknown>, { force: 1000, moment: 1e6 }, 'member_response', sample.x), positionM: sample.x, ...(sample.segmentId ? { segmentId: sample.segmentId } : {}), ...(sample.side ? { side: sample.side } : {}) });
      }
    } else if (factors && !nativeEnvelope && !incompatibleFrame) {
      for (const endpoint of ['n1', 'n2']) {
        const value = asRecord(elemForces[endpoint]);
        if (hasRecordKeys(value)) {
          const state = codeCheckForceState(value, factors, 'native_endpoint', endpoint);
          if (String(data['analysisMode']).includes('3d_frame') && !finiteNumber(value['M2'])) {
            state.unsupportedReason = 'Legacy 3-D force component conventions are unverified / 旧三维内力分量约定尚未验证。';
          }
          forceStates.push(state);
        }
      }
      if (!forceStates.length && hasRecordKeys(elemForces)) forceStates.push(codeCheckForceState(elemForces, factors, 'provided_station', 'provided'));
    }
    const forceInputIssue = nativeEnvelope
      ? 'Native component envelopes lack verified simultaneous station conventions / 原生分量包络尚缺同截面向量约定，不能用于组合验算。'
      : incompatibleFrame ? 'Member checks require verified element-local actions / 构件校核需要已验证的局部坐标内力。'
        : !factors && hasRecordKeys(elemForces) ? 'Analysis force units are not declared / 分析内力单位未声明。' : undefined;

    // element length from node coordinates (m → mm)
    const elemNodes = Array.isArray(elem['nodes']) ? (elem['nodes'] as string[]) : [];
    const nodeStart = elemNodes.length >= 1 ? nodeById[elemNodes[0]!] : undefined;
    const nodeEnd = elemNodes.length >= 2 ? nodeById[elemNodes[1]!] : undefined;
    let lengthMm: number | undefined;
    if (nodeStart && nodeEnd) {
      const dx = (Number(nodeStart['x'] ?? 0) - Number(nodeEnd['x'] ?? 0));
      const dy = (Number(nodeStart['y'] ?? 0) - Number(nodeEnd['y'] ?? 0));
      const dz = (Number(nodeStart['z'] ?? 0) - Number(nodeEnd['z'] ?? 0));
      lengthMm = Math.sqrt(dx * dx + dy * dy + dz * dz) * 1000; // m → mm
    }

    // unit conversions: model sections in m²/m⁴ → mm²/mm⁴
    const A_m2 = Number(sectionProps['A'] ?? 0);
    const Iy_m4 = Number(sectionProps['Iy'] ?? 0);
    const Iz_m4 = Number(sectionProps['Iz'] ?? 0);
    const J_m4 = Number(sectionProps['J'] ?? 0);
    const Wx_m3 = Number(swappedPrincipalAxes ? sectionProps['Wz'] ?? 0 : sectionProps['Wnx'] ?? sectionProps['Wx'] ?? 0);
    const S_m3 = Number(swappedPrincipalAxes ? sectionProps['Sz'] ?? 0 : sectionProps['S'] ?? 0);
    const tw_m = Number(swappedPrincipalAxes ? sectionProps['tz'] ?? 0 : sectionProps['tw'] ?? 0);
    const As_m2 = Number(swappedPrincipalAxes ? sectionProps['Asz'] ?? 0 : sectionProps['As'] ?? 0);

    const A_mm2 = A_m2 * 1e6;
    const Iy_mm4 = Iy_m4 * 1e12;
    const Iz_mm4 = Iz_m4 * 1e12;
    const J_mm4 = J_m4 * 1e12;
    const Wx_mm3 = Wx_m3 * 1e9;
    const S_mm3 = S_m3 * 1e9;
    const tw_mm = tw_m * 1e3;
    const As_mm2 = As_m2 * 1e6;

    // rotation radius i = sqrt(I / A) in mm
    const i_min = A_mm2 > 0 ? Math.sqrt(Math.min(Iy_mm4, Iz_mm4) / A_mm2) : undefined;

    // V2 SectionShape dimensions are millimetres, independently of their magnitude.
    let derivedWnxMm3 = Wx_mm3;
    let derivedS_mm3 = S_mm3;
    let derivedTw_mm = tw_mm;
    let derivedAs_mm2 = As_mm2;
    if (sectionShape && ['H', 'I', 'built-up-I'].includes(String(sectionShape['kind']))) {
      const Hmm = Number(sectionShape['H'] ?? 0);
      const Bmm = Number(sectionShape['B'] ?? 0);
      const twmm = Number(sectionShape['tw'] ?? 0);
      const tfmm = Number(sectionShape['tf'] ?? 0);
      if ([Hmm, Bmm, twmm, tfmm].every(Number.isFinite) && Hmm > 2 * tfmm && Bmm > twmm && twmm > 0 && tfmm > 0) {
        const hw = Hmm - 2 * tfmm;
        if (derivedWnxMm3 <= 0) {
          // Iy = (tw*hw³)/12 + 2*B*tf*((hw+tf)/2)² — already have Iy_mm4 from props
          // Wx = Iy / (H/2)
          derivedWnxMm3 = Iy_mm4 > 0 ? Iy_mm4 / ((swappedPrincipalAxes ? Bmm : Hmm) / 2) : 0;
        }
        if (derivedS_mm3 <= 0) {
          // S = B*tf*(hw+tf)/2 + tw*(hw/2)²/2
          const S_flange = Bmm * tfmm * (hw + tfmm) / 2;
          const S_web = twmm * (hw / 2) * (hw / 4);
          derivedS_mm3 = swappedPrincipalAxes ? tfmm * Bmm ** 2 / 4 + hw * twmm ** 2 / 8 : S_flange + S_web;
        }
        if (derivedTw_mm <= 0 && !swappedPrincipalAxes) {
          derivedTw_mm = twmm;
        }
        if (derivedAs_mm2 <= 0 && !swappedPrincipalAxes) {
          derivedAs_mm2 = twmm * hw;
        }
      }
    }
    const widthMm = Number(sectionObj?.['width'] ?? sectionShape?.['B']);
    const heightMm = Number(sectionObj?.['height'] ?? sectionShape?.['H']);
    const effectiveWidth = swappedPrincipalAxes ? heightMm : widthMm;
    const effectiveHeight = swappedPrincipalAxes ? widthMm : heightMm;
    if (sectionShape?.['kind'] === 'rectangular' && effectiveWidth > 0 && effectiveHeight > 0) {
      if (derivedWnxMm3 <= 0) derivedWnxMm3 = Iy_mm4 / (effectiveHeight / 2);
      if (derivedS_mm3 <= 0) derivedS_mm3 = effectiveWidth * effectiveHeight ** 2 / 8;
      if (derivedTw_mm <= 0) derivedTw_mm = effectiveWidth;
    }

    // Yield strength is not design strength; preserve only explicitly supplied design values.
    const materialWithDesign = materialObj ? { ...materialObj, ...asRecord(materialObj['design']) } : {};

    // design parameters from element metadata (phi, lambda limits, etc.)
    const elemMetadata = (typeof elem['metadata'] === 'object' && elem['metadata'] !== null
      ? elem['metadata'] as Record<string, unknown> : {}) as Record<string, unknown>;
    const elemExtra = asRecord(elem['extra']);
    const memberDesign = asRecord(elem['design']);
    const designSources = [memberDesign, elem, elemMetadata, elemExtra];
    const structuralSources = [
      memberDesign, elem,
      elemMetadata,
      elemExtra,
      sectionObj ?? {},
      sectionExtra,
      sectionProps,
      sectionShape ?? {},
    ];
    const wallThickness = pickFirstDefined(structuralSources, [
      'thicknessMm',
      'wallThicknessMm',
      'tMm',
      'thickness',
      'wallThickness',
      't',
      'T',
    ]);
    const wallLength = pickFirstDefined(structuralSources, [
      'wallLengthMm',
      'wallLengthM',
      'wallLength',
      'wall_length',
      'length',
      'L',
    ]);
    const templateReinforcement = asRecord(model['metadata'])['source'] === 'concrete-frame-skill-draft';
    const sectionReinforcement = acceptedReinforcement(
      pickFirstDefined([sectionObj ?? {}, sectionExtra, sectionProps], ['reinforcement']), templateReinforcement,
    );
    const declaredReinforcement = pickFirstDefined(
      [memberDesign, elem, elemMetadata, elemExtra, sectionObj ?? {}, sectionExtra, sectionProps],
      ['reinforcement'],
    );
    const reinforcement = acceptedReinforcement(declaredReinforcement, templateReinforcement);
    // Explicit records override legacy flat fields; rejected suggestions never fall back to them.
    const rebarSources = reinforcement
      ? [asRecord(reinforcement['values']), reinforcement]
      : !templateReinforcement && declaredReinforcement === undefined ? [elem, elemMetadata] : [];
    const rebarValues = Object.fromEntries(REBAR_FIELDS.flatMap(key => {
      const value = pickFirstDefined(rebarSources, [key]);
      return finiteNumber(value) ? [[key, value]] : [];
    }));
    const shearWall = pickFirstDefined(structuralSources, ['shearWall']);
    const seismicWall = pickFirstDefined(structuralSources, ['seismicWall']);
    const wallData = pickFirstDefined(structuralSources, ['wallData']);
    const shearWallData = pickFirstDefined(structuralSources, ['shearWallData']);
    const boundaryElement = pickFirstDefined(structuralSources, ['boundaryElement', 'boundaryMember', 'edgeMember']);
    const boundaryElements = pickFirstDefined(structuralSources, ['boundaryElements', 'boundaryMembers', 'edgeMembers']);
    const storyHeightMm = pickFirstDefined(structuralSources, ['storyHeightMm', 'floorHeightMm', 'heightBetweenFloorsMm']);
    const storyHeight = pickFirstDefined(structuralSources, ['storyHeight', 'floorHeight', 'heightBetweenFloors']);
    const seismicCapacity = pickFirstDefined(structuralSources, ['seismicCapacity']);
    const capacityDesign = pickFirstDefined(structuralSources, ['capacityDesign']);
    const strongShearWeakBending = pickFirstDefined(structuralSources, [
      'strongShearWeakBending',
      'strongShearWeakFlexure',
      'strongShearWeakMoment',
      'shearBendingCapacityDesign',
      'capacityDesignShear',
    ]);
    const shearCompression = pickFirstDefined(structuralSources, [
      'shearCompression',
      'shearCompressionLimit',
      'shearCompressionCheck',
      'seismicShearCompression',
      'seismicShearCompressionLimit',
      'seismicShearCompressionCheck',
    ]);
    const jointCore = pickFirstDefined(structuralSources, ['jointCore', 'jointCoreStirrup', 'jointCoreStirrups', 'coreJoint', 'beamColumnJoint']);
    const jointData = pickFirstDefined(structuralSources, ['jointData', 'beamJointData', 'connection']);
    const flatBeam = pickFirstDefined(structuralSources, ['flatBeam', 'wideBeam']);
    const columnPosition = pickFirstDefined(structuralSources, ['columnPosition']);
    const columnCategory = pickFirstDefined(structuralSources, ['columnCategory']);
    const steelSeismicDetailing = pickFirstDefined(structuralSources, [
      'steelSeismicDetailing',
      'steelSeismicChecks',
      'steelDetailing',
      'seismicDetailing',
      'seismicDetailingChecks',
    ]);
    const steelSlenderness = pickFirstDefined(structuralSources, ['slenderness']);
    const steelWidthThickness = pickFirstDefined(structuralSources, ['widthThickness']);
    const resultKey = analysis['selectedResultKey'] ?? asRecord(analysis['selection'])['key'];
    const serviceKeys = memberDesign['serviceability_result_keys'];
    const serviceResult = Array.isArray(serviceKeys) && serviceKeys.includes(resultKey);
    const deflectionResponse = serviceResult ? memberDeflection(recovered) : undefined;
    if (serviceResult) for (const state of forceStates) {
      if (finiteNumber(state.forces['Mx'])) state.forces['M_service'] = state.forces['Mx'];
    }
    const numericDesign = Object.fromEntries(['l0', 'h0', 'phi', 'phi_b', 'phi_axial', 'beta1', 'btLimit',
      'lambdaLimit', 'deflectionLimitN', 'axialRatioLimit', 'crackWidthLimit', 'alpha_cr'].flatMap(key => {
      const value = pickFirstDefined(designSources, [key]);
      return finiteNumber(value) ? [[key, value]] : [];
    }));

    elementData[elemId] = {
      type: elem['type'],
      section: {
        A: A_mm2,
        ...(Iy_mm4 > 0 ? { I: Iy_mm4 } : {}),
        ...(Iz_mm4 > 0 ? { Iz: Iz_mm4 } : {}),
        ...(J_mm4 > 0 ? { J: J_mm4 } : {}),
        ...(i_min !== undefined ? { i: i_min } : {}),
        ...(derivedWnxMm3 > 0 ? { Wx: derivedWnxMm3, Wnx: derivedWnxMm3 } : {}),
        ...(derivedS_mm3 > 0 ? { S: derivedS_mm3 } : {}),
        ...(derivedTw_mm > 0 ? { tw: derivedTw_mm } : {}),
        ...(derivedAs_mm2 > 0 ? { As: derivedAs_mm2 } : {}),
        ...(effectiveWidth > 0 ? { width: effectiveWidth } : {}),
        ...(effectiveHeight > 0 ? { height: effectiveHeight } : {}),
        effectiveBendingAxis: swappedPrincipalAxes ? 'section-z' : 'section-y',
        ...(wallThickness !== undefined ? { wallThickness } : {}),
        ...(wallLength !== undefined ? { wallLength } : {}),
        ...(sectionObj?.['thickness'] !== undefined ? { thickness: sectionObj?.['thickness'] } : {}),
        ...(sectionReinforcement !== undefined ? { reinforcement: sectionReinforcement } : {}),
        ...(sectionProps && hasRecordKeys(sectionProps) ? { properties: sectionProps } : {}),
        ...(sectionExtra && hasRecordKeys(sectionExtra) ? { extra: sectionExtra } : {}),
        ...(typeof sectionProps['G'] === 'number' ? { G: sectionProps['G'] } : {}),
        ...(sectionShape ? { shape: sectionShape } : {}),
      },
      material: materialWithDesign,
      forces: forceStates.length === 1 ? forceStates[0]!.forces : {},
      forceStates,
      forceCoverage: recovered ? 'sampled_member_response' : forceStates.length ? 'endpoints_only' : 'unavailable',
      ...(forceInputIssue ? { forceInputIssue } : {}),
      ...(lengthMm !== undefined ? { length: lengthMm } : {}),
      ...numericDesign,
      ...(deflectionResponse ? { deflection: deflectionResponse.valueMm, deflectionResponse } : {}),
      serviceabilityResult: serviceResult,
      ...(elem['seismic_grade'] !== undefined ? { seismicGrade: elem['seismic_grade'] } : {}),
      ...(storyHeightMm !== undefined ? { storyHeightMm } : {}),
      ...(storyHeight !== undefined ? { storyHeight } : {}),
      ...(reinforcement !== undefined ? { reinforcement } : {}),
      ...(shearWall !== undefined ? { shearWall } : {}),
      ...(seismicWall !== undefined ? { seismicWall } : {}),
      ...(wallData !== undefined ? { wallData } : {}),
      ...(shearWallData !== undefined ? { shearWallData } : {}),
      ...(boundaryElement !== undefined ? { boundaryElement } : {}),
      ...(boundaryElements !== undefined ? { boundaryElements } : {}),
      ...(seismicCapacity !== undefined ? { seismicCapacity } : {}),
      ...(capacityDesign !== undefined ? { capacityDesign } : {}),
      ...(strongShearWeakBending !== undefined ? { strongShearWeakBending } : {}),
      ...(shearCompression !== undefined ? { shearCompression } : {}),
      ...(jointCore !== undefined ? { jointCore } : {}),
      ...(jointData !== undefined ? { jointData } : {}),
      ...(flatBeam !== undefined ? { flatBeam } : {}),
      ...(columnPosition !== undefined ? { columnPosition } : {}),
      ...(columnCategory !== undefined ? { columnCategory } : {}),
      ...(steelSeismicDetailing !== undefined ? { steelSeismicDetailing } : {}),
      ...(steelSlenderness !== undefined ? { slenderness: steelSlenderness } : {}),
      ...(steelWidthThickness !== undefined ? { widthThickness: steelWidthThickness } : {}),
      ...(hasRecordKeys(elemExtra) ? { extra: elemExtra } : {}),
    // Reinforcement is declared input, never a geometry-template minimum or design suggestion.
    ...rebarValues,
  };
  }

  return elementData;
}

export function buildCodeCheckInput(options: {
  traceId: string;
  designCode: string;
  model: Record<string, unknown>;
  analysis: unknown;
  analysisParameters: Record<string, unknown>;
  postprocessedResult?: Record<string, unknown>;
  codeCheckElements?: string[];
}): CodeCheckDomainInput {
  const model = withConfirmedReinforcement(options.model);
  // elementData: 合并 OpenSees 内力 + 模型截面/材料, 供 Python code-check 层真算
  const elementData = extractElementDataForCodeCheck(model, options.analysis);

  const elements = options.codeCheckElements?.length ? options.codeCheckElements : extractElementIds(options.model);
  const context: CodeCheckDomainInput['context'] = {
    source: {
      ...asRecord(asRecord(options.analysis)['meta']),
      resultKey: asRecord(options.analysis)['selectedResultKey'] ?? asRecord(asRecord(options.analysis)['selection'])['key'],
      designCode: options.designCode,
      modelId: options.traceId,
    },
    analysisSummary: extractAnalysisSummary(options.analysis),
    // Utilizations must be computed from the bound model and result vectors.
    // Caller-supplied ratios cannot override missing forces or design properties.
    utilizationByElement: {},
    elementContextById: extractElementContextById(model),
    modelSummary: extractModelSummary(model),
    elementData,
  };

  return {
    modelId: options.traceId,
    code: options.designCode,
    elements: appendGlobalSeismicElement(elements, options.designCode, options.analysis),
    context: isGB50011DesignCode(options.designCode)
      ? withGB50011CodeCheckMetadata(context)
      : context,
  };
}

export async function executeCodeCheckDomain(
  engineClient: CodeCheckClient,
  input: CodeCheckDomainInput,
  engineId?: string,
  requestOptions?: ExecutionRequestOptions,
): Promise<unknown> {
  const rule = resolveCodeCheckRule(input.code);
  return rule.execute(engineClient, input, engineId, requestOptions);
}
