import {
  recoverMemberResponses,
  type MemberResponse,
  type RecoveryModel,
  type RecoveryResult,
  type RecoveryLoad,
  type Vec,
} from "../../skill-shared/member-response.js";

type Segment = {
  id: string;
  physicalElementId: string;
  start: number;
  end: number;
  nodes: string[];
  localAxes?: { x: Vec; y: Vec; z: Vec };
};
type Raw = Record<string, unknown>;
const asRecord = (v: unknown): Raw =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : {};
const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);
const keys = ["wx", "wy", "wz"] as const;

function globalVector(values: number[], load: Raw, segment: Segment): Vec {
  if (!values.every(finite)) throw new Error("non-finite load");
  if (load.reference_frame === "element-local") {
    const axes = segment.localAxes;
    if (!axes) throw new Error("missing axes");
    return [0, 1, 2].map(
      (i) =>
        axes.x[i] * values[0] + axes.y[i] * values[1] + axes.z[i] * values[2],
    ) as Vec;
  }
  if (load.reference_frame !== undefined && load.reference_frame !== "global")
    throw new Error("unknown load frame");
  return values as Vec;
}

function segmentLoads(
  loads: Raw[],
  segment: Segment,
  length: number,
): RecoveryLoad[] {
  return loads.flatMap((load) => {
    if (load.element !== segment.physicalElementId) return [];
    if (load.type === "point") {
      const position = load.position;
      if (
        !finite(position) ||
        position < 0 ||
        position > length ||
        (position > segment.start + 1e-9 && position < segment.end - 1e-9)
      )
        throw new Error("unsplit internal point");
      return [];
    }
    if (load.type !== "distributed") throw new Error("unknown member load");
    const start = load.start ?? 0,
      end = load.end ?? length;
    if (!finite(start) || !finite(end)) throw new Error("unknown interval");
    if (end <= segment.start + 1e-9 || start >= segment.end - 1e-9) return [];
    if (start > segment.start + 1e-9 || end < segment.end - 1e-9)
      throw new Error("unsplit load interval");
    let first: Vec, last: Vec;
    if (load.distribution === "piecewise_linear") {
      if (!Array.isArray(load.points))
        throw new Error("missing load ordinates");
      const points = load.points.map(asRecord);
      if (
        points.some(
          (p, i) =>
            !finite(p.position) ||
            p.position < 0 ||
            p.position > 1 ||
            (i > 0 && Number(p.position) <= Number(points[i - 1].position)) ||
            (Number(p.position) * length > segment.start + 1e-9 &&
              Number(p.position) * length < segment.end - 1e-9),
        )
      ) {
        throw new Error("invalid or unsplit load ordinates");
      }
      const pointAt = (x: number): Vec => {
        const index = points.findIndex(
          (p, i) =>
            finite(p.position) &&
            finite(points[i + 1]?.position) &&
            x >= Number(p.position) * length - 1e-9 &&
            x <= Number(points[i + 1].position) * length + 1e-9,
        );
        if (index < 0) throw new Error("incomplete load ordinates");
        const a = points[index],
          b = points[index + 1];
        const ratio =
          (x / length - Number(a.position)) /
          (Number(b.position) - Number(a.position));
        return globalVector(
          keys.map(
            (k) => (1 - ratio) * Number(a[k] ?? 0) + ratio * Number(b[k] ?? 0),
          ),
          load,
          segment,
        );
      };
      first = pointAt(segment.start);
      last = pointAt(segment.end);
    } else {
      if (load.distribution !== undefined && load.distribution !== "uniform")
        throw new Error("unsupported load distribution");
      first = globalVector(
        keys.map((k) => Number(load[k] ?? 0)),
        load,
        segment,
      );
      last = first;
    }
    return [
      {
        type: "distributed",
        element: segment.id,
        reference_frame: "global",
        wx: first[0],
        wy: first[1],
        wz: first[2],
        gradient: Object.fromEntries(
          keys.map((key, i) => [
            key,
            (last[i] - first[i]) / (segment.end - segment.start),
          ]),
        ),
      },
    ];
  });
}

