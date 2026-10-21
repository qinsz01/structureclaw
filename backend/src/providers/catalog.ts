import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';
import { resolveBackendAsset } from '../utils/bundled-paths.js';

const localized = z.object({ en: z.string(), zh: z.string() });
const providerSchema = z.object({
  id: z.string(),
  kind: z.enum(['solver', 'design-code', 'input-parser', 'report-exporter']),
  name: localized,
  description: localized,
  priority: z.number().default(0),
  software: z.string().optional(),
  analysisType: z.enum(['static', 'dynamic', 'seismic', 'nonlinear']).optional(),
  engineId: z.string().optional(),
  adapterKey: z.string().optional(),
  runtimePath: z.string().optional(),
  designCode: z.string().optional(),
  supportedAnalysisTypes: z.array(z.string()).default([]),
  supportedModelFamilies: z.array(z.string()).default([]),
  dimensions: z.array(z.enum(['2D', '3D'])).default(['2D', '3D']),
  formats: z.array(z.string()).default([]),
  aliases: z.array(z.string()).default([]),
}).strict();

export type ProviderDefinition = z.infer<typeof providerSchema>;
export type ProviderKind = ProviderDefinition['kind'];

/** Metadata only. Execution stays in the existing domain runtimes; probes live in services. */
export const PROVIDERS: readonly ProviderDefinition[] = z.array(providerSchema).parse(
  parse(readFileSync(resolveBackendAsset('src/providers/catalog.yaml'), 'utf8')),
);
if (new Set(PROVIDERS.map(provider => provider.id)).size !== PROVIDERS.length) {
  throw new Error('DUPLICATE_PROVIDER_ID');
}

export function listProviders(kind?: ProviderKind): ProviderDefinition[] {
  return PROVIDERS.filter(provider => !kind || provider.kind === kind);
}

export function getProvider(id: string): ProviderDefinition | undefined {
  return PROVIDERS.find(provider => provider.id === id || provider.aliases.includes(id));
}
