import type { AppLocale } from '../../../shared/locale.js';
import { getCommonConstraints } from './llm-model-prompt-fragments.js';
import { modelContract, promptContract } from '../../../engineering/draft-contract.js';
import { modellingOperationsContract } from '../../../skill-shared/modelling/contract.js';

type GenericModelPromptIntent = 'build-structure-model-v2';

type PromptIntentConfig = {
  opening: (locale: AppLocale) => string[];
  closing: (locale: AppLocale, stateHint: string, message: string, conversationHistory?: string) => string[];
};

const INTENT_CONFIGS: Record<GenericModelPromptIntent, PromptIntentConfig> = {
  'build-structure-model-v2': {
    opening: (locale) => {
      if (locale === 'zh') {
        return [
          '你是结构建模专家。',
          '请根据用户描述输出可计算的 StructureModel V2 JSON。',
          '只输出 JSON 对象，不要 Markdown。',
          '使用 {"schema_version":"2.2.0"} 和下方正式字段定义。节点、构件、属性及荷载全部依据本次用户资料建立；没有预设算例可复制。',
        ];
      }
      return [
        'You are a structural modeling expert.',
        'Generate a computable StructureModel V2 JSON from the user request.',
        'Return JSON object only, without markdown.',
        'Use {"schema_version":"2.2.0"} and the formal field definitions below. Generate nodes, members, properties and loads from this request; there is no preset example structure to copy.',
      ];
    },
    closing: (locale, stateHint, message, conversationHistory) => {
      const lines: string[] = [];
      if (conversationHistory) {
        lines.push(locale === 'zh' ? `对话历史:\n${conversationHistory}` : `Conversation history:\n${conversationHistory}`);
      }
      if (locale === 'zh') {
        lines.push(`已确认参数: ${stateHint}`);
        lines.push(`用户最新输入: ${message}`);
      } else {
        lines.push(`Confirmed parameters: ${stateHint}`);
        lines.push(`Latest user message: ${message}`);
      }
      return lines;
    },
  },
};

