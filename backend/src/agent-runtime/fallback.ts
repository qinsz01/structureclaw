import type { AppLocale } from '../shared/locale.js';
import type {
  DraftState,
  InferredModelType,
  InteractionQuestion,
  RoutingSource,
  StructuralTypeMatch,
  StructuralTypeKey,
} from '../shared/types/agent.js';
import { localize } from './plugin-helpers.js';

function buildUnsupportedStructuralType(
  locale: AppLocale,
  key: StructuralTypeKey,
  noteZh: string,
  noteEn: string,
  routingSource: RoutingSource = 'explicit-keyword',
): StructuralTypeMatch {
  return {
    key,
    mappedType: 'unknown',
    supportLevel: 'unsupported',
    supportNote: localize(locale, noteZh, noteEn),
    routingSource,
  };
}

export function buildUnknownStructuralType(locale: AppLocale): StructuralTypeMatch {
  return buildUnsupportedStructuralType(
    locale,
    'unknown',
    '我还没有从当前描述中稳定细化出可直接补参的结构草稿。请先说明你希望按梁、桁架、门式刚架还是规则框架这类结构继续处理。',
    'I have not yet refined the current description into a stable structural draft for follow-up guidance. Please tell me whether you want to proceed as a beam, truss, portal frame, or regular frame.',
    'generic-fallback',
  );
}

export function detectUnsupportedStructuralTypeByRules(message: string, locale: AppLocale): StructuralTypeMatch | null {
  const text = message.toLowerCase();
  if (text.includes('space frame') || text.includes('网架')) {
    return buildUnsupportedStructuralType(
      locale,
      'space-frame',
      '当前对话补参链路还不直接支持空间网架；如果你愿意，可先收敛成梁、桁架、门式刚架或规则框架进行澄清。',
      'The current guidance flow does not directly support space frames. If acceptable, we can first simplify the problem to a beam, truss, portal frame, or regular frame.'
    );
  }
  if (text.includes('slab') || text.includes('plate') || text.includes('楼板') || text.includes('板')) {
    return buildUnsupportedStructuralType(
      locale,
      'plate-slab',
      '当前补参链路还不直接支持板/楼板模型；请先确认是否可以简化为梁系、框架或桁架问题。',
      'The current guidance flow does not directly support plate or slab models. Please confirm whether the problem can be simplified into beams, frames, or trusses.'
    );
  }
  if (text.includes('shell') || text.includes('壳')) {
    return buildUnsupportedStructuralType(
      locale,
      'shell',
      '当前补参链路还不直接支持壳体模型；请先说明是否可以收敛到梁、桁架或规则框架的近似模型。',
      'The current guidance flow does not directly support shell models. Please clarify whether the problem can be reduced to a beam, truss, or regular-frame approximation.'
    );
  }
  if (text.includes('tower') || text.includes('塔')) {
    return buildUnsupportedStructuralType(
      locale,
      'tower',
      '当前补参链路还不直接支持塔架专用模板；如果只是杆系近似，可先按桁架继续澄清。',
      'The current guidance flow does not directly support tower-specific templates. If a truss approximation is acceptable, we can continue with that.'
    );
  }
  if (text.includes('bridge') || text.includes('桥')) {
    return buildUnsupportedStructuralType(
      locale,
      'bridge',
      '当前补参链路还不直接支持桥梁专用模板；若你只想先讨论主梁近似，可收敛到梁模板。',
      'The current guidance flow does not directly support bridge-specific templates. If you only want a girder-style approximation first, we can narrow the problem to a beam template.'
    );
  }
  return null;
}

function buildSupportTypeQuestion(locale: AppLocale): string {
  return localize(
    locale,
    '请确认支座/边界条件（悬臂、简支、两端固结或固铰）。',
    'Please confirm the support condition (cantilever, simply supported, fixed-fixed, or fixed-pinned).'
  );
}

