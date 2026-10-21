import type { RunPolicyInput } from '../../../backend/src/runtime/run-policy'

/** Only editable fields cross the API boundary; effective hashes and audit fields never do. */
export function mergeRunPolicyInputs(...layers: Array<RunPolicyInput | null | undefined>): RunPolicyInput {
  let value: RunPolicyInput = {}
  for (const layer of layers) {
    if (!layer) continue
    const { knowledge, builder, skillIds, routing, repair, context, tools, providers, budgets, features, profile } = layer
    const patch = { knowledge, builder, skillIds, routing, repair, context, tools, providers, budgets, features, profile }
    const nested = Object.fromEntries((['repair', 'context', 'tools', 'providers', 'budgets', 'features'] as const)
      .filter(key => layer[key] !== undefined).map(key => [key, { ...value[key], ...layer[key] }]))
    value = { ...value, ...Object.fromEntries(Object.entries(patch).filter(([, item]) => item !== undefined)), ...nested }
  }
  return value
}
