/** Solver-independent inputs. Model units: m, kN, kN.m; material E in MPa. */
type RecoveryNode = { id: string; x: number; y: number; z: number };
type RecoveryElement = {
  id: string;
  nodes: string[];
  type: string;
  material?: string;
  section?: string;
  [key: string]: unknown;
};
export type RecoveryLoad = {
  type?: string;
  node?: string;
  element?: string;
  wx?: number;
  wy?: number;
  wz?: number;
  reference_frame?: string;
  gradient?: { wx?: number; wy?: number; wz?: number };
  [key: string]: unknown;
};
export type RecoveryModel = {
  unit_system: string;
  coordinate_system: { dimension: string; plane?: string | null };
  nodes: RecoveryNode[];
  elements: RecoveryElement[];
  materials: Record<string, unknown>[];
  sections: Record<string, unknown>[];
  load_cases: { id: string; loads: RecoveryLoad[] }[];
  stories?: { floor_loads?: unknown[]; [key: string]: unknown }[];
};
export type RecoveryResult = {
  displacements?: Record<string, Record<string, number>>;
  forces?: Record<string, unknown>;
  meta?: { units?: Record<string, string>; [key: string]: unknown };
  units?: Record<string, string>;
  [key: string]: unknown;
};

export type Vec = [number, number, number];
export type Sample = {
  segmentId?: string;
  side?: "left" | "right";
  x: number;
  position: Vec;
  displacement: Vec;
  N?: number;
  V2?: number;
  V3?: number;
  M2?: number;
  M3?: number;
  T?: number;
};
export type MemberResponse = {
  id: string;
  length: number;
  state: "recovered" | "interpolated" | "truss" | "unavailable";
  reason: string;
  samples: Sample[];
  axes?: Vec[];
  endError?: number;
};
const dot = (a: Vec, b: Vec) => a.reduce((v, n, i) => v + n * b[i], 0);
const add = (a: Vec, b: Vec): Vec => a.map((v, i) => v + b[i]) as Vec;
const mul = (a: Vec, s: number): Vec => a.map((v) => v * s) as Vec;
const finite = (a: unknown[]): a is number[] =>
  a.every((v) => typeof v === "number" && Number.isFinite(v));
function hermite(
  a: number,
  b: number,
  ra: number,
  rb: number,
  L: number,
  t: number,
) {
  return (
    (1 - 3 * t * t + 2 * t ** 3) * a +
    (t - 2 * t * t + t ** 3) * L * ra +
    (3 * t * t - 2 * t ** 3) * b +
    (-t * t + t ** 3) * L * rb
  );
}

