import { compactAttachmentAnalysisMetadata, isRecord, attachmentSummary } from './attachment-analysis.js';
import type { AttachmentInfo, LangGraphRunInput, AttachmentAnalysis } from '../service-types.js';

function analysisRowsRecord(
  attachment: AttachmentInfo,
  analysis: Record<string, unknown>,
  idSuffix?: string,
): Record<string, unknown> | null {
  const rows = analysis.rows;
  if (!Array.isArray(rows) || rows.length === 0) {
    return null;
  }
  const sheetLabel = idSuffix ? `:${idSuffix}` : '';
  return {
    id: `${attachment.fileId || attachment.relPath || attachment.originalName}${sheetLabel}`,
    name: idSuffix ? `${attachment.originalName}:${idSuffix}` : attachment.originalName,
    recordType: 'actual',
    source: 'uploaded_attachment',
    fileId: attachment.fileId,
    relPath: attachment.relPath,
    ...(idSuffix ? { sheetName: idSuffix } : {}),
    ...(analysis.fileReference ? { fileReference: analysis.fileReference }
      : { ...(Array.isArray(analysis.headers) ? { headers: analysis.headers } : {}), rows }),
    fileAnalysis: compactAttachmentAnalysisMetadata(analysis),
  };
}

function finiteCellNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function numericRows(rows: unknown): number[][] {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => Array.isArray(row)
      ? row.every(cell => finiteCellNumber(cell) !== null) ? row.map(cell => finiteCellNumber(cell)!) : []
      : [])
    .filter((row) => row.length > 0);
}

function normalizeHeader(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

function isNumericHeaderRow(headers: unknown): boolean {
  return Array.isArray(headers)
    && headers.length > 0
    && headers.every((header) => finiteCellNumber(header) !== null);
}

function hasMotionHeaders(headers: unknown): boolean {
  if (!Array.isArray(headers)) return false;
  const normalized = headers.map(normalizeHeader);
  const hasTime = normalized.some((header) =>
    ['time', 't', 'sec', 'second', 'seconds'].includes(header)
    || header.includes('time')
    || header.includes('(s)'));
  const hasAcceleration = normalized.some((header) =>
    ['acc', 'ag', 'a', 'gal', 'g'].includes(header)
    || header.includes('accel')
    || header.includes('acceler')
    || header.includes('cm/s')
    || header.includes('m/s'));
  return hasTime && hasAcceleration;
}

function hasClearlyNonMotionHeaders(headers: unknown): boolean {
  if (!Array.isArray(headers)) return false;
  const normalized = headers.map(normalizeHeader).join(' ');
  return [
    'story',
    'floor',
    'load',
    'force',
    'node',
    'element',
    'member',
    'beam',
    'column',
    'region',
    'intensity',
    'designgroup',
    'design group',
    'sitecategory',
    'site category',
    'alphamax',
    'alpha max',
    'characteristicperiod',
  ].some((token) => normalized.includes(token));
}

function hasLikelyGroundMotionTimeColumn(rows: number[][]): boolean {
  const timeValues = rows
    .filter((row) => row.length >= 2)
    .map((row) => row[0]);
  if (timeValues.length < 3) return false;
  const deltas = timeValues.slice(1).map((value, index) => value - timeValues[index]);
  return deltas.every((delta) => delta > 0 && delta <= 0.5);
}

function looksLikeGroundMotionRows(analysis: Record<string, unknown>): boolean {
  const rows = numericRows(analysis.rows);
  if (rows.length < 3) return false;
  if (hasMotionHeaders(analysis.headers)) return rows.some((row) => row.length >= 2);
  if (hasClearlyNonMotionHeaders(analysis.headers)) return false;
  if (!isNumericHeaderRow(analysis.headers)) return false;
  if (rows.every((row) => row.length === 1)) return rows.length >= 8;
  return hasLikelyGroundMotionTimeColumn(rows);
}

function looksLikeGroundMotionText(analysis: Record<string, unknown>): boolean {
  const ext = typeof analysis.ext === 'string' ? analysis.ext.toLowerCase() : '';
  const content = typeof analysis.content === 'string' ? analysis.content : '';
  if (!content.trim()) return false;
  if (ext === '.at2') return true;
  if (ext !== '.txt') return false;
  const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const numericLines = lines.filter((line) => {
    const values = line.split(/[\s,;]+/).map(finiteCellNumber).filter((value) => value !== null);
    return values.length > 0 && values.length === line.split(/[\s,;]+/).filter(Boolean).length;
  });
  return numericLines.length >= 4 && numericLines.length >= Math.ceil(lines.length * 0.5);
}

function looksLikeGroundMotionAttachmentAnalysis(analysis: Record<string, unknown>): boolean {
  const type = typeof analysis.type === 'string' ? analysis.type : '';
  if (type === 'csv') return looksLikeGroundMotionRows(analysis);
  if (type === 'text') return looksLikeGroundMotionText(analysis);
  if (type === 'excel' && isRecord(analysis.sheets)) {
    return Object.values(analysis.sheets).some((sheetValue) =>
      isRecord(sheetValue) && looksLikeGroundMotionRows(sheetValue));
  }
  return false;
}

function groundMotionAttachmentAnalyses(
  attachmentAnalyses: AttachmentAnalysis[],
): AttachmentAnalysis[] {
  return attachmentAnalyses.filter(({ analysis }) => looksLikeGroundMotionAttachmentAnalysis(analysis));
}

function groundMotionRecordsFromAttachmentAnalyses(attachmentAnalyses: AttachmentAnalysis[]): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  for (const { attachment, analysis } of attachmentAnalyses) {
    const type = typeof analysis.type === 'string' ? analysis.type : '';
    if (type === 'csv') {
      const record = analysisRowsRecord(attachment, analysis);
      if (record) records.push(record);
      continue;
    }
    if (type === 'text') {
      const content = typeof analysis.content === 'string' ? analysis.content : '';
      if (content.trim()) {
        records.push({
          id: attachment.fileId || attachment.relPath || attachment.originalName,
          name: attachment.originalName,
          recordType: 'actual',
          source: 'uploaded_attachment',
          fileId: attachment.fileId,
          relPath: attachment.relPath,
          ...(analysis.fileReference ? { fileReference: analysis.fileReference } : { content }),
          fileAnalysis: compactAttachmentAnalysisMetadata(analysis),
        });
      }
      continue;
    }
    if (type === 'excel' && isRecord(analysis.sheets)) {
      for (const [sheetName, sheetValue] of Object.entries(analysis.sheets)) {
        if (!isRecord(sheetValue)) continue;
        if (!looksLikeGroundMotionRows(sheetValue)) continue;
        const record = analysisRowsRecord(attachment, { ...sheetValue, fileReference: analysis.fileReference }, sheetName);
        if (record) {
          records.push({
            ...record,
            fileAnalysis: {
              ...compactAttachmentAnalysisMetadata(sheetValue),
              workbook: compactAttachmentAnalysisMetadata(analysis),
            },
          });
        }
      }
    }
  }
  return records;
}

