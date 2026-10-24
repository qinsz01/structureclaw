import { trussPanelGeometry } from '../../skill-shared/modelling/geometry.js';
/** Planar truss template model. */
import type { DraftState, EngineeringDraftLoad } from '../../shared/types/agent.js';
import { compileTemplateLoadCases } from './load-cases.js';
import { PINNED_RESTRAINT, ROLLER_X_RESTRAINT } from '../../engineering/coordinate-semantics.js';

function getTrussTopology(state: DraftState): string {
  const topology = state.skillState?.trussTopology;
  return typeof topology === 'string' ? topology : 'generic';
}

function getTrussLoadChord(state: DraftState): 'top' | 'bottom' | undefined {
  const chord = state.skillState?.trussLoadChord;
  if (chord === 'top' || chord === 'bottom') return chord;
  return state.loadPosition === 'top-nodes' ? 'top' : undefined;
}

function loadTargetError(field: string): Error {
  return new Error(`MODEL_EDIT_FIELD_INVALID: ${field} requires an explicit valid truss load target. / 桁架荷载需要明确有效的节点或标准选择器，不能猜测或丢弃荷载。`);
}

function clampTrussPanelCount(value: number | undefined, span: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return Math.max(2, Math.min(30, Math.round(span / 3)));
  }
  return Math.max(2, Math.min(30, Math.round(value)));
}

function buildExplicitTrussTopology(state: DraftState): {
  nodes: Array<Record<string, unknown>>;
  elements: Array<Record<string, unknown>>;
} | null {
  const topology = state.engineeringDraft?.topology;
  if (topology?.nodes === undefined && topology?.members === undefined) return null;
  if (!topology?.nodes?.length || !topology.members?.length) throw loadTargetError('topology.nodes/members');
  const nodeIds = new Set(topology.nodes.map((node) => node.id));
  if (nodeIds.size !== topology.nodes.length
    || topology.nodes.some(node => !node.id || ![node.x, node.y, node.z].every(Number.isFinite))
    || topology.members.some((member) => !nodeIds.has(member.nodes[0]) || !nodeIds.has(member.nodes[1]))) {
    throw loadTargetError('topology node IDs/coordinates/member references');
  }

  const nodes = topology.nodes.map((node) => ({
    id: node.id,
    x: node.x,
    y: node.y,
    z: node.z,
    ...(node.restraints
      ? {
          restraints: node.restraints[0] || node.restraints[2]
            ? [
                node.restraints[0],
                true,
                node.restraints[2],
                node.restraints[3],
                node.restraints[4],
                node.restraints[5],
              ]
            : [...node.restraints],
        }
      : {}),
  }));
  if (!nodes.some((node) => 'restraints' in node)) {
    const minZ = Math.min(...topology.nodes.map((node) => node.z));
    const baseNodes = topology.nodes
      .filter((node) => Math.abs(node.z - minZ) <= 1e-9)
      .sort((left, right) => left.x - right.x || left.y - right.y);
    const left = nodes.find((node) => node.id === baseNodes[0]?.id);
    const right = nodes.find((node) => node.id === baseNodes[baseNodes.length - 1]?.id);
    if (left) left.restraints = [...PINNED_RESTRAINT];
    if (right && right !== left) right.restraints = [...ROLLER_X_RESTRAINT];
  }

  return {
    nodes,
    elements: topology.members.map((member, index) => ({
      id: member.id ?? `E${index + 1}`,
      type: 'truss',
      nodes: [...member.nodes],
      material: '1',
      section: '1',
    })),
  };
}

