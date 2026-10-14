import { describe, expect, test } from "@jest/globals";
import { recoverMemberResponses } from "../../../../dist/skill-shared/member-response.js";
import {
  recoverAnalysisMembers,
  queryMemberResponse,
  sampleMemberResponse,
  memberResponseExtrema,
} from "../../../../dist/agent-skills/result-postprocess/member-response.js";

const units = { displacement: "m", force: "kN", moment: "kN.m" };
const axes = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
const d = (uz = 0, ry = 0) => ({ ux: 0, uy: 0, uz, rx: 0, ry, rz: 0 });
const end = (V3 = 0, M2 = 0) => ({ N: 0, V2: 0, V3, T: 0, M2, M3: 0 });
const force = (n1, n2) => ({
  n1,
  n2,
  localAxes: axes,
  referenceFrame: "element-local",
  responseCoordinateConvention: "global-xyz",
});
function model(loads = []) {
  return {
    unit_system: "SI",
    coordinate_system: { dimension: "2d", plane: "xz" },
    nodes: [
      { id: "A", x: 0, y: 0, z: 0 },
      { id: "B", x: 6, y: 0, z: 0 },
    ],
    elements: [
      {
        id: "beam",
        type: "beam",
        nodes: ["A", "B"],
        material: "m",
        section: "s",
      },
    ],
    materials: [{ id: "m", E: 200000 }],
    sections: [
      { id: "s", properties: { A: 0.02, Iy: 0.0001, Iz: 0.0002, J: 0.00005 } },
    ],
    load_cases: [{ id: "D", loads }],
  };
}