function uploadedGroundMotionWorkflowFromAttachmentAnalyses(
  attachmentAnalyses: AttachmentAnalysis[],
): Record<string, unknown> | null {
  const groundMotionAnalyses = groundMotionAttachmentAnalyses(attachmentAnalyses);
  const records = groundMotionRecordsFromAttachmentAnalyses(groundMotionAnalyses);
  if (records.length === 0) {
    return null;
  }
  return {
    groundMotionSet: {
      source: 'uploaded',
      uploadedAttachments: groundMotionAnalyses.map(({ attachment }) => attachmentSummary(attachment)),
      records,
    },
  };
}

export function enrichUploadedGroundMotionWorkflow(
  seismicWorkflow: Record<string, unknown>,
  attachmentAnalyses: AttachmentAnalysis[],
): Record<string, unknown> {
  const groundMotionSet = isRecord(seismicWorkflow.groundMotionSet)
    ? seismicWorkflow.groundMotionSet
    : undefined;
  const source = typeof groundMotionSet?.source === 'string'
    ? groundMotionSet.source.trim().toLowerCase()
    : '';
  if (source !== 'uploaded' || !groundMotionSet) {
    return seismicWorkflow;
  }

  const groundMotionAnalyses = groundMotionAttachmentAnalyses(attachmentAnalyses);
  const uploadedAttachments = groundMotionAnalyses.map(({ attachment }) => attachmentSummary(attachment));
  const existingRecords = Array.isArray(groundMotionSet.records) ? groundMotionSet.records : undefined;
  const fullRecords = groundMotionRecordsFromAttachmentAnalyses(groundMotionAnalyses);
  const generatedRecords = existingRecords && existingRecords.length > 0
    ? existingRecords.map(record => {
      if (!isRecord(record)) return record;
      const matches = fullRecords.filter(full => record.id === full.id
        || ((record.fileId !== undefined && record.fileId === full.fileId
          || record.relPath !== undefined && record.relPath === full.relPath) && record.sheetName === full.sheetName));
      if (matches.length !== 1 || !matches[0]!.fileReference) return record;
      // Keep explicit sampling settings; samples always come from the complete source.
      const result = { ...record, ...matches[0], ...Object.fromEntries(Object.entries(record)
        .filter(([key]) => ['unit', 'direction', 'component', 'axis', 'seismicDirection', 'dt', 'timeStep', 'time_step',
          'timeUnit', 'timeColumn', 'accelerationColumn', 'accelColumn', 'valueColumn', 'recordType'].includes(key))) };
      for (const key of ['values', 'accelerations', 'accel', 'rows', 'content', 'text', 'csv', 'at2', 'data']) delete result[key];
      return result;
    }) : fullRecords;

  return {
    ...seismicWorkflow,
    groundMotionSet: {
      ...groundMotionSet,
      uploadedAttachments,
      ...(generatedRecords.length > 0 ? { records: generatedRecords } : {}),
    },
  };
}

export function extractContextSeismicWorkflow(
  context?: LangGraphRunInput['context'],
  attachmentAnalyses: AttachmentAnalysis[] = [],
): Record<string, unknown> | null {
  const seismicWorkflow = context?.seismicWorkflow;
  if (!isRecord(seismicWorkflow) || Object.keys(seismicWorkflow).length === 0) {
    return uploadedGroundMotionWorkflowFromAttachmentAnalyses(attachmentAnalyses);
  }
  return enrichUploadedGroundMotionWorkflow(seismicWorkflow, attachmentAnalyses);
}
