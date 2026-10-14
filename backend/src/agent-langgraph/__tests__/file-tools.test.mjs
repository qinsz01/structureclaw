import { describe, expect, test, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
jest.setTimeout(30000);

function validDxf(entities = [], units = 6) {
  return ['0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1009', '9', '$INSUNITS', '70', String(units), '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES', ...entities, '0', 'ENDSEC', '0', 'EOF', ''].join('\n');
}

function pdfFixture(firstStream = 'BT /F1 12 Tf 20 120 Td (Beam B1) Tj ET 10 10 m 200 150 l S') {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...[firstStream, '10 10 m 200 150 l S'].map(text=>`<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`),
  ];
  let value='%PDF-1.4\n'; const offsets=[0];
  for(let index=0;index<objects.length;index++){offsets.push(Buffer.byteLength(value));value+=`${index+1} 0 obj\n${objects[index]}\nendobj\n`;}
  const xref=Buffer.byteLength(value);
  value+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(offset=>String(offset).padStart(10,'0')+' 00000 n ').join('\n')}\ntrailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(value);
}
describe('file-tools helpers', () => {
  describe('isPathWithinRoot', () => {
    test('exact root match returns true', async () => {
      const { isPathWithinRoot } = await import('../../../dist/agent-langgraph/file-tools.js');
      const root = path.resolve('/tmp/test-root');
      expect(isPathWithinRoot(root, root)).toBe(true);
    });

    test('strict descendant returns true', async () => {
      const { isPathWithinRoot } = await import('../../../dist/agent-langgraph/file-tools.js');
      const root = path.resolve('/tmp/test-root');
      expect(isPathWithinRoot(path.join(root, 'sub', 'file.txt'), root)).toBe(true);
    });

    test('sibling directory returns false', async () => {
      const { isPathWithinRoot } = await import('../../../dist/agent-langgraph/file-tools.js');
      const root = path.resolve('/tmp/test-root');
      expect(isPathWithinRoot(path.resolve('/tmp/test-other/file.txt'), root)).toBe(false);
    });

    test('traversal via ../ returns false', async () => {
      const { isPathWithinRoot } = await import('../../../dist/agent-langgraph/file-tools.js');
      const root = path.resolve('/tmp/test-root');
      const traversal = path.normalize(path.join(root, '..', 'outside.txt'));
      expect(isPathWithinRoot(traversal, root)).toBe(false);
    });
  });

  describe('parseCsv', () => {
    test('keeps escaped quotes, multiline cells and physical line provenance', async () => {
      const { parseCsv } = await import('../../../dist/agent-langgraph/file-tools.js');
      const result = parseCsv('\ufeffname,note\nA,"line1\nline2 with ""quotes"""\nB,next', 1);
      expect(result.rows).toEqual([['A','line1\nline2 with "quotes"']]);
      expect(result.rowSources).toEqual([{recordNumber:2,lineStart:2,lineEnd:3}]);
      expect(result.totalRows).toBe(2);
      expect(result.truncated).toBe(true);
    });
    test('empty input returns empty headers and rows', async () => {
      const { parseCsv } = await import('../../../dist/agent-langgraph/file-tools.js');
      const result = parseCsv('', 100);
      expect(result.headers).toEqual([]);
      expect(result.rows).toEqual([]);
    });

    test('single row returns headers only', async () => {
      const { parseCsv } = await import('../../../dist/agent-langgraph/file-tools.js');
      const result = parseCsv('a,b,c', 100);
      expect(result.headers).toEqual(['a', 'b', 'c']);
      expect(result.rows).toEqual([]);
    });

    test('quoted fields with commas are preserved', async () => {
      const { parseCsv } = await import('../../../dist/agent-langgraph/file-tools.js');
      const result = parseCsv('name,value\n"Smith, John",100', 100);
      expect(result.headers).toEqual(['name', 'value']);
      expect(result.rows[0][0]).toBe('Smith, John');
      expect(result.rows[0][1]).toBe('100');
    });

    test('tab-separated input splits on tabs', async () => {
      const { parseCsv } = await import('../../../dist/agent-langgraph/file-tools.js');
      const result = parseCsv('a\tb\tc\n1\t2\t3', 100);
      expect(result.headers).toEqual(['a', 'b', 'c']);
      expect(result.rows[0]).toEqual(['1', '2', '3']);
    });

    test('rows are truncated at maxRows', async () => {
      const { parseCsv } = await import('../../../dist/agent-langgraph/file-tools.js');
      const lines = ['h'].concat(Array.from({ length: 20 }, (_, i) => `${i}`));
      const result = parseCsv(lines.join('\n'), 5);
      expect(result.rows).toHaveLength(5);
    });
  });

  describe('parseDxf', () => {
    test('extracts real DXF LINE geometry, units and entity provenance', async () => {
      const { parseDxf } = await import('../../../dist/agent-langgraph/file-tools.js');
      const result = await parseDxf(validDxf(['0','LINE','8','STRUCTURE','10','1','20','2','30','5','11','3','21','4','31','6'], 4));
      expect(result.lines[0]).toMatchObject({ x1: 1, y1: 2, z1: 5, x2: 3, y2: 4, z2: 6, layer: 'STRUCTURE', source: { entityIndex: 0 } });
      expect(result.lineEntityCount).toBe(1);
      expect(result.insertionUnits).toMatchObject({ code: 4, metersPerUnit: 0.001 });
    });
    test('keeps text insertion positions and flags unsupported curves', async () => {
      const { parseDxf } = await import('../../../dist/agent-langgraph/file-tools.js');
      const result = await parseDxf(validDxf(['0','TEXT','10','3','20','4','40','1','1','Beam Label','0','CIRCLE','10','0','20','0','40','2']));
      expect(result.texts).toEqual(['Beam Label']);
      expect(result.annotations[0]).toMatchObject({ position: [3,4,0], source: { entityIndex: 0 } });
      expect(result.unsupportedEntities.CIRCLE).toBe(1);
      expect(result.complete).toBe(false);
    });
    test('rejects malformed DXF rather than returning an apparently empty drawing', async () => {
      const { parseDxf } = await import('../../../dist/agent-langgraph/file-tools.js');
      await expect(parseDxf('')).rejects.toThrow();
      await expect(parseDxf(validDxf(['0','LINE','10','not-a-number','20','2','11','3','21','4']))).rejects.toThrow();
    });
    test('valid empty unitless DXF does not invent drawing units', async () => {
      const { parseDxf } = await import('../../../dist/agent-langgraph/file-tools.js');
      const result = await parseDxf(validDxf([], 0));
      expect(result.entityCount).toBe(0);
      expect(result.lines).toEqual([]);
      expect(result.insertionUnits.metersPerUnit).toBeNull();
    });
  });
});
describe('createAnalyzeFileTool', () => {
  let tmpDir;
  let uploadsDir;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sclaw-file-tools-'));
    uploadsDir = path.join(tmpDir, '.uploads');
    await fs.mkdir(uploadsDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('analyzes a CSV file', async () => {
    const { createAnalyzeFileTool } = await import('../../../dist/agent-langgraph/file-tools.js');
    const csvPath = path.join(uploadsDir, 'data.csv');
    await fs.writeFile(csvPath, 'name,value\nA,1\nB,2\n', 'utf8');
    const tool = createAnalyzeFileTool();
    const raw = await tool.invoke(
      { filePath: csvPath },
      { configurable: { workspaceRoot: tmpDir } },
    );
    const result = JSON.parse(raw);
    expect(result.success).toBe(true);
    expect(result.type).toBe('csv');
    expect(result.headers).toEqual(['name', 'value']);
    expect(result.rows).toEqual([['A', '1'], ['B', '2']]);
  });

  test('PDF returns page text locations, rendered diagram and explicit pagination', async () => {
    const { analyzeUploadedFile } = await import('../../../dist/agent-langgraph/file-tools.js');
    const pdfPath=path.join(uploadsDir,'drawing.pdf'); await fs.writeFile(pdfPath,pdfFixture());
    const first=await analyzeUploadedFile(pdfPath,tmpDir,undefined,{pageCount:1});
    expect(first.success).toBe(true);
    expect(first.pageCount).toBe(2); expect(first.nextPage).toBe(2); expect(first.truncated).toBe(true);
    expect(first.pages[0].text).toContain('Beam B1'); expect(first.pages[0].items[0].source.pageNumber).toBe(1);
    expect(first.pages[0].requiresVision).toBe(true);
    const next=await analyzeUploadedFile(pdfPath,tmpDir,undefined,{pageStart:2,pageCount:1});
    expect(next.pages[0].requiresVision).toBe(true);
    const image=await fs.readFile(next.pages[0].renderedImagePath);
    expect(image.subarray(1,4).toString()).toBe('PNG');
    expect(JSON.stringify(next)).not.toContain('base64');
  });

  test('can preserve all CSV rows for runtime attachment use', async () => {
    const { analyzeUploadedFile } = await import('../../../dist/agent-langgraph/file-tools.js');
    const csvPath = path.join(uploadsDir, 'ground-motion.csv');
    const rows = Array.from({ length: 1560 }, (_, index) => `${(index * 0.02).toFixed(2)},${(index % 2 === 0 ? 0.01 : -0.01).toFixed(5)}`);
    await fs.writeFile(csvPath, ['time,acceleration', ...rows].join('\n'), 'utf8');

    const preview = await analyzeUploadedFile(csvPath, tmpDir);
    const full = await analyzeUploadedFile(csvPath, tmpDir, undefined, { mode: 'full' });

    expect(preview.rows).toHaveLength(100);
    expect(preview.truncated).toBe(true);
    expect(full.rows).toHaveLength(1560);
    expect(full.truncated).toBe(false);
  });

  test('motion inspection uses complete samples, returns bounded preview and preserves a source-bound context record', async () => {
    const { createAnalyzeFileTool } = await import('../../../dist/agent-langgraph/file-tools.js');
    const file=path.join(uploadsDir,'inspection.csv');
    await fs.writeFile(file,['time,accel_g',...Array.from({length:1001},(_,i)=>`${i*.02},${i===1000?.3:0}`)].join('\n'));
    const output=await createAnalyzeFileTool().invoke({filePath:file,groundMotion:{direction:'y'}},
      {toolCall:{id:'inspect'},configurable:{workspaceRoot:tmpDir,agentState:{analysisResult:{runId:'old'},model:{nodes:[]}}}});
    const response=JSON.parse(output.update.messages[0].content);
    expect(response.rows).toBeUndefined();
    expect(response.groundMotionPreview).toMatchObject({pointCount:1001,dt:.02,unit:'m/s2',originalUnit:'g',direction:'y'});
    expect(response.groundMotionPreview.preview.points.length).toBeLessThanOrEqual(601);
    expect(response.groundMotionPreview.preview.points.at(-1).acceleration).toBeCloseTo(.3*9.80665);
    expect(output.update.analysisResult).toBeNull();
    expect(output.update.contextSeismicWorkflow.groundMotionSet.records[0]).toMatchObject({direction:'y',fileReference:{sha256:response.source.sha256}});
    await fs.writeFile(file,'time,accel_g\n0,0\n.02,bad\n.04,.1');
    await expect(createAnalyzeFileTool().invoke({filePath:file,groundMotion:{direction:'y'}},
      {configurable:{workspaceRoot:tmpDir}})).rejects.toThrow('GROUND_MOTION_BAD_CELL');
  });

  test('a single Excel sheet is explicitly retained in the motion record and can be source-confirmed', async () => {
    const XLSX = await import('xlsx');
    const { createAnalyzeFileTool } = await import('../../../dist/agent-langgraph/file-tools.js');
    const { createReviewInputTool } = await import('../../../dist/agent-langgraph/model-tools.js');
    const file = path.join(uploadsDir, 'one-sheet.xlsx');
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['time', 'accel_g'], ...Array.from({ length: 250 }, (_, i) => [i * .01, i === 249 ? .2 : 0])]), 'Motion');
    await fs.writeFile(file, XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));
    const output = await createAnalyzeFileTool().invoke({ filePath: file, groundMotion: { direction: 'x' } },
      { toolCall: { id: 'inspect-sheet' }, configurable: { workspaceRoot: tmpDir, agentState: {} } });
    const parsed = JSON.parse(output.update.messages[0].content);
    expect(parsed.groundMotionPreview.pointCount).toBe(250);
    expect(parsed.groundMotionRecord.sheetName).toBe('Motion');
    const source = output.update.inputEvidence.find(item => item.source?.sheet === 'Motion' && item.source.complete);
    const reviewed = await createReviewInputTool().invoke({ resolutions: [{ field: source.field, value: true, reason: 'Reviewed complete excitation',
      sourceEvidenceId: source.id, analysisRecordId: parsed.groundMotionRecord.id }] },
    { toolCall: { id: 'confirm-sheet' }, configurable: { agentState: output.update } });
    expect(JSON.parse(reviewed.update.messages[0].content).unresolved).toEqual([]);
  });

  test('full mode reads retained DXF entities and complete selected PDF page content', async () => {
    const { analyzeUploadedFile } = await import('../../../dist/agent-langgraph/file-tools.js');
    const dxfPath=path.join(uploadsDir,'large.dxf');
    const entities=Array.from({length:510},(_,i)=>['0','LINE','10',String(i),'20','0','11',String(i+1),'21','1']).flat();
    await fs.writeFile(dxfPath,validDxf(entities));
    expect((await analyzeUploadedFile(dxfPath,tmpDir)).linesTruncated).toBe(true);
    const full=await analyzeUploadedFile(dxfPath,tmpDir,undefined,{mode:'full'});
    expect(full.lines).toHaveLength(510);
    expect(full.complete).toBe(true);
    const pdfPath=path.join(uploadsDir,'dense.pdf');
    await fs.writeFile(pdfPath,pdfFixture(Array.from({length:2100},()=> 'BT /F1 12 Tf 20 120 Td (Beam B1 detail) Tj ET').join('\n')));
    const preview=await analyzeUploadedFile(pdfPath,tmpDir,undefined,{pageCount:1});
    expect(preview.pages[0].textTruncated || preview.pages[0].itemsTruncated).toBe(true);
    const complete=await analyzeUploadedFile(pdfPath,tmpDir,undefined,{mode:'full',pageCount:1});
    expect(complete.pages[0].textTruncated).toBe(false);
    expect(complete.pages[0].itemsTruncated).toBe(false);
    expect(complete.pages[0].text.length).toBeGreaterThan(16000);
    expect(complete.inputEvidence.find(item=>item.source.page===2).requirement).toBe('complete-read');
  });

  test('later PDF pages enter the same vision hook and retain page evidence', async () => {
    const { createAnalyzeFileTool } = await import('../../../dist/agent-langgraph/file-tools.js');
    const pdfPath = path.join(uploadsDir, 'later-page.pdf');
    await fs.writeFile(pdfPath, pdfFixture());
    const summarizeFileImages = jest.fn(async (parsed) => ({ ...parsed, pages: parsed.pages.map(page => ({ ...page, visionSummary: 'Visible diagonal', visionStatus: 'completed' })) }));
    const result = JSON.parse(await createAnalyzeFileTool().invoke({ filePath: pdfPath, pageStart: 2, pageCount: 1 },
      { configurable: { workspaceRoot: tmpDir, summarizeFileImages } }));
    expect(summarizeFileImages).toHaveBeenCalledTimes(1);
    expect(result.pages[0].pageNumber).toBe(2);
    expect(result.pages[0].visionSummary).toBe('Visible diagonal');
    expect(result.pages[0].renderedImagePath).toBeTruthy();
  });

  test('analyzes a plain text file', async () => {
    const { createAnalyzeFileTool } = await import('../../../dist/agent-langgraph/file-tools.js');
    const txtPath = path.join(uploadsDir, 'notes.txt');
    await fs.writeFile(txtPath, 'Hello structural engineering', 'utf8');
    const tool = createAnalyzeFileTool();
    const raw = await tool.invoke(
      { filePath: txtPath },
      { configurable: { workspaceRoot: tmpDir } },
    );
    const result = JSON.parse(raw);
    expect(result.success).toBe(true);
    expect(result.type).toBe('text');
    expect(result.content).toContain('Hello structural engineering');
  });

  test('analyzes an AT2 ground-motion file as text content', async () => {
    const { createAnalyzeFileTool } = await import('../../../dist/agent-langgraph/file-tools.js');
    const at2Path = path.join(uploadsDir, 'motion.at2');
    await fs.writeFile(at2Path, [
      'PEER NGA STRONG MOTION DATABASE RECORD',
      'NPTS= 6, DT= .02 SEC',
      '0.000 0.010 -0.010',
      '0.005 -0.005 0.000',
    ].join('\n'), 'utf8');
    const tool = createAnalyzeFileTool();
    const raw = await tool.invoke(
      { filePath: at2Path },
      { configurable: { workspaceRoot: tmpDir } },
    );
    const result = JSON.parse(raw);
    expect(result.success).toBe(true);
    expect(result.type).toBe('text');
    expect(result.ext).toBe('.at2');
    expect(result.content).toContain('DT= .02 SEC');
  });

  test('omits image base64 from analyze_file tool output', async () => {
    const { createAnalyzeFileTool, analyzeUploadedFile } = await import('../../../dist/agent-langgraph/file-tools.js');
    const pngPath = path.join(uploadsDir, 'sketch.png');
    await fs.writeFile(
      pngPath,
      Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lJ6pYQAAAABJRU5ErkJggg==', 'base64'),
    );
    const tool = createAnalyzeFileTool();
    const raw = await tool.invoke(
      { filePath: pngPath },
      { configurable: { workspaceRoot: tmpDir } },
    );
    const result = JSON.parse(raw);
    expect(result.success).toBe(true);
    expect(result.type).toBe('image');
    expect(result.base64DataUri).toBeUndefined();

    const internal = await analyzeUploadedFile(pngPath, tmpDir, undefined, { includeImageData: true });
    expect(internal.base64DataUri).toMatch(/^data:image\/png;base64,/);
  });

  test('keeps DXF analysis note neutral for structure routing', async () => {
    const { createAnalyzeFileTool } = await import('../../../dist/agent-langgraph/file-tools.js');
    const dxfPath = path.join(uploadsDir, 'drawing.dxf');
    await fs.writeFile(dxfPath, validDxf([
      '0', 'LINE',
      '10', '0', '20', '0',
      '11', '6', '21', '0',
      '0', 'TEXT',
      '10', '0', '20', '0', '40', '1', '1', 'Total: 6m',
    ]), 'utf8');
    const tool = createAnalyzeFileTool();
    const raw = await tool.invoke(
      { filePath: dxfPath },
      { configurable: { workspaceRoot: tmpDir } },
    );
    const result = JSON.parse(raw);
    expect(result.success).toBe(true);
    expect(result.type).toBe('dxf');
    expect(result.note.toLowerCase()).not.toMatch(/\b(beams?|columns?)\b/);
  });

  test('does not silently discard DXF topology after the first 50 line entities', async () => {
    const { createAnalyzeFileTool } = await import('../../../dist/agent-langgraph/file-tools.js');
    const dxfPath = path.join(uploadsDir, 'drawing-many-lines.dxf');
    const entities = Array.from({ length: 75 }, (_, index) => [
      '0', 'LINE',
      '8', index < 70 ? 'ARCH' : 'STRUCT',
      '10', String(index), '20', '0',
      '11', String(index + 1), '21', '0',
    ]).flat();
    await fs.writeFile(dxfPath, validDxf(entities), 'utf8');
    const tool = createAnalyzeFileTool();
    const raw = await tool.invoke(
      { filePath: dxfPath },
      { configurable: { workspaceRoot: tmpDir } },
    );
    const result = JSON.parse(raw);

    expect(result.lineCount).toBe(75);
    expect(result.lines).toHaveLength(75);
    expect(result.linesTruncated).toBe(false);
    expect(result.lines.slice(-5).every((line) => line.layer === 'STRUCT')).toBe(true);
  });

  test('rejects path traversal', async () => {
    const { createAnalyzeFileTool } = await import('../../../dist/agent-langgraph/file-tools.js');
    const tool = createAnalyzeFileTool();
    const raw = await tool.invoke(
      { filePath: '../../etc/passwd' },
      { configurable: { workspaceRoot: tmpDir } },
    );
    const result = JSON.parse(raw);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/traversal|denied/);
  });

  test('restricted runs can read only their explicitly supplied attachments', async () => {
    const { createAnalyzeFileTool } = await import('../../../dist/agent-langgraph/file-tools.js');
    const allowedPath = path.join(uploadsDir, 'drawing.dxf');
    const workspaceSecret = path.join(tmpDir, 'ground-truth.json');
    await fs.writeFile(allowedPath, validDxf(), 'utf8');
    await fs.writeFile(workspaceSecret, '{"answer":42}', 'utf8');
    const tool = createAnalyzeFileTool();
    const config = {
      configurable: {
        workspaceRoot: tmpDir,
        fileAccessAllowlist: [allowedPath],
      },
    };

    const allowed = JSON.parse(await tool.invoke({ filePath: allowedPath }, config));
    const denied = JSON.parse(await tool.invoke({ filePath: workspaceSecret }, config));

    expect(allowed.success).toBe(true);
    expect(denied.success).toBe(false);
    expect(denied.error).toMatch(/restricted to the attachments/);
  });

  test('returns FILE_NOT_FOUND for missing file', async () => {
    const { createAnalyzeFileTool } = await import('../../../dist/agent-langgraph/file-tools.js');
    const tool = createAnalyzeFileTool();
    const raw = await tool.invoke(
      { filePath: path.join(uploadsDir, 'missing.csv') },
      { configurable: { workspaceRoot: tmpDir } },
    );
    const result = JSON.parse(raw);
    expect(result.success).toBe(false);
    expect(result.error).toBe('FILE_NOT_FOUND');
  });
});
