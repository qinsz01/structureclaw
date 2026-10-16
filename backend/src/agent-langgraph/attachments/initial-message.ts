import { HumanMessage } from '@langchain/core/messages';
import type { AppLocale } from '../../shared/locale.js';
import { analyzeUploadedFile } from '../file-tools.js';
import { summarizeFileImages } from '../attachment-vision.js';
import { collectVisionEvidence } from '../../engineering/vision-evidence.js';
import { mergeInputEvidence } from '../../engineering/input-evidence.js';
import { compactAttachmentAnalysis, isRecord } from './attachment-analysis.js';
import type { AttachmentInfo, AttachmentAnalysis } from '../service-types.js';

type HumanMessageContentBlock =
  | { type: 'text'; text: string };

interface InitialHumanMessagePayload {
  content: string | HumanMessageContentBlock[];
  canonicalMessage: string;
  attachmentAnalyses: AttachmentAnalysis[];
}

interface InitialHumanMessageOptions {
  summarizeImages?: boolean;
  signal?: AbortSignal;
}

function buildAttachmentBlock(attachments: AttachmentInfo[] | undefined, locale: AppLocale): string {
  if (!attachments || attachments.length === 0) return '';
  const header = locale === 'zh' ? '[已上传文件]' : '[Attached files]';
  const instruction = locale === 'zh'
    ? '下面会提供附件的解析内容。请基于已解析文本、DXF 几何或视觉摘要识别结构类型、尺寸、荷载和边界条件；如果关键信息缺失，请追问。'
    : 'Parsed attachment content follows. Use parsed text, DXF geometry, or vision summaries to identify structural type, dimensions, loads, and boundary conditions; ask for clarification when critical information is missing.';
  const lines = attachments.map(a => `- ${a.originalName} (${a.relPath})`);
  return `\n\n${header}\n${instruction}\n${lines.join('\n')}`;
}

function attachmentAnalysisText(
  attachment: AttachmentInfo,
  analysis: Record<string, unknown>,
  locale: AppLocale,
): string {
  const header = locale === 'zh'
    ? `[附件解析: ${attachment.originalName}]`
    : `[Attachment analysis: ${attachment.originalName}]`;
  return `${header}\n${JSON.stringify(compactAttachmentAnalysis(analysis), null, 2)}`;
}

function attachmentVisionSummaryText(
  attachment: AttachmentInfo,
  summary: string,
  locale: AppLocale,
): string {
  const header = locale === 'zh'
    ? `[附件视觉摘要: ${attachment.originalName}]`
    : `[Attachment vision summary: ${attachment.originalName}]`;
  return `${header}\n${summary}`;
}

function attachmentVisionUnavailableText(
  attachment: AttachmentInfo,
  locale: AppLocale,
): string {
  const header = locale === 'zh'
    ? `[附件视觉摘要不可用: ${attachment.originalName}]`
    : `[Attachment vision summary unavailable: ${attachment.originalName}]`;
  const body = locale === 'zh'
    ? '未配置独立 vision 模型或 vision 模型调用失败。不要假设图片中的尺寸、荷载或边界条件；如需继续分析，请向用户追问缺失信息。'
    : 'No independent vision model is configured or the vision call failed. Do not assume dimensions, loads, or boundary conditions from this image; ask the user for missing information before analysis.';
  return `${header}\n${body}`;
}

export function toInitialHumanMessage(content: string | HumanMessageContentBlock[]): HumanMessage {
  return Array.isArray(content)
    ? new HumanMessage({ content })
    : new HumanMessage(content);
}

function shouldKeepFullAttachmentAnalysis(
  attachment: AttachmentInfo,
  analysis: Record<string, unknown>,
): boolean {
  const name = `${attachment.originalName} ${attachment.relPath}`.toLowerCase();
  const type = typeof analysis.type === 'string' ? analysis.type : '';
  return type === 'excel' || (type === 'csv' || type === 'text')
    && (
      name.endsWith('.csv')
      || name.endsWith('.tsv')
      || name.endsWith('.at2')
      || name.endsWith('.txt')
    );
}

export async function buildInitialHumanMessagePayload(
  message: string,
  attachments: AttachmentInfo[] | undefined,
  locale: AppLocale,
  workspaceRoot: string,
  options: InitialHumanMessageOptions = {},
): Promise<InitialHumanMessagePayload> {
  const attachmentBlock = buildAttachmentBlock(attachments, locale);
  if (!attachments || attachments.length === 0) {
    return { content: message, canonicalMessage: message, attachmentAnalyses: [] };
  }

  const contentParts = [message + attachmentBlock];
  const canonicalParts = [message + attachmentBlock];
  const attachmentAnalyses: AttachmentAnalysis[] = [];

  for (const attachment of attachments) {
    const rawAnalysis = await analyzeUploadedFile(attachment.relPath, workspaceRoot, undefined, { includeImageData: true });
    const analysis = options.summarizeImages && ['image', 'pdf'].includes(String(rawAnalysis.type))
      ? await summarizeFileImages(rawAnalysis, attachment.relPath, locale, message, options.signal) : rawAnalysis;
    const runtimeAnalysis = shouldKeepFullAttachmentAnalysis(attachment, analysis)
      ? await analyzeUploadedFile(attachment.relPath, workspaceRoot, undefined, { mode: 'full' }) : analysis;
    runtimeAnalysis.inputEvidence = mergeInputEvidence(collectVisionEvidence(analysis), collectVisionEvidence(runtimeAnalysis));
    attachmentAnalyses.push({ attachment, analysis: runtimeAnalysis });
    const analysisText = attachmentAnalysisText(attachment, analysis, locale);
    canonicalParts.push(analysisText);
    contentParts.push(analysisText);
    const images = analysis.type === 'image' ? [analysis] : analysis.type === 'pdf' && Array.isArray(analysis.pages)
      ? analysis.pages.filter(isRecord).filter(page => page.requiresVision) : [];
    if (options.summarizeImages) for (const image of images) {
      const imageAttachment = { ...attachment, originalName: image.pageNumber
        ? `${attachment.originalName} · ${String(image.pageNumber)}` : attachment.originalName };
      const text = typeof image.visionSummary === 'string'
        ? attachmentVisionSummaryText(imageAttachment, image.visionSummary, locale)
        : attachmentVisionUnavailableText(imageAttachment, locale);
      canonicalParts.push(text);
      contentParts.push(text);
    }
  }

  return {
    content: contentParts.join('\n\n'),
    canonicalMessage: canonicalParts.join('\n\n'),
    attachmentAnalyses,
  };
}

export async function buildInitialHumanMessageContent(
  message: string,
  attachments: AttachmentInfo[] | undefined,
  locale: AppLocale,
  workspaceRoot: string,
): Promise<string | HumanMessageContentBlock[]> {
  return (await buildInitialHumanMessagePayload(message, attachments, locale, workspaceRoot)).content;
}
