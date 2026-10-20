import fs from 'node:fs'
import { beamModel, beamAnalysis } from './engineering-beam.ts'

/** Shared audit inputs. Frame JSON provenance is recorded in visualization-models.md. */
export const visualizationScenarios = ['beam', 'frame2d', 'frame3d'].map(id => {
  const model = id === 'beam' ? beamModel : JSON.parse(fs.readFileSync(new URL(`./visualization-${id}.json`, import.meta.url), 'utf8'))
  return { id, model, analysis: id === 'beam' ? beamAnalysis : { analysisType: 'static', analysisSkillId: 'opensees-static',
    loadCaseIds: model.load_cases.map((row: { id: string }) => row.id), loadCombinationIds: model.load_combinations.map((row: { id: string }) => row.id) } }
})
