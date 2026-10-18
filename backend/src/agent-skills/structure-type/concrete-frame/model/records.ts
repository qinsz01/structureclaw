/** Shared concrete-frame model fields: topology ids, site seismic, wind, analysis control and code-check metadata. */
import { buildConcreteMaterialRecord, buildRebarMaterialRecord, buildConcreteSectionRecord } from './materials.js';
import type { ConcreteMaterialProps, RebarMaterialProps, SectionProps } from './materials.js';
import { seismicDesignGroupIndex, normalizeSeismicSiteCategory, normalizeSeismicDesignGroup, normalizeWindTerrainRoughness } from '../design-conditions.js';
import type { DraftSiteSeismicParams, DraftWindParams, DraftAnalysisControl } from '../../../../shared/types/agent.js';
import { STRUCTURAL_COORDINATE_SEMANTICS } from '../../../../engineering/coordinate-semantics.js';
import type { ConcreteFrameOutput } from '../types.js';

export type ConcreteFrameModel = {
  schema_version: '2.2.0';
  unit_system: 'SI';
  coordinate_system?: Record<string, unknown>;
  project: Record<string, unknown>;
  structure_system: Record<string, unknown>;
  site_seismic?: Record<string, unknown>;
  wind?: Record<string, unknown>;
  analysis_control?: Record<string, unknown>;
  nodes: Array<Record<string, unknown>>;
  elements: Array<Record<string, unknown>>;
  stories: Array<Record<string, unknown>>;
  load_cases: Array<Record<string, unknown>>;
  load_combinations: Array<Record<string, unknown>>;
  metadata: Record<string, unknown>;
  extensions: Record<string, unknown>;
  storyCount: number;
  bayCount?: number;
  bayCountX?: number;
  bayCountY?: number;
  storyHeightsM: number[];
  bayWidthsM?: number[];
  bayWidthsXM?: number[];
  bayWidthsYM?: number[];
  frameDimension: '2d' | '3d';
  frameConcreteGrade: string;
  frameRebarGrade?: string;
  frameColumnSection: string;
  frameBeamSection: string;
  concreteProps: ConcreteMaterialProps;
  rebarProps?: RebarMaterialProps;
  columnProps: SectionProps;
  beamProps: SectionProps;
  floorLoads?: Array<{ story: number; verticalKN?: number; liveLoadKN?: number; lateralXKN?: number; lateralYKN?: number }>;
  frameBaseSupportType?: string;
  materials?: Array<{
    id: string;
    name: string;
    grade: string;
    category: 'concrete' | 'rebar';
    E: number;
    G?: number;
    nu: number;
    rho: number;
    fc?: number;
    fy?: number;
  }>;
  sections?: Array<{
    id: string;
    name: string;
    type: 'rectangular';
    purpose: 'column' | 'beam';
    width: number;
    height: number;
    shape: { kind: 'rectangular'; B: number; H: number };
    properties: {
      A: number;
      Iy: number;
      Iz: number;
      J: number;
    };
  }>;
};

function deriveCharacteristicPeriod(designGroup: string | undefined, siteCategory: string | undefined): number | undefined {
  const group = seismicDesignGroupIndex(designGroup);
  const category = normalizeSeismicSiteCategory(siteCategory);
  if (!group || !category) return undefined;
  const table: Record<1 | 2 | 3, Record<string, number>> = {
    1: { I: 0.25, II: 0.35, III: 0.45, IV: 0.65 },
    2: { I: 0.30, II: 0.40, III: 0.55, IV: 0.75 },
    3: { I: 0.35, II: 0.45, III: 0.65, IV: 0.90 },
  };
  return table[group][category];
}

function deriveMaxInfluenceCoefficient(accelerationG: number | undefined): number | undefined {
  if (accelerationG === undefined) return undefined;
  const known = [
    { accelerationG: 0.05, alphaMax: 0.04 },
    { accelerationG: 0.10, alphaMax: 0.08 },
    { accelerationG: 0.15, alphaMax: 0.12 },
    { accelerationG: 0.20, alphaMax: 0.16 },
    { accelerationG: 0.30, alphaMax: 0.24 },
    { accelerationG: 0.40, alphaMax: 0.32 },
  ];
  const matched = known.find((item) => Math.abs(item.accelerationG - accelerationG) < 0.001);
  return matched?.alphaMax;
}

