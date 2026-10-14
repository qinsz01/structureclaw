import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { analyzeUploadedFile } from '../dist/agent-langgraph/file-tools.js';
import { mergeInputEvidence } from '../dist/engineering/input-evidence.js';
import { normalizeEngineeringModel } from '../dist/engineering/model-boundary.js';
import { createLocalStructureProtocolClient } from '../dist/services/structure-protocol-execution.js';
import { scenarios } from './fixtures/opensees-chain-reference.mjs';

let directory, parsed;
const protocol=createLocalStructureProtocolClient();
const input=structuredClone(scenarios[0].model);
const modelWith=evidence=>({...structuredClone(input),metadata:{inputEvidence:evidence}});
beforeAll(async()=>{
  directory=await mkdtemp(path.join(os.tmpdir(),'sclaw-parser-model-'));
  const file=path.join(directory,'dimensions.csv');
  await writeFile(file,'label,value,unit,note\nB-axis,4000,mm,"dimension\nconfirmed on elevation"\n');
  parsed=await analyzeUploadedFile(file,directory,undefined,{mode:'full'});
});
afterAll(async()=>{if(directory)await rm(directory,{recursive:true,force:true});});

describe('real table parser to reviewed model-field boundary; no paid recognition',()=>{
  test('physical CSV line provenance survives explicit mapping to a stable model ID',async()=>{
    expect(parsed.success).toBe(true);expect(parsed.rowSources[0]).toMatchObject({lineStart:2,lineEnd:3});
    const observation={id:'table:B-axis',field:'drawing.B-axis',value:Number(parsed.rows[0][1]),unit:parsed.rows[0][2],status:'observed',required:true,
      source:{...parsed.source,...parsed.rowSources[0]}};
    await expect(normalizeEngineeringModel(modelWith([observation]),protocol)).rejects.toThrow('MODEL_FIELD_REQUIRED');
    const evidence=mergeInputEvidence([observation],[{id:'review:B-axis',field:'drawing.B-axis',status:'resolved',required:true,
      resolution:{selectedSource:observation.id,modelField:'nodes.B.x',reason:'Explicit review binds axis B to node B'}}]);
    const normalized=await normalizeEngineeringModel(modelWith(evidence),protocol);
    expect(normalized.nodes.find(node=>node.id==='B').x).toBe(4);
    expect(normalized.metadata.inputEvidence[0].source.sha256).toBe(parsed.source.sha256);
    expect(normalized.metadata.inputEvidence[0].source.lineEnd).toBe(3);
  });
  test('an updated drawing cannot override table coordinates without a reviewed decision and application',async()=>{
    const table={id:'csv',field:'nodes.B.x',value:4000,unit:'mm',status:'observed',required:true,source:{...parsed.source,...parsed.rowSources[0]}};
    // Contract input for a manually transcribed drawing observation, not a claim of vision accuracy.
    const drawing={id:'drawing',field:'nodes.B.x',value:5,unit:'m',status:'observed',required:true,source:{file:'manual-drawing-observation',page:1,region:[.1,.2,.3,.1]}};
    const conflict=mergeInputEvidence([table],[drawing]);
    await expect(normalizeEngineeringModel(modelWith(conflict),protocol)).rejects.toThrow('INPUT_EVIDENCE_UNRESOLVED');
    const resolved=mergeInputEvidence(conflict,[{id:'decision',field:'nodes.B.x',status:'resolved',required:true,
      resolution:{selectedSource:'drawing',reason:'Latest drawing was explicitly reviewed'}}]);
    await expect(normalizeEngineeringModel(modelWith(resolved),protocol)).rejects.toThrow('VALUE_MISMATCH');
    const changed=modelWith(resolved);changed.nodes.find(node=>node.id==='B').x=5;
    const normalized=await normalizeEngineeringModel(changed,protocol);
    expect(normalized.nodes.find(node=>node.id==='B').x).toBe(5);
  });
});
