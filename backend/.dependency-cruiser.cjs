/**
 * Backend layering rules (see docs/refactor/clean-core-blueprint.md, "Target layering").
 *
 *   L0 shared       src/shared/, src/types/
 *   L1 kernel       src/runtime/, src/config/, src/utils/, src/generated/
 *   L2 domain       src/engineering/, src/skill-shared/, src/agent-skills/
 *   L3 agent-core   src/agent-runtime/
 *   L4 services     src/services/
 *   L5 agent-host   src/agent-langgraph/
 *   L6 delivery     src/api/, src/index.ts
 *
 * Lower layers never import higher ones; no file-level cycles.
 * Type-only imports are ignored (tsPreCompilationDeps: false) because they vanish at runtime.
 */
const SEVERITY = 'warn';

const L0 = '^src/(shared|types)/';
const L1 = '^src/(runtime|config|utils|generated)/';
const L2 = '^src/(engineering|skill-shared|agent-skills)/';
const L3 = '^src/agent-runtime/';
const L4 = '^src/services/';
const L5 = '^src/agent-langgraph/';

const ABOVE_L0 = '^src/(runtime|config|utils|generated|engineering|skill-shared|agent-skills|agent-runtime|services|agent-langgraph|api)/|^src/index\\.ts$';
const ABOVE_L1 = '^src/(engineering|skill-shared|agent-skills|agent-runtime|services|agent-langgraph|api)/|^src/index\\.ts$';
const ABOVE_L2 = '^src/(agent-runtime|services|agent-langgraph|api)/|^src/index\\.ts$';
const ABOVE_L3 = '^src/(services|agent-langgraph|api)/|^src/index\\.ts$';
const ABOVE_L4 = '^src/(agent-langgraph|api)/|^src/index\\.ts$';
const ABOVE_L5 = '^src/api/|^src/index\\.ts$';

// Allowed exceptions. Each entry is a deliberate, documented edge that would otherwise violate the layering.
// - runtime/policy-settings.ts: re-export shim kept because integrations/openclaw/worker.mjs imports
//   dist/runtime/policy-settings.js; the implementation lives in agent-langgraph/policy-resolver.ts.
const COMPAT_SHIMS = '^src/runtime/policy-settings\\.ts$';

function layerRule(name, from, to, comment) {
  return { name, comment, severity: SEVERITY, from: { path: from, pathNot: COMPAT_SHIMS }, to: { path: to } };
}

module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      comment: 'File-level import cycles are not allowed.',
      severity: SEVERITY,
      from: {},
      to: { circular: true },
    },
    layerRule('L0-shared-no-upward', L0, ABOVE_L0, 'shared/ and types/ must not import any other backend layer.'),
    layerRule('L1-kernel-no-upward', L1, ABOVE_L1, 'runtime/config/utils must not import domain, agent, services or delivery code.'),
    layerRule('L2-domain-no-upward', L2, ABOVE_L2, 'engineering/skill-shared/agent-skills must not import agent-runtime, services, agent-langgraph or api.'),
    layerRule('L3-agent-core-no-upward', L3, ABOVE_L3, 'agent-runtime must not import services, agent-langgraph or api.'),
    layerRule('L4-services-no-upward', L4, ABOVE_L4, 'services must not import agent-langgraph or api.'),
    layerRule('L5-agent-host-no-upward', L5, ABOVE_L5, 'agent-langgraph must not import api or the server entry point.'),
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)__tests__/|\\.test\\.(m?js|ts)$' },
    includeOnly: '^src/',
    tsPreCompilationDeps: false,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
      extensions: ['.ts', '.js', '.mjs', '.cjs', '.json'],
    },
  },
};
