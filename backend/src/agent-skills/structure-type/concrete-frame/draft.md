# Concrete Frame Skill – Draft Extraction

## Purpose
Extract a regular reinforced concrete frame model from a natural language description.

## Input Format
A single natural language paragraph describing the frame, e.g.:
- "A 3‑story 2‑bay concrete frame, story heights 3.5 m each, bay widths 6 m, concrete C30, rebar HRB400, fixed base."
- "混凝土框架，4层3跨，层高3.6 m，跨度7.2 m，混凝土C40，钢筋HRB400，固接基础。"

## Output Format
A `DraftExtraction` JSON object with the following optional keys (see `constants.ts` for the complete list):

### Geometry
| Key | Type | Example | Notes |
|-----|------|---------|-------|
| `frameDimension` | `"2d"` or `"3d"` | `"2d"` | Inferred from "planar", "space", "3‑d", "三维", etc. |
| `storyCount` | `number` | `3` | Number of stories (above ground). |
| `bayCount` | `number` | `2` | For 2D frames, total number of bays. |
| `bayCountX` | `number` | `3` | For 3D frames, number of bays in X direction. |
| `bayCountY` | `number` | `2` | For 3D frames, number of bays in Y direction. |
| `storyHeightsM` | `number[]` | `[3.5, 3.5, 3.5]` | Each story's height (m). Length must equal `storyCount`. |
| `bayWidthsM` | `number[]` | `[6.0, 6.0]` | For 2D frames, each bay's width (m). Length must equal `bayCount`. |
| `bayWidthsXM` | `number[]` | `[6.0, 6.0, 6.0]` | For 3D frames, bay widths in X direction. Length = `bayCountX`. |
| `bayWidthsYM` | `number[]` | `[5.0, 5.0]` | For 3D frames, bay widths in Y direction. Length = `bayCountY`. |

### Loads & Boundaries
| Key | Type | Example | Notes |
|-----|------|---------|-------|
| `floorLoads` | `Array<{ story: number; verticalKN?: number; lateralXKN?: number; lateralYKN?: number; liveLoadKN?: number }>` | `[{ story: 1, verticalKN: -200, lateralXKN: 50 }]` | Vertical load negative (downward). Lateral loads positive in global X/Y. |
| `frameBaseSupportType` | `"fixed"` or `"pinned"` | `"fixed"` | Only when stated; when omitted the template models fixed bases. |

### Materials & Sections
| Key | Type | Example | Notes |
|-----|------|---------|-------|
| `frameConcreteGrade` | `string` | `"C30"` | Concrete grade (C20–C80), only when the user gives one. |
| `frameRebarGrade` | `string` | `"HRB400"` | Rebar grade (HPB300, HRB400, HRB500), only when the user gives one. A code-check input; analysis never needs it, so never ask for it or default it. |
| `frameColumnSection` | `string` | `"400X400"` | Column cross‑section description. See section parsing below. |
| `frameBeamSection` | `"string"` | `"300X600"` | Beam cross‑section description. |

### Site, Seismic & Wind
| Key | Type | Example | Notes |
|-----|------|---------|-------|
| `siteSeismic` | `object` | `{ "intensity": 7, "accelerationG": 0.1, "designGroup": "第三组", "siteCategory": "III" }` | Use for PKPM/YJK-style seismic design parameters. Normalize "3类" to `"III"`. |
| `wind` | `object` | `{ "basicPressureKNM2": 0.4, "terrainRoughness": "B" }` | Basic wind pressure in kN/m² and terrain roughness A/B/C/D. |
| `analysisControl` | `object` | `{ "rigidFloor": true, "modalCount": 15 }` | Optional calculation-control values such as rigid diaphragm, modal count, P-Delta. |
| `skillState.seismicWorkflow` | `object` | `{ "methodPreference": "auto", "designBasis": { "codes": ["GB 55002-2021", "GB/T 50011-2010-2024"], "siteSeismic": { "intensity": 8, "designGroup": "2", "siteCategory": "III" } }, "designRequirements": { "fortificationCategory": "standard", "seismicGrade": 2, "irregularity": "regular" } }` | Use for China-code seismic workflow intent. This must come from semantic understanding of the request, not keyword matching. |

## Section Parsing
Concrete frame sections are described as rectangular cross‑sections:

- **Rectangular**: `"400X400"`, `"B400H600"`, `"RECT400X500"` → width × height (mm).
- The parser expects width (B) and height (H) in millimeters.
- Extract sections only when given; never choose a default section.