export function buildSiteSeismicRecord(input: DraftSiteSeismicParams | undefined): Record<string, unknown> | undefined {
  if (!input || Object.keys(input).length === 0) return undefined;
  const designGroup = normalizeSeismicDesignGroup(input.designGroup);
  const siteCategory = normalizeSeismicSiteCategory(input.siteCategory);
  const characteristicPeriod = input.characteristicPeriod
    ?? deriveCharacteristicPeriod(designGroup, siteCategory);
  const maxInfluenceCoefficient = input.maxInfluenceCoefficient
    ?? deriveMaxInfluenceCoefficient(input.accelerationG);
  return {
    ...(input.intensity !== undefined && { intensity: input.intensity }),
    ...(designGroup !== undefined && { design_group: designGroup }),
    ...(siteCategory !== undefined && { site_category: siteCategory }),
    ...(characteristicPeriod !== undefined && { characteristic_period: characteristicPeriod }),
    ...(maxInfluenceCoefficient !== undefined && { max_influence_coefficient: maxInfluenceCoefficient }),
    damping_ratio: input.dampingRatio ?? 0.05,
    extra: {
      ...(input.accelerationG !== undefined && { acceleration_g: input.accelerationG }),
    },
  };
}

export function buildWindRecord(input: DraftWindParams | undefined): Record<string, unknown> | undefined {
  if (!input || Object.keys(input).length === 0) return undefined;
  const terrainRoughness = normalizeWindTerrainRoughness(input.terrainRoughness);
  return {
    ...(input.basicPressureKNM2 !== undefined && { basic_pressure: input.basicPressureKNM2 }),
    ...(terrainRoughness !== undefined && { terrain_roughness: terrainRoughness }),
    ...(input.shapeFactor !== undefined && { shape_factor: input.shapeFactor }),
    ...(input.heightVariationFactor !== undefined && { height_variation_factor: input.heightVariationFactor }),
  };
}

export function buildAnalysisControlRecord(input: DraftAnalysisControl | undefined, includeDefaults = true): Record<string, unknown> | undefined {
  const base: Record<string, unknown> = {
    ...((includeDefaults || input?.pDelta !== undefined) && { p_delta: input?.pDelta ?? false }),
    ...((includeDefaults || input?.rigidFloor !== undefined) && { rigid_floor: input?.rigidFloor ?? true }),
    ...((includeDefaults || input?.considerationTorsion !== undefined) && { consideration_torsion: input?.considerationTorsion ?? true }),
  };
  if (input?.periodReductionFactor !== undefined) base.period_reduction_factor = input.periodReductionFactor;
  if (input?.accidentalEccentricity !== undefined) base.accidental_eccentricity = input.accidentalEccentricity;
  if (input?.modalCount !== undefined) base.modal_count = input.modalCount;
  if (input?.basementCount !== undefined) base.basement_count = input.basementCount;
  if (input?.liveLoadReduction !== undefined) base.live_load_reduction = input.liveLoadReduction;
  if (input?.structureImportanceFactor !== undefined) base.structure_importance_factor = input.structureImportanceFactor;
  if (input?.dampingRatioWind !== undefined) base.damping_ratio_wind = input.dampingRatioWind;
  if (input?.designParams !== undefined) base.design_params = input.designParams;
  return Object.keys(base).length ? base : undefined;
}

export function accumulateCoords(lengths: number[]): number[] {
  const coords = [0];
  for (const value of lengths) {
    coords.push(coords[coords.length - 1] + value);
  }
  return coords;
}

export function buildBaseRestraint(baseSupport: string): boolean[] {
  return baseSupport === 'pinned'
    ? [true, true, true, false, false, false]
    : [true, true, true, true, true, true];
}

export function n2dId(storyIdx: number, bayNodeIdx: number): string {
  return `N${storyIdx}_${bayNodeIdx}`;
}

export function n3dId(storyIdx: number, xIdx: number, yIdx: number): string {
  return `N${storyIdx}_${xIdx}_${yIdx}`;
}

