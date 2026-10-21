const fixed = [true, true, true, true, true, true];
const pin = [true, true, true, false, false, false];
const roller = [false, true, true, false, false, false];
const node = (id, x, z, restraints, y = 0) => ({ id, x, y, z, ...(restraints ? { restraints } : {}) });
const member = (id, type, a, b) => ({ id, type, nodes: [a, b], material: 'Q235', section: 'R' });
function fixture(id, nodes, elements, loads, total, dimension = '2d') {
  const model = {
    schema_version: '2.2.0', unit_system: 'SI',
    coordinate_system: { semantics: 'global-z-up', version: 1, dimension, plane: dimension === '2d' ? 'xz' : null, dof_order: ['ux', 'uy', 'uz', 'rx', 'ry', 'rz'] },
    nodes, elements, materials: [{ id: 'Q235', name: 'Q235', grade: 'Q235', E: 206000, nu: 0.3, rho: 7850 }],
    sections: [{ id: 'R', name: '100×200 mm rectangle', type: 'rectangular', purpose: 'beam', shape: { kind: 'rectangular', B: 100, H: 200 } }],
    load_cases: [{ id: 'LC1', type: 'other', loads }], load_combinations: [], analysis_control: { self_weight: false },
  };
  return { id, model, total, supports: nodes.filter(node => node.restraints).map(node => node.id),
    draft: { inferredType: 'unknown', engineeringDraft: {
      coordinateSystem: model.coordinate_system, topology: { nodes, members: elements },
      materials: model.materials, sectionRecords: model.sections, loadCases: model.load_cases,
      analysisControl: model.analysis_control, analysis: { type: 'static' },
    }, requestScope: { responses: ['forces', 'reactions', 'displacements'], design: false, report: false, outputs: [] } },
  };
}
const frameNodes = [], frameMembers = [];
for (let story = 0; story <= 2; story++) for (let bay = 0; bay <= 2; bay++) {
  frameNodes.push(node(`F${story}${bay}`, bay * 5, story * 3, story === 0 ? fixed : undefined));
  if (story) frameMembers.push(member(`C${story}${bay}`, 'column', `F${story - 1}${bay}`, `F${story}${bay}`));
  if (story && bay) frameMembers.push(member(`B${story}${bay}`, 'beam', `F${story}${bay - 1}`, `F${story}${bay}`));
}
const gridNodes = [], gridMembers = [];
for (let story = 0; story <= 1; story++) for (let x = 0; x <= 2; x++) for (let y = 0; y <= 2; y++) {
  const id = `G${story}${x}${y}`;
  gridNodes.push(node(id, x * 5, story * 3, story === 0 ? fixed : undefined, y * 5));
  if (story) gridMembers.push(member(`C${x}${y}`, 'column', `G0${x}${y}`, id));
  if (story && x) gridMembers.push(member(`X${x}${y}`, 'beam', `G1${x - 1}${y}`, id));
  if (story && y) gridMembers.push(member(`Y${x}${y}`, 'beam', `G1${x}${y - 1}`, id));
}
const archNodes = Array.from({ length: 7 }, (_, index) => {
  const x = index;
  return node(`A${index}`, x, 2 * (1 - ((x - 3) / 3) ** 2), index === 0 || index === 6 ? fixed : undefined);
});
export const genericFixtures = [
  fixture('two-storey-frame', frameNodes, frameMembers, frameNodes.filter(node => node.z > 0).map(node => ({ type: 'nodal', node: node.id, fx: 10 })), [60, 0, 0]),
  fixture('portal', [node('A', 0, 0, fixed), node('B', 0, 3), node('C', 3, 4), node('D', 6, 3), node('E', 6, 0, fixed)],
    [member('AB', 'column', 'A', 'B'), member('BC', 'beam', 'B', 'C'), member('CD', 'beam', 'C', 'D'), member('DE', 'column', 'D', 'E')], [{ type: 'nodal', node: 'C', fx: 10 }], [10, 0, 0]),
  fixture('arch', archNodes, archNodes.slice(1).map((node, i) => member(`arch${i}`, 'beam', `A${i}`, node.id)), [{ type: 'nodal', node: 'A3', fz: -10 }], [0, 0, -10]),
  fixture('inclined-truss', [node('A', 0, 0, pin), node('B', 6, 2, roller), node('C', 3, 4)],
    [member('AB', 'truss', 'A', 'B'), member('AC', 'truss', 'A', 'C'), member('BC', 'truss', 'B', 'C')], [{ type: 'nodal', node: 'C', fz: -10 }], [0, 0, -10]),
  fixture('grid3d', gridNodes, gridMembers, gridNodes.filter(node => node.z > 0).map(node => ({ type: 'nodal', node: node.id, fx: 1 })), [9, 0, 0], '3d'),
  fixture('mixed-frame-brace', [node('A', 0, 0, fixed), node('B', 5, 0, fixed), node('C', 0, 3), node('D', 5, 3)],
    [member('AC', 'column', 'A', 'C'), member('BD', 'column', 'B', 'D'), member('CD', 'beam', 'C', 'D'), member('AD', 'brace', 'A', 'D')], [{ type: 'nodal', node: 'D', fx: 10 }], [10, 0, 0]),
];
