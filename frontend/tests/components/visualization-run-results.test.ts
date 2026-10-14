import { describe, expect, it } from 'vitest'
import { buildVisualizationSnapshot } from '@/components/visualization/adapter'
import { getBucklingModes } from '@/components/visualization/extensions'
import { isCanonicalVisualizationSnapshot } from '@/components/visualization/normalization'
import { getMemberDeformedPoints, isLoadVisible } from '@/components/visualization/structural-scene-utils'

const coordinates = { semantics: 'global-z-up', version: 1, dimension: '2d', plane: 'xz',
  dof_order: ['ux', 'uy', 'uz', 'rx', 'ry', 'rz'] }
const resultMeta = { coordinateSemantics: 'global-z-up', coordinateContractVersion: 1, dimension: '2d', plane: 'xz',
  dofOrder: coordinates.dof_order, activeDofs: ['ux', 'uz', 'ry'], nodalResultFrame: 'global', elementForceFrame: 'element-local' }
const model = { schema_version: '2.1.0', coordinate_system: coordinates,
  nodes: [{ id: '1', x: 0, y: 0, z: 0 }, { id: '2', x: 6, y: 0, z: 0 }],
  elements: [{ id: 'E1', type: 'beam', nodes: ['1', '2'] }],
  load_cases: [{ id: 'D', loads: [{ node: '2', fz: -10 }] }, { id: 'L', loads: [{ element: 'E1', wz: -5 }] }],
  load_combinations: [{ id: 'U', factors: { D: 1.2, L: -0.5 } }],
}

function child(id: string, magnitude: number, kind = 'case') {
  return { success: true, selection: { key: `${kind}:${id}`, kind, id }, meta: { runId: 'run', modelHash: 'physical' },
    data: { meta: resultMeta, summary: { maxDisplacement: magnitude }, displacements: { '2': { ux: 0, uy: 0, uz: -magnitude } },
      forces: { E1: { n1: { N: 0, V: magnitude, M: magnitude * 2 }, n2: { N: 0, V: -magnitude, M: 0 } } },
      reactions: { '1': { fz: magnitude } },
      memberResponses: [{ id: 'E1', length: 6, state: 'recovered', reason: 'equilibrium', samples: [
        { x: 0, position: [0, 0, 0], displacement: [0, 0, 0] },
        { x: 3, position: [3, 0, 0], displacement: [0, 0, -magnitude * 2] },
        { x: 6, position: [6, 0, 0], displacement: [0, 0, -magnitude] },
      ] }],
    } }
}
function run() {
  return { ...child('IGNORED', 999), runId: 'run', selectedResultKey: 'case:L',
    results: { 'case:D': child('D', 1), 'case:L': child('L', 2), 'combination:U': child('U', 3, 'combination') } }
}
function snapshot(analysis: Record<string, unknown> = run()) {
  return buildVisualizationSnapshot({ title: 'Run results', model, analysis })
}

