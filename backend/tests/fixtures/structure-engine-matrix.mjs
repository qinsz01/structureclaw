// Product-owned contract inputs, separate from the benchmark corpus.
import { genericFixtures } from '../characterization/fixtures/generic-physics.mjs';

export const control = { self_weight: false, rigid_floor: false, rigid_offsets: false, p_delta: false, construction_stage: false };
const steel = { family: 'steel', grade: 'Q235B' };
const sections = { member: 'H300X200X8X12', beam: 'H300X200X8X12', column: 'H300X200X8X12' };
const load = (magnitude, direction, target, location, kind = 'nodal') => ({ kind, magnitude, unit: kind === 'line' ? 'kN/m' : 'kN', direction, target, ...(location ? { location } : {}) });
const base = (id, skillId, geometry, loads, extra = {}, total = [0, 0, 0]) => ({ id, skillId, total,
  draft: { engineeringDraft: { structureType: skillId, geometry, material: steel, sections, loads,
    analysisControl: control, analysis: { type: 'static', loadCombinations: [] }, ...extra },
    requestScope: { responses: ['forces', 'reactions', 'displacements'], design: false, report: true, outputs: [] } } });

export const structureCases = [
  base('beam-point', 'beam', { lengthM: 6 }, [load(10, 'gravity', 'beam', { xM: 3 }, 'point')], { boundary: { supportType: 'simply-supported' } }, [0, 0, -10]),
  base('continuous-three-span', 'double-span-beam', { spanLengthsM: [4, 5, 4] }, [load(5, 'gravity', 'beam', undefined, 'line')], { boundary: { supportPositionsM: [0, 4, 9, 13] } }, [0, 0, -65]),
  base('column-biaxial', 'column', { heightM: 3 }, [load(100, 'gravity', 'top-node'), load(10, 'globalX', 'top-node')], {}, [10, 0, -100]),
  base('steel-frame-two-storey', 'frame', { storyHeightsM: [3, 3.5], bayWidthsM: [4, 5] },
    [load(20, 'globalX', 'all-stories'), load(100, 'gravity', 'all-stories')], { boundary: { supportType: 'fixed' } }, [40, 0, -200]),
  base('portal-two-bay', 'portal-frame', { spanLengthsM: [6, 6], heightM: 4 }, [load(5, 'gravity', 'roof', undefined, 'line')], { boundary: { supportType: 'fixed' } }, [0, 0, -60]),
  base('concrete-frame', 'concrete-frame', { storyHeightsM: [3.6, 3.6], bayWidthsM: [6] },
    [load(120, 'gravity', 'all-stories'), load(20, 'globalX', 'all-stories')],
    { material: { family: 'concrete', grade: 'C35', rebarGrade: 'HRB500' }, sections: { beam: '300X600', column: '500X500' }, boundary: { supportType: 'fixed' } }, [40, 0, -240]),
  base('truss-four-panel', 'truss', { lengthM: 12, heightM: 3, spanLengthsM: [3, 3, 3, 3] },
    [load(10, 'gravity', 'interior-top-nodes')], {}, [0, 0, -30]),
  ...['frame', 'concrete-frame'].map(skillId => base(`${skillId}-3d-cases`, skillId,
    { storyHeightsM: [3.6], bayWidthsXM: [4], bayWidthsYM: [5] },
    [0, 1].flatMap(x => [0, 1].map(y => ({ ...load(10, 'gravity', `N1_${x}_${y}`), caseId: 'DL', caseType: 'dead' })))
      .concat([{ ...load(5, 'globalX', 'N1_1_1'), caseId: 'LL', caseType: 'live' }]),
    { coordinateSystem: { dimension: '3d' }, boundary: { frameBaseSupportType: 'fixed' },
      ...(skillId === 'concrete-frame' ? { material: { family: 'concrete', grade: 'C40', rebarGrade: 'HRB500' }, sections: { beam: '300X600', column: '500X500' } } : {}),
      analysis: { type: 'static', loadCombinations: [{ id: 'ULS', factors: { DL: 1.3, LL: 1.5 } }] } }, [5, 0, -40])),
  ...genericFixtures.map(fixture => ({ ...structuredClone(fixture), id: `generic-${fixture.id}`, skillId: 'generic',
    draft: { ...structuredClone(fixture.draft), requestScope: { ...fixture.draft.requestScope, report: true } } })),
];
const rectangularSteel = structuredClone(structureCases.find(row => row.id === 'frame-3d-cases'));
rectangularSteel.id = 'frame-3d-rectangular-cases';
rectangularSteel.draft.engineeringDraft.sections = { beam: '300X600', column: '300X300' };
structureCases.push(rectangularSteel);
const baseGradeSteel = structuredClone(rectangularSteel);
baseGradeSteel.id = 'frame-3d-rectangular-base-grade-cases';
baseGradeSteel.draft.engineeringDraft.material.grade = 'Q235';
structureCases.push(baseGradeSteel);
const auditedSteel = structuredClone(baseGradeSteel);
auditedSteel.id = 'frame-3d-provenance-cases';
auditedSteel.draft.engineeringDraft.materials = [{ id: 'M', name: 'Q235', grade: 'Q235', E: 206000, nu: .3, rho: 7850 }];
auditedSteel.draft.engineeringDraft.sectionRecords = [['SB', 300, 600], ['SC', 300, 300]].map(([id, B, H]) => ({ id,
  name: `${B}X${H}`, type: 'rectangular', shape: { kind: 'rectangular', B, H }, extra: {
    provenance: { shape: 'user', properties: 'geometry' }, discarded_nonuser_properties: { J: 999 },
    confirmation: { clarificationId: 'confirmed-dimensions' } } }));
