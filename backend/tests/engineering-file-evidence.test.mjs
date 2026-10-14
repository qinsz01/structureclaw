import { describe, expect, test } from '@jest/globals';
import { fileInputEvidence } from '../dist/engineering/file-evidence.js';
import { activeInputEvidence, analysisInputBinding, assertAnalysisInputEvidenceMatchesRequest,
  assertInputEvidenceMatchesModel, mergeInputEvidence, unresolvedInputEvidence } from '../dist/engineering/input-evidence.js';
import { createReviewInputTool } from '../dist/agent-langgraph/model-tools.js';

const model = { nodes:[{id:'A',x:5}] };
const source = { filePath:'table.csv', sha256:'original' };
const review = async (evidence, resolutions, other = {}) => (await createReviewInputTool().invoke({ resolutions },
  { toolCall:{id:'review'}, configurable:{agentState:{inputEvidence:evidence,model,...other}} })).update.inputEvidence;

describe('parsed input must reach the engineering model or an explicit analysis source', () => {
  test('successful parsing and arbitrary acknowledgment do not prove a field mapping', async () => {
    const parsed = fileInputEvidence({success:true,type:'csv',source:{...source,parser:'csv-parse'}}, 'table.csv');
    expect(unresolvedInputEvidence(parsed)).toHaveLength(1);
    const evidence = await review(parsed, [{field:parsed[0].field,value:true,reason:'Read the file'}]);
    expect(unresolvedInputEvidence(evidence)[0].reason).toContain('INPUT_SOURCE_FIELD_MAPPING_REQUIRED');
    expect(() => assertInputEvidenceMatchesModel(model,evidence)).toThrow('INPUT_SOURCE_FIELD_MAPPING_REQUIRED');
    const mapped = await review(parsed, [
      {field:'nodes.A.x',value:5000,unit:'mm',reason:'Cell A2',sourceEvidenceId:parsed[0].id,sourceLocation:{row:2,column:'A'}},
      {field:parsed[0].field,value:true,reason:'Mapped the dimension',mappedFields:['nodes.A.x']},
    ]);
    expect(() => assertInputEvidenceMatchesModel(model,mapped)).not.toThrow();
    expect(() => assertInputEvidenceMatchesModel({nodes:[{id:'A',x:4}]},mapped)).toThrow('INPUT_EVIDENCE_MODEL_VALUE_MISMATCH');
  });

  test('truncation requires complete read of the same source and exact page', async () => {
    const preview = fileInputEvidence({success:true,type:'pdf',source,pageCount:2,pages:[{pageNumber:1}]},'table.pdf');
    const page2 = preview.find(item => item.source.page === 2);
    const bad = await review(preview,[{field:page2.field,value:true,reason:'Acknowledged',sourceEvidenceId:preview[0].id}]);
    // Resolve the other page separately to focus on the complete-read check.
    const filtered = bad.filter(item => item.field === page2.field || item.id === preview[0].id)
      .map(item => item.id === preview[0].id ? {...item,required:false} : item);
    expect(() => assertInputEvidenceMatchesModel(model,filtered)).toThrow('INPUT_SOURCE_COMPLETE_READ_REQUIRED');
  });

  test('explicit exclusion keeps evidence, requires a reason, and cannot waive later reads', async () => {
    const initial = fileInputEvidence({success:true,type:'csv',source,truncated:true},'table.csv');
    const output = await createReviewInputTool().invoke({excludeSources:[{sourceFile:'table.csv',reason:'Unrelated calibration sheet'}]},
      {toolCall:{id:'exclude'},configurable:{agentState:{inputEvidence:initial,model}}});
    expect(output.update.inputEvidence).toHaveLength(initial.length+1);
    expect(activeInputEvidence(output.update.inputEvidence)).toEqual([]);
    expect(() => assertInputEvidenceMatchesModel(model,output.update.inputEvidence)).not.toThrow();
    const fresh = fileInputEvidence({success:true,type:'csv',source:{...source,sha256:'changed'}},'table.csv');
    expect(unresolvedInputEvidence(mergeInputEvidence(output.update.inputEvidence,fresh))).toHaveLength(1);
  });

  test('analysis use binds complete file, sheet and sampling settings without pretending to be a model field', async () => {
    const fileReference = {path:'wave.csv',sha256:'original',parsedPath:'parsed.json',parsedSha256:'parsed'};
    const record = {id:'wave-1',fileReference,unit:'g',direction:'x',dt:.02};
    const parsed = fileInputEvidence({success:true,type:'csv',source:{...source,fileReference,complete:true}},'table.csv');
    const workflow = {groundMotionSet:{records:[record]}};
    const evidence = await review(parsed,[{field:parsed[0].field,value:true,reason:'Use for excitation',
      sourceEvidenceId:parsed[0].id,analysisRecordId:'wave-1'}],{contextSeismicWorkflow:workflow});
    expect(() => assertInputEvidenceMatchesModel(model,evidence)).not.toThrow();
    expect(() => assertAnalysisInputEvidenceMatchesRequest(evidence,workflow)).not.toThrow();
    expect(() => assertAnalysisInputEvidenceMatchesRequest(evidence,{groundMotionSet:{records:[{...record,unit:'m/s2'}]}}))
      .toThrow('ANALYSIS_INPUT_BINDING_CHANGED');
    expect(analysisInputBinding(record).parameters.fileReference).toEqual(fileReference);
    const changed = await createReviewInputTool().invoke({resolutions:[{field:parsed[0].field,value:true,
      reason:'Confirmed millimetres per second squared',sourceEvidenceId:parsed[0].id,analysisRecordId:'wave-1',
      analysisParameters:{unit:'mm/s2',direction:'y',dt:.01}}]},
      {toolCall:{id:'new-settings'},configurable:{agentState:{inputEvidence:evidence,contextSeismicWorkflow:workflow}}});
    expect(() => assertAnalysisInputEvidenceMatchesRequest(changed.update.inputEvidence,changed.update.contextSeismicWorkflow)).not.toThrow();
    expect(changed.update.contextSeismicWorkflow.groundMotionSet.records[0].fileReference).toEqual(fileReference);
  });

  test('run_analysis rejects changed analysis-input units before executing an engine', async () => {
    const { createRunAnalysisTool } = await import('../dist/agent-langgraph/tools.js');
    let called = false;
    const tool = createRunAnalysisTool({async executeAnalysisSkill(){called=true;throw new Error('Unexpected execution');}});
    const record={id:'wave',unit:'g',direction:'x',dt:.02,fileReference:{format:'sclaw-parsed-input-v1',
      path:'wave.csv',sha256:'original',parsedPath:'parsed.json',parsedSha256:'parsed'}};
    const parsed=fileInputEvidence({success:true,type:'csv',source:{filePath:'wave.csv',sha256:'original',
      complete:true,fileReference:record.fileReference}},'wave');
    const evidence=mergeInputEvidence(parsed,[{id:'review',field:parsed[0].field,status:'resolved',required:true,resolution:{value:true,
      reason:'Confirmed wave',sourceEvidenceId:parsed[0].id,analysisInput:analysisInputBinding(record)}}]);
    await expect(tool.invoke({analysisType:'seismic',seismicWorkflowJson:JSON.stringify({methodPreference:'time_history',
      groundMotionSet:{source:'uploaded',records:[{...record,unit:'m/s2'}]}})},
      {toolCall:{id:'analysis'},configurable:{skillScope:['opensees-seismic'],agentState:{model,inputEvidence:evidence,
        contextSeismicWorkflow:{groundMotionSet:{source:'uploaded',records:[record]}}}}})).rejects.toThrow('ANALYSIS_INPUT_BINDING_CHANGED');
    expect(called).toBe(false);
  });
});
