/** Continuous (double-span) beam and portal frame template models. */
import type { DraftState } from '../../shared/types/agent.js';
import { readPositiveNumberArray, readPositiveInteger, readNonNegativeNumberArray, accumulateCoordinates, readSignedNumber, readNonNegativeNumber, coordinateMatches, readPositiveNumber, buildFixedRestraint } from './readers.js';
import { buildSemanticBeamModel } from './beam.js';
import { compileTemplateLoadCases } from './load-cases.js';
import { PINNED_RESTRAINT, ROLLER_X_RESTRAINT } from '../../engineering/coordinate-semantics.js';

function getContinuousBeamSpanLengths(state: DraftState): number[] {
  const explicit = readPositiveNumberArray(state.skillState?.spanLengthsM);
  if (explicit?.length) {
    return explicit;
  }
  const span = state.spanLengthM!;
  const spanCount = Math.max(2, readPositiveInteger(state.skillState?.spanCount) ?? 2);
  return Array.from({ length: spanCount }, () => span);
}

export function buildContinuousBeamModel(state: DraftState, metadata: Record<string, unknown>): Record<string, unknown> {
  const spans = getContinuousBeamSpanLengths(state);
  const totalLength = spans.reduce((sum, span) => sum + span, 0);
  const topologyNodes = state.engineeringDraft?.topology?.nodes ?? [];
  const boundarySupports = readNonNegativeNumberArray(state.engineeringDraft?.boundary?.supportPositionsM)
    ?.filter((x) => x <= totalLength);
  const topologySupports = topologyNodes
    .filter((node) => Array.isArray(node.restraints) && node.restraints.some(Boolean))
    .map((node) => node.x)
    .filter((x) => x >= 0 && x <= totalLength);
  const supportCoordinates = Array.from(new Set(
    boundarySupports?.length
      ? boundarySupports
      : topologySupports.length
        ? topologySupports
        : accumulateCoordinates(spans),
  )).sort((left, right) => left - right);
  if (state.engineeringDraft?.loads?.length) {
    const model = buildSemanticBeamModel({ ...state, lengthM: totalLength, supportType: 'simply-supported',
      engineeringDraft: { ...state.engineeringDraft, geometry: { ...state.engineeringDraft.geometry, spanLengthsM: spans },
        boundary: { ...state.engineeringDraft.boundary, supportPositionsM: supportCoordinates } } },
    { ...metadata, spanCount: spans.length, geometry: { spanLengthsM: spans } },
    state.engineeringDraft.loads as unknown as Array<Record<string, unknown>>);
    // Retain explicitly authored boundary restraints at matching coordinates.
    for (const node of model.nodes as Array<Record<string, unknown>>) {
      const authored = topologyNodes.find(candidate => coordinateMatches(candidate.x, node.x as number));
      if (authored?.restraints) node.restraints = [...authored.restraints];
    }
    return model;
  }
  const explicitPointLoad = readSignedNumber(state.skillState?.pointLoadKN);
  const pointLoad = explicitPointLoad
    ?? (state.loadType === 'point' ? state.loadKN : undefined);
  const pointSpanIndex = state.skillState?.pointLoadSpanIndex;
  const explicitPointLoadX = readNonNegativeNumber(state.skillState?.pointLoadXM);
  const middleSupportX = supportCoordinates.length > 2
    ? supportCoordinates[Math.floor((supportCoordinates.length - 1) / 2)]
    : undefined;
  const spanBoundaries = accumulateCoordinates(spans);
  let pointLoadX = explicitPointLoadX;
  if (pointLoad !== undefined) {
    if (state.skillState?.pointLoadXM !== undefined && (pointLoadX === undefined || pointLoadX > totalLength)) throw loadTargetError('pointLoadXM');
    if (pointLoadX === undefined && state.loadPosition === 'middle-joint' && middleSupportX !== undefined) pointLoadX = middleSupportX;
    if (pointLoadX === undefined && state.loadPosition === 'end') pointLoadX = totalLength;
    if (pointLoadX === undefined && state.loadPosition === 'midspan' && typeof pointSpanIndex === 'number'
      && Number.isInteger(pointSpanIndex) && pointSpanIndex >= 1 && pointSpanIndex <= spans.length) {
      pointLoadX = spanBoundaries[pointSpanIndex - 1]! + spans[pointSpanIndex - 1]! / 2;
    }
    if (pointLoadX === undefined) throw loadTargetError('point load location');
  }
  const coordinates = Array.from(new Set([
    ...supportCoordinates,
    ...topologyNodes.map((node) => node.x).filter((x) => x >= 0 && x <= totalLength),
    ...(pointLoadX !== undefined ? [pointLoadX] : []),
  ])).sort((left, right) => left - right);
  const pinned = [...PINNED_RESTRAINT];
  const roller = [...ROLLER_X_RESTRAINT];
  const nodes = coordinates.map((x, index) => {
    const supportIndex = supportCoordinates.findIndex((supportX) => Math.abs(supportX - x) < 1e-9);
    const topologyNode = topologyNodes.find((node) => Math.abs(node.x - x) < 1e-9);
    const node: Record<string, unknown> = { id: `${index + 1}`, x, y: 0, z: 0 };
    if (topologyNode?.restraints) {
      node.restraints = [...topologyNode.restraints];
    } else if (supportIndex >= 0) {
      node.restraints = supportIndex === 0 ? pinned : roller;
    }
    return node;
  });
  const elements = coordinates.slice(0, -1).map((_x, index) => ({
    id: `${index + 1}`,
    type: 'beam',
    nodes: [`${index + 1}`, `${index + 2}`],
    material: '1',
    section: '1',
  }));
  const distributedLoad = readSignedNumber(state.skillState?.distributedLoadKNM)
    ?? ((state.loadType === 'distributed' || state.loadPosition === 'full-span') ? state.loadKN : undefined);
  const loads: Array<Record<string, unknown>> = [];
  if (distributedLoad !== undefined) {
    if (state.loadPosition !== 'full-span') throw loadTargetError('distributed load extent');
    for (const element of elements) {
      loads.push({ type: 'distributed', element: element.id, wz: -distributedLoad, wy: 0 });
    }
  }
  if (pointLoad !== undefined && pointLoadX !== undefined) {
    const nodeIndex = coordinates.findIndex((x) => Math.abs(x - pointLoadX) < 1e-9);
    loads.push({ node: `${nodeIndex + 1}`, fz: -pointLoad });
  }
  if (loads.length === 0) throw loadTargetError('loads');

  return {
    schema_version: '2.2.0',
    unit_system: 'SI',
    nodes,
    elements,
    materials: [],
    sections: [],
    load_cases: [{ id: 'LC1', type: 'other', loads }],
    load_combinations: [],
    metadata: {
      ...metadata,
      spanCount: spans.length,
      geometry: {
        spanLengthsM: spans,
      },
    },
  };
}