export function composePromptByIntent(
  intent: GenericModelPromptIntent,
  locale: AppLocale,
  stateHint: string,
  message: string,
  conversationHistory?: string,
): string {
  const config = INTENT_CONFIGS[intent];
  const opening = config.opening(locale);
  const constraints = getCommonConstraints(locale);
  const closing = config.closing(locale, stateHint, message, conversationHistory);
  return [...opening, ...constraints,
    locale === 'zh'
      ? '可以输出显式V2记录，也可以在同一JSON顶层输出operations数组，或混合两者。规则轴网与重复几何优先用操作，避免逐项心算和枚举数百条记录；系统确定性展开后执行相同的物理校核。几何用m，力用kN，线荷载用kN/m，面荷载用kN/m²。每项操作id唯一，生成对象使用id:作为前缀；规则框架节点N层_X索引_Y索引、柱C序号、梁BX/BY序号，二维梁B序号；桁架B/T节点与BC/TC/WV/WD杆件；折线/拱N从0开始、E从1开始。规则框架nodeIds以"层,X索引,Y索引"映射用户节点ID，折线/拱以节点序号映射。保留用户已给全部节点和构件ID，已有显式记录可作为操作的锚点。三维规则框架必须给bayWidthsY，其他操作需顶层coordinate_system.dimension明确二维或三维。加载操作按选择器逐个施加vector，而非把单节点力当成整层总量；上部节点可用coordinate:{axis:"z",gt:0}选择。复制只复制所选构件及端点，copyLoads=true才复制荷载；平移/镜像改变几何，荷载向量仍按其显式坐标声明。merge-coincident可指定preferredIds保留用户ID，不能删除受保护的用户标识。楼面传荷必须有明确矩形范围和方向，缺支承梁会报错。材料和截面ID必须与记录一致，不能用操作猜缺项；缺项一次返回missing_fields。'
      : 'Return explicit V2 records, a top-level operations array, or both. Prefer operations for regular grids and repeated geometry instead of enumerating hundreds of records. Expansion is deterministic and crosses the same physics validator. Units: geometry m, forces kN, UDL kN/m, pressure kN/m2. Each operation id is unique and prefixes generated IDs with id:. Frame nodes are Nstorey_Xindex_Yindex (2D omits Y), columns Cnumber, beams BX/BYnumber (2D Bnumber); trusses use B/T nodes and BC/TC/WV/WD members; polyline/arc nodes start at N0 and members at E1. Frame nodeIds maps "storey,Xindex,Yindex" to user IDs; polyline/arc nodeIds maps node indices. Preserve every supplied node/member ID; explicit records can anchor generated geometry. A 3D frame requires bayWidthsY; other geometry requires top-level coordinate_system.dimension. A load operation applies vector to EACH selected target, never confuses per-node forces with floor totals. Upper nodes can use coordinate:{axis:"z",gt:0}. Replication copies selected members and endpoints; copyLoads=true also copies loads. Translate/mirror change geometry while loads retain their explicit vector frame. merge-coincident preferredIds preserves user IDs; protected identities cannot be removed. Floor transfer needs explicit rectangular bounds and direction and fails if supporting beams are absent. Match material/section IDs to records; operations never justify guessing missing properties. Return missing_fields together when needed.',
    locale === 'zh'
      ? '构件选择器coordinate按端点中点计算，at=start/end可改用端点；coordinates数组用于多个坐标条件同时满足，parallelTo按端点方向选择平行全局x/y/z轴的构件。规则框架楼层的准确ID为操作id:F1、id:F2等，不猜测S3/story3别名。规则框架只初始化统一截面，随后assign-properties可按层或空间分组覆盖，无需简化设计。已确认的荷载标签尚未对应实体时，输出metadata.loadMappings:[{loadId:"原草稿荷载ID",selector:{...}}]，由LLM明确对应生成几何，不能遗漏、复制或合并荷载记录，不能改变原数值、方向、单位、工况ID或已明确作用目标；已有loads[].selector不能重写。保留原location.story楼层范围。每个选择器目标均须分别落实与核对，内梁、边梁等不同分组不得混合。'
      : 'Member coordinate selectors use endpoint midpoints; at=start/end selects an endpoint. coordinates combines multiple coordinate predicates with AND; parallelTo uses global-axis alignment. Exact regular-frame story IDs are operationId:F1, operationId:F2, etc.; never guess S3/story3 aliases. A regular frame seeds uniform sections; assign-properties can override storeys/groups without simplifying the design. Resolve confirmed load labels into generated geometry using metadata.loadMappings:[{loadId:"original draft load ID",selector:{...}}]. Do not omit, duplicate or merge load records, change confirmed magnitudes/directions/units/case IDs/explicit targets, or override existing loads[].selector. Preserve location.story scope. Apply and verify every selected target, retaining separate edge/interior groups.',
    `Modelling operations contract / 建模操作协议:\n${JSON.stringify(modellingOperationsContract)}`,
    locale === 'zh'
      ? '若已提供stories，用regular-frame.storyIds将从1起的层编号映射到已有楼层ID，不能再生成同标高的未引用重复楼层；elevation是层底标高。已确认的统一混凝土及纵筋牌号会按所引用混凝土材料写入构件，保留已确认的逐构件覆盖；未显式建模的钢筋不需要独立分析材料。'
      : 'For supplied stories, use regular-frame.storyIds to map one-based storey indices to existing IDs; never add unused duplicate storeys at the same elevation. Story elevation means storey base. Confirmed uniform concrete and reinforcement grades are compiled onto referenced concrete members, retaining confirmed member overrides; reinforcement without explicit members needs no separate analysis material.',
    `Authoritative model schema / 正式模型字段定义（模板仅为格式示例，不是用户模型）:\n${JSON.stringify(promptContract(modelContract))}`,
    ...closing].join('\n');
}
