# Native design profiles / 原生设计验收范围

This review covers StructureClaw's input, execution and result adaptation. It is
not a new certification of PKPM/YJK, and it does not mean 300 benchmark tasks have
been authored or executed. The [product runtime](product-runtime.md) describes the
public interfaces; the [read-only review manifest](reproducibility/native-design-independent-review-20261014.json)
binds the completed result files and native evidence by SHA-256.

本记录独立复查本体的传参、原生执行、结果读回及交付口径，不重新认证商业求解器，也不把代表算例通过
写成300题全部完成。历史失败结果、参考数值和容差均未改写。

## Material and code identity / 材料与规范身份

| Profile / 配置 | Verified meaning / 已核含义 |
|---|---|
| PKPM C30 native design | E=30000 MPa, G=12000 MPa. Source G=12500 MPa is a conflict, not permission to change it. / 源模型刚度不符须明确修改，不能静默切换。 |
| PKPM C35 native design | E=31500 MPa, G=12600 MPa, independently checked in the explicit-parameter run below. / 已在下列参数算例独立校核。 |
| PKPM Q355 native design | E=206000 MPa, G=79000 MPa. SDK grade enum 29, native DATA grade −355, and WPJ report Rsc=355 are distinct representations of this identity. / 三种牌号编码分别核对。 |
| PKPM concrete code profile | `PKPM-2025R2.5-native` is a version-bound profile. WMASS identifies the 2021 general specification; it does not establish an arbitrary GB50010 edition. / 不能把软件版本配置冒充任意混凝土规范年份。 |
| Steel code | `GB50017-2017`, verified from native code settings/report. / 必须核对实际生效规范。 |
| YJK concrete code | `GB/T50010-2010(2024)`, verified in native settings and output. / 原生设置与结果共同核对。 |

Elastic analysis with exact user materials remains separate from native-grade
design. An accepted elastic calculation alone is insufficient evidence for native
reinforcement or code compliance. Known design values, including fck/fyk/fstk,
remain on the canonical model and its design context; an unmapped design override
must still be rejected when native design is requested.

精确弹性分析与原生牌号设计分别绑定。计算成功不等于配筋已算，更不等于已有配筋合格。设计请求必须
明确采用已读回的默认值；额外参数只有经过实际写入、读回后才可宣称生效。

PKPM's installed SATWE user guide, section 1.2.10 item 26, fixes beam/column
stirrup design spacing at **100 mm**. Writing 816/817 to another value does not
establish a changed native design basis. The guide permits converting reinforcement
output for other spacing; such a conversion must be labeled as derived and retain
the original 100 mm basis. This review does not claim that conversion is implemented.

本机官方手册明确梁柱箍筋以100 mm为计算基准。不能把设置文件中的80或120当作已生效；非100 mm折算
应另行标明派生依据，本记录不把该折算宣称为已实现能力。

The fresh PKPM C35 run independently verified beam/column covers 40/45 mm,
HRB400 main bars (360 MPa), HPB300 beam stirrups (270 MPa), HRB400 column
stirrups (360 MPa), and both 100 mm spacings in native output. Attempts to select
HRB500 main bars initially did not change the effective native value. That failure
remains archived. A later PKPM-specific repair reapplies official parameters after
PMCAD and before SATWE preprocessing: run `114742-0b3da89e` reads back 435 MPa for
both beam/column main bars. See [the subsequent HRB500 acceptance](reproducibility/pkpm-hrb500-20261014.json).
YJK's separate readback is independent evidence, not the basis for PKPM support.

C35早期验收核对的是八项实际生效参数；主筋HRB500的早期未生效记录保留。后续PKPM专属修复在
PMCAD之后、SATWE前处理之前重写官方参数，`114742-0b3da89e`已读回梁柱主筋435 MPa。
YJK与PKPM分别验收，不能把一家软件的能力直接外推到另一家。

YJK also verified all 14 standard concrete grade identities C15–C80 in a native
project. Its steel-column sway flags select a native effective-length method;
they do not accept an arbitrary prescribed `l0`. See the
[YJK-specific receipt](reproducibility/yjk-native-design-20261014.json).

YJK另核对14个标准混凝土牌号的原生身份，以及钢柱有无侧移计算长度方法；后者不等同于任意指定计算长度。

## Completed native runs / 已完成的原生证据

Counts below refer to the normalized native records/checks, not independent
clauses or benchmark tasks. Full paths and hashes are in the review manifest.
执行完成与验算结论分别统计；NA表示该原生检查不适用，不计作通过。

| Run suffix / 运行尾号 | Case / 算例 | Reinforcement records / 配筋记录 | Pass / 通过 | Fail / 超限 | NA |
|---|---|---:|---:|---:|---:|
| PKPM `090434-6b7bb6d5` | C30 normal / 正常 | 30 | 13 | 0 | 0 |
| PKPM `090550-86b77176` | C30 overload / 超载 | 30 | 4 | 9 | 0 |
| PKPM `091116-643e218a` | Q355 3 m box columns / 箱柱 | 0 | 0 | 6 | 0 |
| PKPM `091209-735605bb` | Q355 overload / 超载 | 0 | 0 | 6 | 0 |
| PKPM `091839-52070c27` | Q355 2 m box columns / 箱柱 | 0 | 6 | 0 | 0 |
| PKPM `093006-df3f10c3` | C35 explicit parameters / 显式参数 | 30 | 13 | 0 | 0 |
| YJK `090449-c6fc800b` | C30 normal / 正常 | 140 | 12 | 0 | 0 |
| YJK `090906-56aba572` | C30 load ×50 / 荷载50倍 | 140 | 0 | 12 | 0 |
| YJK `091110-f8640252` | Q355 box normal / 正常箱形框架 | 0 | 140 | 0 | 72 |
| YJK `090659-803f122a` | Q355 box load ×100 / 荷载100倍 | 0 | 52 | 88 | 72 |
| YJK `085916-e8dd01` | Q355 H section / H形框架 | 0 | 172 | 4 | 36 |
| YJK `092619-403b83` | C15–C80 native identities / 牌号身份 | 280 | 24 | 0 | 0 |
| YJK `093033-e40ca6` | HRB500 main bars / 纵筋 | 140 | 12 | 0 | 0 |
| YJK `093457-e61a96` | Non-sway steel-column method / 无侧移计算方法 | 0 | 140 | 0 | 72 |