function getPortalFrameSpanLengths(state: DraftState): number[] {
  const explicit = readPositiveNumberArray(state.skillState?.portalBaySpansM);
  if (explicit?.length) {
    return explicit;
  }
  const span = state.spanLengthM!;
  const bayCount = Math.max(1, readPositiveInteger(state.skillState?.portalBayCount) ?? 1);
  return Array.from({ length: bayCount }, () => span);
}

function loadTargetError(field: string): Error {
  return new Error(`MODEL_EDIT_FIELD_INVALID: ${field} requires an explicit valid load target. / 荷载需要明确有效的作用目标，不能猜测位置或作用范围。`);
}

function buildPortalDraftLoads(state: DraftState, nodes: Array<Record<string, unknown>>,
  elements: Array<Record<string, unknown>>, xCoordinates: number[]): Array<Record<string, unknown>> {
  return (state.engineeringDraft?.loads ?? []).flatMap<Record<string, unknown>>((load) => {
    if (!Number.isFinite(load.magnitude)) throw loadTargetError('load.magnitude');
    const target = load.target;
    const role = load.location?.nodeRole;
    if (load.kind === 'line' || load.kind === 'distributed') {
      if (load.unit !== 'kN/m') throw loadTargetError('line load unit');
      const span = load.location?.spanIndex;
      let targets: Array<Record<string, unknown>>;
      if (span !== undefined) {
        if (!Number.isInteger(span) || span < 1 || span >= xCoordinates.length) throw loadTargetError('location.spanIndex');
        if (target !== undefined && target !== 'roof' && target !== 'all-roof-beams' && target !== `R${span - 1}`) {
          throw loadTargetError('line load target/spanIndex');
        }
        targets = elements.filter(element => element.id === `R${span - 1}`);
      } else if (target === 'roof' || target === 'all-roof-beams') {
        targets = elements.filter(element => xCoordinates.slice(1).some((_x, index) => element.id === `R${index}`));
      } else if (target === 'mezzanine') targets = elements.filter(element => element.id === 'MEZ1');
      else targets = elements.filter(element => element.id === target);
      if (!targets.length) throw loadTargetError('line load target');
      const axis = load.direction === 'globalX' ? 'wx' : load.direction === 'globalY' ? 'wy' : 'wz';
      return targets.map(element => ({ type: 'distributed', element: element.id,
        [axis]: axis === 'wz' && load.direction !== 'globalZ' ? -load.magnitude : load.magnitude }));
    }
    if ((load.kind !== 'point' && load.kind !== 'nodal') || load.unit !== 'kN') throw loadTargetError('nodal load kind/unit');
    let targets = nodes.filter(node => node.id === target);
    if (!targets.length) {
      let index: number | undefined;
      if (load.location?.xM !== undefined) {
        if (role !== 'column-top' && role !== 'top-nodes' && target !== 'roof') throw loadTargetError('nodal load nodeRole');
        index = xCoordinates.findIndex(x => coordinateMatches(x, load.location!.xM!));
        if (index < 0) throw loadTargetError('location.xM');
      } else if (role === 'left-column-top') index = 0;
      else if (role === 'right-column-top') index = xCoordinates.length - 1;
      else if (role === 'middle-column-top' && xCoordinates.length % 2 === 1) index = (xCoordinates.length - 1) / 2;
      if (index !== undefined) targets = nodes.filter(node => node.id === `T${index}`);
      else if (role === 'top-nodes' || target === 'top-nodes') {
        targets = nodes.filter(node => xCoordinates.some((_x, i) => node.id === `T${i}`));
      }
    }
    if (!targets.length) throw loadTargetError('nodal load target');
    const component = load.direction === 'globalX' ? 'fx' : load.direction === 'globalY' ? 'fy' : 'fz';
    return targets.map(node => ({ node: node.id,
      [component]: component === 'fz' && load.direction !== 'globalZ' ? -load.magnitude : load.magnitude }));
  });
}