function buildLoadTypeQuestion(type: InferredModelType, locale: AppLocale): string {
  switch (type) {
    case 'beam':
      return localize(locale, '请确认荷载形式（点荷载或均布荷载）。', 'Please confirm the load type (point or distributed).');
    case 'column':
      return localize(locale, '请确认柱荷载形式（通常为柱顶轴向点荷载）。', 'Please confirm the column load type (usually a top axial point load).');
    case 'portal-frame':
      return localize(locale, '请确认门式刚架荷载形式（柱顶节点点荷载或檐梁均布荷载）。', 'Please confirm the portal-frame load type (top-node point load or distributed load on the rafter).');
    case 'double-span-beam':
      return localize(locale, '请确认连续梁荷载形式（指定节点点荷载，或指定跨/全跨均布荷载）。', 'Please confirm the continuous-beam load type (a point load at a specified joint, or a distributed load over specified/all spans).');
    case 'truss':
      return localize(locale, '请确认桁架荷载形式（当前建议使用节点点荷载）。', 'Please confirm the truss load type (node point load is currently recommended).');
    default:
      return localize(locale, '请确认荷载形式（点荷载或均布荷载）。', 'Please confirm the load type (point or distributed).');
  }
}

function buildLoadPositionQuestion(type: InferredModelType, locale: AppLocale): string {
  switch (type) {
    case 'beam':
      return localize(locale, '请确认荷载位置（可说端部/跨中/全跨，也可直接给距左端 x m）。', 'Please confirm the load position (end / midspan / full span), or provide an offset x m from the left end.');
    case 'column':
      return localize(locale, '请确认柱荷载位置（通常为柱顶节点）。', 'Please confirm the column load position (usually the top joint).');
    case 'portal-frame':
      return localize(locale, '请确认荷载位置（柱顶节点/檐梁全跨）。', 'Please confirm the load position (top nodes / full rafter span).');
    case 'double-span-beam':
      return localize(locale, '请确认荷载位置或作用跨（指定节点/指定跨/全部跨）。', 'Please confirm the load position or loaded spans (specified joint / specified spans / all spans).');
    case 'truss':
      return localize(locale, '请确认荷载位置（受力节点）。', 'Please confirm the loaded joint.');
    default:
      return localize(locale, '请确认荷载位置。', 'Please confirm the load position.');
  }
}

