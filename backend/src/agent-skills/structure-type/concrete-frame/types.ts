import type { DraftExtraction, DraftState } from '../../../agent-runtime/types.js';

export interface ConcreteFramePatchSources {
  message: string;
  existingState?: DraftState;
  naturalPatch?: DraftExtraction | null;
  llmPatch?: DraftExtraction | null;
}

// ============================================================================
// PR2: 构件生成器接口
// ============================================================================

/**
 * 混凝土框架技能输入接口
 * 用于接收用户提供的混凝土框架结构参数
 */
export interface ConcreteFrameInput {
  // 结构体系
  structureSystem?: 'moment-frame' | 'frame-shear-wall' | 'shear-wall'; // 默认: moment-frame

  // 几何参数
  storyCount: number; // 层数（必填）
  bayCount: number; // 跨数（必填）
  storyHeightsM: number[]; // 每层层高(m)
  bayWidthsM: number[]; // 每跨跨度(m)

  // 抗震设计
  seismicGrade?: '一级' | '二级' | '三级' | '四级'; // 默认: 四级

  // 材料等级
  concreteGrade: string; // 混凝土等级 (C20-C80)
  rebarGrade: string; // 钢筋等级 (HRB400, HRB500)

  // 板设计参数
  slabType?: 'one-way' | 'two-way' | 'flat-slab' | 'waffle'; // 板类型
  slabUsage?: 'roof' | 'residential' | 'commercial' | 'vehicle'; // 板用途

  // 梁设计参数
  beamType?: 'rectangular' | 't-shaped'; // 梁类型

  // 柱设计参数
  columnType?: 'rectangular' | 'circular'; // 柱类型，默认: rectangular

  // 荷载信息（用于柱截面估算）
  axialLoadKN?: number; // 估算轴力(kN)
}

/**
 * 混凝土梁构件
 *
 * T形截面符号 (GB/T 50010-2010):
 *   bf' / hf' — 受压区翼缘宽度/厚度（带撇，跨中正弯矩区有效）
 *   bf       — 受拉区翼缘宽度（不带撇，正T底面无翼缘 → bf = b）
 *   b        — 腹板宽度
 *   h        — 截面总高
 *
 * 命名约定: 与 model.ts 一致，用 _compression / _tension 后缀代替规范中的撇号。
 */
export interface ConcreteBeam {
  id: string;
  type: 'rectangular' | 't-shaped';
  spanM: number;
  widthMM?: number; // 矩形梁宽度 (b)
  heightMM?: number; // 矩形梁高度 (h)
  webWidthMM?: number; // 腹板宽度 (b)
  flangeWidthMM_compression?: number; // 受压区翼缘有效宽度 (bf')，仅跨中正弯矩区有效
  flangeThicknessMM_compression?: number; // 受压区翼缘厚度 (hf')
  supportEffectiveWidthMM?: number; // 支座有效宽度 (负弯矩区 bf' = b)，等于 webWidthMM
  totalHeightMM?: number; // 截面总高度 (h)
  spanDepthRatio?: number;
  meetsRequirement?: boolean;
}

/**
 * 混凝土柱构件
 */
export interface ConcreteColumn {
  id: string;
  type: 'rectangular' | 'circular';
  heightM: number;
  widthMM?: number; // 矩形柱宽度
  heightMM?: number; // 矩形柱高度
  diameterMM?: number; // 圆形柱直径
  axialLoadRatio?: number; // 轴压比
  meetsRequirement?: boolean;
}

/**
 * 混凝土板构件
 */
export interface ConcreteSlab {
  id: string;
  type: 'one-way' | 'two-way' | 'flat-slab' | 'waffle';
  spanXM?: number; // X向跨度
  spanYM?: number; // Y向跨度
  thicknessMM: number; // 板厚
  usage: string;
  spanDepthRatio?: number;
  meetsRequirement?: boolean;
}

/**
 * 混凝土框架技能输出接口
 */
export interface ConcreteFrameOutput {
  concreteBeams: ConcreteBeam[];
  concreteColumns: ConcreteColumn[];
  concreteSlabs: ConcreteSlab[];
  warnings?: Array<{ code: string; message: string }>;
  errors?: Array<{ code: string; message: string }>;
}

/**
 * 混凝土框架特有状态接口
 */
export interface ConcreteFrameDraftState extends DraftState {
  concreteBeams?: ConcreteBeam[];
  concreteColumns?: ConcreteColumn[];
  concreteSlabs?: ConcreteSlab[];
  structureSystem?: 'moment-frame' | 'frame-shear-wall' | 'shear-wall';
  seismicGrade?: string;
  slabType?: 'one-way' | 'two-way' | 'flat-slab' | 'waffle';
  beamType?: 'rectangular' | 't-shaped';
}