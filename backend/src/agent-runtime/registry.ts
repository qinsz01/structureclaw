import type { AppLocale } from '../shared/locale.js';
import { listStructureModelingProviders } from '../agent-skills/structure-type/registry.js';
import { AgentSkillLoader } from './loader.js';
import { localize } from './plugin-helpers.js';
import type { AgentSkillBundle, AgentSkillPlugin, DraftState, InferredModelType, StructuralTypeKey } from '../shared/types/agent.js';

function providerMatchesScope(provider: { id: string; plugin: AgentSkillPlugin }, requested: Set<string>): boolean {
  const plugin = provider.plugin;
  return requested.has(provider.id)
    || requested.has(plugin.id);
}

export class AgentSkillRegistry {
  constructor(private readonly loader = new AgentSkillLoader()) {}

  /** Invalidate cached bundles and plugins so the next load re-scans disk. */
  invalidateCache(): void {
    this.loader.invalidateCache();
  }

  listSkills(): AgentSkillBundle[] {
    return this.loader.loadBundles();
  }

  async listPlugins(): Promise<AgentSkillPlugin[]> {
    return this.loader.loadPlugins();
  }

  async resolveEnabledPlugins(skillIds?: string[]): Promise<AgentSkillPlugin[]> {
    const providers = listStructureModelingProviders({
      builtInPlugins: await this.listPlugins(),
    });
    if (skillIds === undefined) {
      return providers.map((provider) => provider.plugin);
    }
    if (skillIds.length === 0) {
      return [];
    }
    const requested = new Set(skillIds);
    return providers
      .filter((provider) => providerMatchesScope(provider, requested))
      .map((provider) => provider.plugin);
  }

  async resolvePluginForState(state: DraftState | undefined, skillIds?: string[]): Promise<AgentSkillPlugin | null> {
    const skills = await this.resolveEnabledPlugins(skillIds);
    if (state?.skillId) {
      return skills.find((skill) => skill.id === state.skillId) || null;
    }
    if (state?.inferredType && state.inferredType !== 'unknown') {
      return skills.find((skill) => skill.structureType === state.inferredType) || null;
    }
    return null;
  }

  async resolvePluginForIdentifier(identifier: string | undefined, skillIds?: string[]): Promise<AgentSkillPlugin | null> {
    if (!identifier) {
      return null;
    }
    const skills = await this.resolveEnabledPlugins(skillIds);
    return skills.find((skill) => skill.id === identifier)
      || skills.find((skill) => skill.manifest.structuralTypeKeys.includes(identifier as StructuralTypeKey))
      || skills.find((skill) => skill.structureType === identifier)
      || null;
  }

  async getStructuralTypeLabel(key: string, locale: AppLocale, skillIds?: string[]): Promise<string> {
    if (key === 'steel-frame') {
      return localize(locale, '钢框架', 'Steel Frame');
    }
    const bundles = await this.resolveEnabledPlugins(skillIds);
    const matched = bundles.find((bundle) => bundle.id === key || bundle.structureType === key || bundle.manifest.structuralTypeKeys.includes(key as StructuralTypeKey));
    if (matched) {
      return locale === 'zh' ? matched.name.zh : matched.name.en;
    }
    switch (key as InferredModelType | StructuralTypeKey) {
      case 'portal':
        return localize(locale, '门架/刚架', 'Portal Structure');
      case 'girder':
        return localize(locale, '主梁/大梁', 'Girder');
      case 'space-frame':
        return localize(locale, '空间网架', 'Space Frame');
      case 'plate-slab':
        return localize(locale, '板/楼板', 'Plate or Slab');
      case 'shell':
        return localize(locale, '壳体', 'Shell');
      case 'tower':
        return localize(locale, '塔架', 'Tower');
      case 'bridge':
        return localize(locale, '桥梁', 'Bridge');
      default:
        return localize(locale, '未识别', 'Unclassified');
    }
  }
}
