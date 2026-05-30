import type { DraftWindParams } from '../../../agent-runtime/types.js';

export function seismicDesignGroupIndex(raw: unknown): 1 | 2 | 3 | undefined {
  if (typeof raw !== 'string' && typeof raw !== 'number') return undefined;
  const text = String(raw).trim();
  if (/1|一/.test(text)) return 1;
  if (/2|二|两/.test(text)) return 2;
  if (/3|三/.test(text)) return 3;
  return undefined;
}

export function normalizeSeismicDesignGroup(raw: unknown): string | undefined {
  const index = seismicDesignGroupIndex(raw);
  if (index === 1) return '第一组';
  if (index === 2) return '第二组';
  if (index === 3) return '第三组';
  return undefined;
}

export function normalizeSeismicSiteCategory(raw: unknown): string | undefined {
  if (typeof raw !== 'string' && typeof raw !== 'number') return undefined;
  const text = String(raw).trim().toUpperCase().replace(/类/g, '');
  if (/^(?:1|一|I)$/.test(text)) return 'I';
  if (/^(?:2|二|两|II)$/.test(text)) return 'II';
  if (/^(?:3|三|III)$/.test(text)) return 'III';
  if (/^(?:4|四|IV)$/.test(text)) return 'IV';
  return undefined;
}

export function normalizeWindTerrainRoughness(raw: unknown): DraftWindParams['terrainRoughness'] | undefined {
  if (typeof raw !== 'string') return undefined;
  const text = raw.trim().toUpperCase().replace(/类/g, '');
  return ['A', 'B', 'C', 'D'].includes(text) ? text as DraftWindParams['terrainRoughness'] : undefined;
}
