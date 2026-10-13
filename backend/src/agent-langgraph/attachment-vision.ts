import { HumanMessage } from '@langchain/core/messages';
import { createVisionChatModel } from '../utils/llm.js';
import { logger } from '../utils/logger.js';
import type { AppLocale } from '../services/locale.js';
import type { AttachmentInfo } from './agent-service.js';
import { readFile } from 'node:fs/promises';

export async function summarizeFileImages(analysis: Record<string, unknown>, filePath: string, locale: AppLocale, message: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const result = structuredClone(analysis);
  const summarize = async (image: Record<string, unknown>, originalName: string, dataUri?: string) => {
    const summary = dataUri ? await summarizeImageAttachment({ fileId: filePath, originalName, relPath: filePath }, dataUri, message, locale, signal) : null;
    image.visionSummary = summary;
    image.visionStatus = summary ? 'completed' : 'unavailable';
    if (!summary) image.visionWarning = locale === 'zh' ? '视觉识别不可用，请补充本页必要信息。' : 'Vision is unavailable; required page information must be supplied.';
  };
  if (result.type === 'image') {
    await summarize(result, filePath, typeof result.base64DataUri === 'string' ? result.base64DataUri : undefined);
    delete result.base64DataUri;
  }
  if (result.type === 'pdf' && Array.isArray(result.pages)) {
    for (const page of result.pages as Record<string, unknown>[]) {
      if (!page.requiresVision || typeof page.renderedImagePath !== 'string') continue;
      const bytes = await readFile(page.renderedImagePath);
      await summarize(page, `${filePath} · ${String(page.pageNumber)}`, bytes.length <= 4 * 1024 * 1024 ? `data:image/png;base64,${bytes.toString('base64')}` : undefined);
    }
  }
  return result;
}

function messageContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object' && 'text' in item) {
          return String((item as { text?: unknown }).text ?? '');
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return content == null ? '' : String(content);
}

export async function summarizeImageAttachment(
  attachment: AttachmentInfo,
  dataUri: string,
  userMessage: string,
  locale: AppLocale,
  signal?: AbortSignal,
): Promise<string | null> {
  const model = createVisionChatModel(0, { disableStreaming: true });
  if (!model) return null;

  const prompt = locale === 'zh'
    ? [
      '你是结构工程图像理解助手。只根据图片中可见的文字、标注和几何关系提取信息，不要臆测不可见内容。',
      '请用简洁中文输出：结构类型、可见几何尺寸、可见荷载、支座/边界、材料/截面文字、仍不确定的信息。',
      `附件名：${attachment.originalName}`,
      `用户任务：${userMessage}`,
    ].join('\n')
    : [
      'You are a structural engineering image understanding assistant. Extract only information visible in the image text, labels, and geometry; do not invent hidden details.',
      'Return a concise summary covering: structural type, visible dimensions, visible loads, supports/boundaries, material/section labels, and remaining uncertainties.',
      `Attachment name: ${attachment.originalName}`,
      `User task: ${userMessage}`,
    ].join('\n');

  try {
    const result = await model.invoke([
      new HumanMessage({
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: dataUri } },
        ],
      }),
    ], signal ? { signal } : undefined);
    const text = messageContentText(result.content).trim();
    return text || null;
  } catch (error) {
    logger.warn({
      attachment: attachment.originalName,
      error: error instanceof Error ? error.message : String(error),
    }, 'attachment vision summary failed');
    return null;
  }
}
