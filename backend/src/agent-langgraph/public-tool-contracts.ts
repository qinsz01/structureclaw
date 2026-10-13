import { z } from 'zod';
import { AgentSkillRuntime } from '../agent-runtime/index.js';
import { createRegisteredTools, listAgentToolDefinitions, type AgentToolFactoryDeps } from './tool-registry.js';
import { AgentStateAnnotation } from './state.js';

/** Apply the application reducers to external tool updates, without duplicating state rules. */
export function applyPublicToolStateUpdate(
  state: Record<string, unknown>, update: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...state };
  const channels = AgentStateAnnotation.spec as unknown as Record<string, {
    operator?: (previous: unknown, value: unknown) => unknown;
    initialValueFactory?: () => unknown;
  }>;
  for (const [key, value] of Object.entries(update)) {
    // External runners keep serializable message records; they append those themselves.
    if (key === 'messages') continue;
    const channel = channels[key];
    next[key] = channel?.operator
      ? channel.operator(next[key] ?? channel.initialValueFactory?.(), value)
      : value;
  }
  return next;
}

/** External adapters consume the same input schemas as the registered application tools. */
export function getPublicToolDefinitions(deps?: AgentToolFactoryDeps) {
  const definitions = new Map(listAgentToolDefinitions().map((definition) => [definition.id, definition]));
  return createRegisteredTools(deps ?? { skillRuntime: new AgentSkillRuntime() }).map((tool) => {
    const definition = definitions.get(tool.name);
    return {
      name: tool.name,
      description: tool.description,
      category: definition?.category,
      label: definition?.displayName.en ?? tool.name,
      parameters: z.toJSONSchema(tool.schema as z.ZodType, { io: 'input' }),
    };
  });
}
