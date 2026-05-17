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
    expect(result.elements.filter((element) => element.type === 'column')).toHaveLength(4);
    expect(result.elements.filter((element) => element.type === 'beam')).toHaveLength(3);
    expect(result.sections.some((section) => section.id === 'col_400x400')).toBe(true);
    expect(result.sections.some((section) => section.id === 'beam_250x500')).toBe(true);
    expect(result.load_cases.map((loadCase) => loadCase.id)).toEqual(['D', 'L']);
    expect(result.load_combinations.map((combo) => combo.id)).toEqual(['ULS1', 'SLS1']);
  });

  test('throws when required structural members are missing', () => {
    expect(() => convertDetachedHouseDesignToStructureModel({ floors: [{ id: 'F1' }] }))
      .toThrow('Detached-house design must contain at least two floors with columns');
  });
});
