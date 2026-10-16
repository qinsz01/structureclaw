import type { AttachmentInfo } from '../service-types.js';

function sanitizeAttachmentNote(note: string): string {
  return note.replace(/\bbase64DataUri\b/g, 'image binary data');
}

export function compactAttachmentAnalysis(analysis: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...analysis };
  delete rest.base64DataUri;
  if (rest.type === 'image') {
    rest.note = typeof rest.note === 'string'
      ? sanitizeAttachmentNote(rest.note)
      : 'Image binary is parsed only by the configured vision model; the main agent receives text summaries only.';
  }
  return rest;
}

export function compactAttachmentAnalysisMetadata(analysis: Record<string, unknown>): Record<string, unknown> {
  const rest = compactAttachmentAnalysis(analysis);
  delete rest.rows;
  delete rest.content;
  delete rest.text;
  delete rest.csv;
  delete rest.at2;
  delete rest.data;
  delete rest.sheets;
  return rest;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function attachmentSummary(attachment: AttachmentInfo): Record<string, unknown> {
  return {
    fileId: attachment.fileId,
    originalName: attachment.originalName,
    relPath: attachment.relPath,
    ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
  };
}