describe('saved analysis run visualization', () => {
  it('uses the selected child and keeps curves, forces, reactions and loads in their own case', () => {
    const input = run()
    const before = JSON.stringify(input)
    const view = snapshot(input)!
    expect(isCanonicalVisualizationSnapshot(view)).toBe(true)
    expect(view.defaultCaseId).toBe('case:L')
    expect(view.summary).toEqual({ maxDisplacement: 2 })
    expect(view.cases.map(item => item.id)).toEqual(['case:D', 'case:L', 'combination:U'])
    expect(view.cases.map(item => item.nodeResults['2'].displacement?.uz)).toEqual([-1, -2, -3])
    expect(view.cases.map(item => item.nodeResults['1'].reaction?.fz)).toEqual([1, 2, 3])
    expect(view.cases.map(item => item.elementResults.E1.moment)).toEqual([2, 4, 6])
    expect(view.cases.map(item => getMemberDeformedPoints(item, 'E1', 1)?.[1].z)).toEqual([-2, -4, -6])
    expect(view.loads.filter(load => isLoadVisible(view, view.cases[1], load))).toEqual([
      expect.objectContaining({ elementId: 'E1', caseId: 'case:L', vector: { x: 0, y: 0, z: -5 } }),
    ])
    expect(JSON.stringify(input)).toBe(before)
  })

  it('renders combination load factors including sign without rescaling solved result curves', () => {
    const view = snapshot()!
    const combination = view.cases[2]
    expect(view.loads.filter(load => isLoadVisible(view, combination, load)).map(load => load.vector.z)).toEqual([-12, 2.5])
    expect(getMemberDeformedPoints(combination, 'E1', 1)?.[1].z).toBe(-6)
  })

  it('uses effective solver loads including self weight once, without multiplying combination factors twice', () => {
    const input = run()
    Object.assign(input.results['combination:U'].data, { effectiveLoads: [
      { type: 'nodal', node: '2', fz: -24 },
      { type: 'distributed', element: 'E1', start: 0, end: 6, wz: -0.8, source: 'explicit-self-weight' },
    ] })
    const view = snapshot(input)!
    expect(view.loads.filter(load => load.caseId === 'combination:U').map(load => load.vector.z)).toEqual([-24, -0.8])
  })

  it('keeps an unavailable selected result empty instead of borrowing the top-level or another case', () => {
    const input = run()
    input.results['case:L'].success = false
    const view = snapshot(input)!
    expect(view.defaultCaseId).toBe('case:L')
    expect(view.cases[1]).toMatchObject({ resultStatus: 'unavailable', nodeResults: {}, elementResults: {}, availableViews: ['model'] })
    expect(getMemberDeformedPoints(view.cases[1], 'E1', 1)).toBeUndefined()
    expect(view.loads.some(load => isLoadVisible(view, view.cases[1], load))).toBe(false)
    expect(view.cases[0].resultStatus).toBe('available')
    expect(view.summary).toBeUndefined()
  })

  it('never silently changes a missing explicit selection to the first valid case', () => {
    expect(snapshot({ ...run(), selectedResultKey: 'case:missing' })).toBeNull()
  })

  it.each(['run', 'selection', 'geometry', 'model-hash', 'settings-hash'])('does not render a child with conflicting %s provenance', (mismatch) => {
    const input = run()
    const selected = input.results['case:L']
    if (mismatch === 'run') selected.meta.runId = 'old-run'
    if (mismatch === 'selection') selected.selection.id = 'D'
    if (mismatch === 'geometry') selected.data.memberResponses[0].id = 'absent'
    if (mismatch === 'model-hash') selected.meta.modelHash = 'old-model'
    if (mismatch === 'settings-hash') Object.assign(selected.meta, { settingsHash: 'old-settings' })
    const view = snapshot(input)!
    expect(view.cases[1].resultStatus).toBe('unavailable')
    expect(view.cases[1].memberResponses).toBeUndefined()
    expect(view.summary).toBeUndefined()
  })

  it('does not spread aggregate utilization or buckling hints into every case', () => {
    const modes = [{ lambda: 2, modeShape: { '2': [0, 0, 1] as [number, number, number] } }]
    const input = run()
    Object.assign(input.results['case:D'].data, { buckling: { modes }, steelCheck: { memberUtilization: { E1: 0.4 } } })
    const view = buildVisualizationSnapshot({ title: 'Run', model, analysis: input,
      memberUtilizationMap: { E1: 9 }, bucklingModes: modes })!
    expect(view.cases[0].elementResults.E1.utilization).toBe(0.4)
    expect(view.cases[1].elementResults.E1.utilization).toBeUndefined()
    expect(getBucklingModes(view, view.cases[0])).toEqual(modes)
    expect(getBucklingModes(view, view.cases[1])).toEqual([])
  })
})

it('force-only results expose forces and reactions without a fabricated deformation view', () => {
  const scopedModel = { schema_version:'2.2.0', unit_system:'SI',coordinate_system:coordinates,
    nodes:[{id:'A',x:0,y:0,z:0},{id:'B',x:10,y:0,z:0}],elements:[{id:'beam',type:'beam',nodes:['A','B']}],materials:[],sections:[],
    load_cases:[{id:'LC1',loads:[{element:'beam',type:'point',position:5,fz:-1}]}],load_combinations:[] };
  const scopedResult = { success:true,runId:'equilibrium-run',modelSnapshot:scopedModel,meta:{runId:'equilibrium-run',modelHash:'eq',settingsHash:'eq'},selectedResultKey:'case:LC1',
    results:{'case:LC1':{success:true,selection:{key:'case:LC1',kind:'case',id:'LC1'},meta:{...resultMeta,engineId:'builtin-equilibrium',runId:'equilibrium-run',modelHash:'eq',settingsHash:'eq'},
      data:{reactions:{A:{fz:0.5},B:{fz:0.5}},forces:{beam:{n1:{N:0,V3:0.5,M2:0},n2:{N:0,V3:-0.5,M2:0}}},
        memberResponses:[{id:'beam',length:10,state:'force-only',reason:'Equilibrium',samples:[{x:0,position:[0,0,0],N:0,V2:0,V3:0.5,T:0,M2:0,M3:0,provenance:'mechanics-recovery',source:{kind:'equilibrium-direct'}},{x:5,position:[5,0,0],N:0,V2:0,V3:-0.5,T:0,M2:-2.5,M3:0,provenance:'mechanics-recovery',source:{kind:'equilibrium-direct'}},{x:10,position:[10,0,0],N:0,V2:0,V3:-0.5,T:0,M2:0,M3:0,provenance:'mechanics-recovery',source:{kind:'equilibrium-direct'}}]}]}}} };
  const snapshot=buildVisualizationSnapshot({title:'Equilibrium',model:scopedModel,analysis:scopedResult});
  expect(snapshot).not.toBeNull();
  expect(snapshot!.availableViews).toContain('forces');
  expect(snapshot!.availableViews).toContain('reactions');
  expect(snapshot!.availableViews).not.toContain('deformed');
});