## Extraction Rules
1. **Story/bay numbers**: Look for patterns like "3‑story 2‑bay", "4层3跨".
2. **Dimensions**: Extract numbers followed by "m", "米", "mm", "毫米". Convert mm to m for story heights and bay widths.
3. **Loads**: "dead load 5 kN/m²", "恒载 5 kN/m²", "live load 3 kN/m²", "活载 3 kN/m²". Prefer `engineeringDraft.loads` with `kind: "area"` and `unit: "kN/m2"` when floor geometry is available; the runtime can convert it to per-story total loads. Use legacy `floorLoads` only when the total kN per story is explicitly given or can be computed reliably.
   - Preserve a joint load as `kind: "nodal"`, using an exact node ID or the formal story/nodeRole contract. left-side/right-side/middle are 2D-only; 3D uses X/Y grid indices. Repeated loads may use all-non-base-nodes or all-top-nodes; these global selectors need no story. Preserve every global component. A located node load requires no additional floor total.
   - 节点荷载使用 `kind: "nodal"`，用准确节点 ID 或正式的 story/nodeRole 协议定位。left-side/right-side/middle 仅用于二维，三维用 X/Y 轴网索引。重复荷载可用 all-non-base-nodes 或 all-top-nodes，这两个全局选择器无需 story；保留各方向分量，不另要求楼层总荷载。
   - For a point load along a member, use `kind: "point"`, `location.xM` from the member start, and an exact member ID in `target` or one-based `location.story` + `location.spanIndex`; do not request a node role for this load.
   - 构件上的集中荷载使用 `kind: "point"`、距构件起点的 `location.xM`，以及 `target` 中的准确构件 ID 或从 1 开始的 `location.story` + `location.spanIndex`，不要为此追问节点角色。
   - Locate a beam line load by exact beam ID or numeric `location.story` (with optional one-based `spanIndex` in 2D). Use `beam` plus `story` for a complete story, or canonical `roof` for the roof. Use `all-beams` only for an explicitly requested load on every story; use `x-beams` / `y-beams` plus `story` for 3D directions. Resolve prose into these fields through the model; unresolved targets remain missing inputs and must not become free-text selectors or whole-building loads.
   - 梁线荷载用准确的梁 ID，或数字 `location.story`（二维可加从 1 开始的 `spanIndex`）；整层梁可用 `beam` + `story`，屋面可用标准选择器 `roof`。仅明确所有楼层梁均受载时使用 `all-beams`；三维按方向选择梁用 `x-beams` / `y-beams` + `story`。将用户描述交由模型转成这些结构化字段；无法确定目标时记录缺项，不输出任意描述字符串或默认全楼受载。
4. **Materials**: Look for concrete grades (C20–C80) and rebar grades (HPB300, HRB400, HRB500). A missing rebar grade is not a missing analysis input.
5. **Seismic / wind design basis**: Semantically identify seismic fortification inputs such as intensity, design acceleration, design group, site category, fortification category, seismic grade, regularity, and explicit method requirements. Put scalar site parameters into `siteSeismic`; put China-code workflow intent into `skillState.seismicWorkflow`. Do not infer the analysis method through keyword/regex matching.
6. **Boundary**: "fixed base", "pinned base", "固接", "铰接".

## Examples
1. "A 2‑story 1‑bay concrete frame, story heights 4 m, bay width 8 m, concrete C35, rebar HRB400, fixed base."
   → `{ frameDimension: "2d", storyCount: 2, bayCount: 1, storyHeightsM: [4, 4], bayWidthsM: [8], frameConcreteGrade: "C35", frameRebarGrade: "HRB400", frameBaseSupportType: "fixed" }`
2. "混凝土框架，5层4跨，层高3.6 m，跨度6 m，混凝土C40，钢筋HRB500，固接。"
   → `{ frameDimension: "2d", storyCount: 5, bayCount: 4, storyHeightsM: [3.6,3.6,3.6,3.6,3.6], bayWidthsM: [6,6,6,6], frameConcreteGrade: "C40", frameRebarGrade: "HRB500", frameBaseSupportType: "fixed" }`

## Missing Values
Omit what the user did not give; the skill asks for missing required inputs.

For explicitly delegated preliminary choices in a one- or two-story concrete frame, propose C30 and 400×400 mm columns. For rectangular beams, use the existing preliminary sizing rule: depth H = maximum bay span / 10, rounded to 50 mm (minimum 250 mm); width B = H / 2, rounded to 25 mm (minimum 200 mm). Thus a 5 m span proposes 250×500 mm beams. Put all proposed values in one confirmation question; do not enter them as accepted input before the user's acceptance. These are provisional analysis choices, not a code-checked design. Preserve explicitly supplied values instead.

用户明确委托选择一至两层混凝土框架的初步材料与截面时，建议 C30、400×400 mm 柱。矩形梁沿用现有初估规则：梁高 H 取最大跨度的 1/10，按 50 mm 取整且不小于 250 mm；梁宽 B 取 H/2，按 25 mm 取整且不小于 200 mm。因此 5 m 跨度建议 250×500 mm 梁。将全部建议合并为一次确认，用户接受前不得当作已确认输入。这些只是初步分析取值，不代表已通过规范设计；用户已给数值必须保留。
