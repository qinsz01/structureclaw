import { describe, expect, test } from '@jest/globals';
import { convertDetachedHouseDesignToStructureModel } from '../../../dist/services/detached-house-model-converter.js';

const design = {
  version: '0.1',
  project: { name: 'MVP detached house', units: 'mm', structure_type: 'rc_frame' },
  floors: [
    {
      id: 'F1', elevation: 0, height: 3600,
      columns: [{ id: 'C1', x: 0, y: 0, width: 400, depth: 400 }, { id: 'C2', x: 6000, y: 0, width: 400, depth: 400 }],
      beams: [{ id: 'B1', line: [0, 0, 6000, 0], width: 250, height: 500 }],
    },
    {
      id: 'F2', elevation: 3600, height: 3300,
      columns: [{ id: 'C1', x: 0, y: 0, width: 350, depth: 350 }, { id: 'C2', x: 6000, y: 0, width: 350, depth: 350 }],
      beams: [{ id: 'B2', line: [0, 0, 6000, 0], width: 250, height: 450 }],
    },
    {
      id: 'F3', elevation: 6900, height: 3300,
      columns: [{ id: 'C1', x: 0, y: 0, width: 350, depth: 350 }, { id: 'C2', x: 6000, y: 0, width: 350, depth: 350 }],
      beams: [{ id: 'B3', line: [0, 0, 6000, 0], width: 250, height: 450 }],
    },
  ],
};

describe('convertDetachedHouseDesignToStructureModel', () => {
  test('builds stories, nodes, columns, beams, materials, sections, and load cases', () => {
    const result = convertDetachedHouseDesignToStructureModel(design);

    expect(result.schema_version).toBe('2.0.0');
    expect(result.unit_system).toBe('SI');
    expect(result.stories.map((story) => story.id)).toEqual(['F1', 'F2', 'F3']);
    expect(result.stories[1].elevation).toBe(3.6);
    expect(result.nodes.some((node) => node.x === 6 && node.y === 0 && node.z === 3.6)).toBe(true);
    expect(result.elements.filter((element) => element.type === 'column')).toHaveLength(6);
    expect(result.elements.filter((element) => element.type === 'beam')).toHaveLength(3);
    expect(result.sections.some((section) => section.id === 'col_400x400')).toBe(true);
    expect(result.sections.some((section) => section.id === 'beam_250x500')).toBe(true);
    expect(result.load_cases.map((loadCase) => loadCase.id)).toEqual(['D', 'L']);
    expect(result.load_combinations.map((combo) => combo.id)).toEqual(['ULS1', 'SLS1']);
  });

  test('marks converted models with canonical z-up coordinate semantics', () => {
    const result = convertDetachedHouseDesignToStructureModel(design);

    expect(result.metadata).toEqual(expect.objectContaining({
      source: 'detached_house_design',
      coordinateSemantics: 'global-z-up',
      frameDimension: '3d',
    }));
  });

  test('places detached-house floor beams at each floor ceiling level', () => {
    const result = convertDetachedHouseDesignToStructureModel(design);
    const nodesById = new Map(result.nodes.map((node) => [node.id, node]));
    const elementsById = new Map(result.elements.map((element) => [element.id, element]));

    const f1Beam = elementsById.get('BM_F1_B1');
    expect(f1Beam.story).toBe('F2');
    expect(f1Beam.nodes.map((nodeId) => nodesById.get(nodeId).z)).toEqual([3.6, 3.6]);

    const f3Beam = elementsById.get('BM_F3_B3');
    expect(f3Beam.story).toBe('F3');
    expect(f3Beam.nodes.map((nodeId) => nodesById.get(nodeId).z)).toEqual([10.2, 10.2]);
  });

  test('splits beam elements at intermediate column nodes', () => {
    const result = convertDetachedHouseDesignToStructureModel({
      version: '0.1',
      project: { name: 'Beam split test', units: 'mm', structure_type: 'rc_frame' },
      floors: [
        {
          id: 'F1',
          elevation: 0,
          height: 3600,
          columns: [
            { id: 'C1', x: 0, y: 0, width: 400, depth: 400 },
            { id: 'C2', x: 5000, y: 0, width: 400, depth: 400 },
            { id: 'C3', x: 10000, y: 0, width: 400, depth: 400 },
          ],
          beams: [{ id: 'B1', line: [0, 0, 10000, 0], width: 250, height: 500 }],
        },
        {
          id: 'F2',
          elevation: 3600,
          height: 3300,
          columns: [
            { id: 'C1', x: 0, y: 0, width: 350, depth: 350 },
            { id: 'C2', x: 5000, y: 0, width: 350, depth: 350 },
            { id: 'C3', x: 10000, y: 0, width: 350, depth: 350 },
          ],
          beams: [{ id: 'B2', line: [0, 0, 10000, 0], width: 250, height: 450 }],
        },
      ],
    });
    const nodesById = new Map(result.nodes.map((node) => [node.id, node]));
    const f1BeamSegments = result.elements
      .filter((element) => element.type === 'beam' && String(element.id).startsWith('BM_F1_B1'))
      .map((element) => element.nodes.map((nodeId) => {
        const node = nodesById.get(nodeId);
        return [node.x, node.y, node.z];
      }));

    expect(f1BeamSegments).toEqual([
      [[0, 0, 3.6], [5, 0, 3.6]],
      [[5, 0, 3.6], [10, 0, 3.6]],
    ]);
  });

  test('spans each floor columns from floor base to that floor ceiling', () => {
    const result = convertDetachedHouseDesignToStructureModel(design);
    const nodesById = new Map(result.nodes.map((node) => [node.id, node]));
    const elementsById = new Map(result.elements.map((element) => [element.id, element]));

    const f1Column = elementsById.get('COL_F1_C1');
    expect(f1Column.nodes.map((nodeId) => nodesById.get(nodeId).z)).toEqual([0, 3.6]);
    expect(f1Column.story).toBe('F1');

    const f3Column = elementsById.get('COL_F3_C1');
    expect(f3Column.nodes.map((nodeId) => nodesById.get(nodeId).z)).toEqual([6.9, 10.2]);
    expect(f3Column.story).toBe('F3');
  });

  test('throws when required structural members are missing', () => {
    expect(() => convertDetachedHouseDesignToStructureModel({ floors: [{ id: 'F1' }] }))
      .toThrow('Detached-house design must contain at least two floors with columns');
  });
});