The PKPM 3 m box-column run is **not** an all-pass case: its official slenderness
limit report fails even at the smaller load. The later 2 m case is a different,
explicit source model. Neither its geometry nor its passing result rewrites the
3 m record. YJK's thin-web H-column limit failures likewise remain visible.

PKPM三米柱较低荷载仍有官方长细比超限；二米柱是另行冻结输入的独立正常算例，不能替换前者。
YJK薄腹板H柱的宽厚比超限也没有被删除。

## Output semantics / 输出口径

- Required reinforcement is an area requirement, not installed reinforcement.
  `required-reinforcement` reports `complianceStatus=fail` when official checks fail;
  otherwise completed area design reports `not_evaluated`, never installed-bar compliance.
  PKPM does not invent YJK's separate `calculatedArea` field.
  / 所需配筋不等于已配钢筋验算；真实官方超限优先标为失败，其余完成情况不发布配筋通过结论。
- Native automatic combinations retain their native identities and scope.
  They are not relabeled as the selected elastic case or user combination.
  / 官方设计组合与用户分析工况分别保存。
- PKPM checks include documented axial-ratio tuples and the official
  `GetExceedLimitInfo` report. Raw `GetCalcMax1/2/3` arrays are preserved.
  Eighteen first-component ratios were independently consistent with printed
  WPJ F1/F2/F3 divided by capacity, within **report rounding**; this does not
  establish every tuple index or certify solver numerical tolerance.
  / 不从未知数组取最大值生成利用率，也不把打印舍入当求解容差。
- The box-section mapping uses B/H outer dimensions and U/T/D/F wall thicknesses,
  matching the installed vendor library
  `Ribbon/AID/OptSect/PKPM截面库/柱/箱形柱/箱形柱-Q355-四级.xlsx` (Sheet2).
  Native WPJ independently records 300×300×12×12×12×12 for the reviewed box columns.
  / 不能只写T而遗漏其余三片壁厚。

## Scope limits / 使用边界

The reviewed profiles cover linear static physical frame members, explicit
self-weight disabled, and the actual material/section families shown above.
Numerical reference carriers, design of subdivided physical members, unmapped
source design overrides, and checking already-installed reinforcement are not
established by these receipts. Requested unsupported inputs must return their
actual missing/unsupported status. Empty arrays, sentinel values and zero-filled
fallbacks cannot become successful design evidence.

这些证据只覆盖上述静力裸杆物理截面及材料。数值截面载体不提供设计几何；分段计算构件的设计归并、
未映射显式设计覆盖、已有配筋校核不能由本表推出。动力、抗震专用方法及内置规范公式属于另外的验收链。
后续参数/牌号验收应追加新证据，不能回填旧运行或把代码里列出的选项当成已经通过。

## Remaining adapter work / 剩余适配工作

These are StructureClaw integration limits, not claims that the commercial products
lack these functions. A successful SDK installation does not by itself establish that
every source-model field and requested output has been connected.

以下是StructureClaw的适配缺口，不代表商业软件没有这些功能。SDK可用不能替代每项输入和输出的接通。

| Area / 范围 | Remaining work / 尚未接通或未验收 |
|---|---|
| Analysis assumptions / 分析假定 | Automatic self-weight, rigid diaphragms/zones, construction stages and second-order settings are not established by the accepted bare-frame runs. / 裸框架验收不能推出自动自重、刚性楼板、刚域、施工阶段和二阶设置已接通。 |
| YJK boundaries / YJK边界 | Current adapter requires fully fixed base supports and ordinary inclined columns below 20 degrees. Other supports, arbitrary member releases and eccentricities still need native mapping. / 其他支座、任意端释放及偏心仍须适配；不能通过修改用户模型绕过。 |
| Member displacement / 构件位移 | Native force stations and identified equilibrium recovery are available. Continuous within-member deflection is not established as a native commercial output. / 原生截面内力和有来源的平衡恢复可用，连续跨内挠度尚未作为商业原生输出接通。 |
| Design parameters / 设计参数 | Arbitrary prescribed effective lengths and unmapped per-member overrides need native write/readback. PKPM HRB500 has subsequent native acceptance; YJK verifies the documented floor/role grouping. / PKPM主筋HRB500后续已原生验收，任意计算长度及未映射逐构件覆盖仍需接通。 |
| Physical-member design / 物理构件设计 | Design of members split for local/point loads needs a verified mapping back to the unsplit physical design member and its lengths. / 分段分析成功不能直接推出原生设计归并正确。 |
| Reinforcement / 配筋 | Native required-area design is available within the documented profiles. Checking installed bars, and derived PKPM stirrup-spacing conversion, remain unimplemented. / 已有配筋验算与PKPM非100毫米间距的派生折算尚未实现。 |

Do not mark the overall product convergence plan complete while required adapter items
remain open. Native failures, missing inputs and unimplemented mappings stay distinct.

必需适配项仍未完成时，整体版本继续标为预览；真实超限、资料不足与尚未接通分别报告。
