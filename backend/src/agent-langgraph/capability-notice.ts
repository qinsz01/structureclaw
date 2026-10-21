import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import { extractMessageText, getMessageType } from './message-inspect.js';

/** A failed draft contract ends the turn before the agent can repeat the question or escape validation. */
export function fieldContractFailure(messages: BaseMessage[]): string | undefined {
  for (const message of [...messages].reverse()) {
    if (['human', 'user'].includes(getMessageType(message) ?? '')) break;
    if (getMessageType(message) !== 'tool' || message.name !== 'extract_draft_params') continue;
    try {
      const payload = JSON.parse(extractMessageText(message));
      if (payload.errorCode === 'FIELD_CONTRACT_UNRESOLVED' && typeof payload.message === 'string') return payload.message;
    } catch { /* Non-JSON results cannot establish a contract failure. */ }
  }
  return undefined;
}

/** A scope restriction is product information, not optional prose for the LLM to remember. */
export function capabilityNotice(messages: BaseMessage[]): string | undefined {
  for (const message of [...messages].reverse()) {
    if (['human', 'user'].includes(getMessageType(message) ?? '')) break;
    if (getMessageType(message) !== 'tool') continue;
    try {
      const payload = JSON.parse(extractMessageText(message));
      const route = payload.scopeExclusion ? payload : payload.structuralTypeMatch;
      if (route?.scopeExclusion?.code === 'STRUCTURE_SKILL_DISABLED' && typeof route.supportNote === 'string') return route.supportNote;
    } catch { /* Only structured routing results establish a scope notice. */ }
  }
  return undefined;
}

/** Append after numerical answer review; a scope notice must never bypass integrity checks. */
export function withCapabilityNotice(message: BaseMessage, messages: BaseMessage[]): BaseMessage {
  if ('tool_calls' in message && Array.isArray(message.tool_calls) && message.tool_calls.length) return message;
  const notice = capabilityNotice(messages);
  const text = extractMessageText(message);
  if (!notice || text.includes(notice)) return message;
  return new AIMessage({ content: `${notice}\n\n${text}`, id: message.id,
    response_metadata: message.response_metadata, usage_metadata: (message as AIMessage).usage_metadata });
}
