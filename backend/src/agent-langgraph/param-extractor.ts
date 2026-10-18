/**
 * Helper for extracting structural engineering parameters from user messages.
 *
 * The extraction logic is driven by the skill manifest and draft-stage
 * markdown. Keep this as a direct LLM call instead of a nested ReAct agent:
 * some OpenAI-compatible providers reject the nested agent's reconstructed
 * internal messages with "role information cannot be empty".
 */
import {
  createChatModel,
  extractLlmTokenUsage,
  getReasoningContentLength,
  type LlmTokenUsage,
} from '../utils/llm.js';
import { logger as rootLogger } from '../utils/agent-logger.js';
import type { Logger } from 'pino';
import type { AgentSkillPlugin, DraftState } from '../shared/types/agent.js';
import { currentRunPolicy, requestRecovery } from '../runtime/run-context.js';
import { llmContentText } from '../utils/llm-content.js';
import { promptContract } from '../engineering/draft-contract.js';
import { currentDraftDiagnostics } from '../agent-runtime/draft-diagnostics.js';

// ---------------------------------------------------------------------------
// Skill context
// ---------------------------------------------------------------------------

function buildSkillInfo(plugin: AgentSkillPlugin): Record<string, unknown> {
  return {
    skillId: plugin.id,
    name: plugin.name,
    ...(currentRunPolicy()?.knowledge !== 'disabled' ? { description: plugin.description, stages: plugin.stages } : {}),
    structureType: plugin.structureType,
    draftStageGuidance: getDraftStageGuidance(plugin),
  };
}

function getDraftStageGuidance(plugin: AgentSkillPlugin): string {
  if (currentRunPolicy()?.knowledge === 'disabled') return '';
  return plugin.markdownByStage.draft
    || plugin.markdownByStage.intent
    || '(no draft-stage guidance)';
}

function isSerializedUndefined(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return record.lc === 2 && record.type === 'undefined' && Object.keys(record).length === 2;
}

function cleanPromptState(value: unknown, keyPath: string[] = []): unknown {
  if (value === undefined || isSerializedUndefined(value)) {
    return undefined;
  }
  if (Array.isArray(value)) {
    const cleanedArray = value
      .map((item) => cleanPromptState(item, keyPath))
      .filter((item) => item !== undefined);
    return cleanedArray.length > 0 ? cleanedArray : undefined;
  }
  if (value && typeof value === 'object') {
    const key = keyPath[keyPath.length - 1];
    if (key === 'draftIssues') {
      return undefined;
    }
    const metadataKeys = new Set([
      'updatedAt',
      'skillId',
      'structuralTypeKey',
      'supportLevel',
      'supportNote',
      'coordinateSemantics',
      'extractionSource',
    ]);
    const cleanedEntries = Object.entries(value as Record<string, unknown>)
      .filter(([entryKey]) => !metadataKeys.has(entryKey))
      .filter(([entryKey]) => !(key === 'skillState' && (
        entryKey === 'invalidDraftFields'
        || entryKey === 'engineeringDraft'
      )))
      .map(([entryKey, item]) => [entryKey, cleanPromptState(item, [...keyPath, entryKey])] as const)
      .filter(([, item]) => item !== undefined);
    if (cleanedEntries.length === 0) {
      return undefined;
    }
    return Object.fromEntries(cleanedEntries);
  }
  return value;
}

