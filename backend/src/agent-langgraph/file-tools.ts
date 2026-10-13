/**
 * File-aware agent tools: analyze_file
 *
 * analyze_file inspects an uploaded file at a given path and extracts
 * meaningful content depending on the file type:
 *   - CSV / text / AT2: returns parsed rows / raw content
 *   - Excel (.xlsx/.xls): returns headers + first N rows per sheet
 *   - PDF: page text, coordinates and rendered pages via PDF.js
 *   - Image (png/jpg/...): returns metadata/base64 for the configured vision parser
 *   - DXF: extracts LINE, TEXT, DIMENSION entities as structural hints
 *   - Other binary: returns metadata + extension hint
 */
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import fsp from 'fs/promises';
import path from 'path';
import { createHash } from 'node:crypto';
import { parse as parseCsvRecords } from 'csv-parse/sync';
import { PythonWorkerRunner, resolveWorkerPath } from '../utils/python-worker-runner.js';
import type { TextItem } from 'pdfjs-dist/types/src/display/api.js';
import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import type { AgentConfigurable } from './configurable.js';
import { runtimeBaseDir } from '../config/index.js';
import { collectVisionEvidence, imageRegionSchema, type ImageRegion } from '../engineering/vision-evidence.js';
import { Command } from '@langchain/langgraph';
import { ToolMessage } from '@langchain/core/messages';

const UPLOAD_DIR = path.join(runtimeBaseDir, '.uploads');
const MAX_READ_BYTES = 10 * 1024 * 1024; // 10 MB cap for analysis
const CSV_MAX_ROWS = 100;
const EXCEL_MAX_ROWS = 50;
const IMAGE_MAX_BYTES = 4 * 1024 * 1024; // 4 MB base64 cap

const TEXT_EXTS = new Set(['.txt', '.at2', '.md', '.log', '.tcl', '.py', '.json', '.yaml', '.yml', '.csv', '.tsv']);
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
const EXCEL_EXTS = new Set(['.xlsx', '.xls']);

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

type AnalyzeFileResult = Record<string, unknown>;

