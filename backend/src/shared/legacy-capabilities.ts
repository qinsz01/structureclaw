/** Compatibility for capability ids saved before the skills/providers split. */
export const LEGACY_PROVIDER_IDS: readonly string[] = [
  "opensees-dynamic",
  "opensees-nonlinear",
  "opensees-seismic",
  "opensees-static",
  "pkpm-static",
  "yjk-static",
  "code-check-gb50010",
  "code-check-gb50011",
  "code-check-gb50017",
  "code-check-jgj3",
  "pkpm-calcbook"
];
export const RETIRED_SKILL_IDS: readonly string[] = [
  "dxf-input",
  "cad-input",
  "csv-input",
  "excel-input",
  "image-input",
  "vision-input",
  "pdf-parsing",
  "skill-wizard",
  "skill-authoring",
  "structure-json-validation",
  "cad-dxf-input",
  "csv-excel-input",
  "image-vision-input",
  "pdf-input",
  "report-export-builtin",
  "memory",
  "shell",
  "skill-creation",
  "boundary-condition",
  "crane-load",
  "dead-load",
  "live-load",
  "load-combination",
  "nodal-constraint",
  "seismic-load",
  "snow-load",
  "temperature-load",
  "wind-load",
  "postprocess-builtin",
  "section-bridge",
  "section-common",
  "section-irregular",
  "validation-structure-model",
  "visualization-frame-summary",
  "validation-structure-json"
];

export function migrateLegacySkillIds(ids: readonly string[], log: (message: string) => void = console.info): { skillIds: string[]; preferredProviderIds: string[] } {
  const preferredProviderIds: string[] = [];
  const skillIds: string[] = [];
  for (const id of new Set(ids)) {
    const providerId = id === 'dxf-input' || id === 'cad-input' ? 'cad-dxf-input' : id;
    if (LEGACY_PROVIDER_IDS.includes(providerId)) preferredProviderIds.push(providerId);
    else if (RETIRED_SKILL_IDS.includes(providerId)) log('[capability-migration] Ignored retired skill: ' + id);
    else skillIds.push(id);
  }
  return { skillIds, preferredProviderIds };
}
