import { describe, expect, test } from '@jest/globals';
import { generateMembers, generateBeams, generateColumns, generateSlabs } from '../../../../../dist/agent-skills/structure-type/concrete-frame/handler.js';

// ============================================================================
// 混凝土构件生成器测试
// ============================================================================
describe('concrete-frame member generation', () => {
  describe('generateBeams', () => {
    test('generates rectangular beams with proper span-depth ratios', () => {
      const input = {
        storyCount: 3,
        bayCount: 2,
        storyHeightsM: [3.6, 3.6, 3.6],
        bayWidthsM: [6, 6],
        concreteGrade: 'C30',
        rebarGrade: 'HRB400',
        beamType: 'rectangular',
      };

      const beams = generateBeams(input);

      expect(beams).toHaveLength(2);
      beams.forEach((beam, i) => {
        expect(beam.id).toBe(`B-${i + 1}`);
        expect(beam.type).toBe('rectangular');
        expect(beam.spanM).toBe(6);
        expect(beam.widthMM).toBeGreaterThanOrEqual(200);
        expect(beam.heightMM).toBeGreaterThanOrEqual(250);
        expect(beam.spanDepthRatio).toBeDefined();
        expect(beam.meetsRequirement).toBeDefined();
      });
    });

    test('generates T-shaped beams with proper flange dimensions (middle + edge)', () => {
      const input = {
        storyCount: 3,
        bayCount: 3,
        storyHeightsM: [3.6, 3.6, 3.6],
        bayWidthsM: [8, 8, 8],
        concreteGrade: 'C30',
        rebarGrade: 'HRB400',
        beamType: 't-shaped',
      };

      const beams = generateBeams(input);

      expect(beams).toHaveLength(3);
      // 边梁 (B-1, B-3) 翼缘宽度应小于中梁 (B-2)
      const edgeBeam = beams[0];
      const midBeam = beams[1];
      expect(edgeBeam.type).toBe('t-shaped');
      expect(midBeam.type).toBe('t-shaped');
      // 中梁翼缘更宽 (l0/3 vs l0/6)
      expect(midBeam.flangeWidthMM_compression).toBeGreaterThan(edgeBeam.flangeWidthMM_compression);
      // bf' = min(l₀/k, b + n·hf') — 边梁 b + 5hf'，中梁 b + 12hf'
      beams.forEach((beam, i) => {
        const isEdge = i === 0 || i === beams.length - 1;
        const candidateL0 = Math.round(beam.spanM * 1000 / (isEdge ? 6 : 3));
        const candidateHf = beam.webWidthMM + (isEdge ? 5 : 12) * beam.flangeThicknessMM_compression;
        const expectedBfMax = Math.min(candidateL0, candidateHf);
        expect(beam.flangeWidthMM_compression).toBe(expectedBfMax);
        expect(beam.webWidthMM).toBeGreaterThanOrEqual(200);
        expect(beam.flangeThicknessMM_compression).toBeGreaterThan(0);
        expect(beam.totalHeightMM).toBeGreaterThanOrEqual(250);
      });
    });

    test('T-beam flange thickness limited by slab thickness (PR2 fix)', () => {
      const input = {
        storyCount: 2,
        bayCount: 2,
        storyHeightsM: [3.6, 3.6],
        bayWidthsM: [8, 8],
        concreteGrade: 'C30',
        rebarGrade: 'HRB400',
        beamType: 't-shaped',
        slabType: 'one-way',
        slabUsage: 'residential',
      };

      const beams = generateBeams(input);
      beams.forEach((beam) => {
        // Flange thickness = min(h/6, slab_thickness)
        const h6 = Math.round(beam.totalHeightMM / 6);
        expect(beam.flangeThicknessMM_compression).toBeLessThanOrEqual(h6);
      });
    });

    test('ensures span-depth ratio for rectangular beams is within 8-16 range', () => {
      const input = {
        storyCount: 2,
        bayCount: 3,
        storyHeightsM: [3.6, 3.6],
        bayWidthsM: [4, 8, 12],
        concreteGrade: 'C30',
        rebarGrade: 'HRB400',
        beamType: 'rectangular',
      };

      const beams = generateBeams(input);

      beams.forEach((beam) => {
        const sd = beam.spanDepthRatio;
        expect(sd).toBeGreaterThanOrEqual(8);
        expect(sd).toBeLessThanOrEqual(16);
      });
    });

    test('handles 2m short-span beams', () => {
      const input = {
        storyCount: 1,
        bayCount: 1,
        storyHeightsM: [3.6],
        bayWidthsM: [2],
        concreteGrade: 'C30',
        rebarGrade: 'HRB400',
        beamType: 'rectangular',
      };

      const beams = generateBeams(input);
      const beam = beams[0];
      expect(beam.heightMM).toBeGreaterThanOrEqual(250);
      expect(beam.widthMM).toBeGreaterThanOrEqual(200);
      expect(beam.meetsRequirement).toBeDefined();
    });
  });

  describe('generateColumns', () => {
    test('generates rectangular columns with proper axial load ratios for C30', () => {
      const input = {
        storyCount: 3,
        bayCount: 2,
        storyHeightsM: [3.6, 3.6, 3.6],
        bayWidthsM: [6, 6],
        concreteGrade: 'C30',
        rebarGrade: 'HRB400',
        columnType: 'rectangular',
        axialLoadKN: 1500,
      };

      const columns = generateColumns(input);

      expect(columns).toHaveLength(3);
      columns.forEach((column, i) => {
        expect(column.id).toBe(`C-S${i + 1}-1`);
        expect(column.type).toBe('rectangular');
        expect(column.heightM).toBe(3.6);
        expect(column.widthMM).toBeGreaterThanOrEqual(400);
        expect(column.heightMM).toBe(column.widthMM);
        expect(column.axialLoadRatio).toBeDefined();
        expect(column.axialLoadRatio).toBeLessThanOrEqual(0.9);
      });
    });

    test('generates circular columns', () => {
      const input = {
        storyCount: 3,
        bayCount: 2,
        storyHeightsM: [3.6, 3.6, 3.6],
        bayWidthsM: [6, 6],
        concreteGrade: 'C30',
        rebarGrade: 'HRB400',
        columnType: 'circular',
        axialLoadKN: 1500,
      };

      const columns = generateColumns(input);

      expect(columns).toHaveLength(3);
      columns.forEach((column, i) => {
        expect(column.id).toBe(`C-S${i + 1}-1`);
        expect(column.type).toBe('circular');
        expect(column.diameterMM).toBeGreaterThanOrEqual(500);
        expect(column.axialLoadRatio).toBeDefined();
        expect(column.axialLoadRatio).toBeLessThanOrEqual(0.9);
      });
    });

    test('scales column size with story count', () => {
      const inputs = [
        { storyCount: 1, concreteGrade: 'C30', expectedSize: 500 },
        { storyCount: 6, concreteGrade: 'C30', expectedSize: 550 },
        { storyCount: 12, concreteGrade: 'C30', expectedSize: 750 },
      ];

      inputs.forEach(({ storyCount, concreteGrade, expectedSize }) => {
        const input = {
          storyCount,
          bayCount: 2,
          storyHeightsM: Array(storyCount).fill(3.6),
          bayWidthsM: [6, 6],
          concreteGrade,
          rebarGrade: 'HRB400',
          columnType: 'rectangular',
        };

        const columns = generateColumns(input);
        const bottom = columns[0];
        expect(bottom.widthMM).toBe(expectedSize);
      });
    });

    test('handles 30-story high-rise column sizing', () => {
      const input = {
        storyCount: 30,
        bayCount: 2,
        storyHeightsM: Array(30).fill(3.6),
        bayWidthsM: [6, 6],
        concreteGrade: 'C50',
        rebarGrade: 'HRB500',
        columnType: 'rectangular',
      };

      const columns = generateColumns(input);
      const bottom = columns[0];
      expect(bottom.widthMM).toBeGreaterThanOrEqual(900);
      expect(bottom.axialLoadRatio).toBeLessThanOrEqual(0.9);
    });

    test('respects axial load ratio limit for different concrete grades', () => {
      const grades = ['C20', 'C30', 'C40', 'C50', 'C80'];

      grades.forEach(grade => {
        const input = {
          storyCount: 3,
          bayCount: 2,
          storyHeightsM: [3.6, 3.6, 3.6],
          bayWidthsM: [6, 6],
          concreteGrade: grade,
          rebarGrade: 'HRB400',
          columnType: 'rectangular',
          axialLoadKN: 2000,
        };

        const columns = generateColumns(input);
        columns.forEach(column => {
          expect(column.axialLoadRatio).toBeLessThanOrEqual(0.9);
        });
      });
    });
  });

  describe('generateSlabs', () => {
    test('generates one-way residential slab with proper thickness', () => {
      const input = {
        storyCount: 3,
        bayCount: 2,
        storyHeightsM: [3.6, 3.6, 3.6],
        bayWidthsM: [3, 6],
        concreteGrade: 'C30',
        rebarGrade: 'HRB400',
        slabType: 'one-way',
        slabUsage: 'residential',
      };

      const slabs = generateSlabs(input);

      expect(slabs).toHaveLength(2);
      slabs.forEach((slab, i) => {
        expect(slab.id).toBe(`SL-${i + 1}`);
        expect(slab.type).toBe('one-way');
        expect(slab.usage).toBe('residential');
        expect(slab.thicknessMM).toBeGreaterThanOrEqual(60);
        expect(slab.spanDepthRatio).toBeDefined();
        expect(slab.spanDepthRatio).toBeLessThanOrEqual(30);
      });
    });

    test('generates two-way slab with GB/T 50010 minimum thickness (floor 80mm, roof 100mm)', () => {
      const cases = [
        { usage: 'residential', minThickness: 80 },
        { usage: 'commercial', minThickness: 80 },
        { usage: 'roof', minThickness: 100 },
      ];

      cases.forEach(({ usage, minThickness }) => {
        const input = {
          storyCount: 3,
          bayCount: 1,
          storyHeightsM: [3.6, 3.6, 3.6],
          bayWidthsM: [4],
          concreteGrade: 'C30',
          rebarGrade: 'HRB400',
          slabType: 'two-way',
          slabUsage: usage,
        };

        const slabs = generateSlabs(input);
        const slab = slabs[0];
        expect(slab.type).toBe('two-way');
        expect(slab.thicknessMM).toBeGreaterThanOrEqual(minThickness);
        expect(slab.spanDepthRatio).toBeLessThanOrEqual(40);
      });
    });

    test('handles flat slab with proper minimum thickness', () => {
      const input = {
        storyCount: 3,
        bayCount: 1,
        storyHeightsM: [3.6, 3.6, 3.6],
        bayWidthsM: [7],
        concreteGrade: 'C30',
        rebarGrade: 'HRB400',
        slabType: 'flat-slab',
        slabUsage: 'commercial',
      };

      const slabs = generateSlabs(input);
      const slab = slabs[0];

      expect(slab.type).toBe('flat-slab');
      expect(slab.thicknessMM).toBeGreaterThanOrEqual(150);
      expect(slab.spanDepthRatio).toBeLessThanOrEqual(30);
    });

    test('applies different minimum thickness based on usage for one-way slabs', () => {
      const usageCases = [
        { usage: 'roof', minThickness: 60 },
        { usage: 'residential', minThickness: 60 },
        { usage: 'commercial', minThickness: 70 },
        { usage: 'vehicle', minThickness: 80 },
      ];

      usageCases.forEach(({ usage, minThickness }) => {
        const input = {
          storyCount: 2,
          bayCount: 1,
          storyHeightsM: [3.6, 3.6],
          bayWidthsM: [4],
          concreteGrade: 'C30',
          rebarGrade: 'HRB400',
          slabType: 'one-way',
          slabUsage: usage,
        };

        const slabs = generateSlabs(input);
        const slab = slabs[0];
        expect(slab.thicknessMM).toBeGreaterThanOrEqual(minThickness);
      });
    });

    test('handles 2m short-span slab', () => {
      const input = {
        storyCount: 2,
        bayCount: 1,
        storyHeightsM: [3.6, 3.6],
        bayWidthsM: [2],
        concreteGrade: 'C30',
        rebarGrade: 'HRB400',
        slabType: 'one-way',
        slabUsage: 'residential',
      };

      const slabs = generateSlabs(input);
      const slab = slabs[0];
      expect(slab.thicknessMM).toBe(70);
      expect(slab.spanDepthRatio).toBeLessThanOrEqual(30);
    });
  });

  describe('generateMembers integration', () => {
    test('generates complete member set for typical 3-story frame', () => {
      const input = {
        storyCount: 3,
        bayCount: 3,
        storyHeightsM: [3.6, 3.6, 3.6],
        bayWidthsM: [5, 6, 5],
        concreteGrade: 'C30',
        rebarGrade: 'HRB400',
        beamType: 'rectangular',
        slabType: 'one-way',
        slabUsage: 'residential',
        axialLoadKN: 1200,
      };

      const output = generateMembers(input);

      expect(output.concreteBeams).toHaveLength(3);
      expect(output.concreteColumns).toHaveLength(3);
      expect(output.concreteSlabs).toHaveLength(3);
      expect(output.warnings).toBeDefined();
      expect(output.errors).toBeDefined();

      output.concreteBeams.forEach(beam => {
        expect(beam.spanDepthRatio).toBeGreaterThanOrEqual(8);
        expect(beam.spanDepthRatio).toBeLessThanOrEqual(16);
      });

      output.concreteColumns.forEach(column => {
        expect(column.axialLoadRatio).toBeLessThanOrEqual(0.9);
      });

      output.concreteSlabs.forEach(slab => {
        expect(slab.spanDepthRatio).toBeLessThanOrEqual(30);
      });
    });

    test('handles edge cases with warnings and errors', () => {
      const edgeCases = [
        {
          description: 'single story, single bay',
          input: {
            storyCount: 1,
            bayCount: 1,
            storyHeightsM: [3.6],
            bayWidthsM: [3],
            concreteGrade: 'C30',
            rebarGrade: 'HRB400',
          },
        },
        {
          description: 'long span (12m)',
          input: {
            storyCount: 2,
            bayCount: 1,
            storyHeightsM: [3.6, 3.6],
            bayWidthsM: [12],
            concreteGrade: 'C30',
            rebarGrade: 'HRB400',
          },
        },
        {
          description: '2m short span',
          input: {
            storyCount: 1,
            bayCount: 1,
            storyHeightsM: [3.6],
            bayWidthsM: [2],
            concreteGrade: 'C30',
            rebarGrade: 'HRB400',
          },
        },
        {
          description: 'C80 + HRB500',
          input: {
            storyCount: 3,
            bayCount: 2,
            storyHeightsM: [3.6, 3.6, 3.6],
            bayWidthsM: [6, 6],
            concreteGrade: 'C80',
            rebarGrade: 'HRB500',
          },
        },
        {
          description: '30-story high-rise',
          input: {
            storyCount: 30,
            bayCount: 3,
            storyHeightsM: Array(30).fill(3.6),
            bayWidthsM: [6, 6, 6],
            concreteGrade: 'C50',
            rebarGrade: 'HRB500',
          },
        },
      ];

      edgeCases.forEach(({ input }) => {
        const output = generateMembers(input);

        expect(output.concreteBeams).toBeDefined();
        expect(output.concreteColumns).toBeDefined();
        expect(output.concreteSlabs).toBeDefined();
        expect(output.errors).toBeInstanceOf(Array);
        expect(output.warnings).toBeInstanceOf(Array);
      });
    });

    test('validates GB/T 50010-2010 section 9.1.2 requirements', () => {
      const slabConfigs = [
        { slabType: 'one-way', slabUsage: 'residential', spanM: 4.5, expectedMaxRatio: 30, expectedMinThickness: 60 },
        { slabType: 'two-way', slabUsage: 'commercial', spanM: 6.0, expectedMaxRatio: 40, expectedMinThickness: 80 },
        { slabType: 'two-way', slabUsage: 'roof', spanM: 6.0, expectedMaxRatio: 40, expectedMinThickness: 100 },
        { slabType: 'flat-slab', slabUsage: 'commercial', spanM: 7.0, expectedMaxRatio: 30, expectedMinThickness: 150 },
      ];

      slabConfigs.forEach(({ slabType, slabUsage, spanM, expectedMaxRatio, expectedMinThickness }) => {
        const input = {
          storyCount: 2,
          bayCount: 1,
          storyHeightsM: [3.6, 3.6],
          bayWidthsM: [spanM],
          concreteGrade: 'C30',
          rebarGrade: 'HRB400',
          slabType,
          slabUsage,
        };

        const slabs = generateSlabs(input);
        const slab = slabs[0];

        expect(slab.spanDepthRatio).toBeLessThanOrEqual(expectedMaxRatio);
        expect(slab.thicknessMM).toBeGreaterThanOrEqual(expectedMinThickness);
        expect(slab.meetsRequirement).toBe(
          slab.spanDepthRatio <= expectedMaxRatio && slab.thicknessMM >= expectedMinThickness,
        );
      });
    });
  });

  // ============================================================================
  // 验算集成测试 — code-check deferred to Python gb50010 layer
  // ============================================================================
  describe('member generation output structure', () => {
    test('rectangular beams produce correct count and sizing', () => {
      const input = {
        storyCount: 1, bayCount: 2,
        storyHeightsM: [3.6], bayWidthsM: [6, 6],
        concreteGrade: 'C30', rebarGrade: 'HRB400',
        beamType: 'rectangular', axialLoadKN: 500,
      };
      const output = generateMembers(input);
      expect(output.concreteBeams).toHaveLength(2);
      output.concreteBeams.forEach(beam => {
        expect(beam.type).toBe('rectangular');
        expect(beam.heightMM).toBeGreaterThan(0);
        expect(beam.widthMM).toBeGreaterThan(0);
        expect(beam.spanDepthRatio).toBeGreaterThan(0);
      });
    });

    test('T-shaped beams produce flange geometry', () => {
      const input = {
        storyCount: 1, bayCount: 2,
        storyHeightsM: [3.6], bayWidthsM: [6, 6],
        concreteGrade: 'C30', rebarGrade: 'HRB400',
        beamType: 't-shaped', slabType: 'one-way', slabUsage: 'residential',
        axialLoadKN: 500,
      };
      const output = generateMembers(input);
      expect(output.concreteBeams).toHaveLength(2);
      output.concreteBeams.forEach(beam => {
        expect(beam.type).toBe('t-shaped');
        expect(beam.flangeWidthMM_compression).toBeGreaterThan(0);
        expect(beam.webWidthMM).toBeGreaterThan(0);
      });
    });

    test('columns produce correct count and geometry', () => {
      const input = {
        storyCount: 3, bayCount: 2,
        storyHeightsM: [3.6, 3.6, 3.6], bayWidthsM: [6, 6],
        concreteGrade: 'C30', rebarGrade: 'HRB400',
        axialLoadKN: 1000,
      };
      const output = generateMembers(input);
      expect(output.concreteColumns).toHaveLength(3);
      output.concreteColumns.forEach(column => {
        expect(column.heightM).toBeGreaterThan(0);
        expect(column.axialLoadRatio).toBeGreaterThan(0);
      });
    });

    test('complete member set has correct counts', () => {
      const input = {
        storyCount: 3, bayCount: 3,
        storyHeightsM: [3.6, 3.6, 3.6], bayWidthsM: [5, 6, 5],
        concreteGrade: 'C30', rebarGrade: 'HRB400',
        beamType: 'rectangular', slabType: 'one-way', slabUsage: 'residential',
        axialLoadKN: 1200,
      };
      const output = generateMembers(input);
      expect(output.concreteBeams).toHaveLength(3);
      expect(output.concreteColumns).toHaveLength(3);
      expect(output.concreteSlabs).toHaveLength(3);
    });
  });
});
