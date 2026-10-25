import { isRecord } from '../../engineering/model-record.js';
import type { SectionEvidenceContext } from '../../engineering/section-evidence.js';

export function messageRole(message: unknown): string | null {
  if (!message || typeof message !== 'object') return null;
  const record = message as Record<string, unknown>;
  const getType = record._getType;
  if (typeof getType === 'function') {
    return String(getType.call(message));
  }
  if (typeof record.role === 'string') return record.role;
  if (Array.isArray(record.id) && record.id.some((part) => String(part).includes('HumanMessage'))) {
    return 'human';
  }
  if (Array.isArray(record.id) && record.id.some((part) => String(part).includes('ToolMessage'))) {
    return 'tool';
  }
  if (typeof record.type === 'string') return record.type;
  return null;
}

export function messageText(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const record = message as { content?: unknown; kwargs?: { content?: unknown } };
  const content = record.content ?? record.kwargs?.content;
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

/** A completed extraction consumes this actual answer, irrespective of an agent's restatement. */
export function hasExtractedCurrentInput(messages: unknown[] = []): boolean {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    const role = messageRole(message);
    if (role === 'human' || role === 'user') return false;
    if (role !== 'tool') continue;
    const tool = message as { name?: string; kwargs?: { name?: string } };
    const name = tool.name ?? tool.kwargs?.name;
    // Newly read evidence or a changed routing decision may justify another extraction.
    if (name === 'read_file' || name === 'analyze_file' || name === 'detect_structure_type') return false;
    try {
      const result = JSON.parse(messageText(message));
      if (name === 'ask_user_clarification' && result.type === 'clarification_answered') return false;
      // A builder protocol diagnostic is new structured feedback, not duplicate evidence.
      if (name === 'build_model' && result.modelBuilt === false && result.errorCode === 'DRAFT_PROTOCOL_INVALID'
        && result.nextAction === 'extract_draft_params') return false;
      if (name === 'extract_draft_params') {
        return ['applied', 'no_change'].includes(result.status)
          && Array.isArray(result.unapplied) && result.unapplied.length === 0;
      }
    } catch { /* Historical or failed results do not establish a completed extraction. */ }
  }
  return false;
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

/** Actual conversation input only. Clarification tool messages store the verbatim resume answer. */
export function conversationUserTexts(state?: { messages?: unknown[]; lastUserMessage?: string }): string[] {
  const texts = [state?.lastUserMessage ?? ''];
  for (const message of state?.messages ?? []) {
    const role = messageRole(message);
    if (role === 'human' || role === 'user') texts.push(messageText(message));
    else if (role === 'tool') {
      const tool = message as { name?: string; kwargs?: { name?: string } };
      if ((tool.name ?? tool.kwargs?.name) !== 'ask_user_clarification') continue;
      try {
        const reply = JSON.parse(messageText(message));
        if (reply.type === 'clarification_answered' && typeof reply.answer === 'string') texts.push(reply.answer);
      } catch { /* Historical non-JSON tool results are not evidence. */ }
    }
  }
  return [...new Set(texts.map(text => {
    const attachmentStart = findAttachmentDetailsStart(text);
    return (attachmentStart === -1 ? text : text.slice(0, attachmentStart)).trim();
  }).filter(Boolean))];
}

function withCanonicalAttachmentDetails(message: string, canonicalUserMessage: string | undefined): string {
  const canonical = canonicalUserMessage?.trim();
  if (!canonical || !hasAttachmentDetails(canonical) || hasAttachmentDetails(message)) {
    return message;
  }
  const attachmentDetails = canonicalAttachmentDetailsOnly(canonical);
  return attachmentDetails ? `${message}\n\n${attachmentDetails}` : message;
}

export function conversationSectionEvidence(state?: { messages?: unknown[]; lastUserMessage?: string; inputEvidence?: Record<string, unknown>[] }): SectionEvidenceContext {
  const confirmations: Record<string, unknown>[] = [];
  let pending: Record<string, unknown> | undefined;
  for (const message of state?.messages ?? []) {
    const role = messageRole(message);
    if (role === 'human' || role === 'user') {
      if (pending) {
        const answer = messageText(message);
        const options = Array.isArray(pending.options) ? pending.options : [];
        confirmations.push({ ...pending, type: 'clarification_answered', answer,
          ...(options.includes(answer) ? { selectedOptionId: `option-${options.indexOf(answer) + 1}` } : {}) });
        pending = undefined;
      }
      continue;
    }
    if (role !== 'tool' || !isRecord(message) || (message.name ?? (isRecord(message.kwargs) ? message.kwargs.name : undefined)) !== 'ask_user_clarification') continue;
    try {
      const receipt = JSON.parse(messageText(message));
      pending = receipt.type === 'clarification_needed' ? receipt : undefined;
      if (receipt.type === 'clarification_answered') confirmations.push(receipt);
    } catch { pending = undefined; }
  }
  return { userTexts: conversationUserTexts(state), inputEvidence: state?.inputEvidence, confirmations };
}

/** The canonical draft carries tool results; model generation needs actual user evidence and answered proposal context. */
export function modellingConversationHistory(messages: unknown[] = []): string {
  const evidence: string[] = [];
  for (const message of messages) {
    const role = messageRole(message);
    if (role === 'human' || role === 'user') { evidence.push(`user: ${messageText(message)}`); continue; }
    const tool = message as { name?: string; kwargs?: { name?: string } };
    if (role !== 'tool' || (tool.name ?? tool.kwargs?.name) !== 'ask_user_clarification') continue;
    try {
      const reply = JSON.parse(messageText(message));
      if (reply.type === 'clarification_answered' && typeof reply.answer === 'string') evidence.push(JSON.stringify({
        question: reply.question, options: reply.options, answer: reply.answer, selectedOptionId: reply.selectedOptionId,
        clarificationId: reply.clarificationId, sectionCandidates: reply.sectionCandidates,
      }));
    } catch { /* Unanswered or malformed proposals cannot become accepted facts. */ }
  }
  return evidence.length ? 'User evidence / 用户依据: Questions/options are context; only actual answers or selected alternatives confirm values. Historical assistant plans and failed candidates are not requirements. / 问题和选项仅为上下文，只有实际回答或选中方案才确认数值；历史助手计划和失败候选不是要求。\n' + evidence.join('\n') : '';
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
export function resolveStructuralRoutingInputMessage(
  inputMessage: string | undefined,
  lastUserMessage: string | undefined,
  messages?: unknown[],
): string {
  for (let index = (messages?.length ?? 0) - 1; index >= 0; index--) {
    const message = messages![index];
    const role = messageRole(message);
    if (role === 'human' || role === 'user') {
      return withCanonicalAttachmentDetails(messageText(message).trim(), lastUserMessage);
    }
    const record = message as { name?: string; kwargs?: { name?: string } };
    if (role !== 'tool' || (record.name ?? record.kwargs?.name) !== 'ask_user_clarification') continue;
    try {
      const reply = JSON.parse(messageText(message));
      if (reply.type !== 'clarification_answered' || typeof reply.answer !== 'string' || !reply.answer.trim()) continue;
      const answer = reply.answer.trim();
      // Only a recorded selection may introduce an option's text. The question and
      // all other alternatives are extraction context, never a new routing request.
      const optionId = typeof reply.selectedOptionId === 'string' ? /^option-([1-9]\d*)$/.exec(reply.selectedOptionId) : null;
      const selected = optionId && Array.isArray(reply.options) ? reply.options[Number(optionId[1]) - 1] : undefined;
      const evidence = typeof selected === 'string' && selected.trim() && selected.trim() !== answer
        ? JSON.stringify({ answer, selectedOption: selected.trim() }) : answer;
      return withCanonicalAttachmentDetails(evidence, lastUserMessage);
    } catch { /* Historical plain-text messages do not contain a confirmed answer. */ }
  }
  return lastUserMessage?.trim() || inputMessage?.trim() || '';
}

/** Full clarification context is for LLM extraction only; routing uses actual answers above. */
export function resolveExtractionInputMessage(
  inputMessage: string | undefined,
  lastUserMessage: string | undefined,
  messages?: unknown[],
): string {
  for (let index = (messages?.length ?? 0) - 1; index >= 0; index--) {
    const message = messages![index];
    const role = messageRole(message);
    if (role === 'human' || role === 'user') {
      return withCanonicalAttachmentDetails(messageText(message).trim(), lastUserMessage);
    }
    const toolMessage = message as { name?: string; kwargs?: { name?: string } };
    if (role === 'tool' && (toolMessage.name ?? toolMessage.kwargs?.name) === 'ask_user_clarification') {
      try {
        const reply = JSON.parse(messageText(message));
        if (reply.type === 'clarification_answered' && typeof reply.answer === 'string' && reply.answer.trim()) {
          const answer = reply.answer.trim();
          const question = typeof reply.question === 'string' ? reply.question.trim() : '';
          // The answered question may refer to a plan in the issuing assistant message.
          // Keep that plan as unconfirmed context; only the actual answer can accept it.
          let assistantProposalContext: string | undefined;
          for (let previous = index - 1; previous >= 0; previous--) {
            const prior = messages![previous];
            if (['human', 'user'].includes(messageRole(prior) ?? '')) break;
            if (!['ai', 'assistant'].includes(messageRole(prior) ?? '') || !isRecord(prior)) continue;
            const calls = prior.tool_calls ?? (isRecord(prior.kwargs) ? prior.kwargs.tool_calls : undefined);
            if (Array.isArray(calls) && calls.some(call => isRecord(call) && call.name === 'ask_user_clarification')) {
              assistantProposalContext = messageText(prior).trim() || undefined;
              break;
            }
          }
          const contextualAnswer = question ? [
            '[Clarification context / 澄清上下文]',
            JSON.stringify({ question, ...(Array.isArray(reply.options) ? { options: reply.options } : {}), answer,
              ...(assistantProposalContext ? { assistantProposalContext } : {}),
              clarificationId: reply.clarificationId, sectionCandidates: reply.sectionCandidates, selectedOptionId: reply.selectedOptionId }),
            'The question/options are unconfirmed context, not user-supplied facts. Extract only values explicitly provided or unambiguously accepted by the actual answer; rejected or unselected alternatives remain unconfirmed. A bare yes to multiple alternatives does not select one. / 问题和选项仅是未确认上下文，不是用户事实；只提取真实回答明确给出或无歧义接受的值，不采纳拒绝或未选的备选；多选一问题仅回答“可以”仍需澄清。',
          ].join('\n') : answer;
          // Resume chains can contain an earlier answer whose extraction failed. Keep that actual
          // evidence available; an agent-authored restatement still cannot introduce new facts.
          const earlierAnswers: unknown[] = [];
          let originalUserMessage = '';
          let originalAlreadyExtracted = false;
          for (let previous = index - 1; previous >= 0; previous--) {
            const item = messages![previous];
            if (['human', 'user'].includes(messageRole(item) ?? '')) {
              originalUserMessage = messageText(item).trim();
              break;
            }
            const prior = item as { name?: string; kwargs?: { name?: string } };
            if (messageRole(item) !== 'tool') continue;
            const priorName = prior.name ?? prior.kwargs?.name;
            if (priorName === 'extract_draft_params') {
              try {
                const extracted = JSON.parse(messageText(item));
                if (['applied', 'no_change'].includes(extracted.status) && Array.isArray(extracted.unapplied)
                  && extracted.unapplied.length === 0) originalAlreadyExtracted = true;
              } catch { /* Failed extraction is not persisted input evidence. */ }
            }
            if (priorName !== 'ask_user_clarification') continue;
            try {
              const earlier = JSON.parse(messageText(item));
              if (earlier.type === 'clarification_answered' && typeof earlier.answer === 'string' && earlier.answer.trim()) {
                earlierAnswers.unshift({ question: earlier.question, options: earlier.options, answer: earlier.answer,
                  clarificationId: earlier.clarificationId, selectedOptionId: earlier.selectedOptionId });
              }
            } catch { /* Plain-text historical replies have no structured evidence contract. */ }
          }
          const evidence = earlierAnswers.length ? '\nEarlier actual answers, oldest first; retain missing facts unless superseded by the latest answer. Questions/options remain unconfirmed context. / 较早的真实回答，按时间排列；补回遗漏且未被最新回答替代的事实，问题和选项仍是未确认上下文：\n'
            + JSON.stringify(earlierAnswers) : '';
          const original = originalUserMessage && !originalAlreadyExtracted ? '\nOriginal user input before this clarification chain / 本次澄清链之前的原始用户输入：\n'
            + JSON.stringify({ message: originalUserMessage })
            + '\nExtract supplied facts missing from draftState as well as the answer. The latest actual answer supersedes conflicting earlier input; unselected alternatives remain unconfirmed. / 同时提取原始用户已给但草稿遗漏的事实及本次回答；最新实际回答覆盖较早的冲突输入，未选候选仍未确认。' : '';
          return withCanonicalAttachmentDetails(contextualAnswer + evidence + original, lastUserMessage);
        }
      } catch { /* Older tool messages may contain plain text. */ }
    }
  }
  return lastUserMessage?.trim() || inputMessage?.trim() || '';
}
