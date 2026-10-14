# Input review / 输入复核

The engineering model and the append-only `inputEvidence` list remain the only sources of state. `query_model` returns the evidence and `inputIssues`; the capability assessment also reports values not yet applied to the model. A parser success or an empty issue list alone is not permission to solve: model validation, analysis-input binding and solver preflight still apply.

工程模型与只追加的 `inputEvidence` 是唯一状态来源。`query_model` 返回证据和 `inputIssues`；能力面板同时报告尚未应用到模型的值。解析成功不等于可计算，正式计算仍执行模型校验、分析输入绑定和求解器预检。

## Display / 展示

- Each record has an immutable `id`, `field`, `status`, `required`, `source`, and possibly `requirement`. Sources preserve file/SHA, PDF page and image region, table row/column/sheet, or CAD entity. Coordinates of image regions are normalized `[x,y,width,height]` on the original page.
- `unread`, `missing`, `ambiguous`, `failed`, `truncated`, conflicts, missing source mappings and incomplete readbacks remain pending. Show the reason next to the source. A review must retain its reason and original observations.
- `status: excluded` records retain the reason and exact excluded observation hashes. A changed or newly read source is not covered by an old exclusion. Do not delete excluded data from history.
- `file:*` with `requirement: field-mapping` needs concrete model fields or an analysis-only binding. `complete-read` needs a complete source record of the same file version and page/sheet, or an explicit exclusion of irrelevant content.

每条证据显示来源、字段、状态和原因；图片区域使用原页归一化坐标。待处理项不能只靠“确认读取”清除。排除只作用于明确记录的证据版本，后续新文件或新读取仍须复核。排除项保留在历史中。

## Model fields / 模型字段

First read a file with `analyze_file`; `mode: full` returns complete table/text content, complete selected PDF pages, or DXF entities up to the declared expansion limit. PDF remains paginated. Unsupported entities and unread pages remain explicit.

用 `analyze_file` 读取来源。`mode: full` 读取完整表格/文本、所选 PDF 页和受展开上限约束的 DXF 实体。PDF 仍分页；不支持的实体、未读取的页不会消失。

```json
{"resolutions":[
  {"field":"nodes.A.x","value":5000,"unit":"mm","reason":"Reviewed dimension in cell A2 / 已复核 A2 尺寸",
   "sourceEvidenceId":"<table-source-id>","sourceLocation":{"row":2,"column":"A"}},
  {"field":"file:<path>:fields","value":true,"reason":"Mapped the required dimension / 已关联所需尺寸",
   "mappedFields":["nodes.A.x"]}
]}
```

Pass this to `review_input`. The original evidence stays unchanged; the model itself must then be edited to the reviewed value and validated. IDs in paths are stable object IDs, not array indices. A semantic field such as `drawing.span` additionally needs `modelField: nodes.A.x` only when that coordinate genuinely represents the reviewed dimension.

将以上参数传给 `review_input`。它不修改模型数值；随后按稳定对象 ID 修改模型并校验。语义字段须显式绑定 `modelField`，不能把跨度擅自当作无基准的节点坐标。

## Ground motion / 地震波

```json
{"filePath":"<uploaded-file>","groundMotion":{
  "sheetName":"EW","direction":"x","unit":"g","timeColumn":"time","accelerationColumn":"accel_g","timeUnit":"s"
}}
```

`analyze_file` with `groundMotion` performs a full-file, read-only check using the same Python parser as seismic analysis. It returns `groundMotionRecord` and `groundMotionPreview` and updates the current seismic context with that record. The preview exposes count, time step, duration, original unit, global direction, source hashes, exact full-record PGA and a bounded sampled display. It does not run a solver. Large sample arrays stay in the complete parsed file. Existing results are invalidated when the excitation context is changed.

此调用完整校验文件，返回记录和有限采样预览，并更新当前抗震上下文。展示样本数、时间步、时长、原单位、全局方向、来源摘要及完整序列 PGA；显示采样不替代求解数据。它不启动求解器。

```json
{"resolutions":[
  {"field":"<file-evidence-field>","value":true,"reason":"Confirmed excitation source / 已确认激励来源",
   "sourceEvidenceId":"<complete-file-evidence-id>","analysisRecordId":"<groundMotionRecord.id>"}
]}
```

This binds the file's analysis-only use, not a fictitious model coordinate. Review all relevant file/page/sheet pending records. Optional `analysisParameters` can confirm/change `unit`, `direction`, `dt`, `timeUnit`, `timeColumn`, `accelerationColumn`; it cannot replace sample values or source references. Any changed settings require inspection/review again. `run_analysis` checks that the reviewed record and final merged request match; Python verifies both original and parsed file hashes, sample cells, units and the complete time axis before computation.

此处绑定分析设置用途，不伪造模型字段。`analysisParameters` 可确认单位、方向、时间步和列，不能替换原始样本。实际计算前再次核对复核记录与请求，并校验原文件及完整解析文件摘要。缺单位、缺时间步、坏单元格、重复/倒序/非均匀时间以及未知方向均拒绝；不移动列、不删坏点、不猜默认激励单位。接口 `dt` 和未另注单位的 `time`/`t` 列按秒定义；`timeUnit` 可显式指定秒或毫秒。未标全局方向的记录不能自动复用到 X/Y。

## Explicit exclusions / 明确排除

```json
{"excludeSources":[{"sourceFile":"<same source.file value>","evidenceIds":["<unrelated-page-id>"],
"reason":"The page is an unrelated cover sheet / 此页是无关封面"}]}
```

Use exact `evidenceIds` for a page or observation. Omitting them excludes every current observation from that source, including current reviews; it does not exclude future observations. Exclusion is for irrelevant information and must not be presented as successful interpretation of required engineering inputs.

按页/证据排除时传明确 ID；省略 ID 会排除该来源当前所有证据，但不覆盖未来读取。排除表示与当前任务无关，不能包装成“已正确识别必需信息”。
