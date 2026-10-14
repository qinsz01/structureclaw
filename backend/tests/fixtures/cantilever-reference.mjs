// Product-owned reference: Euler–Bernoulli cantilever, E=200 GPa, Iy=1e-4 m4.
// Values are closed-form, independent of the production solver and recovery code.
export const model = {
  schema_version: '2.2.0', unit_system: 'SI',
  coordinate_system: { semantics: 'global-z-up', version: 1, dimension: '2d', plane: 'xz',
    dof_order: ['ux','uy','uz','rx','ry','rz'] },
  nodes: [{ id: 'A', x: 0, y: 0, z: 0, restraints: [true,true,true,true,true,true] },
    { id: 'B', x: 6, y: 0, z: 0 }],
  materials: [{ id: 'steel', name: 'Elastic steel', E: 200000, nu: 0.3, rho: 7850 }],
  sections: [{ id: 'S', name: 'Explicit elastic properties', type: 'general', properties: { A: 0.02, Iy: 0.0001, Iz: 0.0002, J: 0.00005 } }],
  elements: [{ id: 'beam', type: 'beam', nodes: ['A','B'], material: 'steel', section: 'S' }],
  load_cases: [
    { id: 'D', name: 'Uniform 2 kN/m', type: 'dead', loads: [{ id: 'q', type: 'distributed', element: 'beam', wz: -2 }] },
    { id: 'L', name: 'Tip 500 N', type: 'live', loads: [{ id: 'p', type: 'nodal', node: 'B', fz: -0.5 }] },
  ],
  load_combinations: [{ id: 'U', name: 'Explicit linear combination', factors: { D: 1.2, L: 1.4 } }],
  analysis_control: { self_weight: false },
};
const EI = 200000000 * 0.0001;
const tolerance = { absolute: 1e-8, relative: 1e-7 };
export const reference = { basis: 'closed-form elastic cantilever; frozen formulas, SI engineering units', quantities: [] };
for (const [kind, id, d, l] of [['case','D',1,0],['case','L',0,1],['combination','U',1.2,1.4]]) {
  for (const x of [0,1.234,3,6]) reference.quantities.push({ id: `${id}-M-${x}`, selection: { kind, id },
    location: { kind:'member', id:'beam', positionM:x, side:x===6?'left':'right' },
    component:'M2', unit:'kN.m', value: d*(6-x)**2 + l*0.5*(6-x), tolerance });
  for (const [node, component, unit, value] of [['B','uz','mm',-(d*2*6**4/8+l*.5*6**3/3)/EI*1000],
    ['A','fz','kN',d*12+l*.5],['A','my','kN.m',-d*36-l*3]]) reference.quantities.push({
    id:`${id}-${node}-${component}`, selection:{kind,id}, location:{kind:'node',id:node}, component, unit, value, tolerance });
}
