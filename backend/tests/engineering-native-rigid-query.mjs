// Product acceptance of already completed native jobs. No SDK job is submitted.
// References come from the independently frozen stiffness model, not native forces.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { queryPhysicalResponse, enrichResultData, scalarResultQuantity } from '../dist/engineering/result-data.js';
import { createEngineeringReport } from '../dist/services/engineering-report.js';
import { normalizeEngineeringModel } from '../dist/engineering/model-boundary.js';
import { createLocalStructureProtocolClient } from '../dist/services/structure-protocol-execution.js';
import { contentHash } from '../dist/engineering/model-state.js';

const components = ['N', 'Vy', 'Vz', 'T', 'My', 'Mz'];
const display = ['N', 'V2', 'V3', 'T', 'M2', 'M3'];
const dot = (a, b) => a.reduce((sum, value, i) => sum + value*b[i], 0);
const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const unit = a => a.map(value => value/Math.hypot(...a));

function referenceMember(model, member) {
  const [a, b] = member.nodes.map(id => model.nodes.find(row => row.id === id));
  const delta = ['x', 'y', 'z'].map(key => b[key]-a[key]);
  const x = unit(delta), length = Math.hypot(...delta);
  const reference = model.metadata?.elementReferenceVectors?.[member.id] ?? (Math.abs(x[2]) > .9 ? [1,0,0] : [0,0,1]);
  const y = unit(cross(reference, x)), z = cross(x, y), angle = (member.rotation_angle ?? 0)*Math.PI/180;
  return { length, axes: [x, y.map((v,i) => Math.cos(angle)*v+Math.sin(angle)*z[i]),
    y.map((v,i) => -Math.sin(angle)*v+Math.cos(angle)*z[i])] };
}