function engineeringDraftSchemaDescription(locale: 'zh' | 'en'): string {
  const updateContract = 'Draft update protocol / 草稿更新协议: omitted fields stay unchanged; nested objects and record arrays merge by stable ID. To delete an existing field, emit top-level clearDraftFields: [\'sectionRecords["S1"].standard_steel_name\']; omission DOES NOT delete it. Clear operations run atomically BEFORE engineeringDraft updates. To replace an entire shape or properties object, clear that object and provide its replacement. Use exact existing IDs, never array indexes; do not clear identity or input evidence. Only clear fields the latest user explicitly withdrew or replaced. / 省略不等于删除；用户明确“不使用目录名”时必须输出对应 clearDraftFields，不能只在新补丁省略目录名。仅改厚度时保留其他尺寸和未变属性；更换截面来源时明确清除被替代的旧来源，不得删除用户未撤回的冲突证据。';
  const sectionSources = 'Section source / 截面来源: name is a display label; a designation never selects catalog data. standard_steel_name is only a native PKPM/YJK selector: never copy name into it and never combine it with shape/properties. A designation with four dimensions (HN300×150×6.5×9 or H300x150x6.5x9 = H×B×tw×tf in mm) is explicit geometry: write shape {kind:"H",H,B,tw,tf} and keep the designation in name (sharp-corner idealization). A designation without plate thicknesses (HN300×150) stays in name only; emit one missing draftIssue for that record\'s shape (tw, tf) and never invent thicknesses or properties. / 名称只是标签，不查目录。standard_steel_name 仅为 PKPM/YJK 原生选择器，不复制名称，也不与 shape/properties 并存。四项尺寸型号（HN300×150×6.5×9 或 H300x150x6.5x9，即 H×B×tw×tf，mm）即明确几何：写 shape {kind:"H",H,B,tw,tf}，名称保留型号（无圆角理想化）。缺板厚的型号（HN300×150）只保留名称，并对该截面 shape 提出一项缺项（tw、tf），不得编造厚度或属性。';
  const seismicEvidence = '"seismicMemberEvidence": {"byElementId": {"<stable member ID>": {"seismicCapacity": {}, "capacityDesign": {}, "strongShearWeakBending": {}, "shearCompression": {}, "jointCore": {}, "wallData": {}, "boundaryElement": {}, "steelSeismicDetailing": {}}}}. Preserve supplied seismic evidence in this top-level field or skillState.seismicWorkflow.memberEvidence. / 抗震构件证据保留在此顶层字段或抗震工作流中，不把证据生成验算结论。';
  if (locale === 'zh') {
    return [
      'engineeringDraft uses this generated contract. All fields may be omitted in a partial draft; preserve explicitly supplied values and stable IDs. / 草稿允许缺项，但不得编造信息：',
      JSON.stringify(promptContract()),
      updateContract, sectionSources,
      seismicEvidence,
      'draftIssues: [{field: string, kind: missing|confirmation, severity: invalid|ambiguous|unrealistic|conflict, reason: string, question?: string}]. Use one exact field per issue with quoted stable IDs, e.g. materials["M1"].E. missing means absent data; confirmation means a present value needs user confirmation. Do not repeat a missing issue after supplying its value. Do not emit skillState.invalidDraftFields; the runtime derives it. / 缺项按当前值重新判断；确认与来源冲突单独保留。每项诊断对应一个字段和稳定ID，不维护第二份缺项列表。',
      '  // restraints 顺序严格为 [ux,uy,uz,rx,ry,rz]，true 表示约束。X-Z 平面铰支座为 [true,true,true,false,false,false]，沿全局 X 向可滑动的滚动支座为 [false,true,true,false,false,false]。',
      '  // 用户给出数值材料时使用 materials，不要把 E/G/nu/rho 放进仅保存牌号的 material。E/G 单位 MPa，rho 单位 kg/m³；材料设计强度放在 materials[].design.f/fv（MPa），basis 保存明确依据。保留明确给出的值，不猜牌号或设计强度，缺少必需属性时提出缺项。',
      '  // sections 保存用户给出的截面型号或角色名称；简单截面尺寸也可保留为 sections.beam="100X200"（矩形，宽×高，mm）或 "H300X150X6.5X9"（高×宽×腹板厚×翼缘厚，mm），不要替换成心算属性。',
      '  // 显式节点与连接表须保留 coordinateSystem 中用户指定的二维/三维及平面；二维 XZ 对应 dimension="2d", plane="xz"。不要仅根据坐标共面猜测分析维度。',
      '  // 显式拓扑的每项荷载写入 loadCases[].loads，包含 node/element 目标及有符号分量。只写工况 id/type 会丢失荷载；便捷 loads 仅供模板描述使用，不与 loadCases 重复存放同一力。',
      '  // 仅给几何时只保留 shape，完全省略 properties。矩形 B=宽、H=竖向高度，单位 mm；其他形状按其明确的 shape.kind 和尺寸保留。不计算或补写 A、Iy、Iz、J、截面模量等派生值，交由确定性几何程序计算。',
      '  // 只有用户或附件明确给出的数值截面属性才写 properties，例如 {"id":string,"type":"custom","properties":{"A":number,"Iy":number}}；A 单位 m²、Iy/Iz/J 单位 m⁴，保留来源并正确换算单位。不要把几何描述替换成舍入后的 properties。',
      '  // 保留已有已确认记录中的 shape、properties、ID 及来源；本轮只更正明确改变的字段。若用户同时给了几何和数值属性，两者均保留并交由物理校验，不能删掉显式 properties 隐藏冲突，也不能用派生值覆盖用户数值。',
      '  // 用户明确适用于整类构件的设计输入保存到 templateAssignments.beam/column/member.design；member 仅表示用户明确声明对所有构件统一适用。具体角色覆盖统一字段，补参按字段合并，不丢弃未改变值。模板/新建模型会确定性写入对应 elements[].design；不依赖后续 edit_model 重述。',
      '  // design 字段示例：{"l0":number,"beta1":number,"phi_b":number,"btLimit":number,"lambdaLimit":number,"deflectionLimitN":number,"serviceability_result_keys":["case:LC1"],"basis":object}。l0 是明确给定的计算长度，单位 mm，禁止用网格单元长度代替；其余示例系数无量纲，挠度限值为 L/n 的 n。不输出 l0mm/memberDesignL0Mm 等别名，也不把这些值放进任意 designParameters。',
      '  // 仅针对已给稳定构件ID的设计输入放 topology.members[].design，不自行生成拓扑来存设计参数。不得凭牌号、支撑位置或规范名称补默认设计值。设计输入从不构成缺项：不要为设计强度、系数、限值、计算长度或使用工况输出draftIssues，只保存用户明确给出的数值；尚无规范字段的参数保存 metadata.unmappedDesignParameters，不能声称已用于校核。',
      '  // 明确“考虑自重”或“不计自重”时必须分别保留 self_weight=true 或 false；自重工况和其他分析控制仅按明确输入保留，不猜测。',
      '"skillState": {',
      '  "seismicWorkflow": {',
      '    "methodPreference": "auto|response_spectrum|time_history|pushover|elastic_plastic_time_history",',
      '    "designBasis": { "codes": string[], "region": string, "regionCode": string, "siteSeismic": { "intensity": number, "accelerationG": number, "designGroup": string, "siteCategory": string }, "groundMotionZonation": { "source": string, "records": object[] } },',
      '    "designRequirements": { "fortificationCategory": string, "seismicGrade": number, "irregularity": string, "supplementaryTimeHistory": boolean },',
      '    "structure": { "heightM": number, "storyCount": number },',
      '    "groundMotionSet": { "source": "uploaded|builtin_artificial|local_catalog", "requiredCount": number, "records": object[], "catalogIds": string[], "localCatalog": { "records": object[] }, "selectionCriteria": object, "scaleFactorLimit": number },',
      '    "memberEvidence": { "byElementId": { "E1": { "seismicCapacity": object, "capacityDesign": object, "strongShearWeakBending": object, "shearCompression": object, "jointCore": object, "wallData": object, "boundaryElement": object, "steelSeismicDetailing": object } } },',
      '    "responseSpectrum": { "modalCombination": "cqc|srss" },',
      '    "directions": ["x","y"]',
      '  }',
      '}',
    ].join('\n');
  }
  return [
      'engineeringDraft uses this generated contract. All fields may be omitted in a partial draft; preserve explicitly supplied values and stable IDs. / 草稿允许缺项，但不得编造信息：',
      JSON.stringify(promptContract()),
      updateContract, sectionSources,
      seismicEvidence,
      'draftIssues: [{field: string, kind: missing|confirmation, severity: invalid|ambiguous|unrealistic|conflict, reason: string, question?: string}]. Use one exact field per issue with quoted stable IDs, e.g. materials["M1"].E. missing means absent data; confirmation means a present value needs user confirmation. Do not repeat a missing issue after supplying its value. Do not emit skillState.invalidDraftFields; the runtime derives it. / 缺项按当前值重新判断；确认与来源冲突单独保留。每项诊断对应一个字段和稳定ID，不维护第二份缺项列表。',
    '  // restraints are exactly [ux,uy,uz,rx,ry,rz], where true means restrained. In an X-Z model, a pin is [true,true,true,false,false,false] and a roller free in global X is [false,true,true,false,false,false].',
      '  // Use materials for numerical material properties; material stores grade metadata only. E/G are MPa and rho is kg/m³. Material design strengths belong to materials[].design.f/fv in MPa; basis records their declared source. Preserve explicit values; never guess a grade or design strength. Report missing required properties.',
      '  // sections retains user-supplied section designations or role names. Simple geometry may also remain as sections.beam="100X200" (rectangular width×depth, mm) or "H300X150X6.5X9" (depth×width×web thickness×flange thickness, mm); never replace it with calculated properties.',
      '  // Explicit node/connectivity records retain the user-declared analysis dimension and plane in coordinateSystem: 2D XZ means dimension="2d", plane="xz". Coplanar coordinates alone do not establish the analysis dimension.',
      '  // For explicit topology, put every actual load inside loadCases[].loads with node/element target and signed components. A case id/type alone loses the load. Convenience loads describe templates; do not duplicate the same force in both locations.',
      '  // For geometry-only input, retain shape and OMIT properties completely. For rectangles B is width and H is vertical depth, in mm; preserve the explicit shape.kind and dimensions of other shapes. Do not calculate or add A, Iy, Iz, J or section moduli; deterministic geometry code derives them.',
      '  // Write properties only for numerical section properties explicitly supplied by the user or attachments, e.g. {"id":string,"type":"custom","properties":{"A":number,"Iy":number}}. A is in m² and Iy/Iz/J in m⁴; preserve their source and convert units correctly. Never replace geometry with rounded properties.',
      '  // Preserve shape, properties, IDs and sources in existing confirmed records; amend only fields explicitly changed this turn. When geometry and numerical properties are both supplied, retain both for physics validation. Never delete explicit properties to hide a conflict or overwrite user values with derived ones.',
      '  // Store explicitly role-wide member design inputs in templateAssignments.beam/column/member.design. member means an explicitly declared uniform assignment to all members. A specific role amends uniform fields; clarification patches preserve unchanged values. Templates and new models deterministically project these inputs to elements[].design without a later edit_model restatement.',
      '  // Supported design input examples: {"l0":number,"beta1":number,"phi_b":number,"btLimit":number,"lambdaLimit":number,"deflectionLimitN":number,"serviceability_result_keys":["case:LC1"],"basis":object}. l0 is a declared effective length in mm, never the mesh element length; the other example coefficients are dimensionless and deflectionLimitN is n in L/n. Do not emit aliases l0mm/memberDesignL0Mm or place these values in arbitrary designParameters.',
      '  // For supplied stable member IDs use topology.members[].design; never invent topology to store design inputs. Do not infer design defaults from grades, supports or a code name. Design inputs are never missing items: do not emit draftIssues for design strengths, coefficients, limits, effective lengths or service keys; store only values the user explicitly supplied. Preserve unsupported parameters under metadata.unmappedDesignParameters and never claim that they were used by the checker.',
      '  // Explicitly include or exclude self-weight using self_weight=true or false. Preserve the stated self-weight case and other analysis controls; never guess unstated controls.',
    '"skillState": {',
    '  "seismicWorkflow": {',
    '    "methodPreference": "auto|response_spectrum|time_history|pushover|elastic_plastic_time_history",',
    '    "designBasis": { "codes": string[], "region": string, "regionCode": string, "siteSeismic": { "intensity": number, "accelerationG": number, "designGroup": string, "siteCategory": string }, "groundMotionZonation": { "source": string, "records": object[] } },',
    '    "designRequirements": { "fortificationCategory": string, "seismicGrade": number, "irregularity": string, "supplementaryTimeHistory": boolean },',
      '    "structure": { "heightM": number, "storyCount": number },',
      '    "groundMotionSet": { "source": "uploaded|builtin_artificial|local_catalog", "requiredCount": number, "records": object[], "catalogIds": string[], "localCatalog": { "records": object[] }, "selectionCriteria": object, "scaleFactorLimit": number },',
      '    "memberEvidence": { "byElementId": { "E1": { "seismicCapacity": object, "capacityDesign": object, "strongShearWeakBending": object, "shearCompression": object, "jointCore": object, "wallData": object, "boundaryElement": object, "steelSeismicDetailing": object } } },',
      '    "responseSpectrum": { "modalCombination": "cqc|srss" },',
      '    "directions": ["x","y"]',
      '  }',
    '}',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

export function buildParamExtractorPrompt(
  locale: 'zh' | 'en',
  existingState: DraftState | undefined,
  plugin: AgentSkillPlugin,
  message: string,
  focusFields: string[] = [],
): string {
  if (focusFields.length > 0) {
    return buildFocusedParamExtractorPrompt(locale, existingState, plugin, message, focusFields);
  }

  const stateJson = JSON.stringify(cleanPromptState(existingState) ?? {}, null, 2);
  const skillInfoJson = JSON.stringify(buildSkillInfo(plugin), null, 2);
  const draftStageGuidance = getDraftStageGuidance(plugin);

  if (locale === 'zh') {
    return [
      '你是结构工程参数提取专家。',
      '',
      '当前结构技能参数说明：',
      skillInfoJson,
      '',
      '根据上面的参数说明，从用户消息中提取工程参数，输出一个 JSON 对象。',
      engineeringDraftSchemaDescription(locale),
      '',
      '规则：',
      '- 优先输出 engineeringDraft；为了兼容旧链路，也可以同时输出 draftPatch',
      '- draftPatch 字段名必须与当前结构技能参数说明一致',
      '- 长度单位 m，力单位 kN，线荷载 kN/m，面荷载 kN/m2',
      '- 已有 draftState 由系统保留；本轮 JSON 只输出用户最新消息明确新增或更正的字段，不要重复未改变的旧参数',
      '- 已有 draftState 只代表已接受的参数；如果当前用户消息是在回答追问或更正缺失/无效字段，必须输出新给出的字段，不要重复旧的缺参或无效诊断',
      '- 不确定时省略字段，不要猜测',
      '- 不得补写用户未提供的荷载单位或荷载种类；若荷载数值没有单位，或“楼面荷载”等表述无法区分总力、线荷载或面荷载，必须省略该荷载，输出 draftIssues，要求用户确认单位和荷载种类',
      '- 如果用户给出数学上无效的几何尺寸、荷载符号/单位/位置含义不明确，或要求彼此矛盾，不要把相关值写入 engineeringDraft/draftPatch；输出 draftIssues。数值仅仅非常规或很大/很小并不自动构成无效输入',
      '- 负号可能表示方向或吸力时，必须用 draftIssues 标记为 ambiguous 并追问；只有方向明确且数值大小为正时，才写入荷载 magnitude',
      '- 对框架楼面线荷载/面荷载（如 kN/m、kN/m2），如果已有层数和跨度信息，应输出 engineeringDraft.loads 中的 line/area 荷载；不要因为它不是总 kN 就追问',
      '- 对“基本风压 / basic wind pressure”输出 engineeringDraft.wind.basicPressureKNM2；不要把风压当作竖向楼面荷载',
      '- 当用户提出中国抗震、反应谱、时程、Pushover、弹塑性时程、设防烈度、设计地震分组、场地类别或地震波选择等抗震设计意图时，必须基于整句语义输出 skillState.seismicWorkflow；方法选择只允许来自语义理解后的结构化字段，不要用关键词或正则匹配决定 response_spectrum/time_history/pushover/elastic_plastic_time_history',
      '- 如果用户提供 GB18306 区划表、地震波文件或本地地震波库，只把已提供的数据映射到 seismicWorkflow.designBasis.groundMotionZonation 或 seismicWorkflow.groundMotionSet；不要根据城市名或自然语言自行编造烈度、分组、特征周期或地震波记录',
      '- 如果用户提供构件抗震承载力、gammaRE、强剪弱弯、剪压比、节点核芯区、抗震墙边缘构件、钢构件长细比或宽厚比证据，必须保留为结构化 seismicMemberEvidence 或 seismicWorkflow.memberEvidence；不要把证据只写成自然语言备注，也不要由 LLM 判断条文通过或失败',
      '- 嵌套数组字段必须输出完整对象；例如 floorLoads 的每一项都必须包含 story',
      '- 如果用户明确给出多个荷载，每个荷载都必须作为 engineeringDraft.loads 的独立条目输出，不要合并或丢弃集中力/节点力',
      '- 如果用户明确区分荷载工况，必须在每个荷载中保留 caseId 和 caseType；如果明确给出荷载组合，必须原样输出 engineeringDraft.analysis.loadCombinations，不得把不同工况预先合并；只分析某工况、系数1不代表新增组合。用户明确不新增组合时loadCombinations为空数组，不得凭规范名称自行生成组合',
      '- 源面荷载及其按受荷宽度折算得到的线荷载不是两个独立荷载；若用户要求采用折算结果，只输出折算后的线荷载，除非用户明确要求两者叠加',
      '- 如果用户或附件摘要明确给出节点坐标和构件连接关系，必须原样输出 engineeringDraft.topology，不要用规则化拓扑替换',
      '- 用户只给简单梁模板描述而未给节点坐标/连接表时，保留 geometry/boundary/loads，不自行生成 topology。requestScope.responses 必须包含整句所求全部响应（例如同时求弯矩和挠度为 forces、displacements）；design 仅在用户明确要求规范验算（验算、校核、按规范、规范检查、code check）时为 true，“设计/设计一个梁”不算；report 仅在用户要求报告、计算书或其他交付文件时为 true，“设计/设计一个梁”和只求具体结果时为 false；只求内力时不需要材料截面；outputs 先留空数组，等待模型对象ID后再查询，不能填输出名称字符串',
      '- 不输出元数据字段（updatedAt, skillId, structuralTypeKey, supportLevel, coordinateSemantics, supportNote）',
      '- 不要为了补齐字段而猜测未明确给出的工程参数',
      '- 不要 markdown 包装或解释',
      '',
      '当前 draft 阶段重点说明：',
      draftStageGuidance,
      '',
      `已有 draftState:\n${stateJson}`,
      '',
      `用户消息:\n${message}`,
    ].join('\n');
  }

  return [
    'You are a structural engineering parameter extraction specialist.',
    '',
    'Current structural skill parameter guidance:',
    skillInfoJson,
    '',
    'Extract engineering parameters from the user message based on the guidance above, and output a JSON object.',
    'For a simple beam template without supplied node coordinates/connectivity, retain geometry/boundary/loads; do not invent topology. requestScope.responses includes every requested response (moment and deflection require forces and displacements). design is true only for an explicit code-check request (验算, 校核, 按规范, code check, check against GB…); words such as design/设计 do not request it. report is true only when the user asks for a report, a calculation book or another deliverable document; design wording and specific results alone leave it false; forces alone need no material or section. Leave outputs as [] until model object IDs are known; never supply output-name strings.',
    engineeringDraftSchemaDescription(locale),
    '',
    'Rules:',
    '- Prefer engineeringDraft; you may also include draftPatch for legacy compatibility',
    '- draftPatch field names MUST match the current structural skill parameter guidance',
    '- Length in meters, force in kN, line load in kN/m, area load in kN/m2',
    '- Existing draftState values are preserved by the system; output only fields explicitly added or corrected by the latest user message, without repeating unchanged prior parameters',
    '- Treat the existing draftState as accepted parameters only; if the current user message answers a clarification question or corrects a missing/invalid field, output the newly provided field instead of repeating the old missing/invalid diagnostic',
      '- Omit fields you are unsure about — do NOT guess',
      '- Never supply a load unit or load kind that the user did not provide; if a load magnitude has no unit, or wording such as "floor load" does not distinguish total force, line load, or area load, omit that load, output draftIssues and and ask the user to confirm the unit and load kind',
      '- If geometry is mathematically invalid, a load sign/unit/location is ambiguous, or requirements contradict one another, do NOT write the affected value into engineeringDraft/draftPatch; output draftIssues. An unusual, large, or small value is not invalid by magnitude alone',
    '- If a negative sign may mean direction or suction/uplift, mark it as an ambiguous draftIssue and ask for clarification; only write a load magnitude when the direction is clear and the magnitude is positive',
    '- For frame floor line/area loads such as kN/m or kN/m2, output line/area entries in engineeringDraft.loads when story and span geometry are available; do not ask for total kN just because the user provided intensity units',
    '- For basic wind pressure, output engineeringDraft.wind.basicPressureKNM2; do not treat wind pressure as a vertical floor load',
    '- When the user asks for China seismic design, response spectrum, time history, pushover, elastic-plastic time history, seismic intensity, design group, site class, or ground-motion selection, output skillState.seismicWorkflow from whole-message semantic understanding; method selection may only come from structured semantic fields, never keyword or regex matching',
    '- If the user provides a GB18306 zonation table, ground-motion files, or a local ground-motion catalog, map only the provided data into seismicWorkflow.designBasis.groundMotionZonation or seismicWorkflow.groundMotionSet; do not invent intensity, design group, characteristic period, or ground-motion records from city names or prose',
    '- If the user provides member seismic capacity, gammaRE, capacity-design, strong-shear weak-bending, shear-compression, joint-core, seismic-wall boundary-element, steel slenderness, or steel width-thickness evidence, preserve it as structured seismicMemberEvidence or seismicWorkflow.memberEvidence; do not leave it only as prose and do not have the LLM decide clause pass/fail status',
      '- Nested array fields must contain complete objects; for example each floorLoads item must include story',
      '- If the user explicitly gives multiple loads, output each load as its own engineeringDraft.loads entry; do not merge or drop point/nodal loads',
      '- If the user explicitly distinguishes load cases, preserve caseId and caseType on every load; if a load combination is explicit, reproduce it in engineeringDraft.analysis.loadCombinations without pre-combining the cases. Analyzing a single case at factor 1 does not create a combination. If the user explicitly excludes new combinations, loadCombinations is an empty array; a design-code name does not authorize invented combinations',
      '- A source area load and the line load derived from it by tributary width are not independent loads; when the user says to apply the converted result, emit only the derived line load unless the user explicitly requires both to be superimposed',
    '- If the user or attachment summary explicitly gives node coordinates and member connectivity, preserve them in engineeringDraft.topology instead of replacing them with a regularized topology',
    '- Do NOT output metadata fields (updatedAt, skillId, structuralTypeKey, supportLevel, coordinateSemantics, supportNote)',
    '- Do not guess engineering parameters that are not clear from the message',
    '- No markdown fences, no explanations',
    '',
    'Current draft-stage guidance:',
    draftStageGuidance,
    '',
    `Existing draftState:\n${stateJson}`,
    '',
    `User message:\n${message}`,
  ].join('\n');
}

function buildFocusedParamExtractorPrompt(
  locale: 'zh' | 'en',
  existingState: DraftState | undefined,
  plugin: AgentSkillPlugin,
  message: string,
  focusFields: string[],
): string {
  const stateJson = JSON.stringify(cleanPromptState(existingState) ?? {}, null, 2);
  const skillInfoJson = JSON.stringify(buildSkillInfo(plugin), null, 2);
  const draftStageGuidance = getDraftStageGuidance(plugin);
  const focusJson = JSON.stringify(focusFields);

  if (locale === 'zh') {
    return [
      '你是结构工程参数提取专家，正在处理多轮澄清回答。',
      '',
      '目标：只从用户最新回答中补齐或更正指定缺失字段；不要重新生成整套模型，也不要只重复已有参数。',
      '',
      '当前结构技能：',
      skillInfoJson,
      '',
      '当前 draft 阶段重点说明：',
      draftStageGuidance,
      '',
      `本轮重点字段：${focusJson}`,
      '',
      '输出一个 JSON 对象。优先输出 engineeringDraft；为了兼容旧链路，也可以同时输出 draftPatch。',
      engineeringDraftSchemaDescription(locale),
      '',
      '规则：',
      '- 已有 draftState 由系统保留；本轮 JSON 只输出用户最新回答明确补充或更正的重点字段',
      '- 如果用户最新回答明确提供了本轮重点字段，必须输出该字段对应的 engineeringDraft/draftPatch',
      '- 不要把旧的缺参诊断或无效诊断重复输出为本轮结果',
      '- 不确定时省略字段，不要猜测',
      '- 若本轮荷载数值仍没有单位，或仍无法区分总力、线荷载或面荷载，不得自行补写；输出 draftIssues，并继续要求确认单位和荷载种类',
      '- 不要 markdown 包装或解释',
      '',
      `已有 draftState:\n${stateJson}`,
      '',
      `用户最新回答:\n${message}`,
    ].join('\n');
  }

  return [
    'You are a structural engineering parameter extraction specialist handling a multi-turn clarification answer.',
    '',
    'Goal: fill or correct only the specified missing fields from the latest user answer; do not regenerate the whole model and do not merely repeat existing parameters.',
    '',
    'Current structural skill:',
    skillInfoJson,
    '',
    'Current draft-stage guidance:',
    draftStageGuidance,
    '',
    `Focus fields for this turn: ${focusJson}`,
    '',
    'Output a JSON object. Prefer engineeringDraft; you may also include draftPatch for legacy compatibility.',
    engineeringDraftSchemaDescription(locale),
    '',
    'Rules:',
    '- Existing draftState values are preserved by the system; output only focus fields explicitly supplied or corrected by the latest user answer',
    '- If the latest user answer clearly provides a focus field, you MUST output the corresponding engineeringDraft/draftPatch field',
    '- Do not repeat old missing/invalid diagnostics as the result for this turn',
    '- Omit fields you are unsure about; do not guess',
    '- If the latest load magnitude still has no unit, or still does not distinguish total force, line load, or area load, do not supply one; output draftIssues and continue asking for the unit and load kind',
    '- No markdown fences, no explanations',
    '',
    `Existing draftState:\n${stateJson}`,
    '',
    `Latest user answer:\n${message}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// JSON parsing (reuses logic from executor.ts)
// ---------------------------------------------------------------------------

function parseJsonObject(content: string): Record<string, unknown> | null {
  const trimmed = content.trim();
  const direct = tryParseJson(trimmed);
  if (direct) return direct;

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    const parsed = tryParseJson(fenced[1]);
    if (parsed) return parsed;
  }

  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) {
    return tryParseJson(trimmed.slice(first, last + 1));
  }

  return null;
}

function tryParseJson(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function looksLikeTopLevelEngineeringDraft(parsed: Record<string, unknown>): boolean {
  if (isRecord(parsed.engineeringDraft) || isRecord(parsed.draftPatch)) {
    return false;
  }
  return (
    isRecord(parsed.geometry)
    || isRecord(parsed.material)
    || isRecord(parsed.sections)
    || isRecord(parsed.boundary)
    || Array.isArray(parsed.loads)
    || isRecord(parsed.analysis)
  );
}

function unwrapDraftPatch(parsed: Record<string, unknown>): Record<string, unknown> {
  const engineeringDraft = parsed.engineeringDraft;
  const draftPatch = parsed.draftPatch;
  const supplemental = {
    ...(parsed.clearDraftFields !== undefined ? { clearDraftFields: parsed.clearDraftFields } : {}),
    ...(isRecord(parsed.requestScope) ? { requestScope: parsed.requestScope } : {}),
    ...(parsed.skillState && typeof parsed.skillState === 'object' && !Array.isArray(parsed.skillState)
      ? { skillState: parsed.skillState }
      : {}),
    ...(Array.isArray(parsed.draftIssues) ? { draftIssues: parsed.draftIssues } : {}),
  };
  if (draftPatch && typeof draftPatch === 'object' && !Array.isArray(draftPatch)) {
    return {
      ...(draftPatch as Record<string, unknown>),
      ...(engineeringDraft && typeof engineeringDraft === 'object' && !Array.isArray(engineeringDraft)
        ? { engineeringDraft }
        : {}),
      ...supplemental,
    };
  }
  if (looksLikeTopLevelEngineeringDraft(parsed)) {
    return {
      ...(typeof parsed.inferredType === 'string' ? { inferredType: parsed.inferredType } : {}),
      engineeringDraft: parsed,
      ...supplemental,
    };
  }
  return parsed;
}

export function parseDraftPatchFromContent(content: string): Record<string, unknown> | null {
  const parsed = parseJsonObject(content);
  return parsed ? unwrapDraftPatch(parsed) : null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

interface ParamExtractorInput {
  message: string;
  existingState: DraftState | undefined;
  locale: 'zh' | 'en';
  plugin: AgentSkillPlugin;
  focusFields?: string[];
  /** Read-only projection of the actual V2 design schema, supplied by the tool. */
  designSchema?: Record<string, unknown>;
  sectionShapeSchema?: Record<string, unknown>;
  /** Per-request logger with traceId/conversationId. Falls back to root logger. */
  traceLogger?: Logger;
  /** Require structured LLM output rather than handler-only extraction. */
  requireLlmResult?: boolean;
  /** Cancels an in-flight extraction when the enclosing agent run is aborted. */
  signal?: AbortSignal;
  /** Records provider usage for nested-call reporting. */
  onUsage?: (usage: LlmTokenUsage) => void;
  /** Test injection; production callers use the configured chat model. */
  llm?: {
    invoke: (
      prompt: string,
      options?: { signal?: AbortSignal },
    ) => Promise<{
      content: unknown;
      response_metadata?: Record<string, unknown>;
      usage_metadata?: Record<string, unknown>;
    }>;
  } | null;
}

export async function invokeParamExtractor(
  input: ParamExtractorInput,
): Promise<Record<string, unknown> | null> {
  input = { ...input, existingState: input.existingState ? currentDraftDiagnostics(input.existingState) : undefined };
  const log = input.traceLogger ?? rootLogger;
  const pluginId = input.plugin.id;
  const locale = input.locale;
  log.info({ pluginId, locale }, 'param extractor started');

  const llm = input.llm === undefined ? createChatModel(0) : input.llm;
  if (!llm) {
    if (input.requireLlmResult) {
      throw new Error('LLM_PARAM_EXTRACTOR_CONFIGURATION_ERROR: no LLM is configured');
    }
    return null;
  }

  const start = Date.now();
  const prompt = buildParamExtractorPrompt(
    input.locale,
    input.existingState,
    input.plugin,
    input.message,
    input.focusFields,
  ) + '\nDesign field contract / 设计字段协议: design.basis is a map of nonempty strings, never booleans, numbers, arrays or nested objects. Descriptive assumptions belong in basis as evidence, not invented executable design fields. Preserve unsupported computational requests in metadata.unmappedDesignParameters and report them as unresolved; do not claim basis implements them. / design.basis的每个值必须是非空字符串；描述性假定作为依据保存，不要编造可执行设计字段。未知计算条件保留为metadata.unmappedDesignParameters待解决，不得声称写入basis就已实现。'
    + (input.designSchema ? `\nAuthoritative V2 design schema / 正式V2设计字段定义（只能使用所列字段）:\n${JSON.stringify(input.designSchema)}` : '')
    + (input.sectionShapeSchema ? `\nAuthoritative V2 section shape schema / 正式V2截面几何字段定义（单位mm，kind使用所列大小写，不能猜测尺寸或圆角）:\n${JSON.stringify(input.sectionShapeSchema)}` : '')
    + '\nRequest goal / 本次所求结果: include top-level requestScope only when this message changes the goal: {responses:[forces|reactions|displacements|rotations|stress|dynamic],design:boolean,report:boolean,outputs:[]}. design=true only for an explicit code-check request (验算/校核/按规范/code check); "design a beam" is not one. report=true only for a requested report, calculation book or other deliverable document; "design a beam" and specific results leave it false. Do not infer design from enabled skills. Missing material must not prevent this scope. Retain the prior goal for a clarification answer. / 仅明确要求规范验算时design=true，“设计”一词不算；仅要求报告、计算书或其他交付文件时report=true，“设计”和只求具体结果时为false；不因勾选技能而请求设计；缺少材料不妨碍声明范围；补参数时保留目标。';

  let result: {
    content: unknown;
    response_metadata?: Record<string, unknown>;
    usage_metadata?: Record<string, unknown>;
  };
  try {
    result = await llm.invoke(prompt, { signal: input.signal });
  } catch (error) {
    log.warn(
      {
        pluginId,
        durationMs: Date.now() - start,
        error: error instanceof Error ? error.message : String(error),
      },
      'param extractor LLM call failed',
    );
    throw new Error(
        `LLM_PARAM_EXTRACTOR_INFRASTRUCTURE_ERROR: network error: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
  }

  const usage = extractLlmTokenUsage(result);
  if (usage) input.onUsage?.(usage);
  const content = llmContentText(result.content);
  const patch = parseDraftPatchFromContent(content);
  const rawFinishReason = result.response_metadata?.finish_reason
    ?? result.response_metadata?.stop_reason;
  const finishReason = typeof rawFinishReason === 'string' ? rawFinishReason : undefined;
  const reasoningContentLength = getReasoningContentLength(result);
  log.debug(
    {
      pluginId,
      durationMs: Date.now() - start,
      hasDraftPatch: !!patch,
      finishReason,
      contentLength: content.length,
      reasoningContentLength,
    },
    'param extractor completed',
  );
  if (!patch && input.requireLlmResult) {
    throw new Error(
      'LLM_PARAM_EXTRACTOR_INVALID_OUTPUT: response was not a usable JSON draft patch; '
      + `finishReason=${finishReason ?? 'unknown'}; contentLength=${content.length}; `
      + `reasoningContentLength=${reasoningContentLength}`,
    );
  }
  if (!patch) requestRecovery('parameter extraction: unusable LLM output, applying explicit handler extraction');
  return patch;
}
