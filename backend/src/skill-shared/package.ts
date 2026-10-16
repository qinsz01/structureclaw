import type {
  AgentAnalysisType,
  MaterialFamily,
  SkillCompatibility,
  SkillDomain,
} from '../shared/types/agent.js';
import type { SkillProviderSource } from './provider.js';

interface SkillPackageEntrypoints {
  [key: string]: string | undefined;
}

export interface SkillPackageMetadata<TDomain extends string = SkillDomain> {
  id: string;
  domain: TDomain;
  version: string;
  source: SkillProviderSource;
  capabilities: string[];
  compatibility: SkillCompatibility;
  entrypoints: SkillPackageEntrypoints;
  enabledByDefault: boolean;
  priority?: number;
  requires?: string[];
  conflicts?: string[];
  supportedLocales?: string[];
  supportedAnalysisTypes?: AgentAnalysisType[];
  materialFamilies?: MaterialFamily[];
  name?: {
    zh?: string;
    en?: string;
  };
  description?: {
    zh?: string;
    en?: string;
  };
  structureType?: string;
}
