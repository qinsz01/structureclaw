/**
 * Backend layering rules (see docs/refactor/clean-core-blueprint.md, "Target layering").
 *
 *   L0 shared       src/shared/, src/types/
 *   L1 kernel       src/runtime/, src/config/, src/utils/, src/generated/
 *   L2 domain       src/engineering/, src/skill-shared/, src/agent-skills/, src/providers/
 *   L3 agent-core   src/agent-runtime/
 *   L4 services     src/services/
 *   L5 agent-host   src/agent-langgraph/
 *   L6 delivery     src/api/, src/index.ts
 *
 * Lower layers never import higher ones; no file-level cycles.
 * Type-only imports are ignored (tsPreCompilationDeps: false) because they vanish at runtime.
 */
const SEVERITY = 'error';

const L0 = '^src/(shared|types)/';
const L1 = '^src/(runtime|config|utils|generated)/';
const L2 = '^src/(engineering|skill-shared|agent-skills|providers)/';
const L3 = '^src/agent-runtime/';
const L4 = '^src/services/';
const L5 = '^src/agent-langgraph/';

const ABOVE_L0 = '^src/(runtime|config|utils|generated|engineering|skill-shared|agent-skills|providers|agent-runtime|services|agent-langgraph|api)/|^src/index\\.ts$';
const ABOVE_L1 = '^src/(engineering|skill-shared|agent-skills|providers|agent-runtime|services|agent-langgraph|api)/|^src/index\\.ts$';
const ABOVE_L2 = '^src/(agent-runtime|services|agent-langgraph|api)/|^src/index\\.ts$';
const ABOVE_L3 = '^src/(services|agent-langgraph|api)/|^src/index\\.ts$';
const ABOVE_L4 = '^src/(agent-langgraph|api)/|^src/index\\.ts$';
const ABOVE_L5 = '^src/api/|^src/index\\.ts$';

// Allowed exceptions. Each entry is a deliberate, documented edge that would otherwise violate the layering.
//
// 1. runtime/policy-settings.ts: re-export shim kept because integrations/openclaw/worker.mjs imports
//    dist/runtime/policy-settings.js; the implementation lives in agent-langgraph/policy-resolver.ts.
const COMPAT_SHIMS = '^src/runtime/policy-settings\\.ts$';
//
// 2. Structure-type skill handlers are plugins of agent-runtime and consume its
//    skill-handler/draft SDK (legacy draft normalisation, fallback, engineering-draft, draft guidance,
//    routing and report helpers, and the agent-runtime/draft/ boundary). Moving that SDK out of
//    agent-runtime would pull the whole draft core into the domain layer, so exactly these edges are
//    allowed. No other L2 module may import L3, and the handlers may not import any other
//    agent-runtime module.
const SKILL_HANDLER_PLUGINS = '^src/agent-skills/structure-type/';
const SKILL_HANDLER_SDK = '^src/agent-runtime/(legacy|fallback|engineering-draft|draft/boundary|draft/normalize|draft/project-patch|draft-guidance|explicit-model|template-properties|generic-readiness|plugin-helpers|structural-routing|report-template|reference-vectors|domains/structural-domains)\\.ts$';

function layerRule(name, from, to, comment, { fromNot = COMPAT_SHIMS, toNot } = {}) {
  return {
    name,
    comment,
    severity: SEVERITY,
    from: { path: from, pathNot: fromNot },
    to: toNot ? { path: to, pathNot: toNot } : { path: to },
  };
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
    layerRule('L2-domain-no-upward', L2, ABOVE_L2,
      'engineering/skill-shared/agent-skills must not import agent-runtime, services, agent-langgraph or api.',
      { fromNot: `${COMPAT_SHIMS}|${SKILL_HANDLER_PLUGINS}` }),
    layerRule('L2-skill-handler-no-upward', SKILL_HANDLER_PLUGINS, ABOVE_L2,
      'structure-type/section skill handlers may only use the agent-runtime skill-handler SDK (SKILL_HANDLER_SDK).',
      { toNot: SKILL_HANDLER_SDK }),
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