function buildExplicitTrussLoads(
  state: DraftState,
  nodes: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const nodeIds = new Set(nodes.map((node) => String(node.id)));
  const coordinates = nodes.filter((node): node is Record<string, unknown> & {
    id: string;
    x: number;
    z: number;
  } => (
    typeof node.id === 'string'
    && typeof node.x === 'number'
    && typeof node.z === 'number'
  ));
  const minX = Math.min(...coordinates.map((node) => Number(node.x)));
  const maxX = Math.max(...coordinates.map((node) => Number(node.x)));
  const minZ = Math.min(...coordinates.map((node) => Number(node.z)));

  function semanticTargetIds(load: EngineeringDraftLoad): string[] {
    const role = load.location?.nodeRole ?? load.target;
    const chord = role === 'top' || role === 'top-nodes' || role === 'interior-top-nodes'
      ? 'top'
      : role === 'bottom' || role === 'bottom-nodes' || role === 'interior-bottom-nodes'
        ? 'bottom'
        : undefined;
    const locationX = load.location?.xM;
    if (locationX !== undefined) {
      if (!Number.isFinite(locationX)) throw loadTargetError('location.xM');
      const nodesAtLocation = coordinates.filter(
        (node) => Math.abs(Number(node.x) - locationX) <= 1e-9,
      );
      const locatedTargets = chord
        ? nodesAtLocation.filter((node) => (
            chord === 'top'
              ? Number(node.z) > minZ + 1e-9
              : Math.abs(Number(node.z) - minZ) <= 1e-9
          ))
        : nodesAtLocation.length === 1
          ? nodesAtLocation
          : [];
      if (locatedTargets.length === 1) {
        return locatedTargets
          .sort((left, right) => (
            Number(left.z) - Number(right.z)
            || Number(left.x) - Number(right.x)
            || String(left.id).localeCompare(String(right.id))
          ))
          .map((node) => String(node.id));
      }
      throw loadTargetError('location.xM');
    }
    if (!chord) return [];

    return coordinates
      .filter((node) => (
        Number(node.x) > minX + 1e-9
        && Number(node.x) < maxX - 1e-9
        && (chord === 'top'
          ? Number(node.z) > minZ + 1e-9
          : Math.abs(Number(node.z) - minZ) <= 1e-9)
      ))
      .sort((left, right) => (
        Number(left.x) - Number(right.x)
        || Number(left.z) - Number(right.z)
        || String(left.id).localeCompare(String(right.id))
      ))
      .map((node) => String(node.id));
  }

  return (state.engineeringDraft?.loads ?? []).flatMap((load) => {
    const target = load.target;
    if ((load.kind !== 'point' && load.kind !== 'nodal') || load.unit !== 'kN' || !Number.isFinite(load.magnitude)) {
      throw loadTargetError('load kind/unit/magnitude');
    }
    const targets = target && nodeIds.has(target) ? [target] : semanticTargetIds(load);
    if (targets.length === 0) throw loadTargetError('load.target');
    const component = load.direction === 'globalX' ? 'fx' : load.direction === 'globalY' ? 'fy' : 'fz';
    const sign = component === 'fz' && load.direction !== 'globalZ' ? -1 : 1;
    return targets.map((node) => ({ node, [component]: sign * load.magnitude }));
  });
}

export function buildTrussModel(state: DraftState, metadata: Record<string, unknown>): Record<string, unknown> {
  const span = state.lengthM!;
  const panelCount = clampTrussPanelCount(state.bayCount, span);
  const height = state.heightM ?? span / 6;
  const load = state.loadKN!;
  const topology = getTrussTopology(state);
  const panelLength = span / panelCount;
  const explicitTopology = buildExplicitTrussTopology(state);
  const generated = explicitTopology ?? trussPanelGeometry({ span, height, panels: panelCount, topology: topology === 'trapezoidal' ? 'trapezoidal' : 'generic' });
  const { nodes, elements } = generated;

  const loadChord = getTrussLoadChord(state);
  const loadPrefix = loadChord === 'bottom' ? 'B' : 'T';
  const loadNodeIndexes = state.loadPosition === 'middle-joint'
    ? [Math.max(1, Math.min(panelCount - 1, Math.round(panelCount / 2)))]
    : Array.from({ length: Math.max(0, panelCount - 1) }, (_, index) => index + 1);
  const explicitLoads = buildExplicitTrussLoads(state, nodes);
  if (!state.engineeringDraft?.loads?.length && (!loadChord || !Number.isFinite(load)
    || !['middle-joint', 'top-nodes'].includes(state.loadPosition ?? ''))) {
    throw loadTargetError('load position/chord');
  }
  const nodalLoads = explicitLoads.length > 0
    ? explicitLoads
    : loadNodeIndexes.map((index) => ({ node: `${loadPrefix}${index}`, fz: -load }));

  return {
    schema_version: '2.2.0',
    unit_system: 'SI',
    nodes,
    elements,
    materials: [],
    sections: [],
    load_cases: state.engineeringDraft?.loads?.length ? compileTemplateLoadCases(state.engineeringDraft.loads, state.engineeringDraft.loadCases,
      load => buildExplicitTrussLoads({ ...state, engineeringDraft: { ...state.engineeringDraft, loads: [load] } }, nodes))
      : [{ id: 'LC1', type: 'other', loads: nodalLoads }],
    load_combinations: [],
    metadata: {
      ...metadata,
      trussTopology: topology,
      topologySource: explicitTopology ? 'engineering-draft' : 'generated',
      loadChord,
      panelCount,
      panelCountDefaulted: state.bayCount === undefined,
      heightDefaulted: state.heightM === undefined,
      geometry: {
        spanM: span,
        heightM: height,
        panelLengthM: panelLength,
      },
    },
  };
}