/** Recover on solver segments, then return physical member positions (including both sides of jumps). */
export function recoverAnalysisMembers(
  model: RecoveryModel,
  result: RecoveryResult,
  engine: string,
  factors?: Record<string, number>,
  samplePositions?: Record<string, number[]>,
): MemberResponse[] {
  const mesh = asRecord(result.solverMesh),
    segmentResult = asRecord(result.segmentResults);
  if (!Object.keys(mesh).length)
    return recoverMemberResponses(
      model,
      result,
      factors,
      engine.toLowerCase(),
      samplePositions,
    );
  const unavailable = (reason: string) =>
    model.elements.map((e) => ({
      id: e.id,
      length: 0,
      state: "unavailable" as const,
      reason,
      samples: [],
    }));
  try {
    if (
      mesh.schemaVersion !== 1 ||
      mesh.positionUnit !== "m" ||
      !Array.isArray(mesh.nodes) ||
      !Array.isArray(mesh.elements) ||
      !Array.isArray(result.effectiveLoads) ||
      !segmentResult.displacements ||
      !segmentResult.forces
    )
      return unavailable("mesh");
    const segments = mesh.elements as Segment[];
    const physical = new Map(model.elements.map((e) => [e.id, e]));
    const lengths = new Map(
      model.elements.map((e) => {
        const a = model.nodes.find((n) => n.id === e.nodes[0]),
          b = model.nodes.find((n) => n.id === e.nodes[1]);
        return [e.id, a && b ? Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) : 0];
      }),
    );
    if (
      segments.some(
        (s) =>
          !physical.has(s.physicalElementId) ||
          !finite(s.start) ||
          !finite(s.end) ||
          s.end <= s.start,
      )
    )
      return unavailable("mesh");
    const loads = segments.flatMap((segment) =>
      segmentLoads(
        result.effectiveLoads as Raw[],
        segment,
        lengths.get(segment.physicalElementId)!,
      ),
    );
    const solverModel: RecoveryModel = {
      ...model,
      stories: [],
      nodes: mesh.nodes as RecoveryModel["nodes"],
      elements: segments.map((s) => ({
        ...physical.get(s.physicalElementId)!,
        id: s.id,
        nodes: s.nodes,
      })),
      load_cases: [{ id: "effective", loads }],
    };
    const segmentPositions = Object.fromEntries(
      segments.map((s) => [
        s.id,
        (samplePositions?.[s.physicalElementId] ?? [])
          .filter((x) => x >= s.start && x <= s.end)
          .map((x) => x - s.start),
      ]),
    );
    const rows = recoverMemberResponses(
      solverModel,
      { ...result, ...segmentResult },
      { effective: 1 },
      engine.toLowerCase(),
      segmentPositions,
    );
    return model.elements.map((member) => {
      const parts = segments
        .filter((s) => s.physicalElementId === member.id)
        .sort((a, b) => a.start - b.start);
      if (
        !parts.length ||
        Math.abs(parts[0].start) > 1e-9 ||
        Math.abs(parts.at(-1)!.end - lengths.get(member.id)!) > 1e-9 ||
        parts.some(
          (p, i) => i > 0 && Math.abs(p.start - parts[i - 1].end) > 1e-9,
        )
      )
        return {
          id: member.id,
          length: 0,
          state: "unavailable",
          reason: "mesh",
          samples: [],
        };
      const recovered = parts.map((s) => rows.find((r) => r.id === s.id)!);
      const incomplete = recovered.some((r) => !r || r.state === "unavailable");
      const interpolated = recovered.some((r) => r?.state === "interpolated");
      return {
        id: member.id,
        length: lengths.get(member.id)!,
        state: incomplete
          ? "unavailable"
          : interpolated
            ? "interpolated"
            : recovered[0].state,
        reason: incomplete
          ? "mesh"
          : interpolated
            ? recovered.find((r) => r.state === "interpolated")!.reason
            : "checked",
        axes: recovered[0]?.axes,
        samples: incomplete
          ? []
          : recovered.flatMap((row, index) =>
              row.samples.map((sample, i) => ({
                ...sample,
                x: sample.x + parts[index].start,
                segmentId: parts[index].id,
                side: (i === 0
                  ? "right"
                  : i === row.samples.length - 1
                    ? "left"
                    : undefined) as "left" | "right" | undefined,
              })),
            ),
      };
    });
  } catch {
    return unavailable("mesh");
  }
}

export function queryMemberResponse(
  model: RecoveryModel,
  result: RecoveryResult,
  engine: string,
  elementId: string,
  positionM: number,
  side: "left" | "right" = "right",
  factors?: Record<string, number>,
) {
  const rows = recoverAnalysisMembers(model, result, engine, factors, {
    [elementId]: [positionM],
  });
  return sampleMemberResponse(rows, elementId, positionM, side);
}

export function sampleMemberResponse(
  responses: MemberResponse[],
  elementId: string,
  positionM: number,
  side: "left" | "right" = "right",
) {
  const member = responses.find((item) => item.id === elementId);
  if (
    !member ||
    member.state === "unavailable" ||
    !finite(positionM)
  )
    return undefined;
  // Python math.dist and JS Math.hypot can differ by one ulp at a sloping
  // member endpoint. Admit only roundoff, never an engineering-length offset.
  const endpointRoundoff = 8 * Number.EPSILON * Math.max(1, member.length);
  if (positionM < -endpointRoundoff || positionM > member.length + endpointRoundoff)
    return undefined;
  positionM = Math.max(0, Math.min(member.length, positionM));
  const exact = member.samples.filter(
    (sample) => Math.abs(sample.x - positionM) <= 1e-9,
  );
  if (exact.length)
    return {
      sample: side === "left" ? exact[0] : exact.at(-1)!,
      method: "sampled" as const,
      state: member.state,
    };
  // Do not silently report nearest plotted samples as exact analytical values.
  const nearest = [...member.samples].sort(
    (a, b) => Math.abs(a.x - positionM) - Math.abs(b.x - positionM),
  )[0];
  return {
    sample: nearest,
    requestedPosition: positionM,
    method: "nearest-sample" as const,
    state: member.state,
  };
}

export function memberResponseExtrema(responses: MemberResponse[]) {
  const output: Record<
    string,
    { elementId: string; position: number; value: number }
  > = {};
  for (const member of responses)
    for (const sample of member.samples) {
      const values = {
        ux: sample.displacement[0],
        uy: sample.displacement[1],
        uz: sample.displacement[2],
        N: sample.N,
        V2: sample.V2,
        V3: sample.V3,
        M2: sample.M2,
        M3: sample.M3,
        T: sample.T,
      };
      for (const [key, value] of Object.entries(values))
        if (
          finite(value) &&
          (!output[key] || Math.abs(value) > Math.abs(output[key].value))
        )
          output[key] = { elementId: member.id, position: sample.x, value };
    }
  return { method: "sampled-envelope" as const, values: output };
}