export function verifyNativeRigidDelivery(fixture) {
  const { model, referenceModel, referenceCases, memberMap = {}, cases, runId } = fixture;
  const counts = { direct: 0, recovered: 0, chart: 0, report: 0, reports: 0 };
  const segments = referenceModel.elements.map(member => ({ member, ...referenceMember(referenceModel, member),
    physicalId: memberMap[member.id]?.physicalId ?? member.id, start: memberMap[member.id]?.startM ?? 0 }));
  const close = (actual, expected, location) => {
    assert.ok(Number.isFinite(actual) && Number.isFinite(expected), location);
    assert.ok(Math.abs(actual-expected) <= Math.max(1e-5, 1e-5*Math.abs(expected)), `${location}: ${actual} != ${expected}`);
  };
  const expectedAt = (caseId, memberId, position, side) => {
    const options = segments.filter(s => s.physicalId === memberId);
    const end = Math.max(...options.map(s => s.start+s.length));
    // Reference coordinates can accumulate one ulp at a shared point-load node.
    // Only recognize that floating-point equality; do not merge nearby cuts.
    const same = (a,b) => Math.abs(a-b) <= 8*Number.EPSILON*Math.max(1,end);
    const segment = options.find(s => (same(position,s.start) ? side === 'right' || position === 0 : position > s.start)
      && (same(position,s.start+s.length) ? side === 'left' || same(position,end) : position < s.start+s.length));
    assert.ok(segment, `Reference segment ${memberId}@${position}:${side}`);
    const x = position-segment.start;
    const force = referenceCases[caseId].localEndActions[segment.member.id];
    assert.equal(force.length, 12);
    const q = [0,0,0];
    for (const load of referenceModel.load_cases.find(row => row.id === caseId).loads) {
      if (load.element !== segment.member.id) continue;
      assert.ok(['distributed', 'uniform'].includes(load.type));
      assert.ok(load.reference_frame === undefined || load.reference_frame === 'global');
      assert.equal(load.start ?? 0, 0);
      assert.equal(load.end ?? segment.length, segment.length);
      assert.equal(load.distribution ?? 'uniform', 'uniform');
      const vector = ['wx','wy','wz'].map(key => load[key] ?? 0);
      segment.axes.forEach((axis, i) => { q[i] += dot(axis, vector); });
    }
    return { N:-force[0]-q[0]*x, Vy:force[1]+q[1]*x, Vz:force[2]+q[2]*x,
      T:-force[3], My:-force[4]-force[2]*x-q[2]*x*x/2, Mz:-force[5]+force[1]*x+q[1]*x*x/2 };
  };
  for (const [id, data] of Object.entries(cases)) {
    assert.ok(referenceCases[id], `Missing frozen reference ${id}`);
    const before = contentHash(data), key = `case:${id}`;
    const result = { success:true, selection:{kind:'case',id}, meta:{runId}, data };
    const enriched = enrichResultData(model, result, result.selection);
    const quantities = [];
    for (const member of model.elements) {
      const raw = data.memberStations[member.id];
      for (const station of raw) {
        const response = queryPhysicalResponse(model, result, member.id, station.positionM, station.side === 'left' ? 'left' : 'right');
        assert.equal(response.provenance, 'solver-direct');
        components.forEach(component => { assert.equal(response.sample[component], station.components[component]); counts.direct++; });
      }
      const offset = data.nativeContext.effectiveRigidOffsets.members[member.id], L = offset.physicalLengthM;
      const positions = [...new Set([0, L, .071*L, .283*L, .731*L, .977*L, offset.elasticStartM, offset.elasticEndM,
        ...segments.filter(s => s.physicalId === member.id).flatMap(s => [s.start, s.start+s.length])])];
      for (const position of positions) for (const side of position === 0 ? ['right'] : position === L ? ['left'] : ['left','right']) {
        let response;
        try { response = queryPhysicalResponse(model, result, member.id, position, side); }
        catch (cause) { throw new Error(`Physical query ${id}/${member.id}@${position}:${side} failed`, {cause}); }
        const expected = expectedAt(id, member.id, position, side);
        for (const component of components) {
          close(response.sample[component], expected[component], `${id}/${member.id}/${position}/${side}/${component}`);
          if (response.provenance === 'mechanics-recovery') counts.recovered++;
        }
        assert.throws(() => scalarResultQuantity(response, 'uz', 'mm', true), /RESULT_COMPONENT_UNAVAILABLE/);
        const unit = 'N.m', value = scalarResultQuantity(response, 'My', unit, true);
        close(value/1000, expected.My, 'Explicit moment unit conversion');
        quantities.push({ id:`q${quantities.length}`, runId, selection:key, value, unit, component:'My',
          location:{kind:'member',id:member.id,positionM:position,side}, source:response.source, provenance:response.provenance });
      }
      const chart = enriched.memberResponses.find(row => row.id === member.id);
      assert.ok(chart.samples.length > raw.length, `Missing recovered chart ${id}/${member.id}`);
      assert.ok(chart.samples.every(sample => sample.displacement === undefined));
      for (const sample of chart.samples) {
        const side = sample.side ?? 'right', response = queryPhysicalResponse(model, result, member.id, sample.x, side);
        components.forEach((component, i) => { close(sample[display[i]], response.sample[component], 'Chart/query'); counts.chart++; });
        if (sample.provenance === 'mechanics-recovery') {
          const resolve = pointer => pointer.slice(2).split('/').map(token => token.replace(/~1/g,'/').replace(/~0/g,'~'))
            .reduce((value, token) => value[token], enriched);
          assert.equal(contentHash(resolve(sample.source.anchorRef.path)), sample.source.anchorRef.sha256);
          assert.equal(contentHash(resolve(sample.source.nativeContextRef.path)), sample.source.nativeContextRef.sha256);
        }
      }
    }
    const analysis = { success:true, runId, selectedResultKey:key, results:{[key]:{...result,data:enriched}}, requestedQuantities:quantities };
    for (const locale of ['zh','en']) {
      const report = createEngineeringReport({message:'Rigid member delivery verification',analysisType:'static',normalizedModel:model,analysis,locale});
      assert.equal(report.json.meta.runId, runId);
      assert.deepEqual(report.json.requestedQuantities, quantities);
      for (const q of quantities) {
        assert.ok(report.markdown.includes(`| ${q.id} | ${key} | ${q.location.id}@${q.location.positionM}:${q.location.side} | My | ${q.value} | N.m |`));
        counts.report++;
      }
      assert.ok(report.markdown.includes(`| ${key} | M2 |`));
      counts.reports++;
    }
    assert.equal(contentHash(data), before, 'Native results must remain immutable');
  }
  assert.ok(counts.direct > 0 && counts.recovered > 0 && counts.report > 0);
  return counts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const directory = path.resolve(process.argv[2]);
  const read = name => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
  const sourceName = fs.existsSync(path.join(directory, 'source-model.json')) ? 'source-model.json' : 'source.json';
  const acceptance = read('acceptance.json');
  assert.equal(acceptance.status, 'passed', 'A failed native acceptance cannot certify delivery');
  const model = await normalizeEngineeringModel(read(sourceName), createLocalStructureProtocolClient());
  const native = read('result.json'), reference = read('reference.json');
  const cases = native.caseResults ?? Object.fromEntries(Object.entries(native.nativeResultSet.results)
    .filter(([key]) => key.startsWith('case:')).map(([key, value]) => [key.slice(5), value.data]));
  const fixture = { model, referenceModel:fs.existsSync(path.join(directory, 'reference-model.json')) ? read('reference-model.json') : read(sourceName),
    referenceCases:reference.cases ?? reference, memberMap:reference.memberMap ?? {}, runId:path.basename(directory), cases };
  const files = [sourceName,'reference.json','result.json','acceptance.json'];
  if (fs.existsSync(path.join(directory, 'reference-model.json'))) files.push('reference-model.json');
  const evidence = files.map(name => ({path:path.join(directory,name),sha256:createHash('sha256').update(fs.readFileSync(path.join(directory,name))).digest('hex')}));
  const receipt = { status:'passed', counts:verifyNativeRigidDelivery(fixture), directory, evidence };
  if (process.argv[3]) fs.writeFileSync(path.resolve(process.argv[3]), JSON.stringify(receipt,null,2)+'\n', {flag:'wx'});
  console.log(JSON.stringify(receipt,null,2));
}
