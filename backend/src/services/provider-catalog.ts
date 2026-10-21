import { listProviders } from '../providers/catalog.js';
import { providerAccessError } from '../providers/access.js';
import { getEffectiveVisionLlmSettings } from '../config/llm-runtime.js';
import { AnalysisEngineCatalogService } from './analysis-engine.js';

export class ProviderCatalogService {
  constructor(private readonly engines = new AnalysisEngineCatalogService()) {}

  /** Environment readiness is evidence of installation, never evidence of a commercial licence. */
  async listProviders() {
    let engines: Array<Record<string, unknown>> = [];
    let probeError: string | undefined;
    try { engines = (await this.engines.listEngines()).engines as unknown as Array<Record<string, unknown>>; }
    catch (error) { probeError = error instanceof Error ? error.message : String(error); }
    return listProviders().map(provider => {
      const engine = engines.find(item => item.id === provider.engineId);
      const usesEngine = provider.kind === 'solver' || provider.id === 'pkpm-calcbook';
      const configured = provider.id === 'image-vision-input'
        ? Boolean(getEffectiveVisionLlmSettings()?.llmApiKey)
        : usesEngine ? engine?.available === true : true;
      const installed = usesEngine ? engine?.available === true : true;
      const enabled = !providerAccessError(provider.id) && engine?.enabled !== false;
      return { ...provider, enabled, availability: {
        installed, configured, available: installed && configured && enabled,
        licence: provider.software === 'pkpm' || provider.software === 'yjk' ? 'unknown' : 'not-required',
        checkedAt: new Date().toISOString(),
        reason: !enabled ? 'provider_disabled' : usesEngine && !installed ? engine?.unavailableReason ?? probeError ?? 'engine_unavailable' : undefined,
      } };
    });
  }
}
