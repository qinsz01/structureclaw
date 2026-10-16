// Compatibility shim: the resolver lives in the agent-host layer
// (agent-langgraph/policy-resolver.ts). integrations/openclaw/worker.mjs imports
// dist/runtime/policy-settings.js, so this path must stay importable.
export { resolveApplicationRunPolicy } from '../agent-langgraph/policy-resolver.js';
