/** Product-owned regression input; no Bench data and no production result recovery code.
 * Coordinates m, loads kN, E MPa, density kg/m³, section dimensions mm.
 * Frozen Euler–Bernoulli reference: R=P/2; M2(mid)=-PL/4 (local sign);
 * uz(mid)=-PL³/(48EI), I=0.1*0.2³/12 m⁴, E=206000000 kN/m².
 */
export const beamModel = {
  schema_version: '2.2.0', unit_system: 'SI',
  coordinate_system: { semantics: 'global-z-up', version: 1, dimension: '2d', plane: 'xz',
    dof_order: ['ux', 'uy', 'uz', 'rx', 'ry', 'rz'] },
  nodes: [
    { id: 'A', x: 0, y: 0, z: 0, restraints: [true, true, true, true, false, true] },
    { id: 'B', x: 10, y: 0, z: 0, restraints: [false, true, true, true, false, true] },
  ],
  elements: [{ id: 'beam', type: 'beam', nodes: ['A', 'B'], material: 'steel', section: 'rectangle' }],
  materials: [{ id: 'steel', name: 'Elastic steel', type: 'steel', E: 206000, nu: 0.3, rho: 7850 }],
  sections: [{ id: 'rectangle', name: '100 × 200 mm solid rectangle', type: 'rectangular',
    shape: { kind: 'rectangular', B: 100, H: 200 } }],
  load_cases: [{ id: 'LC1', type: 'other', loads: [{ id: 'midpoint-load', type: 'point', element: 'beam', position: 5, fz: -1 }] }],
  load_combinations: [],
  analysis_control: { self_weight: false, rigid_floor: false, rigid_offsets: false, p_delta: false, construction_stage: false },
}

export const beamReference = { reactionKn: 0.5, midpointMomentKnm: -2.5, midpointDisplacementMm: -1.516990291262136 }
export const beamAnalysis = { analysisType: 'static', analysisSkillId: 'opensees-static', loadCaseIds: ['LC1'] }