export function buildCommonModelFields(options: {
  frameConcreteGrade: string;
  frameRebarGrade?: string;
  frameColumnSection: string;
  frameBeamSection: string;
  frameBaseSupportType: string;
  storyCount: number;
  concreteProps: ConcreteMaterialProps;
  rebarProps?: RebarMaterialProps;
  columnProps: SectionProps;
  beamProps: SectionProps;
  siteSeismic?: Record<string, unknown>;
  wind?: Record<string, unknown>;
  analysisControl?: Record<string, unknown>;
  metadata: Record<string, unknown>;
}): Pick<ConcreteFrameModel, 'schema_version' | 'unit_system' | 'project' | 'structure_system' | 'site_seismic' | 'wind' | 'analysis_control' | 'materials' | 'sections' | 'metadata' | 'extensions'> {
  return {
    schema_version: '2.2.0',
    unit_system: 'SI',
    project: {
      code_standard: 'GB50010-2010',
      extra: {
        designCode: 'GB50010',
      },
    },
    structure_system: {
      type: 'frame',
      seismic_grade: 'none',
      extra: {
        materialSystem: 'reinforced-concrete',
      },
    },
    ...(options.siteSeismic !== undefined && { site_seismic: options.siteSeismic }),
    ...(options.wind !== undefined && { wind: options.wind }),
    ...(options.analysisControl !== undefined && { analysis_control: options.analysisControl }),
    materials: [
      buildConcreteMaterialRecord(options.concreteProps),
      // The rebar grade is optional for analysis; a check looks its strengths up when it is declared.
      ...(options.rebarProps ? [buildRebarMaterialRecord(options.rebarProps)] : []),
    ] as ConcreteFrameModel['materials'],
    sections: [
      buildConcreteSectionRecord('1', 'column', options.columnProps),
      buildConcreteSectionRecord('2', 'beam', options.beamProps),
    ] as ConcreteFrameModel['sections'],
    metadata: {
      ...options.metadata,
      coordinateSemantics: STRUCTURAL_COORDINATE_SEMANTICS,
      source: 'concrete-frame-skill-draft',
      inferredType: 'frame',
      structuralTypeKey: 'concrete-frame',
      materialSystem: 'reinforced-concrete',
      designCode: 'GB50010',
      baseSupport: options.frameBaseSupportType,
      concreteGrade: options.frameConcreteGrade,
      rebarGrade: options.frameRebarGrade,
      columnSection: options.frameColumnSection,
      beamSection: options.frameBeamSection,
      storyCount: options.storyCount,
      ...(options.siteSeismic !== undefined && { siteSeismic: options.siteSeismic }),
      ...(options.wind !== undefined && { wind: options.wind }),
    },
    extensions: {
      pkpm: {
        materialSystem: 'reinforced-concrete',
        designCode: 'GB50010',
        ...(options.siteSeismic !== undefined && { site_seismic: options.siteSeismic }),
        ...(options.wind !== undefined && { wind: options.wind }),
      },
      yjk: {
        materialSystem: 'reinforced-concrete',
        designCode: 'GB50010',
      },
      concreteDesign: {
        concreteGrade: options.frameConcreteGrade,
        rebarGrade: options.frameRebarGrade,
      },
    },
  };
}

/**
 * Build code-check metadata summary for injection into model metadata.
 */
export function buildCodeCheckMetadata(codeCheckResults: ConcreteFrameOutput): Record<string, unknown> {
  return {
    beamCount: codeCheckResults.concreteBeams.length,
    columnCount: codeCheckResults.concreteColumns.length,
    slabCount: codeCheckResults.concreteSlabs.length,
    beams: codeCheckResults.concreteBeams.map((b) => ({
      id: b.id, type: b.type, spanM: b.spanM,
      heightMM: b.heightMM, widthMM: b.widthMM,
    })),
    columns: codeCheckResults.concreteColumns.map((c) => ({
      id: c.id, type: c.type, heightM: c.heightM,
      axialLoadRatio: c.axialLoadRatio,
      widthMM: c.widthMM, heightMM: c.heightMM, diameterMM: c.diameterMM,
    })),
  };
}