export function buildPortalFrameModel(state: DraftState, metadata: Record<string, unknown>): Record<string, unknown> {
  const spans = getPortalFrameSpanLengths(state);
  const xCoordinates = accumulateCoordinates(spans);
  const height = state.heightM!;
  const hasDraftLoads = Boolean(state.engineeringDraft?.loads?.length);
  const roofLoad = hasDraftLoads ? undefined : readSignedNumber(state.skillState?.roofLoadKNM)
    ?? ((state.loadType === 'distributed' || state.loadPosition === 'full-span') ? state.loadKN : undefined);
  const nodalLoad = !hasDraftLoads && roofLoad === undefined ? state.loadKN : undefined;
  const mezzanineHeight = readPositiveNumber(state.skillState?.mezzanineHeightM);
  const mezzanineLength = readPositiveNumber(state.skillState?.mezzanineLengthM);
  const mezzanineLoad = readSignedNumber(state.skillState?.mezzanineLoadKN);
  const hasMezzanine = mezzanineHeight !== undefined
    && mezzanineHeight < height
    && mezzanineLength !== undefined
    && mezzanineLength <= spans[0]
    && spans.length >= 1;
  const baseRestraint = buildFixedRestraint(state.frameBaseSupportType || 'fixed');
  const nodes: Array<Record<string, unknown>> = [];
  const elements: Array<Record<string, unknown>> = [];
  const loads: Array<Record<string, unknown>> = [];

  for (let i = 0; i < xCoordinates.length; i += 1) {
    nodes.push({ id: `B${i}`, x: xCoordinates[i], y: 0, z: 0, restraints: [...baseRestraint] });
    nodes.push({ id: `T${i}`, x: xCoordinates[i], y: 0, z: height });
  }
  if (hasMezzanine) {
    nodes.push({ id: 'M0', x: 0, y: 0, z: mezzanineHeight });
    nodes.push({ id: 'M1', x: mezzanineLength, y: 0, z: mezzanineHeight });
  }

  for (let i = 0; i < xCoordinates.length; i += 1) {
    if (hasMezzanine && i === 0) {
      elements.push({ id: `C${i}a`, type: 'column', nodes: [`B${i}`, 'M0'], material: '1', section: '1' });
      elements.push({ id: `C${i}b`, type: 'column', nodes: ['M0', `T${i}`], material: '1', section: '1' });
    } else {
      elements.push({ id: `C${i}`, type: 'column', nodes: [`B${i}`, `T${i}`], material: '1', section: '1' });
    }
  }
  for (let i = 0; i < spans.length; i += 1) {
    const element = { id: `R${i}`, type: 'beam', nodes: [`T${i}`, `T${i + 1}`], material: '1', section: '1' };
    elements.push(element);
    if (roofLoad !== undefined) {
      loads.push({ type: 'distributed', element: element.id, wz: -roofLoad, wy: 0 });
    }
  }
  if (hasMezzanine) {
    const mezzanineElement = { id: 'MEZ1', type: 'beam', nodes: ['M0', 'M1'], material: '1', section: '1' };
    elements.push(mezzanineElement);
    if (!hasDraftLoads && mezzanineLoad !== undefined) {
      loads.push({ type: 'distributed', element: mezzanineElement.id, wz: -mezzanineLoad, wy: 0 });
    }
  }
  if (nodalLoad !== undefined) {
    if (state.loadPosition !== 'top-nodes') throw loadTargetError('nodal load position');
    const perTopNode = -nodalLoad / xCoordinates.length;
    for (let i = 0; i < xCoordinates.length; i += 1) {
      loads.push({ type: 'nodal', node: `T${i}`, forces: [0, 0, perTopNode, 0, 0, 0] });
    }
  }
  if (hasDraftLoads) loads.push(...buildPortalDraftLoads(state, nodes, elements, xCoordinates));
  else if (state.skillState?.craneLoadKN !== undefined) throw loadTargetError('craneLoadKN node');
  if (!loads.length) throw loadTargetError('loads');

  return {
    schema_version: '2.2.0',
    unit_system: 'SI',
    nodes,
    elements,
    materials: [],
    sections: [],
    load_cases: hasDraftLoads ? compileTemplateLoadCases(state.engineeringDraft!.loads!, state.engineeringDraft?.loadCases,
      load => buildPortalDraftLoads({ ...state, engineeringDraft: { ...state.engineeringDraft, loads: [load] } }, nodes, elements, xCoordinates))
      : [{ id: 'LC1', type: 'other', loads }],
    load_combinations: [],
    metadata: {
      ...metadata,
      bayCount: spans.length,
      hasMezzanine,
      // An unstated base condition is modelled as fixed and reported as an assumption, not asked for.
      ...(state.frameBaseSupportType ? {} : { templateAssumptions: [{ field: 'frameBaseSupportType', value: 'fixed',
        zh: '柱脚约束未说明，按刚接（固定）柱脚计算', en: 'Column bases were not specified; fixed bases were assumed' }] }),
      geometry: {
        spanLengthsM: spans,
        heightM: height,
        mezzanineHeightM: hasMezzanine ? mezzanineHeight : undefined,
        mezzanineLengthM: hasMezzanine ? mezzanineLength : undefined,
      },
    },
  };
}
