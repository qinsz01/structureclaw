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
   - Preserve a load at a specified joint as `kind: "nodal"`, with both `location.story` (one-based, including 1 for a single-storey frame) and `location.nodeRole` (`left-side`, `right-side`, or `middle`). Preserve each global force component separately. A located load is not a floor total and needs no question about distributing it.
   - 指定节点的荷载使用 `kind: "nodal"`，同时填写 `location.story`（从 1 开始，单层框架也填 1）和 `location.nodeRole`（`left-side`、`right-side` 或 `middle`），各全局方向分量分别保留。已定位的节点荷载不是楼层总荷载，不要再询问如何分摊。
   - For a point load along a member, use `kind: "point"`, `location.xM` from the member start, and an exact member ID in `target` or one-based `location.story` + `location.spanIndex`; do not request a node role for this load.
   - 构件上的集中荷载使用 `kind: "point"`、距构件起点的 `location.xM`，以及 `target` 中的准确构件 ID 或从 1 开始的 `location.story` + `location.spanIndex`，不要为此追问节点角色。
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

## Repeated nodal loads / 重复节点荷载
When a force is given **per node**, preserve that force on every specified node. Enumerate located nodal loads by story and node role where supported, or preserve explicit topology and node IDs. Never interpret the per-node force as a per-story total. Ground nodes excluded by the user receive no such load. / 每个节点的荷载大小必须逐节点保留，可按楼层及节点角色逐条列出，或保留显式拓扑及节点 ID；不得把每节点荷载当作每层总荷载，用户排除的地面节点不施加该荷载。
