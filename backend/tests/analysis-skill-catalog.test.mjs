import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import {
  ANALYSIS_ENGINE_IDS,
  ANALYSIS_SKILL_CATALOG,
  ANALYSIS_SKILL_IDS,
  ANALYSIS_SKILL_LABELS,
  analysisSkillLabel,
  getAnalysisSkillCatalogEntry,
  matchesAnalysisContext,
} from '../dist/providers/analysis-catalog.js';

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const analysisRoot = path.join(backendRoot, 'src', 'agent-skills', 'analysis');

function readAnalysisManifests() {
  return parseYaml(fs.readFileSync(path.join(backendRoot, 'src/providers/catalog.yaml'), 'utf8')).filter(provider => provider.kind === 'solver');
}

/** Top-level keys of the ENGINE_DEFAULTS dict literal in analysis/runtime/registry.py. */
function readPythonEngineIds() {
  const source = fs.readFileSync(path.join(analysisRoot, 'runtime', 'registry.py'), 'utf8').replace(/\r\n/g, '\n');
  const start = source.indexOf('ENGINE_DEFAULTS = {\n');
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf('\n}\n', start);
  expect(end).toBeGreaterThan(start);
  const body = source.slice(start, end);
  return [...body.matchAll(/^ {4}"([^"]+)": \{$/gm)].map((match) => match[1]);
}

const byId = (left, right) => left.id.localeCompare(right.id);

describe('analysis skill catalog parity', () => {
  test('catalog entries match the solver provider metadata', () => {
    const manifests = readAnalysisManifests()
      .map(({ id, engineId, analysisType }) => ({ id, engineId, analysisType }))
      .sort(byId);
    expect(manifests.length).toBeGreaterThan(0);
    expect([...ANALYSIS_SKILL_CATALOG].sort(byId)).toEqual(manifests);
  });

  test('every manifest has exactly one label and the label table has no stale ids', () => {
    expect(Object.keys(ANALYSIS_SKILL_LABELS).sort()).toEqual(readAnalysisManifests().map((manifest) => manifest.id).sort());
  });

  test('labels and enum order stay stable (they appear in tool output and the run_analysis schema)', () => {
    expect(ANALYSIS_SKILL_LABELS).toEqual({
      'opensees-static': 'OpenSees static analysis',
      'opensees-dynamic': 'OpenSees dynamic analysis',
      'opensees-seismic': 'OpenSees seismic analysis',
      'opensees-nonlinear': 'OpenSees nonlinear analysis',
      'pkpm-static': 'PKPM/SATWE static analysis',
      'yjk-static': 'YJK static analysis',
    });
    expect([...ANALYSIS_SKILL_IDS]).toEqual(Object.keys(ANALYSIS_SKILL_LABELS));
    expect(analysisSkillLabel('pkpm-static')).toBe('PKPM/SATWE static analysis');
    expect(analysisSkillLabel('unknown-skill')).toBe('unknown-skill');
  });

  test('catalog engine ids match the Python analysis runtime engine registry', () => {
    expect([...ANALYSIS_ENGINE_IDS].sort()).toEqual(readPythonEngineIds().sort());
  });

  test('lookups and context matching', () => {
    expect(getAnalysisSkillCatalogEntry('yjk-static')).toEqual({ id: 'yjk-static', engineId: 'builtin-yjk', analysisType: 'static' });
    expect(getAnalysisSkillCatalogEntry('frame')).toBeUndefined();
    expect(getAnalysisSkillCatalogEntry(undefined)).toBeUndefined();
    const skill = { analysisType: 'static', engineId: 'builtin-opensees', supportedModelFamilies: ['Frame', 'truss'] };
    expect(matchesAnalysisContext(skill, {})).toBe(true);
    expect(matchesAnalysisContext(skill, { analysisType: 'dynamic' })).toBe(false);
    expect(matchesAnalysisContext(skill, { engineId: 'builtin-pkpm' })).toBe(false);
    expect(matchesAnalysisContext(skill, { supportedModelFamilies: ['frame'] })).toBe(true);
    expect(matchesAnalysisContext(skill, { supportedModelFamilies: ['generic'] })).toBe(false);
  });
});
