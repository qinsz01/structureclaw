export function genericLoadBindingFixture() {
  const materials = [{ id: 'M', name: 'Confirmed C35', grade: 'C35', category: 'concrete', E: 31500, nu: 0.2, rho: 2500 }];
  const sections = [
    { id: 'C', name: '500x500 mm column', type: 'rectangular', shape: { kind: 'rectangular', B: 500, H: 500 } },
    { id: 'B', name: '300x600 mm beam', type: 'rectangular', shape: { kind: 'rectangular', B: 300, H: 600 } },
  ].map(section => ({ ...section, extra: { provenance: { shape: 'user' } } }));
  const selector = { type: 'beam', coordinate: { axis: 'z', eq: 11.7 } };
  const draft = { engineeringDraft: {
    structureType: 'frame', coordinateSystem: { dimension: '3d' },
    geometry: { storyHeightsM: [4.5, 3.6, 3.6], bayWidthsXM: [6, 6, 6], bayWidthsYM: [6, 6, 6] },
    materials, sectionRecords: sections, templateAssignments: {
      column: { materialId: 'M', sectionId: 'C' }, beam: { materialId: 'M', sectionId: 'B' },
    }, boundary: { frameBaseSupportType: 'fixed' }, analysisControl: { self_weight: false },
    loads: [{ id: 'ORIGINAL-ROOF-DL', kind: 'line', magnitude: 2, unit: 'kN/m', direction: 'gravity',
      target: 'confirmed-roof-beam-group', location: { story: 3 } },
    { id: 'ORIGINAL-ROOF-LL', kind: 'line', magnitude: 1, unit: 'kN/m', direction: 'gravity',
      target: 'confirmed-roof-beam-group', location: { story: 3 }, caseId: 'L-explicit' }],
    analysis: { type: 'static' },
  }, requestScope: { responses: ['forces', 'reactions', 'displacements'], design: false, report: true, outputs: [] } };
  const model = { schema_version: '2.2.0', unit_system: 'SI', coordinate_system: { dimension: '3d' },
    materials, sections, analysis_control: { self_weight: false },
    load_cases: [{ id: 'D-explicit', type: 'dead', loads: [] }, { id: 'L-explicit', type: 'live', loads: [] }],
    operations: [
      { id: 'frame', op: 'regular-frame', dimension: '3d', bayWidthsX: [6, 6, 6], bayWidthsY: [6, 6, 6],
        storeyHeights: [4.5, 3.6, 3.6], baseRestraint: 'fixed', material: 'M', columnSection: 'C', beamSection: 'B' },
      { id: 'apply-dead', op: 'member-udl', selector, caseId: 'D-explicit', vector: [0, 0, -2] },
      { id: 'apply-live', op: 'member-udl', selector, caseId: 'L-explicit', vector: [0, 0, -1] },
    ], metadata: { loadMappings: [
      { loadId: 'ORIGINAL-ROOF-DL', caseId: 'D-explicit', selector },
      { loadId: 'ORIGINAL-ROOF-LL', selector },
    ] },
  };
  // The roof has twelve 6 m X beams and twelve 6 m Y beams: 144 m in each case.
  return { draft: structuredClone(draft), model: structuredClone(model), totals: { 'case:D-explicit': 288, 'case:L-explicit': 144 } };
}
