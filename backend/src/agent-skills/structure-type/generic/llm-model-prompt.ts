import { engineeringKnowledge } from '../../../engineering/knowledge.js';
import type { AppLocale } from '../../../shared/locale.js';
import type { DraftState } from '../../../shared/types/agent.js';
import { composePromptByIntent } from './llm-model-prompt-intents.js';
import { modelLoadMappingsContract } from '../../../engineering/model-selection.js';

const STATE_METADATA_KEYS = new Set([
  'skillId', 'supportLevel', 'supportNote', 'updatedAt', 'structuralTypeKey',
  'skillState',
]);

function buildCleanStateHint(state: DraftState): string {
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state)) {
    if (!STATE_METADATA_KEYS.has(key) && value !== undefined) {
      filtered[key] = value;
    }
  }
  return JSON.stringify(filtered);
}

export function buildGenericModelPrompt(
  message: string,
  state: DraftState,
  locale: AppLocale,
  conversationHistory?: string,
  currentModel?: Record<string, unknown>,
): string {
  const stateHint = buildCleanStateHint(state);
  const loadIds = [...new Set(state.engineeringDraft?.loads?.flatMap(load => typeof load.id === 'string' && load.id ? [load.id] : []) ?? [])];
  const unresolved = state.engineeringDraft?.loads?.filter(load => !load.selector || !load.caseId) ?? [];
  const unresolvedIds = unresolved.flatMap(load => load.id ? [load.id] : []);
  const base = [composePromptByIntent('build-structure-model-v2', locale, stateHint, message, conversationHistory),
    ...(loadIds.length ? [
      'Confirmed-load compilation protocol / 已确认荷载编译协议: For a NEW draft model, prefer metadata.compileDraftLoads=true with EMPTY load_cases[].loads. Preserve source selectors and supply metadata.loadMappings only to explicitly resolve source labels/cases; identical existing selectors may be repeated. The system compiles the confirmed magnitudes, units, directions and targets. Do NOT also emit nodal-load/member-udl/member-point-load operations or executable loads. Area loads still need distinct floor-to-beam operations and transferId bindings; their expansion is deferred to source compilation. Missing bindings or conflicting executable loads FAIL; this is an explicit output protocol, never a fallback. For an existing model edit omit compileDraftLoads and preserve its existing loads. / 新模型优先声明此协议，避免逐项重写已确认荷载；与施加操作冲突会拒绝，不会覆盖。',
      'In source compilation mode OMIT stories.dead_load/live_load: those are executable floor-pressure shorthand, not descriptive metadata. The source loads are compiled once; repeating a source area pressure there duplicates its derived beam loads. / 源荷载编译时不要同时填写楼层恒活面荷载简写；源压力及折算梁荷载只能施加一次。',
      `Confirmed selector story IDs / 已确认选择器楼层ID: ${JSON.stringify([...new Set(state.engineeringDraft!.loads!.flatMap(load => load.selector?.story ? [load.selector.story] : []))])}. Preserve these exact IDs. For regular-frame use storyIds to bind storey indices to those IDs; without that override generated IDs have the operation prefix. Never alter a confirmed selector to match newly invented IDs. / 用storyIds显式绑定既有楼层标识，不修改已确认选择器适配新编号。`,
      locale === 'zh'
        ? '荷载标识协议 metadata.loadMappings：loadId 只能原样取下列 enum 中的源荷载编号；一项源荷载对应多个构件时使用 selector.ids，不能在 loadId 上追加楼层或构件后缀。源荷载未指定 caseId 时由 LLM 明确绑定到模型中已有的工况；已确认的 caseId 必须原样保留，不能按编号前缀猜测。'
        : 'Load identity contract metadata.loadMappings: loadId must exactly match a source ID in the enum below. Select multiple members with selector.ids; never append storey/member suffixes to loadId. The LLM must explicitly bind an unassigned caseId to an existing model case. Preserve confirmed case IDs exactly; never infer case identity from ID prefixes.',
      unresolvedIds.length ? JSON.stringify(modelLoadMappingsContract(unresolvedIds))
        : 'All source loads already have confirmed selectors and case IDs. OMIT metadata.loadMappings; compile those selectors directly. / 所有源荷载已有选择器和工况，不再生成映射，直接编译原选择器。',
      'Area sources (kN/m2): each metadata.loadMappings entry must include transferId equal to its distinct floor-to-beam operation.id, selector for its supporting beams and exact caseId. The system independently recomputes pressure×area and member loads; metadata totals are not evidence. Use explicit full-floor bounds and the confirmed transfer direction. / 面荷载须以transferId明确绑定各自的floor-to-beam操作，由系统重算面积合力及各梁荷载，不接受助手声明总量代替校核。',
      `Required source-load bindings / 必须逐条绑定的源荷载: ${JSON.stringify(unresolved.map(load => ({
        loadId: load.id, caseId: load.caseId, target: load.target, location: load.location, selector: load.selector,
      })))}. Return metadata.loadMappings with one entry for EVERY source load not already resolved by its exact entity ID or selector. Load operations do not replace this evidence. Do not omit mappings merely because operation resultants match. / 荷载操作和相同合力不能替代逐条映射依据。`,
    ] : []),
    engineeringKnowledge(locale, ['loads', 'boundaries', 'combinations', 'validation']),
    locale === 'zh' ? '端释放协议：releases 使用 i/j 下的局部自由度布尔值 ux/uy/uz/rx/ry/rz；不要写成力或弯矩结果字段。纯轴力杆已具有自由转动，不需要另选单元表示；无剪切和弯曲刚度也不代表平移端释放。平移释放、偏心与冲突定义不得删除或自行更改。仅供纯轴力杆使用的截面若已给定正面积A，可直接用properties.A，不需补问或编造等代形状与惯性矩。'
      : 'End-release contract: releases uses boolean local DOFs ux/uy/uz/rx/ry/rz under i/j, not force or moment result fields. Axial members already have free rotations; no representation choice is needed. Their lack of shear/bending stiffness does not mean translational end releases. Never remove or guess translational releases, offsets or conflicting definitions. For a section used only by axial members, an explicitly supplied positive properties.A is sufficient; never ask for or invent an equivalent shape or inertia.',
  ].filter(Boolean).join('\n');
  if (!currentModel) return base;
  return `${base}\n\n${locale === 'zh'
    ? '当前已确认的完整 V2 模型如下。本轮只改变用户明确指定的对象和字段，保留其余节点、连接、属性、荷载与组合及其 ID；不要按结构名称重建或简化。目标不唯一或关键数据缺失时不得猜测。'
    : 'The complete confirmed V2 model follows. Change only the objects and fields explicitly requested this turn. Preserve all other nodes, connectivity, properties, loads, combinations and IDs; do not rebuild or simplify from the structure name. Never guess an ambiguous target or missing critical value.'}\n${JSON.stringify(currentModel)}`;
}

export function buildRetrySuffix(locale: AppLocale, error: string, candidate: string): string {
  const instruction = locale === 'zh'
    ? '上一候选模型未通过校验。依据下面的实际错误修正字段；保留用户已确认的几何、荷载与属性，不通过删减需求绕过错误。只返回完整 JSON 模型。'
    : 'The previous candidate failed validation. Correct the fields using the actual error below. Preserve confirmed geometry, loads and properties; do not remove requirements to evade validation. Return the complete JSON model only.';
  return `\n${instruction}\n${JSON.stringify({ validationError: error, previousCandidate: candidate })}`;
}
