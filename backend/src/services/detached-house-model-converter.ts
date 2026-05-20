export interface DetachedHouseFloor {
  id: string;
  elevation?: number;
  height?: number;
  columns?: DetachedHouseColumn[];
  beams?: DetachedHouseBeam[];
}

export interface DetachedHouseColumn {
  id: string;
  x: number;
  y: number;
  width?: number;
  depth?: number;
}

export interface DetachedHouseBeam {
  id: string;
  line: [number, number, number, number];
  width?: number;
  height?: number;
}

interface EnsureNodeArgs {
  nodes: Array<Record<string, unknown>>;
  nodeIds: Map<string, string>;
  level: DetachedHouseLevel;
  x: number;
  y: number;
}

interface DetachedHouseLevel {
  id: string;
  storyId: string;
  elevation: number;
}

export function convertDetachedHouseDesignToStructureModel(design: Record<string, unknown>): Record<string, unknown> {
  const floors = readFloors(design);
  const nodes: Array<Record<string, unknown>> = [];
  const elements: Array<Record<string, unknown>> = [];
  const sections = new Map<string, Record<string, unknown>>();
  const nodeIds = new Map<string, string>();

  const stories = floors.map((floor) => ({
    id: floor.id,
    height: mmToM(floor.height ?? 3300),
    elevation: mmToM(floor.elevation ?? 0),
    is_basement: false,
    rigid_diaphragm: true,
    dead_load: 4.0,
    live_load: 2.0,
    floor_loads: [{ type: 'dead', value: 4.0 }, { type: 'live', value: 2.0 }],
  }));

  for (const floor of floors) {
    const baseLevel = floorBaseLevel(floor);
    const topLevel = floorTopLevel(floors, floor);
    for (const column of floor.columns ?? []) {
      ensureNode({ nodes, nodeIds, level: baseLevel, x: column.x, y: column.y });
      ensureNode({ nodes, nodeIds, level: topLevel, x: column.x, y: column.y });
      ensureSection(sections, 'column', column.width ?? 350, column.depth ?? column.width ?? 350);
    }
    for (const beam of floor.beams ?? []) {
      ensureNode({ nodes, nodeIds, level: topLevel, x: beam.line[0], y: beam.line[1] });
      ensureNode({ nodes, nodeIds, level: topLevel, x: beam.line[2], y: beam.line[3] });
      ensureSection(sections, 'beam', beam.width ?? 250, beam.height ?? 500);
    }
  }

  for (const floor of floors) {
    const baseLevel = floorBaseLevel(floor);
    const topLevel = floorTopLevel(floors, floor);
    for (const column of floor.columns ?? []) {
      const sectionId = sectionIdFor('column', column.width ?? 350, column.depth ?? column.width ?? 350);
      elements.push({
        id: `COL_${floor.id}_${column.id}`,
        type: 'column',
        nodes: [
          nodeKeyToId(nodeIds, baseLevel.id, column.x, column.y),
          nodeKeyToId(nodeIds, topLevel.id, column.x, column.y),
        ],
        material: 'conc1',
        section: sectionId,
        story: floor.id,
        concrete_grade: (floor.elevation ?? 0) === 0 ? 'C35' : 'C30',
      });
    }
  }

  for (const floor of floors) {
    const topLevel = floorTopLevel(floors, floor);
    for (const beam of floor.beams ?? []) {
      const sectionId = sectionIdFor('beam', beam.width ?? 250, beam.height ?? 500);
      elements.push({
        id: `BM_${floor.id}_${beam.id}`,
        type: 'beam',
        nodes: [
          nodeKeyToId(nodeIds, topLevel.id, beam.line[0], beam.line[1]),
          nodeKeyToId(nodeIds, topLevel.id, beam.line[2], beam.line[3]),
        ],
        material: 'conc1',
        section: sectionId,
        story: topLevel.storyId,
        concrete_grade: 'C30',
      });
    }
  }

  if (nodes.length === 0 || elements.length === 0) {
    throw new Error('Detached-house design did not produce analyzable nodes and elements');
  }

  return {
    schema_version: '2.0.0',
    unit_system: 'SI',
    project: {
      name: readProjectName(design),
      code_standard: 'GB50010-2010',
      design_life: 50,
      importance_class: '丙',
    },
    structure_system: { type: 'frame', seismic_grade: 'third' },
    stories,
    nodes,
    elements,
    materials: [
      { id: 'conc1', name: 'C30', E: 30000, nu: 0.2, rho: 2500, grade: 'C30', category: 'concrete' },
      { id: 'rebar1', name: 'HRB400', E: 200000, nu: 0.3, rho: 7850, fy: 400, grade: 'HRB400', category: 'rebar' },
    ],
    sections: Array.from(sections.values()),
    load_cases: [
      { id: 'D', type: 'dead', kind: 'permanent', loads: [], description: '恒荷载' },
      { id: 'L', type: 'live', kind: 'variable', loads: [], description: '活荷载' },
    ],
    load_combinations: [
      { id: 'ULS1', factors: { D: 1.2, L: 1.4 }, combination_type: 'uls' },
      { id: 'SLS1', factors: { D: 1.0, L: 1.0 }, combination_type: 'sls' },
    ],
    wall_openings: [],
    slab_openings: [],
    metadata: { source: 'detached_house_design' },
  };
}

