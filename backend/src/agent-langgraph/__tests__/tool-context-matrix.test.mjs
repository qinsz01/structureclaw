// Pins per-node tool exposure, skill scope, budget and file allow-list (blueprint step 11).
// Goldens were produced by the pre-step-11 graph host (buildGraphRuntimeConfig seeding +
// applyToolsNodeSessionContext + resolveActiveToolIds) over a matrix of run policies, checkpointed
// access policies (including pre-policy checkpoints), host inputs and skill selections.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from '@jest/globals';
import { applyToolsNodeSessionContext } from '../../../dist/agent-langgraph/graph.js';
import { resolveActiveToolIds } from '../../../dist/agent-langgraph/tool-policy.js';
import { listAgentToolDefinitions } from '../../../dist/agent-langgraph/tool-registry.js';
import { resolveRunPolicy } from '../../../dist/runtime/run-policy.js';

const fixture = JSON.parse(readFileSync(new URL('../../../tests/fixtures/tool-context-matrix-20261017.json', import.meta.url), 'utf8'));
const definitions = listAgentToolDefinitions();
const toolIds = definitions.map(item => item.id);
const defaultToolIds = definitions.filter(item => item.defaultEnabled).map(item => item.id);
const policies = Object.fromEntries(Object.entries(fixture.policyInputs).map(([name, requested]) => [name,
  requested ? resolveRunPolicy({ availableSkillIds: fixture.skills, availableToolIds: toolIds, defaultToolIds, requested }) : undefined]));
const inputs = item => {
  const policy = policies[item.policy];
  const host = fixture.hosts[item.host];
  const state = { selectedSkillIds: [...fixture.selections[item.selection]], toolAccessPolicy: structuredClone(fixture.accesses[item.access]),
    ...(item.statePolicy ? { runPolicy: policy } : {}) };
  return { policy, host, state };
};
const nullable = value => value ?? null;

describe('tool context matrix', () => {
  test('covers every policy, access policy, host and selection', () => {
    expect(fixture.cases.length).toBe(405);
  });

  test.each(fixture.cases.map(item => [item.id, item]))('%s: compatibility wrappers keep their output', (_id, item) => {
    const { policy, host, state } = inputs(item);
    const configurable = { allowShell: host.allowShell, fileAccessAllowlist: host.fileAccessAllowlist,
      ...(policy ? { runContext: { policy }, maxToolCallsPerTurn: policy.budgets.maxToolCallsPerTurn,
        enabledToolIds: policy.activeToolIds, disabledToolIds: [], skillScope: policy.activeSkillIds }
        : { enabledToolIds: host.enabledToolIds, disabledToolIds: host.disabledToolIds, maxToolCallsPerTurn: host.maxToolCallsPerTurn }) };
    applyToolsNodeSessionContext(configurable, state);
    expect({
      activeToolIds: resolveActiveToolIds({ requestedEnabledToolIds: configurable.enabledToolIds,
        requestedDisabledToolIds: configurable.disabledToolIds, allowShell: configurable.allowShell }).activeToolIds,
      skillScope: nullable(configurable.skillScope),
      maxToolCallsPerTurn: nullable(configurable.maxToolCallsPerTurn),
      fileAccessAllowlist: nullable(configurable.fileAccessAllowlist),
    }).toEqual(item.expected);
  });
});
