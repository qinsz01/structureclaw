/**
 * Read-only inspection of LangChain messages (including checkpoint-deserialized
 * plain objects) shared by the graph nodes and the final-answer delivery policy.
 */
import type { BaseMessage } from '@langchain/core/messages';

export function getMessageType(message: BaseMessage): string | null {
  return typeof (message as any)._getType === 'function'
    ? (message as any)._getType()
    : null;
}

export function extractMessageText(message: BaseMessage): string {
  const content = message.content;
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === 'string') return block;
        if (block && typeof block === 'object' && 'text' in block) {
          return String((block as { text?: unknown }).text ?? '');
        }
        return '';
      })
      .join('');
  }
  return content == null ? '' : JSON.stringify(content);
}

export function getToolName(message: BaseMessage): string | undefined {
  return typeof (message as any).name === 'string' && (message as any).name.trim().length > 0
    ? (message as any).name
    : undefined;
}
