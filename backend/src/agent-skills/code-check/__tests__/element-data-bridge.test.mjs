// ============================================================================
// PR: elementData bridge — unit tests
// ============================================================================

import { describe, expect, test } from '@jest/globals';
import { buildCodeCheckInput } from '../../../../dist/agent-skills/code-check/entry.js';

describe('elementData bridge', () => {
  const makeModel = () => ({
    schema_version: '2.0.0',
    elements: [
      { id: 'C1', type: 'column', nodes: ['N0_0', 'N1_0'], material: '1', section: '1', story: 'F1' },
      { id: 'B2', type: 'beam',   nodes: ['N1_0', 'N1_1'], material: '1', section: '2', story: 'F1' },
    ],
    sections: [
      {
        id: '1', name: '500X500', type: 'rectangular', purpose: 'column',
        width: 500, height: 500,
        shape: { kind: 'rectangular', B: 500, H: 500 },
        properties: { A: 0.25, Iy: 0.0052083, Iz: 0.0052083, J: 0.0086, G: 12500 },
      },
      {
        id: '2', name: '300X600', type: 'rectangular', purpose: 'beam',
        width: 300, height: 600,
        shape: { kind: 'rectangular', B: 300, H: 600 },
        properties: { A: 0.18, Iy: 0.0054, Iz: 0.00135, J: 0.004, G: 12500 },
      },
    ],
    materials: [
      { id: '1', name: 'C30', grade: 'C30', category: 'concrete', E: 30000, nu: 0.2, rho: 2500, fc: 14.3 },
    ],
    nodes: [
      { id: 'N0_0', x: 0, y: 0, z: 0 },
      { id: 'N1_0', x: 0, y: 0, z: 3.6 },
      { id: 'N1_1', x: 6, y: 0, z: 3.6 },
    ],
    stories: [],
    load_cases: [{ id: 'LC1', type: 'other', loads: [] }],
    load_combinations: [{ id: 'ULS', factors: { LC1: 1.0 } }],
    metadata: { source: 'test' },
  });

  const makeAnalysisResult = () => ({
    schema_version: '2.0.0',
    analysis_type: 'static',
    meta: { units: { force: 'N', moment: 'N.mm' } },
    success: true,
    data: {
      status: 'success',
      analysisMode: 'opensees_2d_frame',
      forces: {
        'C1': {
          n1: { N: 45200, V: 2100, M: 3400 },
          n2: { N: -45200, V: -2100, M: -4100 },
          axial: 45200,
          stress: 0.18,
        },
        'B2': {
          n1: { N: 1200, V: 18000, M: 54000 },
          n2: { N: -1200, V: 18000, M: -54000 },
          axial: 1200,
          stress: 0.0067,
        },
      },
    },
  });

  test('elementData is present in buildCodeCheckInput context', () => {
    const input = buildCodeCheckInput({
      traceId: 'test-trace',
      designCode: 'GB50017',
      model: makeModel(),
      analysis: makeAnalysisResult(),
      analysisParameters: {},
    });

    expect(input.context).toBeDefined();
    expect(input.context['elementData']).toBeDefined();
    const ed = input.context['elementData'];
    expect(typeof ed).toBe('object');
    expect(ed['C1']).toBeDefined();
    expect(ed['B2']).toBeDefined();
  });

  test('elementData has correct type per element', () => {
    const input = buildCodeCheckInput({
      traceId: 'test-trace',
      designCode: 'GB50017',
      model: makeModel(),
      analysis: makeAnalysisResult(),
      analysisParameters: {},
    });

    const ed = input.context['elementData'];
    expect(ed['C1']['type']).toBe('column');
    expect(ed['B2']['type']).toBe('beam');
  });

  test('elementData forces match analysisResult', () => {
    const input = buildCodeCheckInput({
      traceId: 'test-trace',
      designCode: 'GB50017',
      model: makeModel(),
      analysis: makeAnalysisResult(),
      analysisParameters: {},
    });

    const ed = input.context['elementData'];
    const c1Forces = ed['C1']['forceStates'][0]['forces'];
    expect(c1Forces['N']).toBe(45200);
    expect(c1Forces['V']).toBe(2100);

    const b2Forces = ed['B2']['forceStates'][0]['forces'];
    expect(b2Forces['N']).toBe(1200);
  });

  test('elementData section.A is converted from m² to mm²', () => {
    const input = buildCodeCheckInput({
      traceId: 'test-trace',
      designCode: 'GB50017',
      model: makeModel(),
      analysis: makeAnalysisResult(),
      analysisParameters: {},
    });

    const ed = input.context['elementData'];
    const c1Section = ed['C1']['section'];
    // 0.25 m² × 1e6 = 250000 mm²
    expect(c1Section['A']).toBeCloseTo(250000, -1);
  });

  test('elementData has material properties', () => {
    const input = buildCodeCheckInput({
      traceId: 'test-trace',
      designCode: 'GB50017',
      model: makeModel(),
      analysis: makeAnalysisResult(),
      analysisParameters: {},
    });

    const ed = input.context['elementData'];
    const c1Mat = ed['C1']['material'];
    expect(c1Mat['fc']).toBe(14.3);
    expect(c1Mat['E']).toBe(30000);
  });

  test('elementData has length in mm (from node coordinates)', () => {
    const input = buildCodeCheckInput({
      traceId: 'test-trace',
      designCode: 'GB50017',
      model: makeModel(),
      analysis: makeAnalysisResult(),
      analysisParameters: {},
    });

    const ed = input.context['elementData'];
    // C1: N0_0(0,0,0) to N1_0(0,0,3.6) → 3.6m → 3600mm
    expect(ed['C1']['length']).toBeCloseTo(3600, -2);
    // B2: N1_0(0,0,3.6) to N1_1(6,0,3.6) → 6m → 6000mm
    expect(ed['B2']['length']).toBeCloseTo(6000, -2);
  });

  test('elementData is empty object when model has no elements', () => {
    const input = buildCodeCheckInput({
      traceId: 'test-trace',
      designCode: 'GB50017',
      model: { schema_version: '2.0.0' },
      analysis: makeAnalysisResult(),
      analysisParameters: {},
    });

    const ed = input.context['elementData'];
    expect(Object.keys(ed).length).toBe(0);
  });

  test('elementData elements exist even when analysis has no forces', () => {
    const input = buildCodeCheckInput({
      traceId: 'test-trace',
      designCode: 'GB50017',
      model: makeModel(),
      analysis: { data: { forces: {} } },
      analysisParameters: {},
    });

    const ed = input.context['elementData'];
    expect(ed['C1']).toBeDefined();
    expect(ed['C1']['forces']).toBeDefined();
  });

  test('buildCodeCheckInput works without analysisResult.data', () => {
    const input = buildCodeCheckInput({
      traceId: 'test-trace',
      designCode: 'GB50017',
      model: makeModel(),
      analysis: {},
      analysisParameters: {},
    });

    const ed = input.context['elementData'];
    expect(ed['C1']).toBeDefined();
    expect(ed['C1']['forces']).toBeDefined();
  });

  test('supports numeric section/material/node IDs', () => {
    const model = {
      elements: [
        { id: 'E1', type: 'beam', nodes: ['N1', 'N2'], material: 1, section: 1 },
      ],
      sections: [
        { id: 1, name: 'H300X200', purpose: 'beam', properties: { A: 0.006, Iy: 0.0001, Wx: 0.0005, S: 0.0003, tw: 0.006, As: 0.002, G: 79000 } },
      ],
      materials: [
        { id: 1, name: 'Q355', category: 'steel', E: 206000, fy: 355 },
      ],
      nodes: [
        { id: 'N1', x: 0, y: 0, z: 0 },
        { id: 'N2', x: 0, y: 0, z: 3 },
      ],
    };
    const input = buildCodeCheckInput({
      traceId: 'test-trace',
      designCode: 'GB50017',
      model,
      analysis: { data: { forces: { 'E1': { n1: { N: 10000, V: 5000, M: 2000000 } } } } },
      analysisParameters: {},
    });

    const ed = input.context['elementData'];
    const section = ed['E1']['section'];
    expect(section['A']).toBeCloseTo(6000, -1);    // 0.006 * 1e6
    expect(section['Wx']).toBeCloseTo(500000, -2); // 0.0005 * 1e9
    expect(section['S']).toBeCloseTo(300000, -2);  // 0.0003 * 1e9
    expect(section['tw']).toBeCloseTo(6, -1);      // 0.006 * 1e3
    expect(section['As']).toBeCloseTo(2000, -1);   // 0.002 * 1e6
    expect(ed['E1']['material']['fy']).toBe(355);
    expect(ed['E1']['length']).toBeCloseTo(3000, -2);
  });

  test('passes through element design parameters when present', () => {
    const input = buildCodeCheckInput({
      traceId: 'test-trace',
      designCode: 'GB50017',
      model: {
        elements: [
          { id: 'E1', type: 'beam', nodes: ['N1', 'N2'], material: '1', section: '1',
            phi: 0.85, phi_b: 0.9, btLimit: 15, lambdaLimit: 200 },
        ],
        sections: [{ id: '1', properties: { A: 0.005 } }],
        materials: [{ id: '1', E: 206000, fy: 355 }],
        nodes: [{ id: 'N1', x: 0, y: 0, z: 0 }, { id: 'N2', x: 5, y: 0, z: 0 }],
      },
      analysis: { data: { forces: {} } },
      analysisParameters: {},
    });

    const ed = input.context['elementData'];
    expect(ed['E1']['phi']).toBe(0.85);
    expect(ed['E1']['phi_b']).toBe(0.9);
    expect(ed['E1']['btLimit']).toBe(15);
    expect(ed['E1']['lambdaLimit']).toBe(200);
  });

  test('existing fields in context remain unchanged', () => {
    const input = buildCodeCheckInput({
      traceId: 'test-trace',
      designCode: 'GB50017',
      model: makeModel(),
      analysis: makeAnalysisResult(),
      analysisParameters: {},
    });

    expect(input.code).toBe('GB50017');
    expect(input.elements).toContain('C1');
    expect(input.elements).toContain('B2');
    expect(input.context['analysisSummary']).toBeDefined();
    expect(input.context['utilizationByElement']).toBeDefined();
    expect(input.context['elementContextById']).toBeDefined();
    expect(input.context['modelSummary']).toBeDefined();
  });

  test('preserves signed complete endpoint vectors without mixing component maxima', () => {
    const input = buildCodeCheckInput({
      traceId: 'test-trace',
      designCode: 'GB50017',
      model: makeModel(),
      analysis: {
        meta: { units: { force: 'N', moment: 'N.mm' } },
        data: {
          forces: {
            'C1': {
              n1: { N: -30000, V: 5000, M: -2000000 },
              n2: { N: 45000, V: -3000, M: 3500000 },
            },
          },
        },
      },
      analysisParameters: {},
    });

    const ed = input.context['elementData'];
    expect(ed['C1']['forces']).toEqual({});
    expect(ed['C1']['forceStates'].map(s => s.forces)).toEqual([
      { N: -30000, V: 5000, M: -2000000, Mx: -2000000 },
      { N: 45000, V: -3000, M: 3500000, Mx: 3500000 },
    ]);
  });

  test('rejects PKPM component envelopes as simultaneous section vectors', () => {
    const model = {
      elements: [
        { id: 'B1', type: 'beam', nodes: ['N1', 'N2'], material: '1', section: '1' },
      ],
      sections: [
        {
          id: '1',
          properties: {
            A: 0.00487,
            Iy: 0.0000721,
            Wx: 0.00048,
            S: 0.000286,
            tw: 0.0065,
            As: 0.001833,
            G: 79000,
          },
        },
      ],
      materials: [{ id: '1', E: 206000, fy: 355 }],
      nodes: [
        { id: 'N1', x: 0, y: 0, z: 3.6 },
        { id: 'N2', x: 6, y: 0, z: 3.6 },
      ],
    };

    const input = buildCodeCheckInput({
      traceId: 'test-trace',
      designCode: 'GB50017',
      model,
      analysis: {
        data: {
          analysisMode: 'pkpm-satwe',
          forces: {
            B1: { N: 8, V: 36, M: 54 },
          },
        },
      },
      analysisParameters: {},
    });

    const element = input.context['elementData']['B1'];
    expect(element.forces).toEqual({});
    expect(element.forceStates).toEqual([]);
    expect(element.forceInputIssue).toContain('NATIVE_STATION_CONVENTIONS_UNVERIFIED');
  });

  test('verified commercial stations enter explicit builtin checks without splicing envelopes', () => {
    const model = makeModel();
    const data = { analysisMode: 'pkpm-satwe', units: {force:'kN',moment:'kN.m'},
      forceSemantics: 'simultaneous-signed-stations', nativeContext: {stationConventionsVerified:true},
      memberStations: {B2: [{ positionM:3,side:'continuous',referenceFrame:'element-local',
        components:{N:-5,Vy:0,Vz:3,T:0,My:12,Mz:0}, source:{method:'official SDK',case:'D'} }] } };
    const input = buildCodeCheckInput({traceId:'native',designCode:'GB50017',model,analysis:{data},analysisParameters:{}});
    const element = input.context.elementData.B2;
    expect(element.forceInputIssue).toBeUndefined();
    expect(element.forceStates).toHaveLength(1);
    expect(element.forceStates[0]).toMatchObject({positionM:3,forces:{N:-5000,Mx:12000000,V:3000}});
    data.memberStations.B2[0].components.My = null;
    const invalid = buildCodeCheckInput({traceId:'native',designCode:'GB50017',model,analysis:{data},analysisParameters:{}});
    expect(invalid.context.elementData.B2.forceInputIssue).toBe('NATIVE_STATION_COMPONENTS_INCOMPLETE');
  });

  test('converts OpenSees force units before GB50017 elementData consumption', () => {
    const model = {
      elements: [
        { id: 'B1', type: 'beam', nodes: ['N1', 'N2'], material: '1', section: '1' },
      ],
      sections: [
        {
          id: '1',
          properties: {
            A: 0.00487,
            Iy: 0.0000721,
            Wx: 0.00048,
            S: 0.000286,
            tw: 0.0065,
            As: 0.001833,
            G: 79000,
          },
        },
      ],
      materials: [{ id: '1', E: 206000, fy: 355 }],
      nodes: [
        { id: 'N1', x: 0, y: 0, z: 3.6 },
        { id: 'N2', x: 6, y: 0, z: 3.6 },
      ],
    };

    const input = buildCodeCheckInput({
      traceId: 'test-trace',
      designCode: 'GB50017',
      model,
      analysis: {
        meta: { analysisAdapterKey: 'builtin-opensees' },
        data: {
          analysisMode: 'opensees_3d_frame',
          forces: {
            B1: { n1: { N: 8, V: 36, M: 54 } },
          },
        },
      },
      analysisParameters: {},
    });

    const forces = input.context['elementData']['B1']['forces'];
    expect(forces['N']).toBe(8000);
    expect(forces['V']).toBe(36000);
    expect(forces['Mx']).toBe(54000000);
  });

  test('does not guess shape units from the magnitude of dimensions', () => {
    const input = buildCodeCheckInput({
      traceId: 'test-trace',
      designCode: 'GB50017',
      model: {
        elements: [{ id: 'E1', type: 'beam', nodes: ['N1', 'N2'], material: '1', section: '1' }],
        sections: [{
          id: '1', name: 'H300X150', type: 'H', purpose: 'beam',
          shape: { kind: 'H', H: 0.3, B: 0.15, tw: 0.0065, tf: 0.009 },
          properties: { A: 0.00487, Iy: 0.0000721, Iz: 0.00000508, G: 79000 },
        }],
        materials: [{ id: '1', E: 206000, fy: 235 }],
        nodes: [{ id: 'N1', x: 0, y: 0, z: 0 }, { id: 'N2', x: 0, y: 0, z: 3 }],
      },
      analysis: { data: { forces: {} } },
      analysisParameters: {},
    });

    const ed = input.context['elementData'];
    const section = ed['E1']['section'];
    expect(section['Wx']).toBeGreaterThan(0);   // derived from Iy/(H/2)
    expect(section['S']).toBeGreaterThan(0);     // derived from H/B/tw/tf
    expect(section['tw']).toBeCloseTo(0.0065, 6); // V2 shape dimensions remain mm even when small
    expect(section['As']).toBeGreaterThan(0);    // tw × hw
  });

  test('derives Wnx/S/As/tw from H-section shape expressed in millimeters', () => {
    const input = buildCodeCheckInput({
      traceId: 'test-trace',
      designCode: 'GB50017',
      model: {
        elements: [{ id: 'E1', type: 'beam', nodes: ['N1', 'N2'], material: '1', section: '1' }],
        sections: [{
          id: '1', name: 'HN300X150', type: 'H', purpose: 'beam',
          shape: { kind: 'H', H: 300, B: 150, tw: 6.5, tf: 9 },
          properties: { A: 0.00487, Iy: 0.0000721, Iz: 0.00000508, G: 79000 },
        }],
        materials: [{ id: '1', E: 206000, fy: 235 }],
        nodes: [{ id: 'N1', x: 0, y: 0, z: 0 }, { id: 'N2', x: 0, y: 0, z: 3 }],
      },
      analysis: { data: { forces: {} } },
      analysisParameters: {},
    });

    const ed = input.context['elementData'];
    const section = ed['E1']['section'];
    expect(section['Wx']).toBeCloseTo(480667, -2); // Iy/(H/2), with H already in mm
    expect(section['S']).toBeGreaterThan(250000);
    expect(section['S']).toBeLessThan(270000);
    expect(section['tw']).toBeCloseTo(6.5, 0);
    expect(section['As']).toBeCloseTo(1833, -1);
  });

  test('does not substitute yield strength for design strengths', () => {
    const input = buildCodeCheckInput({
      traceId: 'test-trace',
      designCode: 'GB50017',
      model: {
        elements: [{ id: 'E1', type: 'beam', nodes: ['N1', 'N2'], material: '1', section: '1' }],
        sections: [{ id: '1', properties: { A: 0.005 } }],
        materials: [{ id: '1', E: 206000, fy: 355 }],  // no f, no fv
        nodes: [{ id: 'N1', x: 0, y: 0, z: 0 }, { id: 'N2', x: 5, y: 0, z: 0 }],
      },
      analysis: { data: { forces: {} } },
      analysisParameters: {},
    });

    const mat = input.context['elementData']['E1']['material'];
    expect(mat['f']).toBeUndefined();
    expect(mat['fv']).toBeUndefined();
    expect(mat['fy']).toBe(355);                    // original fy preserved
  });

  test('uses canonical signed components and preserves zero rather than 3-D magnitudes', () => {
    const input = buildCodeCheckInput({
      traceId: 'canonical-components', designCode: 'GB50017', model: makeModel(), analysisParameters: {},
      analysis: {
        meta: { units: { force: 'kN', moment: 'kN.m' } },
        data: { analysisMode: 'opensees_3d_frame', forces: { C1: {
          n1: { N: 0, V2: 3, V3: -2, T: 0, M2: -4, M3: 5, V: 999, M: 999 },
        } } },
      },
    });
    const state = input.context.elementData.C1.forceStates[0];
    expect(state.forces.N).toBe(0);
    expect(state.forces.V).toBe(-2000);
    expect(state.forces.Mx).toBe(-4000000);
    expect(state.forces.M3).toBe(5000000);
    expect(state.unsupportedReason).toContain('Biaxial');
  });

  test('does not infer force units from an untagged response', () => {
    const input = buildCodeCheckInput({
      traceId: 'unknown-units', designCode: 'GB50017', model: makeModel(), analysisParameters: {},
      analysis: { data: { forces: { C1: { n1: { N: 3, V: 0, M: 0 } } } } },
    });
    expect(input.context.elementData.C1.forceStates).toEqual([]);
    expect(input.context.elementData.C1.forceInputIssue).toContain('units');
  });
});
