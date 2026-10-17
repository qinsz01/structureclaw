/**
 * English labels for the check and item names the code-check engines emit in Chinese
 * (code_check.py of gb50017, gb50010, gb50011, jgj3 and the shared runner). Engine output and
 * stored results stay unchanged; reports localize at render time.
 */
import type { AppLocale } from '../../shared/locale.js';

const CODE_CHECK_LABELS_EN: Readonly<Record<string, string>> = Object.freeze({
  'GB 18306标准状态': 'GB 18306 standard status',
  'Pushover弹塑性估算位移角': 'Pushover elastoplastic drift-ratio estimate',
  'Pushover弹塑性估算校核': 'Pushover elastoplastic estimate check',
  'Pushover最终符合性': 'Pushover final compliance',
  '位移验算': 'Displacement check',
  '刚度验算': 'Stiffness check',
  '剪应力': 'Shear stress',
  '单条时程基底剪力比例': 'Single time-history base-shear ratio',
  '反应谱周期范围校核': 'Response-spectrum period range check',
  '反应谱长周期专项研究': 'Response-spectrum long-period special study',
  '地震波反应谱适配': 'Ground-motion spectrum compatibility',
  '地震波组数规则': 'Ground-motion set count rule',
  '地震波调幅系数': 'Ground-motion scaling factor',
  '多遇地震弹性层间位移角': 'Frequent-earthquake elastic story drift ratio',
  '实际强震记录比例': 'Recorded ground-motion proportion',
  '局部稳定': 'Local stability',
  '平均时程基底剪力比例': 'Average time-history base-shear ratio',
  '弹塑性时程最终符合性': 'Elastoplastic time-history final compliance',
  '强度验算': 'Strength check',
  '截面抗震验算': 'Section seismic check',
  '承载力验算': 'Capacity check',
  '抗震基本作用组合': 'Seismic fundamental combination',
  '抗震基本作用组合校核': 'Seismic fundamental combination check',
  '抗震墙分布钢筋构造': 'Shear-wall distributed reinforcement detailing',
  '抗震墙墙厚': 'Shear-wall thickness',
  '抗震墙轴压比限值': 'Shear-wall axial compression ratio limit',
  '抗震墙边缘构件构造': 'Shear-wall boundary element detailing',
  '抗震流程输入校核': 'Seismic workflow input check',
  '抗震等级结构化依据': 'Structured seismic grade basis',
  '抗震组合构件承载力': 'Member capacity under seismic combinations',
  '抗震组合构件承载力抽查': 'Member capacity spot check under seismic combinations',
  '抗震能力边界': 'Seismic capability boundary',
  '抗震能力边界校核': 'Seismic capability boundary check',
  '抗震设计依据完整性': 'Seismic design basis completeness',
  '抗震设计依据完整性校核': 'Seismic design basis completeness check',
  '抗震设防类别标准': 'Seismic fortification category standard',
  '折算应力': 'Equivalent stress',
  '挠度': 'Deflection',
  '振型参与质量系数': 'Modal mass participation ratio',
  '振型组合完整性校核': 'Modal combination completeness check',
  '整体抗震变形验算': 'Global seismic deformation check',
  '整体稳定': 'Overall stability',
  '时程分析输入与结果校核': 'Time-history input and result check',
  '时程方向级校核追踪': 'Time-history per-direction check trace',
  '时程组合规则': 'Time-history combination rule',
  '构造验算': 'Detailing check',
  '柱承载力与稳定验算': 'Column capacity and stability check',
  '柱承载力验算': 'Column capacity check',
  '柱稳定与构造验算': 'Column stability and detailing check',
  '框架扁梁构造': 'Frame wide-beam detailing',
  '框架构件强剪弱弯受剪承载力': 'Frame member strong-shear/weak-flexure shear capacity',
  '框架柱剪跨比专项要求': 'Frame column shear-span ratio requirement',
  '框架柱截面尺寸': 'Frame column section size',
  '框架柱箍筋体积配箍率': 'Frame column volumetric stirrup ratio',
  '框架柱箍筋加密区构造': 'Frame column confinement-zone stirrup detailing',
  '框架柱箍筋加密区范围': 'Frame column confinement-zone extent',
  '框架柱纵筋构造': 'Frame column longitudinal reinforcement detailing',
  '框架柱纵筋补充构造': 'Frame column supplementary longitudinal reinforcement detailing',
  '框架柱轴压比限值': 'Frame column axial compression ratio limit',
  '框架梁截面尺寸': 'Frame beam section size',
  '框架梁柱混凝土强度等级': 'Frame beam/column concrete grade',
  '框架梁端纵筋延性构造': 'Frame beam-end longitudinal reinforcement ductility detailing',
  '框架梁箍筋加密区构造': 'Frame beam confinement-zone stirrup detailing',
  '框架梁贯通中柱纵筋直径': 'Frame beam bar diameter through interior columns',
  '框架梁贯通纵筋构造': 'Frame beam continuous longitudinal reinforcement detailing',
  '框架节点强柱弱梁弯矩关系': 'Frame joint strong-column/weak-beam moment relation',
  '框架节点核芯区截面抗震验算': 'Frame joint core section seismic check',
  '框架节点核芯区箍筋构造': 'Frame joint core stirrup detailing',
  '梁承载力与正常使用验算': 'Beam capacity and serviceability check',
  '楼层地震剪力系数校核': 'Story seismic shear coefficient check',
  '楼层最小地震剪力系数': 'Minimum story seismic shear coefficient',
  '正常使用验算': 'Serviceability check',
  '正应力': 'Normal stress',
  '水平地震作用校核': 'Horizontal seismic action check',
  '水平地震构件内力': 'Member forces under horizontal seismic action',
  '混凝土构件剪压比限值': 'Concrete member shear-compression ratio limit',
  '稳定验算': 'Stability check',
  '竖向地震作用标准值': 'Vertical seismic action characteristic value',
  '竖向地震作用校核': 'Vertical seismic action check',
  '竖向地震构件内力': 'Member forces under vertical seismic action',
  '竖向地震构件承载力': 'Member capacity under vertical seismic action',
  '结构化抗震流程输入': 'Structured seismic workflow input',
  '补充时程分析完整性': 'Supplementary time-history analysis completeness',
  '规则性与方法选择校核': 'Regularity and method selection check',
  '规则性评估与补充时程触发': 'Regularity assessment and supplementary time-history trigger',
  '超限与专项审查校核': 'Out-of-code and special review check',
  '超限与专项审查结构化追踪': 'Out-of-code and special review trace',
  '轴压稳定': 'Axial compression stability',
  '钢构件抗震构造限值': 'Steel member seismic detailing limits',
  '长细比': 'Slenderness ratio',
  '隔震与消能减震专门体系审计': 'Isolation and energy-dissipation system audit',
  '隔震与消能减震专门体系校核': 'Isolation and energy-dissipation system check',
  '隔震层位移验收': 'Isolation-layer displacement acceptance',
  '隔震层 SDOF 时程位移估算验收': 'Isolation-layer SDOF time-history displacement estimate acceptance',
  '隔震支座位移验收': 'Isolation bearing displacement acceptance',
  '隔震等效线性位移估算验收': 'Isolation equivalent-linear displacement estimate acceptance',
  '消能减震等效阻尼变形估算验收': 'Energy-dissipation equivalent-damping deformation estimate acceptance',
  '消能器 SDOF 时程变形/力估算验收': 'Damper SDOF time-history deformation/force estimate acceptance',
  '消能器变形验收': 'Damper deformation acceptance',
});

const CJK = /[一-龥]/;

/** English label for a known engine name; undefined when none is registered. */
export function codeCheckLabelEn(value: string): string | undefined {
  return CODE_CHECK_LABELS_EN[value.trim()];
}

/**
 * Check or item name in the report locale. `zh` keeps the engine text. `en` maps known names,
 * takes the English half of a bilingual "中文 / English" name, and otherwise keeps the text.
 */
export function localizeCodeCheckLabel(value: unknown, locale: AppLocale): unknown {
  if (locale !== 'en' || typeof value !== 'string') return value;
  const known = codeCheckLabelEn(value);
  if (known) return known;
  const [zh, en, ...rest] = value.split(' / ');
  if (rest.length === 0 && en && CJK.test(zh) && !CJK.test(en)) return en.trim();
  return value;
}
