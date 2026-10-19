import { expect, test } from '@jest/globals';
import { memberGlobalPoint, withGlobalMemberLocation, withGlobalResultLocations } from '../dist/engineering/result-locations.js';
import { resultCatalogEntry, solverMeshQueryGuidance } from '../dist/engineering/result-selection.js';
import { reportResultRows, resultTableMarkdown } from '../dist/engineering/result-data.js';
import { buildAnalysisToolSummary } from '../dist/agent-langgraph/tools.js';
import { createQueryResultsTool } from '../dist/agent-langgraph/model-tools.js';

const modelFor = (start, end) => ({ nodes: [{ id: 'A', ...start }, { id: 'B', ...end }], elements: [{ id: '2', nodes: ['A', 'B'] }] });
const horizontal = modelFor({ x: 6, y: 0, z: 0 }, { x: 12, y: 0, z: 0 });
const global = { x: 9.45, y: 0, z: 0 };

test.each([
  ['horizontal', horizontal, 3.45, global],
  ['inclined', modelFor({ x: 1, y: 2, z: 3 }, { x: 4, y: 6, z: 3 }), 2.5, { x: 2.5, y: 4, z: 3 }],
  ['3D', modelFor({ x: 1, y: 2, z: 3 }, { x: 3, y: 5, z: 9 }), 3.5, { x: 2, y: 3.5, z: 6 }],
])('%s member locations use the axis and both physical ends', (_name, model, position, expected) => {
  expect(memberGlobalPoint(model, '2', position)).toEqual(expected);
  const { id: _a, ...start } = model.nodes[0], { id: _b, ...end } = model.nodes[1];
  const length = Math.hypot(end.x - start.x, end.y - start.y, end.z - start.z);
  expect(memberGlobalPoint(model, '2', 0)).toEqual(start);
  expect(memberGlobalPoint(model, '2', length)).toEqual(end);
  expect(memberGlobalPoint(model, '2', 'n1')).toEqual(start);
  expect(memberGlobalPoint(model, '2', 'n2')).toEqual(end);
});

test('missing geometry, zero length and invalid positions do not invent global locations', () => {
  for (const position of [NaN, Infinity, -1, 7, undefined]) expect(memberGlobalPoint(horizontal, '2', position)).toBeUndefined();
  expect(memberGlobalPoint(horizontal, 'missing', 1)).toBeUndefined();
  expect(memberGlobalPoint(modelFor({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }), '2', 0)).toBeUndefined();
  const location = { kind: 'member', id: 'missing', positionM: 3.45 };
  expect(withGlobalMemberLocation(horizontal, location)).toEqual(location);
});

test('summary, catalog and report locations preserve local fields and add global coordinates', () => {
  const location = { kind: 'member', elementId: '2', positionM: 3.45, side: 'right', provenance: 'mechanics-recovery' };
  const data = { envelope: { maxAbsMoment: 1, controlLocations: { moment: location } },
    summary: { maxDisplacementLocation: location },
    memberResponseExtrema: { values: { M2: { elementId: '2', position: 3.45, value: -1 } } },
    memberResponses: [{ id: '2', samples: [{ x: 3.45, position: [9.45, 0, 0], M2: -1 }] }],
    memberStations: { '2': [{ positionM: 3.45, side: 'right', components: { My: -1 } }] } };
  const before = structuredClone(data);
  const enriched = withGlobalResultLocations(horizontal, data);
  expect(enriched.envelope.controlLocations.moment).toEqual({ ...location, global });
  expect(enriched.summary.maxDisplacementLocation.global).toEqual(global);
  expect(enriched.memberResponses[0].samples[0]).toEqual({ ...data.memberResponses[0].samples[0], global });
  expect(enriched.memberStations['2'][0]).toEqual({ ...data.memberStations['2'][0], global });
  const run = { runId: 'r', modelSnapshot: horizontal, selectedResultKey: 'case:D',
    results: { 'case:D': { success: true, data } } };
  expect(buildAnalysisToolSummary({ result: { success: true, data }, model: horizontal }).controlling.locations.moment.global).toEqual(global);
  expect(resultCatalogEntry(run, true).results[0].controlLocations.moment.global).toEqual(global);
  expect(resultCatalogEntry(run, true).results[0].memberResponseExtrema.values.M2.global).toEqual(global);
  expect(reportResultRows(run)[0].memberResponseExtrema.values.M2.global).toEqual(global);
  for (const locale of ['en', 'zh']) expect(resultTableMarkdown(run, locale)).toContain(JSON.stringify(global));
  expect(data).toEqual(before);
});

test('solver-internal node guidance gives physical local and global positions together', () => {
  const data = { solverMesh: { positionUnit: 'm', nodes: [{ id: 'internal', physicalNodeId: null }],
    elements: [{ physicalElementId: '2', nodes: ['A', 'internal'], start: 0, end: 3.45 }] } };
  expect(solverMeshQueryGuidance(data, horizontal).internalNodeLocations[0].memberPositions).toEqual([
    { elementId: '2', positionM: 3.45, side: 'left', global },
  ]);
});

test('historical member-end queries and time series keep coordinates in model units', async () => {
  const saved = { runId: 'saved', modelSnapshot: horizontal, selectedResultKey: 'analysis:dynamic',
    results: { 'analysis:dynamic': { success: true,
      data: { timeHistory: [{ time: 0, forces: { '2': { referenceFrame: 'element-local', n2: { M2: -3 } } } }] } } } };
  const invoke = input => createQueryResultsTool().invoke({ runId: 'saved', elementId: '2', end: 'n2',
    field: 'forces', component: 'M2', unit: 'N.m', ...input },
  { toolCall: { id: 'query' }, configurable: { agentState: { analysisRuns: { saved } } } });
  const queried = await invoke({ timeIndex: 0 });
  const response = JSON.parse(queried.update.messages[0].content);
  expect(response.quantity).toMatchObject({ value: -3000, unit: 'N.m',
    location: { kind: 'member', id: '2', end: 'n2', global: { x: 12, y: 0, z: 0 } } });
  expect(response.values.global).toEqual({ x: 12, y: 0, z: 0 });
  const series = JSON.parse((await invoke({ series: {} })).content);
  expect(series.series.location).toEqual({ elementId: '2', end: 'n2', global: { x: 12, y: 0, z: 0 } });
});
