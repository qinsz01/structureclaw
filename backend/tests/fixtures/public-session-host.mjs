// Test host: hold a real registered calculator call at its invocation boundary.
// No LLM, Python worker, commercial solver or application service is started.
import { createPublicToolSession } from '../../dist/agent-langgraph/public-tool-contracts.js';
import { AGENT_TOOL_DEFINITIONS } from '../../dist/agent-langgraph/tool-registry.js';

const [sessionId, mode] = process.argv.slice(2);
let hold = mode === 'hold';
let unblock;
const definition = AGENT_TOOL_DEFINITIONS.find(item => item.id === 'calculate');
const create = definition.create;
definition.create = deps => {
  const tool = create(deps);
  const invoke = tool.invoke.bind(tool);
  tool.invoke = async (...args) => {
    if (hold) {
      hold = false;
      const gate = new Promise(resolve => { unblock = resolve; });
      process.send({ type: 'entered' });
      await gate;
    }
    return invoke(...args);
  };
  return tool;
};

try {
  const session = await createPublicToolSession({ sessionId, resume: true });
  process.on('message', async message => {
    if (message === 'release') return unblock?.();
    if (message !== 'invoke') return;
    try {
      const result = await session.invoke('calculate', { expression: '6 * 7' });
      process.send({ type: 'result', toolCalls: result.usage.toolCalls, messages: result.messages });
    } catch (error) { process.send({ type: 'error', message: error.message }); }
  });
  process.send({ type: 'ready' });
} catch (error) { process.send({ type: 'error', message: error.message }); }