interface AnalyzeUploadedFileOptions {
  includeImageData?: boolean;
  mode?: 'preview' | 'full';
  pageStart?: number;
  pageCount?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns true only when candidatePath is exactly root or a strict descendant. */
export function isPathWithinRoot(candidatePath: string, root: string): boolean {
  const c = path.normalize(candidatePath);
  const r = path.normalize(root);
  return c === r || c.startsWith(r + path.sep);
}

/** Resolve an uploaded file path safely inside UPLOAD_DIR or workspaceRoot.
 *
 * Relative paths (e.g. ".uploads/<conversationId>/<file>") are resolved
 * against runtimeBaseDir so the leading ".uploads/" segment is preserved
 * and the final path lands inside UPLOAD_DIR correctly.
 */
export function resolveUploadPath(
  relPath: string,
  workspaceRoot: string | undefined,
): string {
  const runtimeDir = path.resolve(UPLOAD_DIR, '..');
  // Absolute paths: allow only inside UPLOAD_DIR or workspaceRoot
  if (path.isAbsolute(relPath)) {
    const absNorm = path.normalize(relPath);
    if (isPathWithinRoot(absNorm, UPLOAD_DIR) || (workspaceRoot && isPathWithinRoot(absNorm, workspaceRoot))) {
      return absNorm;
    }
    throw new Error('Access denied: path outside allowed directories');
  }
  // Relative: resolve under runtimeBaseDir so ".uploads/<conv>/<file>" resolves correctly
  const uploadResolved = path.resolve(runtimeDir, relPath);
  if (isPathWithinRoot(uploadResolved, UPLOAD_DIR)) {
    return uploadResolved;
  }
  if (workspaceRoot) {
    const wsResolved = path.resolve(workspaceRoot, relPath);
    if (isPathWithinRoot(wsResolved, workspaceRoot)) {
      return wsResolved;
    }
  }
  throw new Error('Access denied: path traversal blocked');
}

/** RFC 4180 parsing with physical line provenance, including quoted multiline cells. */
export function parseCsv(text: string, maxRows: number, delimiter?: string) {
  const separator = delimiter ?? (text.split(/\r?\n/, 1)[0]?.includes('\t') ? '\t' : ',');
  const records = parseCsvRecords(text, { bom: true, delimiter: separator, skip_empty_lines: true, info: true }) as unknown as Array<{ record: string[]; info: { lines: number } }>;
  const data = records.slice(1);
  const selected = data.slice(0, Math.max(0, maxRows));
  return {
    headers: records[0]?.record ?? [], rows: selected.map((item) => item.record), totalRows: data.length,
    rowSources: selected.map((item, index) => ({ recordNumber: index + 2, lineStart: (records[index]?.info.lines ?? 0) + 1, lineEnd: item.info.lines })),
    truncated: selected.length < data.length,
  };
}

/** DXF semantics are delegated to ezdxf rather than a partial group-code parser. */
export async function parseDxf(text: string, maxLines = 500, maxTexts = 200, resolvedFilePath?: string): Promise<Record<string, any>> {
  const runner = new PythonWorkerRunner<{ text: string; maxLines: number; maxTexts: number; filePath?: string }>(resolveWorkerPath('agent-skills/data-input/cad/dxf_worker.py'));
  return runner.invoke({ text, maxLines, maxTexts, filePath: resolvedFilePath });
}

async function parsePdf(filePath: string, bytes: Buffer, options: AnalyzeUploadedFileOptions) {
  const { getDocument, OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { createCanvas } = await import('@napi-rs/canvas');
  const loadingTask = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
  const document = await loadingTask.promise;
  try {
    const first = Math.max(1, options.pageStart ?? 1);
    const last = Math.min(document.numPages, first + Math.min(options.pageCount ?? 4, 12) - 1);
    if (first > document.numPages) throw new Error('PDF_PAGE_OUT_OF_RANGE / PDF页码超出范围');
    const digest = createHash('sha256').update(bytes).digest('hex');
    const outputDir = path.join(path.dirname(filePath), '.parsed', digest.slice(0, 16));
    await fsp.mkdir(outputDir, { recursive: true });
    const pages = [];
    for (let number = first; number <= last; number += 1) {
      const page = await document.getPage(number);
      const viewport = page.getViewport({ scale: 1 });
      const textContent = await page.getTextContent();
      const operations = await page.getOperatorList();
      const drawingOps = new Set([OPS.constructPath, OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject, OPS.shadingFill]);
      const hasGraphics = operations.fnArray.some((operation: number) => drawingOps.has(operation));
      const items = textContent.items.filter((item): item is TextItem => 'str' in item);
      const scale = Math.min(2, 1800 / Math.max(viewport.width, viewport.height));
      const renderedViewport = page.getViewport({ scale });
      const canvas = createCanvas(Math.ceil(renderedViewport.width), Math.ceil(renderedViewport.height));
      await page.render({ canvasContext: canvas.getContext('2d') as never, canvas: canvas as never, viewport: renderedViewport }).promise;
      const renderedImagePath = path.join(outputDir, `page-${number}.png`);
      await fsp.writeFile(renderedImagePath, await canvas.encode('png'));
      const text = items.map((item) => item.str + (item.hasEOL ? '\n' : ' ')).join('');
      pages.push({ pageNumber: number, width: viewport.width, height: viewport.height,
        text: text.slice(0, 16000), textTruncated: text.length > 16000,
        items: items.slice(0, 2000).map((item, index) => ({ text: item.str, transform: item.transform, width: item.width, height: item.height, source: { pageNumber: number, itemIndex: index } })),
        itemsTruncated: items.length > 2000, renderedImagePath, hasGraphics, requiresVision: !text.trim() || hasGraphics,
        note: 'Text extraction does not reconstruct drawing geometry; inspect rendered page / 提取文字不等于识别图形，须结合页面图像' });
      page.cleanup();
    }
    return { pageCount: document.numPages, pages, text: pages.map((page) => `[Page ${page.pageNumber}]\n${page.text}`).join('\n'),
      truncated: first > 1 || last < document.numPages || pages.some((page) => page.textTruncated || page.itemsTruncated),
      nextPage: last < document.numPages ? last + 1 : null, parser: 'pdfjs-dist',
      source: { filePath, sha256: digest }, coordinateFrame: 'pdf-page',
    };
  } finally { await loadingTask.destroy(); }
}
export async function analyzeUploadedFile(
  filePath: string,
  workspaceRoot: string | undefined,
  maxRows?: number,
  options: AnalyzeUploadedFileOptions = {},
): Promise<AnalyzeFileResult> {
  let resolvedPath: string;
  try {
    resolvedPath = resolveUploadPath(filePath, workspaceRoot);
  } catch (err) {
    return { success: false, error: String(err) };
  }

  let stat: Awaited<ReturnType<typeof fsp.stat>>;
  try {
    stat = await fsp.stat(resolvedPath);
  } catch {
    return { success: false, error: 'FILE_NOT_FOUND', filePath };
  }

  if (!stat.isFile()) {
    return { success: false, error: 'NOT_A_FILE', filePath };
  }

  try {
  const ext = path.extname(resolvedPath).toLowerCase();
  const size = stat.size;

  // ── Image ────────────────────────────────────────────────────────────
  if (IMAGE_EXTS.has(ext)) {
    if (size > IMAGE_MAX_BYTES) {
      return {
        success: true,
        type: 'image',
        ext,
        size,
        note: 'Image too large for base64 encoding (> 4 MB). Consider resizing before analysis.',
      };
    }
    const buf = await fsp.readFile(resolvedPath);
    const mime = IMAGE_MIME[ext] ?? 'image/png';
    const base64 = buf.toString('base64');
    const imageResult: AnalyzeFileResult = {
      success: true,
      type: 'image',
      ext,
      size,
      mimeType: mime,
      source: { filePath: resolvedPath, sha256: createHash('sha256').update(buf).digest('hex'), parser: 'image' },
      note: 'Image binary is available for the configured vision parser. The main agent should use the resulting text summary, not pass base64DataUri to the standard model.',
    };
    if (options.includeImageData) {
      imageResult.base64DataUri = `data:${mime};base64,${base64}`;
    }
    return imageResult;
  }

  if (size > MAX_READ_BYTES) {
    return {
      success: false,
      error: 'FILE_TOO_LARGE',
      size,
      note: `File exceeds ${MAX_READ_BYTES / 1024 / 1024} MB analysis limit.`,
    };
  }

  // ── PDF ──────────────────────────────────────────────────────────────
  if (ext === '.pdf') {
    try {
      const bytes = await fsp.readFile(resolvedPath);
      return { success: true, type: 'pdf', ext, size, ...await parsePdf(resolvedPath, bytes, options) };
    } catch (err) {
      const msg = String(err);
      if (msg.includes('Cannot find module')) {
        return {
          success: false,
          type: 'pdf',
          error: 'PDF_DEPENDENCY_MISSING',
          note: 'Install pdfjs-dist and @napi-rs/canvas / 请安装PDF解析及渲染依赖',
        };
      }
      return { success: false, type: 'pdf', error: msg };
    }
  }

  // ── Excel ────────────────────────────────────────────────────────────
  if (EXCEL_EXTS.has(ext)) {
    try {
      const XLSX = await import('xlsx').then((m) => m.default ?? m);
      const buf = await fsp.readFile(resolvedPath);
      const workbook = XLSX.read(buf, { type: 'buffer' });
      const sheets: Record<string, unknown> = {};
      for (const sheetName of workbook.SheetNames) {
        const ws = workbook.Sheets[sheetName];
        const jsonData: unknown[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }) as unknown[][];
        const rowLimit = options.mode === 'full'
          ? Math.max(jsonData.length - 1, 0)
          : Math.min(maxRows ?? EXCEL_MAX_ROWS, 200);
        const headers = (jsonData[0] as unknown[] ?? []).map(String);
        const rows = jsonData.slice(1, rowLimit + 1).map((row) =>
          (row as unknown[]).map((cell) => (cell === null || cell === undefined ? '' : cell)),
        );
        const range = XLSX.utils.decode_range(ws['!ref'] ?? 'A1');
        sheets[sheetName] = { headers, rows, totalRows: Math.max(0, jsonData.length - 1),
          rowSources: rows.map((_, index) => ({ sheet: sheetName, row: range.s.r + index + 2 })),
          truncated: rows.length < jsonData.length - 1 };
      }
      return { success: true, type: 'excel', ext, size, sheets,
        source: { filePath: resolvedPath, sha256: createHash('sha256').update(buf).digest('hex'), parser: 'xlsx' } };
    } catch (err) {
      const msg = String(err);
      if (msg.includes('Cannot find module')) {
        return {
          success: false,
          type: 'excel',
          error: 'XLSX_NOT_INSTALLED',
          note: 'Install xlsx: npm install xlsx',
        };
      }
      return { success: false, type: 'excel', error: msg };
    }
  }

  // ── CSV / TSV / AT2 / plain text ───────────────────────────────────────
  if (ext === '.csv' || ext === '.tsv' || TEXT_EXTS.has(ext)) {
    const buf = await fsp.readFile(resolvedPath);
    const text = buf.toString('utf-8');

    if (ext === '.csv' || ext === '.tsv') {
      const allLines = text.split(/\r?\n/);
      const rowLimit = options.mode === 'full'
        ? Math.max(allLines.filter((line) => line.trim()).length - 1, 0)
        : Math.min(maxRows ?? CSV_MAX_ROWS, 500);
      const parsed = parseCsv(text, rowLimit, ext === '.tsv' ? '\t' : ',');
      return {
        success: true,
        type: 'csv',
        ext,
        size,
        totalLines: allLines.length,
        ...parsed,
        source: { filePath: resolvedPath, sha256: createHash('sha256').update(buf).digest('hex'), parser: 'csv-parse' },
      };
    }

    // Plain text
    const content = options.mode === 'full' ? text : text.slice(0, 8000);
    return {
      success: true,
      type: 'text',
      ext,
      size,
      content,
      source: { filePath: resolvedPath, sha256: createHash('sha256').update(buf).digest('hex'), parser: 'utf8', characterStart: 0, characterEnd: content.length },
      truncated: options.mode === 'full' ? false : text.length > 8000,
    };
  }

  // ── DXF ──────────────────────────────────────────────────────────────
  if (ext === '.dxf') {
    const buf = await fsp.readFile(resolvedPath);
    const text = buf.toString('utf-8');
    const dxfData = await parseDxf(text, 500, 200, resolvedPath);
    return {
      success: true,
      type: 'dxf',
      ext,
      size,
      ...dxfData,
      source: { filePath: resolvedPath, sha256: createHash('sha256').update(buf).digest('hex'), parser: 'ezdxf' },
      entityCount: dxfData.entityCount,
      lineCount: dxfData.lineEntityCount,
      textCount: dxfData.textEntityCount,
      invalidLineCount: dxfData.invalidLineCount,
      lines: dxfData.lines,
      texts: dxfData.texts,
      linesTruncated: dxfData.lineEntityCount - dxfData.invalidLineCount > dxfData.lines.length,
      textsTruncated: dxfData.textEntityCount > dxfData.texts.length,
      coordinateFrame: 'source-dxf',
      insertionUnits: dxfData.insertionUnits,
      note: 'LINE coordinates remain in the source DXF frame. Do not treat source Y as StructureClaw global Y or Z until the drawing view is confirmed. Use declared insertionUnits when available; ask when units, plan/elevation/3D axis mapping, or truncated entities are ambiguous.',
    };
  }

  // ── Unknown binary ───────────────────────────────────────────────────
  return {
    success: true,
    type: 'binary',
    ext,
    size,
    note: `Binary file of type ${ext}. No parser available. Check if the correct file was uploaded.`,
  };
  } catch (error) {
    return { success: false, filePath, error: 'FILE_PARSE_FAILED', detail: error instanceof Error ? error.message : String(error) };
  }
}

// ---------------------------------------------------------------------------
// analyze_file tool
// ---------------------------------------------------------------------------

export function createAnalyzeFileTool() {
  return tool(
    async (
      input: { filePath: string; maxRows?: number; pageStart?: number; pageCount?: number; region?: ImageRegion; requiredFields?: string[] },
      config: LangGraphRunnableConfig,
    ) => {
      const configurable = config.configurable as Partial<AgentConfigurable>;
      const workspaceRoot = configurable?.workspaceRoot;
      if (Array.isArray(configurable?.fileAccessAllowlist)) {
        let requestedPath: string;
        let allowedPaths: string[];
        try {
          requestedPath = resolveUploadPath(input.filePath, workspaceRoot);
          allowedPaths = configurable.fileAccessAllowlist.map(
            (filePath) => resolveUploadPath(filePath, workspaceRoot),
          );
        } catch (error) {
          return JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        if (!allowedPaths.includes(requestedPath)) {
          return JSON.stringify({
            success: false,
            error: 'Access denied: analyze_file is restricted to the attachments supplied for this run',
          });
        }
      }
      const analysis = await analyzeUploadedFile(input.filePath, workspaceRoot, input.maxRows, { includeImageData: true, pageStart: input.pageStart, pageCount: input.pageCount });
      analysis.visionRequest = { region: input.region, requiredFields: input.requiredFields };
      const summarize = (config.configurable as Partial<AgentConfigurable> | undefined)?.summarizeFileImages;
      const parsed = summarize ? await summarize(analysis, input.filePath, config.signal) : analysis;
      delete parsed.base64DataUri;
      const evidence = collectVisionEvidence(parsed);
      const toolCallId = (config as LangGraphRunnableConfig & { toolCall?: { id: string } }).toolCall?.id;
      if (evidence.length && toolCallId) return new Command({ update: { inputEvidence: evidence,
        messages: [new ToolMessage({ name: 'analyze_file', tool_call_id: toolCallId, content: JSON.stringify(parsed) })] } });
      return JSON.stringify(parsed);
    },
    {
      name: 'analyze_file',
      description:
        'Analyze an uploaded file and extract its content. ' +
        'Supports CSV/TSV (structured rows), AT2/TXT ground-motion text, Excel (.xlsx/.xls, multi-sheet), ' +
        'PDF (text extraction), images (metadata/base64 for the configured vision parser), ' +
        'DXF/CAD (structural entity extraction), and plain text. ' +
        'filePath may be a relative path under .uploads/<conversationId>/ or an absolute path inside the upload directory.',
      schema: z.object({
        filePath: z.string().describe('Path to the uploaded file (relPath from upload response, or absolute path)'),
        pageStart: z.number().int().min(1).optional().describe('PDF first page, one-based / PDF起始页'),
        pageCount: z.number().int().min(1).max(12).optional().describe('PDF pages to extract and render, default 4 / 提取与渲染页数'),
        region: imageRegionSchema.optional().describe('Focused review crop, normalized x/y/width/height / 定点复核裁切区域'),
        requiredFields: z.array(z.string().min(1)).optional().describe('Fields that must be visibly checked; missing observations remain unresolved / 必须可见并复核的字段'),
        maxRows: z.number().int().min(1).max(500).optional().describe('Max rows to return for CSV/Excel (default 50-100)'),
      }),
    },
  );
}
