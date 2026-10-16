import type { ManifestBackedSkillProvider, SkillProviderSource } from '../../skill-shared/provider.js';
import type { AgentSkillPlugin, SkillHandler, SkillManifest } from '../../shared/types/agent.js';

export interface StructureModelingProvider extends ManifestBackedSkillProvider<'structure-type', SkillManifest> {
  handler: SkillHandler;
  plugin: AgentSkillPlugin;
}

export function toStructureModelingProvider(
  plugin: AgentSkillPlugin,
  options?: {
    source?: SkillProviderSource;
    priority?: number;
  },
): StructureModelingProvider {
  return {
    id: plugin.id,
    domain: 'structure-type',
    source: options?.source ?? 'builtin',
    priority: options?.priority ?? plugin.manifest.priority,
    manifest: plugin.manifest,
    handler: plugin.handler,
    plugin,
  };
}