auditedSteel.draft.engineeringDraft.templateAssignments = { beam: { materialId: 'M', sectionId: 'SB' }, column: { materialId: 'M', sectionId: 'SC' } };
structureCases.push(auditedSteel);
for (const skillId of ['frame', 'concrete-frame']) {
  for (const floorTotals of [false, true]) {
    const fixture = structuredClone(structureCases.find(row => row.id === (skillId === 'frame'
      ? 'frame-3d-rectangular-base-grade-cases' : 'concrete-frame-3d-cases')));
    fixture.id = `${skillId}-two-storey-${floorTotals ? 'floor' : 'nodal'}-cases`;
    fixture.draft.engineeringDraft.geometry.storyHeightsM = [3, 3.6];
    fixture.draft.engineeringDraft.loads = floorTotals
      ? [{ ...load(100, 'gravity', 'all-stories'), caseId: 'DL', caseType: 'dead' },
        { ...load(50, 'gravity', 'top-story'), caseId: 'LL', caseType: 'live' }]
      : [1, 2].flatMap(story => [0, 1].flatMap(x => [0, 1].map(y => ({
        ...load(25, 'gravity', `N${story}_${x}_${y}`), caseId: 'DL', caseType: 'dead' }))))
        .concat([0, 1].flatMap(x => [0, 1].map(y => ({ ...load(12.5, 'gravity', `N2_${x}_${y}`), caseId: 'LL', caseType: 'live' }))));
    fixture.floorTotals = floorTotals;
    fixture.analysisArgs = { floorLoadTransferMode: 'node_tributary' };
    fixture.expectedTotals = { 'case:DL': [0, 0, -200], 'case:LL': [0, 0, -50], 'combination:ULS': [0, 0, -335] };
    fixture.expectedNative = { 'pkpm-static': floorTotals ? 'refused' : 'solved',
      'yjk-static': floorTotals ? 'refused' : 'solved' };
    const ea = (skillId === 'frame' ? 206000 * .3 ** 2 : 32500 * .5 ** 2) * 1000;
    fixture.referenceChecks = [
      { resultKey: 'case:DL', z: 3, value: -50 * 3 / ea },
      { resultKey: 'case:DL', z: 6.6, value: -(50 * 3 + 25 * 3.6) / ea },
      { resultKey: 'case:LL', z: 6.6, value: -12.5 * 6.6 / ea },
      { resultKey: 'combination:ULS', z: 6.6, value: -(1.3 * (50 * 3 + 25 * 3.6) + 1.5 * 12.5 * 6.6) / ea },
    ].map(check => ({ ...check, x: 0, field: 'displacements', component: 'uz', tolerance: 1e-9 }));
    structureCases.push(fixture);
  }
}
const mixedFloorLine = base('concrete-frame-mixed-floor-line-cases', 'concrete-frame',
  { storyHeightsM: [3, 3.6], bayWidthsM: [6] },
  [{ ...load(100, 'gravity', 'all-stories'), caseId: 'DL', caseType: 'dead' },
    { ...load(50, 'gravity', 'top-story'), caseId: 'LL', caseType: 'live' },
    { ...load(5, 'gravity', 'roof', undefined, 'line'), caseId: 'SDL', caseType: 'dead' }],
  { coordinateSystem: { dimension: '2d' }, material: { family: 'concrete', grade: 'C40', rebarGrade: 'HRB500' },
    sections: { beam: '300X600', column: '500X500' }, boundary: { frameBaseSupportType: 'fixed' },
    analysis: { type: 'static', loadCombinations: [{ id: 'ULS', factors: { DL: 1.3, SDL: 1.3, LL: 1.5 } }] } }, [0, 0, -280]);