describe("shared member response recovery", () => {
  test("an endpoint differing by machine roundoff is accepted, an outside station is not", () => {
    const length = Math.hypot(1, 3.3);
    const responses = [{ id: "slope", length, state: "recovered", samples: [{ x: length, N: 5 }] }];
    expect(sampleMemberResponse(responses, "slope", length + Number.EPSILON * length).sample.N).toBe(5);
    expect(sampleMemberResponse(responses, "slope", length + 1e-10)).toBeUndefined();
  });
  test("product-owned analytic references retain model and result immutability", () => {
    for (const q of [0.5, 2, 10]) {
      const m = model([{ type: 'distributed', element: 'beam', reference_frame: 'global', wz: -q }]);
      const result = { units, responseCoordinateConvention: 'global-xyz',
        displacements: { A: d(), B: d(-q*6**4/(8*20000), q*6**3/(6*20000)) },
        forces: { beam: force(end(q*6, -q*18), end()) } };
      const before = JSON.stringify({m,result});
      const rows = recoverMemberResponses(m, result, { D: 1 }, 'opensees');
      expect(rows).toHaveLength(1);
      expect(rows[0].state).toBe('recovered');
      for (const sample of rows[0].samples) {
        expect(sample.M2).toBeCloseTo(q*(6-sample.x)**2/2, 8);
        expect(sample.displacement[2]).toBeCloseTo(-q*sample.x**2*(216-24*sample.x+sample.x**2)/(24*20000), 9);
      }
      expect(JSON.stringify({m,result})).toBe(before);
    }
  });
  test("canonical My/Ry and linear distributed loads recover quintic cantilever displacement", () => {
    const m = model([
      {
        type: "distributed",
        element: "beam",
        reference_frame: "global",
        wz: 0,
        gradient: { wz: -2 },
      },
    ]);
    const result = {
      responseCoordinateConvention: "global-xyz",
      units,
      displacements: {
        A: d(),
        B: d(
          (-11 * 12 * 6 ** 4) / (120 * 200000000 * 0.0001),
          (12 * 6 ** 3) / (8 * 200000000 * 0.0001),
        ),
      },
      forces: { beam: force(end(36, -144), end()) },
    };
    const rows = recoverMemberResponses(m, result, { D: 1 }, "opensees");
    expect(rows[0].state).toBe("recovered");
    for (const sample of rows[0].samples) {
      const x = sample.x;
      expect(sample.M2).toBeCloseTo(144 - 36 * x + x ** 3 / 3, 9);
      expect(sample.displacement[2]).toBeCloseTo(
        (-72 * x * x + 6 * x ** 3 - x ** 5 / 60) / 20000,
        10,
      );
    }
  });
  test("solver segments preserve physical member identity and both sides of a point-load shear jump", () => {
    const m = model([{ type: "point", element: "beam", position: 3, fz: -20 }]);
    const elements = [
      {
        id: "s1",
        physicalElementId: "beam",
        start: 0,
        end: 3,
        nodes: ["A", "C"],
        localAxes: axes,
      },
      {
        id: "s2",
        physicalElementId: "beam",
        start: 3,
        end: 6,
        nodes: ["C", "B"],
        localAxes: axes,
      },
    ];
    const result = {
      responseCoordinateConvention: "global-xyz",
      units,
      solverMesh: {
        schemaVersion: 1,
        positionUnit: "m",
        nodes: [...m.nodes, { id: "C", x: 3, y: 0, z: 0 }],
        elements,
      },
      effectiveLoads: m.load_cases[0].loads,
      segmentResults: {
        displacements: { A: d(0, 0.00225), C: d(-0.0045), B: d(0, -0.00225) },
        forces: {
          s1: force(end(10), end(-10, -30)),
          s2: force(end(-10, 30), end(10)),
        },
      },
    };
    const before = JSON.stringify({ m, result }),
      rows = recoverAnalysisMembers(m, result, "opensees");
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("beam");
    expect(rows[0].state).toBe("recovered");
    expect(
      queryMemberResponse(m, result, "opensees", "beam", 3, "left").sample.V3,
    ).toBe(10);
    expect(
      queryMemberResponse(m, result, "opensees", "beam", 3, "right").sample.V3,
    ).toBe(-10);
    const exact = queryMemberResponse(m, result, "opensees", "beam", 1.234);
    expect(exact.sample.x).toBe(1.234);
    expect(exact.method).toBe("sampled");
    expect(memberResponseExtrema(rows).method).toBe("sampled-envelope");
    expect(JSON.stringify({ m, result })).toBe(before);
    result.effectiveLoads[0].position = 2;
    expect(recoverAnalysisMembers(m, result, "opensees")[0].state).toBe(
      "unavailable",
    );
  });
  test("partial UDL uses only its loaded solver segment and fails closed without units", () => {
    const m = model([
      { type: "distributed", element: "beam", start: 3, end: 6, wz: -10 },
    ]);
    const elements = [
      {
        id: "s1",
        physicalElementId: "beam",
        start: 0,
        end: 3,
        nodes: ["A", "C"],
        localAxes: axes,
      },
      {
        id: "s2",
        physicalElementId: "beam",
        start: 3,
        end: 6,
        nodes: ["C", "B"],
        localAxes: axes,
      },
    ];
    const result = {
      units,
      solverMesh: {
        schemaVersion: 1,
        positionUnit: "m",
        nodes: [...m.nodes, { id: "C", x: 3, y: 0, z: 0 }],
        elements,
      },
      effectiveLoads: m.load_cases[0].loads,
      segmentResults: {
        displacements: {
          A: d(0, 0.00196875),
          C: d(-0.00421875, 0.00028125),
          B: d(0, -0.00253125),
        },
        forces: {
          s1: force(end(7.5), end(-7.5, -22.5)),
          s2: force(end(7.5, 22.5), end(22.5)),
        },
      },
    };
    const rows = recoverAnalysisMembers(m, result, "opensees");
    expect(rows[0].state).toBe("recovered");
    for (const sample of rows[0].samples) {
      const x = sample.x;
      expect(sample.displacement[2]).toBeCloseTo(
        ((7.5 * x ** 3) / 6 - (10 * Math.max(x - 3, 0) ** 4) / 24) / 20000 -
          0.00196875 * x,
        10,
      );
    }
    delete result.units;
    expect(recoverAnalysisMembers(m, result, "opensees")[0].state).toBe(
      "unavailable",
    );
  });

  test.each([false, true])('hinged UDL recovers member slopes from end actions and translations (joint rotations known=%s)', known => {
    const m = model([{ type:'distributed', element:'beam', reference_frame:'global', wz:-10 }]);
    m.elements[0].releases = { i:{ry:true}, j:{ry:true} };
    const translation = () => ({ux:0,uy:0,uz:0,rx:0,rz:0,...(known ? {ry:0} : {})});
    const result = {units, displacements:{A:translation(),B:translation()}, forces:{beam:force(end(30),end(30))}};
    const row = recoverMemberResponses(m,result,{D:1},'opensees')[0];
    expect(row.state).toBe('recovered');
    for (const sample of row.samples) {
      expect(sample.M2).toBeCloseTo(-30*sample.x+5*sample.x**2,8);
      expect(sample.displacement[2]).toBeCloseTo(-10*sample.x*(6**3-12*sample.x**2+sample.x**3)/(24*20000),10);
    }
    expect(row.samples[40].displacement[2]).toBeCloseTo(-5*10*6**4/(384*20000),10);
    result.forces.beam.n1.M2 = 1;
    expect(recoverMemberResponses(m,result,{D:1},'opensees')[0].state).toBe('unavailable');
  });

  test('released physical endpoints do not create artificial hinges at solver cuts', () => {
    const m = model([{type:'point',element:'beam',position:3,fz:-20}]);
    m.elements[0].releases = {releaseI:{ry:true},releaseJ:{ry:true}};
    const translation = {ux:0,uy:0,uz:0,rx:0,rz:0};
    const result = {units, solverMesh:{schemaVersion:1,positionUnit:'m',
      nodes:[...m.nodes,{id:'C',x:3,y:0,z:0}],elements:[
        {id:'s1',physicalElementId:'beam',start:0,end:3,nodes:['A','C'],localAxes:axes},
        {id:'s2',physicalElementId:'beam',start:3,end:6,nodes:['C','B'],localAxes:axes}]},
      effectiveLoads:m.load_cases[0].loads, segmentResults:{displacements:{A:translation,C:d(-.0045),B:translation},
        forces:{s1:force(end(10),end(-10,-30)),s2:force(end(-10,30),end(10))}}};
    expect(recoverAnalysisMembers(m,result,'opensees')[0].state).toBe('recovered');
    for (const x of [.1,1.234,3,4.12,5.99]) {
      const query = queryMemberResponse(m,result,'opensees','beam',x,'left');
      const s = Math.min(x,6-x);
      expect(query.sample.displacement[2]).toBeCloseTo(-20*s*(3*6**2-4*s*s)/(48*20000),10);
    }
    expect(queryMemberResponse(m,result,'opensees','beam',3,'left').sample.V3).toBe(10);
    expect(queryMemberResponse(m,result,'opensees','beam',3,'right').sample.V3).toBe(-10);
    delete result.segmentResults.displacements.C.ry;
    expect(recoverAnalysisMembers(m,result,'opensees')[0].state).toBe('unavailable');
  });
});
