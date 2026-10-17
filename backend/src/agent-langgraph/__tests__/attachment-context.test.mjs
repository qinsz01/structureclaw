import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

jest.setTimeout(20000);

describe('attachment context', () => {
  test('persists tool and attachment access policy for interrupted runs', async () => {
    const { buildToolAccessPolicy } = await import('../../../dist/agent-langgraph/agent-service.js');
    const context = {
      enabledToolIds: ['analyze_file', 'ask_user_clarification'],
      disabledToolIds: ['read_file'],
      restrictFileAccessToAttachments: true,
      attachments: [
        { fileId: 'f1', originalName: 'frame.dxf', relPath: '.uploads/case/frame.dxf' },
      ],
    };

    const policy = buildToolAccessPolicy(context);
    context.enabledToolIds.push('read_file');
    context.attachments[0].relPath = '.uploads/case/changed.dxf';

    expect(policy).toEqual({
      enabledToolIds: ['analyze_file', 'ask_user_clarification'],
      disabledToolIds: ['read_file'],
      fileAccessAllowlist: ['.uploads/case/frame.dxf'],
    });
  });

  let tmpDir;
  let previousEnv;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sclaw-attachment-context-'));
    previousEnv = {
      SCLAW_DATA_DIR: process.env.SCLAW_DATA_DIR,
      LLM_API_KEY: process.env.LLM_API_KEY,
      LLM_MODEL: process.env.LLM_MODEL,
      LLM_BASE_URL: process.env.LLM_BASE_URL,
      LLM_VISION_API_KEY: process.env.LLM_VISION_API_KEY,
      LLM_VISION_MODEL: process.env.LLM_VISION_MODEL,
      LLM_VISION_BASE_URL: process.env.LLM_VISION_BASE_URL,
    };
    process.env.SCLAW_DATA_DIR = tmpDir;
    const previousData = previousEnv.SCLAW_DATA_DIR ?? path.join(os.homedir(), '.structureclaw');
    let configuredPython;
    try { configuredPython = JSON.parse(await fs.readFile(path.join(previousData, 'settings.json'), 'utf8')).analysis?.pythonBin; }
    catch { /* An unconfigured installation uses its conventional runtime. */ }
    const runtimePython = configuredPython || path.join(previousData, '.venv', ...(process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']));
    try {
      await fs.access(runtimePython);
      await fs.writeFile(path.join(tmpDir, 'settings.json'), JSON.stringify({ analysis: { pythonBin: runtimePython } }));
    } catch { /* A development environment can use backend/.venv instead. */ }
    delete process.env.LLM_API_KEY;
    delete process.env.LLM_MODEL;
    delete process.env.LLM_BASE_URL;
    delete process.env.LLM_VISION_API_KEY;
    delete process.env.LLM_VISION_MODEL;
    delete process.env.LLM_VISION_BASE_URL;
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('keeps uploaded image binaries out of the main agent message', async () => {
    const { buildInitialHumanMessagePayload } = await import('../../../dist/agent-langgraph/attachments/initial-message.js');
    const pngPath = path.join(tmpDir, 'beam-sketch.png');
    await fs.writeFile(
      pngPath,
      Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lJ6pYQAAAABJRU5ErkJggg==', 'base64'),
    );

    const payload = await buildInitialHumanMessagePayload(
      'Analyze the attached beam sketch.',
      [{
        fileId: 'img-1',
        originalName: 'beam-sketch.png',
        relPath: pngPath,
        mimeType: 'image/png',
      }],
      'en',
      tmpDir,
      { summarizeImages: true },
    );

    expect(typeof payload.content).toBe('string');
    expect(payload.content).toContain('beam-sketch.png');
    expect(payload.content).toContain('vision summary unavailable');
    expect(payload.content).not.toContain('image_url');
    expect(payload.content).not.toContain('base64DataUri');
    expect(payload.content).not.toContain('data:image/png;base64');
  });

  test('preserves large image notes and asks for missing vision details', async () => {
    const { buildInitialHumanMessagePayload } = await import('../../../dist/agent-langgraph/attachments/initial-message.js');
    const pngPath = path.join(tmpDir, 'large-frame-sketch.png');
    await fs.writeFile(pngPath, Buffer.alloc(4 * 1024 * 1024 + 1, 1));

    const payload = await buildInitialHumanMessagePayload(
      'Analyze the attached large frame sketch.',
      [{
        fileId: 'img-large',
        originalName: 'large-frame-sketch.png',
        relPath: pngPath,
        mimeType: 'image/png',
      }],
      'en',
      tmpDir,
      { summarizeImages: true },
    );

    expect(typeof payload.content).toBe('string');
    expect(payload.content).toContain('Image too large for base64 encoding');
    expect(payload.content).toContain('vision summary unavailable');
    expect(payload.content).not.toContain('Image binary is parsed only by the configured vision model');
    expect(payload.content).not.toContain('base64DataUri');
    expect(payload.content).not.toContain('data:image/png;base64');
  });

  test('embeds DXF structural hints as text context', async () => {
    const { buildInitialHumanMessageContent } = await import('../../../dist/agent-langgraph/attachments/initial-message.js');
    const dxfPath = path.join(tmpDir, 'beam.dxf');
    const dxf = [
      '0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1009', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC',
      '0', 'SECTION', '2', 'ENTITIES',
      '0', 'LINE',
      '10', '0', '20', '0',
      '11', '6000', '21', '0',
      '0', 'TEXT',
      '10', '0', '20', '0', '40', '100',
      '1', 'SPAN 6m',
      '0', 'ENDSEC', '0', 'EOF', '',
    ].join('\n');
    await fs.writeFile(dxfPath, dxf, 'utf8');

    const content = await buildInitialHumanMessageContent(
      'Analyze the attached DXF.',
      [{
        fileId: 'dxf-1',
        originalName: 'beam.dxf',
        relPath: dxfPath,
        mimeType: 'application/dxf',
      }],
      'en',
      tmpDir,
    );

    expect(typeof content).toBe('string');
    const text = content;
    expect(text).toContain('"type": "dxf"');
    expect(text).toContain('"lineCount": 1');
    expect(text).toContain('SPAN 6m');
  });

  test('Excel motion samples beyond preview stay in a hashed complete file and explicit settings override preview copies', async () => {
    const { buildInitialHumanMessagePayload } = await import('../../../dist/agent-langgraph/attachments/initial-message.js');
    const { extractContextSeismicWorkflow } = await import('../../../dist/agent-langgraph/attachments/ground-motion.js');
    const XLSX = await import('xlsx').then(m => m.default ?? m);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['time', 'accel_g'],
      ...Array.from({length:250}, (_,index) => [index*.02,index*.001])]),'EW');
    const file = path.join(tmpDir,'wave.xlsx');
    await fs.writeFile(file,XLSX.write(workbook,{type:'buffer',bookType:'xlsx'}));
    const payload = await buildInitialHumanMessagePayload('Use the supplied wave.',
      [{fileId:'wave',originalName:'wave.xlsx',relPath:file}], 'en',tmpDir);
    expect(payload.attachmentAnalyses[0].analysis.sheets.EW.rows).toHaveLength(250);
    const workflow = extractContextSeismicWorkflow({seismicWorkflow:{groundMotionSet:{source:'uploaded',records:[
      {id:'wave:EW',unit:'g',direction:'x',rows:[[0,99]],dt:.02},
    ]}}},payload.attachmentAnalyses);
    const record=workflow.groundMotionSet.records[0];
    expect(record).toMatchObject({sheetName:'EW',unit:'g',direction:'x',dt:.02});
    expect(record.rows).toBeUndefined();
    const parsed=JSON.parse(await fs.readFile(record.fileReference.parsedPath,'utf8'));
    expect(parsed.sheets.EW.rows).toHaveLength(250);
    expect(parsed.sheets.EW.rows[249][1]).toBeCloseTo(.249);
    const configured = JSON.parse(await fs.readFile(path.join(tmpDir,'settings.json'),'utf8')).analysis.pythonBin;
    const moduleDir = fileURLToPath(new URL('../../agent-skills/analysis/opensees-seismic/',import.meta.url));
    const output = execFileSync(configured,['-c',
      'import sys,json; sys.path.insert(0,sys.argv[1]); from ground_motion_input import values; p=values(json.loads(sys.argv[2])); print(json.dumps({"count":len(p.values),"last":p.values[-1],"dt":p.inferred_dt,"source":p.source}))',
      moduleDir,JSON.stringify(record)],{encoding:'utf8'});
    expect(JSON.parse(output)).toMatchObject({count:250,last:.249,dt:.02,source:{sha256:record.fileReference.sha256}});
    expect(payload.attachmentAnalyses[0].analysis.inputEvidence.some(item=>item.status==='truncated')).toBe(true);
  });
});
