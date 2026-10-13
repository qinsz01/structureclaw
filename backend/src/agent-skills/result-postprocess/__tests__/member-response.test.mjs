import { describe, expect, test } from "@jest/globals";
import fs from "node:fs";
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
  test("all frozen references retain coverage and immutability without depending on viewer types", () => {
    const base = new URL(
      "../../../../../tests/llm-benchmark/fixtures/",
      import.meta.url,
    );
    const models = JSON.parse(
      fs.readFileSync(new URL("ground-truth-models.json", base)),
    );
    const results = JSON.parse(
      fs.readFileSync(new URL("opensees-ground-truth.json", base)),
    ).models;
    let recovered = 0;
    for (const reference of models) {
      const numerical = results.find((n) => n.modelId === reference.id);
      if (!numerical) continue;
      const before = JSON.stringify(reference),
        rows = recoverMemberResponses(
          reference.model,
          numerical.result,
          numerical.analysisSelection.factors,
          "opensees",
        );
      expect(rows).toHaveLength(reference.model.elements.length);
      recovered += rows.filter((row) => row.state === "recovered").length;
      expect(JSON.stringify(reference)).toBe(before);
    }
    expect(recovered).toBeGreaterThan(100);
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
});
