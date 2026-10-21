import { readSettingsFile } from '../config/settings-file.js';
import { currentRunPolicy } from '../runtime/run-context.js';
import type { RunPolicy } from '../runtime/run-policy.js';

/** Explicit global disables are permissions; conversation preferences cannot undo them. */
export function providerAccessError(id: string, policy?: RunPolicy | null): Record<string, unknown> | undefined {
  const disabledIds = [...(readSettingsFile()?.agent?.runPolicy?.providers?.disabledIds ?? []),
    ...((policy ?? currentRunPolicy())?.providers?.disabledIds ?? [])];
  if (!disabledIds.includes(id)) return undefined;
  return { success: false, error_code: 'ENGINE_UNAVAILABLE', providerId: id, reason: 'provider_disabled',
    message: `Provider '${id}' is disabled in settings.`, messageZh: `Provider“${id}”已在设置中禁用。` };
}