function readFloors(design: Record<string, unknown>): DetachedHouseFloor[] {
  const rawFloors = design.floors;
  if (!Array.isArray(rawFloors)) {
    throw new Error('Detached-house design must contain at least two floors with columns');
  }
  const floors = rawFloors
    .map(readFloor)
    .filter((floor): floor is DetachedHouseFloor => floor !== null)
    .sort((a, b) => (a.elevation ?? 0) - (b.elevation ?? 0));
  const columnFloors = floors.filter((floor) => (floor.columns ?? []).length > 0);
  if (columnFloors.length < 2) {
    throw new Error('Detached-house design must contain at least two floors with columns');
  }
  return floors;
}

function readFloor(value: unknown): DetachedHouseFloor | null {
  if (!isRecord(value) || typeof value.id !== 'string') return null;
  return {
    id: value.id,
    elevation: readNumber(value.elevation),
    height: readNumber(value.height),
    columns: Array.isArray(value.columns) ? value.columns.map(readColumn).filter((item): item is DetachedHouseColumn => item !== null) : [],
    beams: Array.isArray(value.beams) ? value.beams.map(readBeam).filter((item): item is DetachedHouseBeam => item !== null) : [],
  };
}

function readColumn(value: unknown): DetachedHouseColumn | null {
  if (!isRecord(value) || typeof value.id !== 'string') return null;
  const x = readNumber(value.x);
  const y = readNumber(value.y);
  if (x === undefined || y === undefined) return null;
  return {
    id: value.id,
    x,
    y,
    width: readNumber(value.width),
    depth: readNumber(value.depth),
  };
}

function readBeam(value: unknown): DetachedHouseBeam | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !Array.isArray(value.line) || value.line.length !== 4) {
    return null;
  }
  const line = value.line.map(readNumber);
  if (line.some((item) => item === undefined)) return null;
  return {
    id: value.id,
    line: line as [number, number, number, number],
    width: readNumber(value.width),
    height: readNumber(value.height),
  };
}

function ensureNode(args: EnsureNodeArgs): string {
  const key = nodeKey(args.level.id, args.x, args.y);
  const existing = args.nodeIds.get(key);
  if (existing) return existing;
  const id = `N_${args.level.id}_${formatCoord(args.x)}_${formatCoord(args.y)}`;
  args.nodeIds.set(key, id);
  const node: Record<string, unknown> = {
    id,
    x: mmToM(args.x),
    y: mmToM(args.y),
    z: mmToM(args.level.elevation),
    story: args.level.storyId,
  };
  if (args.level.elevation === 0) {
    node.restraints = [true, true, true, true, true, true];
  }
  args.nodes.push(node);
  return id;
}

function ensureSection(
  sections: Map<string, Record<string, unknown>>,
  purpose: 'column' | 'beam',
  width: number,
  height: number,
): void {
  const id = sectionIdFor(purpose, width, height);
  if (sections.has(id)) return;
  sections.set(id, {
    id,
    name: `${purpose === 'column' ? '柱' : '梁'} ${width}x${height}`,
    type: 'rectangular',
    purpose,
    shape: { kind: 'rectangular', H: height, B: width },
    width,
    height,
    properties: { A: width * height },
  });
}

function floorBaseLevel(floor: DetachedHouseFloor): DetachedHouseLevel {
  return {
    id: floor.id,
    storyId: floor.id,
    elevation: floor.elevation ?? 0,
  };
}

function floorTopLevel(floors: DetachedHouseFloor[], floor: DetachedHouseFloor): DetachedHouseLevel {
  const elevation = floorTopElevation(floor);
  const matchingFloor = findFloorAtElevation(floors, elevation);
  if (matchingFloor) {
    return {
      id: matchingFloor.id,
      storyId: matchingFloor.id,
      elevation,
    };
  }
  return {
    id: `${floor.id}_TOP`,
    storyId: floor.id,
    elevation,
  };
}

function floorTopElevation(floor: DetachedHouseFloor): number {
  return (floor.elevation ?? 0) + (floor.height ?? 3300);
}

function findFloorAtElevation(floors: DetachedHouseFloor[], elevation: number): DetachedHouseFloor | undefined {
  return floors.find((floor) => nearlyEqual(floor.elevation ?? 0, elevation));
}

function nearlyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) < 1e-6;
}

function nodeKeyToId(nodeIds: Map<string, string>, levelId: string, x: number, y: number): string {
  const id = nodeIds.get(nodeKey(levelId, x, y));
  if (!id) throw new Error(`Missing node for ${levelId} (${x}, ${y})`);
  return id;
}

function nodeKey(levelId: string, x: number, y: number): string {
  return `${levelId}:${formatCoord(x)}:${formatCoord(y)}`;
}

function sectionIdFor(purpose: 'column' | 'beam', width: number, height: number): string {
  return `${purpose === 'column' ? 'col' : 'beam'}_${formatCoord(width)}x${formatCoord(height)}`;
}

function readProjectName(design: Record<string, unknown>): string {
  const project = isRecord(design.project) ? design.project : {};
  return typeof project.name === 'string' && project.name.trim() ? project.name : 'Detached house';
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function mmToM(value: number): number {
  return Number((value / 1000).toFixed(6));
}

function formatCoord(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value).replace(/\./g, '_');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
