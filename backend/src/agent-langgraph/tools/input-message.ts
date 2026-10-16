export function messageRole(message: unknown): string | null {
  if (!message || typeof message !== 'object') return null;
  const record = message as Record<string, unknown>;
  const getType = record._getType;
  if (typeof getType === 'function') {
    return String(getType.call(message));
  }
  if (typeof record.role === 'string') return record.role;
  if (typeof record.type === 'string') return record.type;
  if (Array.isArray(record.id) && record.id.some((part) => String(part).includes('HumanMessage'))) {
    return 'human';
  }
  return null;
}

export function messageText(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const content = (message as { content?: unknown }).content;
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
      .join('');
  }
  return content == null ? '' : String(content);
}

function latestHumanMessageText(messages: unknown[] | undefined): string {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const role = messageRole(messages[i]);
    if (role === 'human' || role === 'user') {
      return messageText(messages[i]).trim();
    }
  }
  return '';
}

const ATTACHMENT_DETAIL_MARKERS = [
  '[Attachment analysis:',
  '[附件解析:',
  '[Attachment vision summary:',
  '[附件视觉摘要:',
  '[Attachment vision summary unavailable:',
  '[附件视觉摘要不可用:',
];

function findAttachmentDetailsStart(message: string): number {
  return ATTACHMENT_DETAIL_MARKERS.reduce((best, marker) => {
    const index = message.indexOf(marker);
    if (index === -1) return best;
    return best === -1 ? index : Math.min(best, index);
  }, -1);
}

function hasAttachmentDetails(message: string | undefined): boolean {
  const text = message || '';
  return findAttachmentDetailsStart(text) !== -1;
}

function canonicalAttachmentDetailsOnly(message: string): string {
  const start = findAttachmentDetailsStart(message);
  return start === -1 ? '' : message.slice(start).trim();
}

function withCanonicalAttachmentDetails(message: string, canonicalUserMessage: string | undefined): string {
  const canonical = canonicalUserMessage?.trim();
  if (!canonical || !hasAttachmentDetails(canonical) || hasAttachmentDetails(message)) {
    return message;
  }
  const attachmentDetails = canonicalAttachmentDetailsOnly(canonical);
  return attachmentDetails ? `${message}\n\n${attachmentDetails}` : message;
}

export function resolveToolInputMessage(
  inputMessage: string | undefined,
  lastUserMessage: string | undefined,
  messages?: unknown[],
): string {
  const explicitMessage = inputMessage?.trim();
  if (explicitMessage) {
    return withCanonicalAttachmentDetails(explicitMessage, lastUserMessage);
  }
  const canonicalUserMessage = lastUserMessage?.trim();
  if (canonicalUserMessage) {
    return canonicalUserMessage;
  }
  const latestHumanMessage = latestHumanMessageText(messages);
  if (latestHumanMessage) {
    return latestHumanMessage;
  }
  return '';
}

/** Extraction consumes user evidence, never an agent-authored restatement with invented values. */
export function resolveExtractionInputMessage(
  inputMessage: string | undefined,
  lastUserMessage: string | undefined,
  messages?: unknown[],
): string {
  for (const message of [...(messages ?? [])].reverse()) {
    const role = messageRole(message);
    if (role === 'human' || role === 'user') {
      return withCanonicalAttachmentDetails(messageText(message).trim(), lastUserMessage);
    }
    if (role === 'tool' && (message as { name?: string }).name === 'ask_user_clarification') {
      try {
        const reply = JSON.parse(messageText(message));
        if (reply.type === 'clarification_answered' && typeof reply.answer === 'string' && reply.answer.trim()) {
          const answer = reply.answer.trim();
          const question = typeof reply.question === 'string' ? reply.question.trim() : '';
          const contextualAnswer = question ? [
            '[Clarification context / 澄清上下文]',
            JSON.stringify({ question, ...(Array.isArray(reply.options) ? { options: reply.options } : {}), answer }),
            'The question/options are unconfirmed context, not user-supplied facts. Extract only values explicitly provided or unambiguously accepted by the actual answer; rejected or unselected alternatives remain unconfirmed. A bare yes to multiple alternatives does not select one. / 问题和选项仅是未确认上下文，不是用户事实；只提取真实回答明确给出或无歧义接受的值，不采纳拒绝或未选的备选；多选一问题仅回答“可以”仍需澄清。',
          ].join('\n') : answer;
          return withCanonicalAttachmentDetails(contextualAnswer, lastUserMessage);
        }
      } catch { /* Older tool messages may contain plain text. */ }
    }
  }
  return lastUserMessage?.trim() || inputMessage?.trim() || '';
}