function bendingReleases(value: unknown): { i: Set<string>; j: Set<string> } | undefined {
  const record = value == null ? {} : value as Record<string, unknown>;
  if (typeof record !== 'object' || Array.isArray(record) ||
      Object.keys(record).some(k => !['i', 'j', 'releaseI', 'releaseJ', 'reference_frame'].includes(k)) ||
      (record.reference_frame !== undefined && record.reference_frame !== 'element-local')) return;
  const result = { i: new Set<string>(), j: new Set<string>() };
  for (const [end, alias] of [['i', 'releaseI'], ['j', 'releaseJ']] as const) {
    const raw = record[end] ?? record[alias] ?? {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    if (record[end] && record[alias] && JSON.stringify(record[end]) !== JSON.stringify(record[alias])) return;
    for (const [key, enabled] of Object.entries(raw)) {
      if (!['ux','uy','uz','rx','ry','rz'].includes(key) || typeof enabled !== 'boolean') return;
      if (enabled && !['ry','rz'].includes(key)) return;
      if (enabled) result[end].add(key);
    }
  }
  return result;
}

// Pure postprocessing. Never runs a solver or changes model, results, or evaluation tolerances.
export function recoverMemberResponses(
  model: RecoveryModel,
  result: RecoveryResult,
  factors: Record<string, number> | undefined,
  engine: string,
  samplePositions?: Record<string, number[]>,
): MemberResponse[] {
  const m = model;
  // Older frozen 2-D results claimed global-xyz but still stored OpenSees M/Ry signs.
  // The new end-action contract is explicit; do not reinterpret those historical values.
  const canonical =
    result.meta?.forceConvention === "element-end-resisting-actions" ||
    Object.values(result.forces ?? {}).some(
      (force) =>
        !!force &&
        typeof force === "object" &&
        (force as Record<string, unknown>).responseCoordinateConvention ===
          "global-xyz",
    );
  const planar = m.coordinate_system.dimension === "2d" && !canonical;
  const units = result.meta?.units || result.units;

  const transfer = result.floorLoadTransfer as
    { effectiveMode?: string } | undefined;
  const hiddenLoads =
    !!m.stories?.some((s) => s.floor_loads?.length) &&
    transfer?.effectiveMode !== "node_tributary";
  const validFactors =
    !!factors &&
    Object.entries(factors).every(
      ([id, f]) => Number.isFinite(f) && m.load_cases.some((c) => c.id === id),
    );
  const activeLoads = m.load_cases.flatMap((c) =>
    (factors?.[c.id] || 0) === 0
      ? []
      : c.loads.map((l) => ({ ...l, factor: factors![c.id] })),
  );
  return m.elements.map((e) => {
    const fail = (reason: string): MemberResponse => ({
      id: e.id,
      length: 0,
      state: "unavailable",
      reason,
      samples: [],
    });
    const a = m.nodes.find((n) => n.id === e.nodes[0]),
      b = m.nodes.find((n) => n.id === e.nodes[1]);
    if (!a || !b || e.nodes.length !== 2) return fail("geometry");
    const legacyTruss =
      engine === "opensees" &&
      result.analysisMode === "opensees_2d_truss" &&
      !units;
    if (m.unit_system !== "SI" || (units?.displacement !== "m" && !legacyTruss))
      return fail("units");
    const start: Vec = [a.x, a.y, a.z],
      end: Vec = [b.x, b.y, b.z],
      dx = end.map((v, i) => v - start[i]) as Vec,
      L = Math.hypot(...dx);
    if (!L) return fail("geometry");
    const da = result.displacements?.[a.id],
      db = result.displacements?.[b.id];
    if (!da || !db || !finite([da.ux, da.uy, da.uz, db.ux, db.uy, db.uz]))
      return fail("displacements");
    const ua: Vec = [da.ux, da.uy, da.uz],
      ub: Vec = [db.ux, db.uy, db.uz];
    const force = result.forces?.[e.id] as
      | {
          axial?: number;
          referenceFrame?: string;
          localAxes?: { x: Vec; y: Vec; z: Vec };
          n1?: Record<string, number>;
          n2?: Record<string, number>;
        }
      | undefined;
    if (e.type === "truss" || e.type === "brace")
      return {
        id: e.id,
        length: L,
        state: "truss",
        reason: "axial",
        samples: [
          ...new Set([
            ...Array.from({ length: 41 }, (_, i) => (L * i) / 40),
            ...(samplePositions?.[e.id] ?? []).filter(
              (x) => Number.isFinite(x) && x >= 0 && x <= L,
            ),
          ]),
        ]
          .sort((a, b) => a - b)
          .map((x) => {
            const t = x / L;
            return {
              x: t * L,
              position: add(start, mul(dx, t)),
              displacement: add(mul(ua, 1 - t), mul(ub, t)),
              N: typeof force?.axial === "number" ? force.axial : undefined,
            };
          }),
      };
    if (!["beam", "column"].includes(e.type)) return fail("element");
    if (engine !== "opensees") return fail("engine");
    if (
      planar &&
      (m.coordinate_system.plane !== "xz" || Math.abs(dx[1]) > 1e-9)
    )
      return fail("axes");
    const ex = mul(dx, 1 / L),
      axes: Vec[] = planar
        ? [ex, [-ex[2], 0, ex[0]], [0, -1, 0]]
        : force?.localAxes
          ? [force.localAxes.x, force.localAxes.y, force.localAxes.z]
          : [];
    if (
      axes.length !== 3 ||
      axes.some(
        (v) =>
          !Array.isArray(v) ||
          v.length !== 3 ||
          !finite(v) ||
          Math.abs(dot(v, v) - 1) > 1e-6,
      ) ||
      axes.some((v, i) =>
        axes.some((w, j) => i !== j && Math.abs(dot(v, w)) > 1e-6),
      ) ||
      dot(ex, axes[0]) < 1 - 1e-6
    )
      return fail("axes");
    const cross: Vec = [
      axes[0][1] * axes[1][2] - axes[0][2] * axes[1][1],
      axes[0][2] * axes[1][0] - axes[0][0] * axes[1][2],
      axes[0][0] * axes[1][1] - axes[0][1] * axes[1][0],
    ];
    if (dot(cross, axes[2]) < 1 - 1e-6) return fail("axes");
    const releases = bendingReleases(e.releases);
    if (!releases) return fail('releases');
    const hasReleases = releases.i.size > 0 || releases.j.size > 0;
    if (hasReleases && planar) return fail('releases');
    const va = axes.map((v) => dot(v, ua)),
      vb = axes.map((v) => dot(v, ub));
    const rotation = (axis: Vec, d: Record<string, number>) => axis.reduce((value, coefficient, index) =>
      value + (Math.abs(coefficient) > 1e-10 ? coefficient*d[['rx','ry','rz'][index]] : 0), 0);
    const ra = planar
      ? [0, 0, -da.ry]
      : axes.map((v) => rotation(v, da));
    const rb = planar
      ? [0, 0, -db.ry]
      : axes.map((v) => rotation(v, db));
    if ((!releases.i.has('rz') && !finite([ra[2]])) || (!releases.j.has('rz') && !finite([rb[2]])) ||
        (!planar && ((!releases.i.has('ry') && !finite([ra[1]])) || (!releases.j.has('ry') && !finite([rb[1]])))))
      return fail('rotations');
    const E = Number(m.materials.find((v) => v.id === e.material)?.E) * 1000;
    const declaredProperties = m.sections.find((v) => v.id === e.section)?.properties as
      Record<string, number> | undefined;
    // Canonical vectors already use rotated section axes. Only legacy planar
    // vectors need an effective in-plane inertia swap.
    const swapped = planar && Math.abs(Math.round(Number(e.rotation_angle ?? 0) / 90) % 2) === 1;
    const p = declaredProperties && swapped ? { ...declaredProperties, Iy: declaredProperties.Iz, Iz: declaredProperties.Iy } : declaredProperties;
    const n1 = force?.n1,
      n2 = force?.n2;
    const q: Vec = [0, 0, 0],
      dq: Vec = [0, 0, 0];
    const memberLoads = activeLoads.filter((l) => l.element === e.id);
    const loadsKnown =
      validFactors &&
      !hiddenLoads &&
      memberLoads.every(
        (l) =>
          l.type === "distributed" &&
          l.reference_frame === "global" &&
          finite([
            l.wx ?? 0,
            l.wy ?? 0,
            l.wz ?? 0,
            l.gradient?.wx ?? 0,
            l.gradient?.wy ?? 0,
            l.gradient?.wz ?? 0,
          ]) &&
          Object.keys(l).every((k) =>
            [
              "type",
              "element",
              "wx",
              "wy",
              "wz",
              "gradient",
              "reference_frame",
              "factor",
            ].includes(k),
          ),
      );
    if (loadsKnown)
      for (const l of memberLoads) {
        const global: Vec = [l.wx || 0, l.wy || 0, l.wz || 0];
        axes.forEach((v, i) => (q[i] += dot(v, global) * l.factor));
        const gradient: Vec = [
          l.gradient?.wx || 0,
          l.gradient?.wy || 0,
          l.gradient?.wz || 0,
        ];
        axes.forEach((v, i) => (dq[i] += dot(v, gradient) * l.factor));
      }
    const Iy = planar ? p?.Iy : p?.Iz,
      Iz = p?.Iy;
    // A canonical 2-D result still carries three local components. Its inactive
    // transverse direction needs no section inertia, but only when the declared
    // plane, axes, actions, loads, translations and slopes all agree it is absent.
    // Do not substitute an invented out-of-plane stiffness into a 2-D model.
    const normal: Vec | undefined = m.coordinate_system.dimension === '2d'
      ? m.coordinate_system.plane === 'xz' ? [0, 1, 0] : m.coordinate_system.plane === 'xy' ? [0, 0, 1] : undefined : undefined;
    const inactiveY = !planar && !!normal && Math.abs(dot(axes[1], normal)) > 1 - 1e-10
      && [va[1], vb[1], ra[2], rb[2], n1?.V2, n2?.V2, n1?.M3, n2?.M3, q[1], dq[1]].every(value => value === 0);
    const inactiveZ = !planar && !!normal && Math.abs(dot(axes[2], normal)) > 1 - 1e-10
      && [va[2], vb[2], ra[1], rb[1], n1?.V3, n2?.V3, n1?.M2, n2?.M2, q[2], dq[2]].every(value => value === 0);
    const activeInertias = [...(inactiveY ? [] : [Iy]), ...(inactiveZ ? [] : [Iz])];
    const stiffness =
      !!p && finite([E, p.A, ...activeInertias]) && E > 0 && p.A > 0 && activeInertias.every(value => value! > 0);
    const required = planar
      ? ["N", "V", "M"]
      : ["N", "V2", "V3", "M2", "M3", "T"];
    const ends = !!n1 && !!n2 && required.every((k) => finite([n1[k], n2[k]]));
    let eligible =
      loadsKnown &&
      stiffness &&
      ends &&
      force?.referenceFrame === "element-local" &&
      units?.force === "kN" &&
      units?.moment === "kN.m" &&
      !Object.keys(e).some((k) => /offset/i.test(k) && e[k] != null);
    const V = n1?.[planar ? "V" : "V2"] || 0,
      M = n1?.[planar ? "M" : "M3"] || 0;
    const moment = (x: number) =>
      -M + V * x + (q[1] * x * x) / 2 + (dq[1] * x ** 3) / 6;
    const moment2 = (x: number) =>
      -(n1?.M2 || 0) -
      (n1?.V3 || 0) * x -
      (q[2] * x * x) / 2 -
      (dq[2] * x ** 3) / 6;
    const poly = (x: number) => inactiveY ? 0 :
      ((-M * x * x) / 2 +
        (V * x ** 3) / 6 +
        (q[1] * x ** 4) / 24 +
        (dq[1] * x ** 5) / 120) /
      (E * Iy!);
    const polyZ = (x: number) => inactiveZ ? 0 :
      (((n1?.M2 || 0) * x * x) / 2 +
        ((n1?.V3 || 0) * x ** 3) / 6 +
        (q[2] * x ** 4) / 24 +
        (dq[2] * x ** 5) / 120) /
      (E * Iz!);
    const sy = (vb[1] - va[1] - poly(L)) / L,
      sz = (vb[2] - va[2] - polyZ(L)) / L;
    const slopeY = inactiveY ? 0 :
      sy +
      (-M * L + (V * L * L) / 2 + (q[1] * L ** 3) / 6 + (dq[1] * L ** 4) / 24) /
        (E * Iy!);
    const slopeZ = inactiveZ ? 0 :
      sz +
      ((n1?.M2 || 0) * L +
        ((n1?.V3 || 0) * L * L) / 2 +
        (q[2] * L ** 3) / 6 +
        (dq[2] * L ** 4) / 24) /
        (E * Iz!);
    let error = 0;
    if (eligible) {
      const pairs = [
        [moment(L), n2![planar ? "M" : "M3"]],
        [V + q[1] * L + (dq[1] * L * L) / 2, -n2![planar ? "V" : "V2"]],
        [-n1!.N - q[0] * L - (dq[0] * L * L) / 2, n2!.N],
        [
          (E * p!.A * (vb[0] - va[0])) / L,
          -n1!.N - (q[0] * L) / 2 - (dq[0] * L * L) / 6,
        ],
        releases.i.has('rz') ? [n1![planar ? 'M' : 'M3'], 0] : [sy, ra[2]],
        releases.j.has('rz') ? [n2![planar ? 'M' : 'M3'], 0] : [slopeY, rb[2]],
      ];
      if (!planar)
        pairs.push(
          [-n1!.T, n2!.T],
          [moment2(L), n2!.M2],
          [(n1!.V3 || 0) + q[2] * L + (dq[2] * L * L) / 2, -n2!.V3],
          releases.i.has('ry') ? [n1!.M2, 0] : [sz, -ra[1]],
          releases.j.has('ry') ? [n2!.M2, 0] : [slopeZ, -rb[1]],
        );
      error = Math.max(
        ...pairs.map(
          ([v, w]) =>
            Math.abs(v - w) /
            (1e-8 + 1e-5 * Math.max(Math.abs(v), Math.abs(w))),
        ),
      );
      eligible = error <= 1;
    }
    // Released member-end slopes need not equal joint rotations. When mechanics
    // cannot be checked, a Hermite curve through those joint rotations is false.
    if (hasReleases && !eligible) return fail('release-consistency');
    const reason = eligible
      ? "checked"
      : hiddenLoads
        ? "floor"
        : !loadsKnown
          ? "loads"
          : !stiffness
            ? "stiffness"
            : !ends
              ? "forces"
              : "consistency";
    return {
      id: e.id,
      length: L,
      state: eligible ? "recovered" : "interpolated",
      reason,
      axes,
      endError: eligible ? error : undefined,
      samples: [
        ...new Set([
          ...Array.from({ length: 81 }, (_, i) => (L * i) / 80),
          ...(samplePositions?.[e.id] ?? []).filter(
            (x) => Number.isFinite(x) && x >= 0 && x <= L,
          ),
        ]),
      ]
        .sort((a, b) => a - b)
        .map((x) => {
          const t = x / L;
          const local: Vec = [
            va[0] * (1 - t) +
              vb[0] * t +
              (eligible
                ? ((q[0] * x * (L - x)) / 2 +
                    (dq[0] * (L * L * x - x ** 3)) / 6) /
                  (E * p!.A)
                : 0),
            eligible
              ? va[1] + sy * x + poly(x)
              : hermite(va[1], vb[1], ra[2], rb[2], L, t),
            planar
              ? 0
              : eligible
                ? va[2] + sz * x + polyZ(x)
                : hermite(va[2], vb[2], -ra[1], -rb[1], L, t),
          ];
          return {
            x,
            position: add(start, mul(dx, t)),
            displacement: axes.reduce<Vec>(
              (v, axis, j) => add(v, mul(axis, local[j])),
              [0, 0, 0],
            ),
            ...(eligible
              ? {
                  N: -n1!.N - q[0] * x - (dq[0] * x * x) / 2,
                  V2: V + q[1] * x + (dq[1] * x * x) / 2,
                  M3: moment(x),
                  ...(!planar
                    ? {
                        V3: n1!.V3 + q[2] * x + (dq[2] * x * x) / 2,
                        M2: moment2(x),
                        T: -n1!.T,
                      }
                    : {}),
                }
              : {}),
          };
        }),
    };
  });
}
