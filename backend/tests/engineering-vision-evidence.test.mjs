import { describe, expect, test } from '@jest/globals';
import { parseVisionEvidence, collectVisionEvidence, imageRegionSchema } from '../dist/engineering/vision-evidence.js';
import { mergeInputEvidence, unresolvedInputEvidence, assertResolvedInput } from '../dist/engineering/input-evidence.js';
import { createReviewInputTool } from '../dist/agent-langgraph/model-tools.js';
import { applyInputEvidence, beginAnalysisRequest, currentAnalysisError } from '../dist/engineering/model-state.js';

const observation = (value, field='nodes.A.restraints') => ({ summary: 'Visible support / 可见支座',
  coverage: { geometry:'observed', connectivity:'observed', supports:'observed', loads:'not_applicable', materials:'not_applicable', sections:'not_applicable' },
  fields: [{ field, category:'supports', value, status:'observed', required:true, region:[.1,.2,.3,.4], evidenceText:'Support symbol A' }] });

describe('field-level image evidence without paid recognition', () => {
  test('focused crop observations retain original-page coordinates and file identity', () => {
    const parsed = parseVisionEvidence(JSON.stringify(observation([true,false,true])),
      { file:'drawing.pdf', page:2, sha256:'digest' }, { region:[.2,.3,.5,.5] });
    expect(parsed.inputEvidence[0].source).toMatchObject({ file:'drawing.pdf', page:2, sha256:'digest', coordinateFrame:'image-normalized-xywh' });
    const expected = [.25,.4,.15,.2];
    parsed.inputEvidence[0].source.region.forEach((value,index) => expect(value).toBeCloseTo(expected[index],12));
    expect(() => imageRegionSchema.parse([.9,0,.2,1])).toThrow();
    const missingRegion = observation(5); delete missingRegion.fields[0].region;
    expect(() => parseVisionEvidence(JSON.stringify(missingRegion), {})).toThrow('VISION_OBSERVATION_VALUE_AND_REGION_REQUIRED');
  });

  test('required cropped-away support blocks until supplementary evidence is explicitly reviewed', async () => {
    const cropped = observation(6,'geometry.span');
    cropped.coverage.supports = 'missing';
    const first = parseVisionEvidence(JSON.stringify(cropped), { file:'crop.png' }, { requiredFields:['supports.left'] });
    expect(() => assertResolvedInput(first.inputEvidence)).toThrow('supports.left');
    const next = parseVisionEvidence(JSON.stringify(observation('pin','supports.left')), { file:'complete.png' });
    const evidence = mergeInputEvidence(first.inputEvidence, next.inputEvidence);
    expect(() => assertResolvedInput(evidence)).toThrow();
    const state = { inputEvidence:evidence, lastUserMessage:'The complete drawing shows a pin at the left support.',
      model:{ nodes:[] }, analysisResult:{ runId:'old', success:true } };
    const reviewed = await createReviewInputTool().invoke({ resolutions:[{ field:'supports.left',
      selectedSource:next.inputEvidence[0].id, reason:'Reviewed the supplementary support symbol' }] },
      { toolCall:{ id:'review' }, configurable:{ agentState:state } });
    expect(unresolvedInputEvidence(reviewed.update.inputEvidence)).toEqual([]);
    expect(reviewed.update.modelPending).toBe(true);
    expect(reviewed.update.analysisResult).toBeNull();
    expect(reviewed.update.inputEvidence).toHaveLength(4);
  });

  test('conflicting drawing/table observations remain visible and cannot silently override', () => {
    const a = parseVisionEvidence(JSON.stringify(observation(4,'geometry.span')), {file:'drawing.png'});
    const b = { id:'table-row-3', field:'geometry.span', value:5, required:true, source:{file:'table.csv',row:3} };
    const merged = mergeInputEvidence(collectVisionEvidence({pages:[{visionSummary:JSON.stringify(a)}]}), [b]);
    expect(merged).toHaveLength(2);
    expect(unresolvedInputEvidence(merged)).toEqual([{field:'geometry.span',reason:'conflicting observations require an explicit resolution'}]);
  });

  test('a required field cannot be waived by recognition and a review cannot specify conflicting sources', async () => {
    const image = observation(undefined, 'supports.left');
    image.fields[0].status = 'missing'; image.fields[0].required = false;
    const parsed = parseVisionEvidence(JSON.stringify(image), {}, { requiredFields:['supports'] });
    expect(() => assertResolvedInput(parsed.inputEvidence)).toThrow('supports.left');
    const record = { id:'support-observation', field:'supports.left', value:'pin', status:'observed' };
    await expect(createReviewInputTool().invoke({ resolutions:[{ field:'supports.left', selectedSource:record.id,
      value:'fixed', reason:'ambiguous override' }] }, { toolCall:{ id:'review' }, configurable:{ agentState:{ inputEvidence:[record] } } }))
      .rejects.toThrow('INPUT_RESOLUTION_SOURCE_OR_VALUE_ONLY');
  });

  test('missing category coverage cannot disappear when recognition omits its field list', () => {
    const image = observation(undefined); image.fields = []; image.coverage.supports = 'missing';
    const parsed = parseVisionEvidence(JSON.stringify(image), { file:'missing-support.png' });
    expect(parsed.interpretationStatus).toBe('needs_review');
    expect(() => assertResolvedInput(parsed.inputEvidence)).toThrow('coverage.supports');
  });

  test('reading new engineering evidence archives and invalidates prior results, duplicate reading does not', () => {
    const model = { nodes:[], elements:[], materials:[], sections:[] };
    const state = { model, ...beginAnalysisRequest({ model }, 'settings'), inputEvidence:[] };
    state.analysisResult = { success:true, runId:'old', meta:state.analysisRequest };
    expect(currentAnalysisError(state)).toBeUndefined();
    const evidence = [{ id:'new-drawing', field:'supports.left', status:'ambiguous', required:true }];
    expect(currentAnalysisError({ ...state, inputEvidence:evidence })).toBe('INPUT_EVIDENCE_UNRESOLVED');
    const update = applyInputEvidence(state, evidence);
    expect(update.analysisResult).toBeNull();
    expect(update.analysisRuns.old).toEqual(state.analysisResult);
    expect(update.modelPending).toBe(true);
    expect(applyInputEvidence({ ...state, inputEvidence:evidence }, evidence).analysisResult).toBeUndefined();
  });
});