mixedFloorLine.expectedTotals = { 'case:DL': [0, 0, -200], 'case:LL': [0, 0, -50], 'case:SDL': [0, 0, -30], 'combination:ULS': [0, 0, -374] };
mixedFloorLine.expectedNative = { 'pkpm-static': 'refused', 'yjk-static': 'refused' };
mixedFloorLine.analysisArgs = { floorLoadTransferMode: 'node_tributary' };
mixedFloorLine.referenceChecks = [
  { resultKey: 'case:DL', value: -(100 * 3 + 50 * 3.6) / (32500 * 1000 * .5 ** 2) },
  { resultKey: 'case:LL', value: -25 * 6.6 / (32500 * 1000 * .5 ** 2) },
].map(check => ({ ...check, x: 0, z: 6.6, field: 'displacements', component: 'uz', tolerance: 1e-9 }));
structureCases.push(mixedFloorLine);
for (const fixture of structureCases) {
  fixture.draft.engineeringDraft.analysisControl = structuredClone(control);
  if (fixture.model) fixture.model.analysis_control = structuredClone(control);
  const building = fixture.draft.engineeringDraft.coordinateSystem?.dimension === '3d' && !fixture.model;
  fixture.expectedTotals ??= building
    ? { 'case:DL': [0, 0, -40], 'case:LL': [5, 0, 0], 'combination:ULS': [7.5, 0, -52] }
    : ['steel-frame-two-storey', 'concrete-frame'].includes(fixture.id)
      ? { 'case:D': [0, 0, fixture.total[2]], 'case:LAT': [fixture.total[0], 0, 0] }
      : { 'case:LC1': fixture.total };
  fixture.expectedNative ??= { 'pkpm-static': building && fixture.draft.engineeringDraft.material.grade !== 'Q235B' ? 'solved' : 'refused',
    'yjk-static': building ? 'solved' : 'refused' };
  if (building && !fixture.referenceChecks) {
    const E = fixture.skillId === 'concrete-frame' ? 32500 : 206000;
    const area = fixture.skillId === 'concrete-frame' ? .5 ** 2
      : fixture.draft.engineeringDraft.sections.column === '300X300' ? .3 ** 2 : 2 * .2 * .012 + (.3 - .024) * .008;
    fixture.axialDzM = -10 * 3.6 / (E * 1000 * area); // Four equal top loads: each column carries 10 kN, PL/EA.
  }
  if (fixture.id === 'beam-point') fixture.referenceChecks = [{ resultKey: 'case:LC1', x: 3, field: 'displacements', component: 'uz',
    value: -10 * 6 ** 3 / (48 * 206000000 * ((.2 * .3 ** 3 - (.2 - .008) * (.3 - .024) ** 3) / 12)), tolerance: 1e-9 }];
  if (fixture.id === 'continuous-three-span') fixture.referenceChecks = [0, 13].map(x => ({ resultKey: 'case:LC1', x,
    field: 'reactions', component: 'fz', value: 10 - (5 * (4 ** 3 + 5 ** 3) / 4 / 23) / 4, tolerance: 1e-6 }));
}

export const engines = ['opensees-static', 'pkpm-static', 'yjk-static'];
