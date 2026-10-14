import type { ToolMessage } from '@langchain/core/messages';

/** The run ledger and presentation must interpret tool failures identically. */
export function toolMessageFailure(message: Pick<ToolMessage, 'content' | 'status'>): string | undefined {
  const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
  let failure = message.status === 'error' ? content : undefined;
  try {
    const payload = JSON.parse(content);
    if (payload && (payload.success === false || payload.valid === false || payload.error || payload.status === 'failed')) {
      failure = [payload.errorCode, payload.error_code, payload.error, payload.message].filter(Boolean).map(String).join(': ') || 'operation failed';
    }
  } catch { /* Plain successful tool text is valid. */ }
  return failure;
}