export function buildInteractionQuestions(
  missingKeys: string[],
  criticalMissing: string[],
  draft: DraftState,
  locale: AppLocale,
): InteractionQuestion[] {
  return missingKeys.map((paramKey) => {
    const critical = criticalMissing.includes(paramKey);
    let question: InteractionQuestion;
    switch (paramKey) {
      case 'inferredType':
        question = {
          paramKey,
          label: localize(locale, '结构体系', 'Structural system'),
          question: localize(locale, '请描述结构体系与构件连接关系（不限类型）；也可以直接提供可计算的结构模型 JSON。', 'Please describe the structural system and member connectivity (any type). You can also provide a computable structural model JSON directly.'),
          required: true,
          critical,
        };
        break;
      case 'lengthM':
        question = { paramKey, label: localize(locale, '跨度/长度', 'Span / length'), question: localize(locale, '请确认跨度或长度。', 'Please confirm the span or length.'), unit: 'm', required: true, critical };
        break;
      case 'spanLengthM':
        question = { paramKey, label: localize(locale, '每跨跨度', 'Span per bay'), question: localize(locale, '请确认门式刚架或双跨梁每跨跨度。', 'Please confirm the span length for each bay of the portal frame or double-span beam.'), unit: 'm', required: true, critical };
        break;
      case 'heightM':
        question = { paramKey, label: localize(locale, '柱高', 'Column height'), question: localize(locale, '请确认门式刚架柱高。', 'Please confirm the portal-frame column height.'), unit: 'm', required: true, critical };
        break;
      case 'supportType':
        question = { paramKey, label: localize(locale, '支座条件', 'Support condition'), question: buildSupportTypeQuestion(locale), required: true, critical, suggestedValue: 'simply-supported' };
        break;
      case 'frameDimension':
        question = { paramKey, label: localize(locale, '框架维度', 'Frame dimension'), question: localize(locale, '请确认这是 2D 平面框架还是 3D 规则轴网框架。', 'Please confirm whether this is a 2D planar frame or a 3D regular-grid frame.'), required: true, critical, suggestedValue: '2d' };
        break;
      case 'storyCount':
        question = { paramKey, label: localize(locale, '层数', 'Story count'), question: localize(locale, '请确认框架层数。', 'Please confirm the number of stories.'), required: true, critical };
        break;
      case 'bayCount':
        question = { paramKey, label: localize(locale, '跨数', 'Bay count'), question: localize(locale, '请确认 2D 框架跨数。', 'Please confirm the number of bays for the 2D frame.'), required: true, critical };
        break;
      case 'bayCountX':
        question = { paramKey, label: localize(locale, 'X向跨数', 'Bay count in X'), question: localize(locale, '请确认 3D 框架 X 向跨数。', 'Please confirm the number of bays in the X direction for the 3D frame.'), required: true, critical };
        break;
      case 'bayCountY':
        question = { paramKey, label: localize(locale, 'Y向跨数', 'Bay count in Y'), question: localize(locale, '请确认 3D 框架 Y 向跨数。', 'Please confirm the number of bays in the Y direction for the 3D frame.'), required: true, critical };
        break;
      case 'storyHeightsM':
        question = { paramKey, label: localize(locale, '层高', 'Story heights'), question: localize(locale, '请确认各层层高；若各层相同，也可以直接提供统一层高。', 'Please confirm the story heights. If all stories are identical, you can provide one common story height.'), unit: 'm', required: true, critical };
        break;
      case 'bayWidthsM':
        question = { paramKey, label: localize(locale, '各跨跨度', 'Bay widths'), question: localize(locale, '请确认 2D 框架各跨跨度；若相同，也可以直接提供统一跨度。', 'Please confirm the bay widths for the 2D frame. If all bays are identical, you can provide one common bay width.'), unit: 'm', required: true, critical };
        break;
      case 'bayWidthsXM':
        question = { paramKey, label: localize(locale, 'X向各跨跨度', 'Bay widths in X'), question: localize(locale, '请确认 3D 框架 X 向各跨跨度。', 'Please confirm the bay widths in the X direction for the 3D frame.'), unit: 'm', required: true, critical };
        break;
      case 'bayWidthsYM':
        question = { paramKey, label: localize(locale, 'Y向各跨跨度', 'Bay widths in Y'), question: localize(locale, '请确认 3D 框架 Y 向各跨跨度。', 'Please confirm the bay widths in the Y direction for the 3D frame.'), unit: 'm', required: true, critical };
        break;
      case 'floorLoads':
        question = { paramKey, label: localize(locale, '各层总荷载', 'Per-floor total load'), question: localize(locale, '请确认各层总荷载（该总荷载将均匀分配到该层所有节点上；至少给出每层竖向荷载；2D 框架可补水平荷载，3D 框架可补 X/Y 向水平荷载）。', 'Please confirm the per-floor total load. The value will be distributed equally across all nodes on that floor. At minimum provide the vertical load for each story; you may also add lateral loads in X for 2D or X/Y for 3D.'), unit: 'kN', required: true, critical };
        break;
      case 'loadKN':
        question = { paramKey, label: localize(locale, '荷载', 'Load'), question: localize(locale, '请确认控制荷载大小。', 'Please confirm the controlling load magnitude.'), unit: 'kN', required: true, critical };
        break;
      case 'loadType':
        question = { paramKey, label: localize(locale, '荷载形式', 'Load type'), question: buildLoadTypeQuestion(draft.inferredType, locale), required: true, critical, suggestedValue: 'point' };
        break;
      case 'loadPosition':
        question = { paramKey, label: localize(locale, '荷载位置', 'Load position'), question: buildLoadPositionQuestion(draft.inferredType, locale), required: true, critical };
        break;
      default:
        question = { paramKey, label: paramKey, question: localize(locale, `请确认参数 ${paramKey}。`, `Please confirm parameter ${paramKey}.`), required: true, critical };
        break;
    }
    const issue = draft.draftIssues?.find((candidate) => candidate.field === paramKey);
    if (!issue) {
      return question;
    }
    const issueQuestion = issue.question?.trim();
    const issueReason = issue.reason.trim();
    return {
      ...question,
      question: issueQuestion ? `${issueReason} ${issueQuestion}` : issueReason,
      suggestedValue: undefined,
    };
  });
}
