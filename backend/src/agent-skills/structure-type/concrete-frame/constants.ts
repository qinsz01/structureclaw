export const GEOMETRY_KEYS = [
  'frameDimension',
  'storyCount',
  'bayCount',
  'bayCountX',
  'bayCountY',
  'storyHeightsM',
  'bayWidthsM',
  'bayWidthsXM',
  'bayWidthsYM',
] as const;

export const LOAD_BOUNDARY_KEYS = ['floorLoads', 'frameBaseSupportType'] as const;

export const DESIGN_CONDITION_KEYS = ['siteSeismic', 'wind', 'analysisControl'] as const;

export const REQUIRED_KEYS = [
  'frameDimension',
  'storyCount',
  'bayCount',
  'bayCountX',
  'bayCountY',
  'storyHeightsM',
  'bayWidthsM',
  'bayWidthsXM',
  'bayWidthsYM',
  'floorLoads',
] as const;

export const FRAME_MATERIAL_KEYS = ['frameConcreteGrade', 'frameRebarGrade', 'frameColumnSection', 'frameBeamSection'] as const;

/** 方案阶段柱轴力估算默认单位荷载 (kN/m²)，已含恒载、活载及分项系数 */
export const DEFAULT_FLOOR_LOAD_KN_PER_M2 = 15;
