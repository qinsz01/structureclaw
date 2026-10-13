# Native commercial adapters / 商业分析原生验收

The converters compile each natural floor independently. They preserve the input
plan nodes, member connectivity, per-member section selection and native IDs;
they do not fill a Cartesian grid or replicate a first-floor template.

转换器按自然层独立生成标准层，保留输入平面节点、构件连接、逐构件截面和原生编号；
不补齐矩形网格，也不把首层模板复制成全部楼层。

## Evidence levels / 证据分级

| Capability / 能力 | Evidence / 证据 |
|---|---|
| PKPM two-floor L-plan/setback, distinct beam sections / 两层 L 形退台、异梁截面 | Native JWS save/reopen preserved 6/4 nodes and 12/8 members; hidden SATWE execution returned 10 beams, 10 columns and signed station vectors / 原生回读及计算通过 |
| YJK individual joints, grids, beams, columns / 逐节点构件 | SDK declarations and converter contract test; native acceptance blocked by incomplete local installation / 声明与契约测试，原生环境未通过 |
| Signed native station vectors / 原始有符号截面力 | Retained separately from component envelopes; endpoint conventions remain unverified / 独立保存，端部符号约定待验收 |
| Arbitrary member/node loads, requested combinations / 任意构件节点荷载、指定组合 | Not yet enabled; reject unsupported inputs / 尚未放行，明确拒绝 |
| Sloping members, releases, offsets, springs, settlement / 斜构件、释放、偏心、弹簧、沉降 | Not yet enabled in these floor compilers / 尚未放行 |
| Explicit self-weight/diaphragm/rigid-zone/construction/P-delta controls / 显式自重楼板刚域施工与二阶设置 | Reject until native setting write/readback is accepted; unspecified legacy defaults are not proof of OFF / 写入回读未验收前拒绝，未声明不等于关闭 |
| PKPM reactions / 支座反力 | No direct reader in the installed ResultData interface; derived equilibrium requires signed endpoint vectors and verified axes/signs/offsets / 尚无直接读取，平衡恢复尚待端力约定验收 |

Each request selects at most one input case. Verified dead/live cases are mapped
to native labels; a missing/ambiguous mapping fails instead of returning DL.
Requested combinations currently fail explicitly. Native design envelopes are
not represented as the requested case's simultaneous endpoint vectors.

每次请求至多选择一个输入工况。恒活载按原生标签匹配；缺失或歧义会失败，不默认返回恒载。
请求指定组合目前会明确失败。原生设计包络不能用作某工况的同一端截面力向量。

## Reproduce / 复现

Use `backend/tests/analysis-commercial-native-acceptance.py` with a new work root.
It always creates a unique directory, retains the input and `acceptance.json`,
and never attaches to an existing YJK GUI. `--run` requires an explicit PKPM
JWSCYCLE path. The launcher hides the new process and restores DirectorySet.conf.
Do not run it concurrently with another PKPM batch process: the vendor directory
configuration is shared across processes.

```powershell
& '<engineering-python>' backend/tests/analysis-commercial-native-acceptance.py pkpm --work-root '<acceptance-root>' --run --cycle '<PKPM>/PkpmCycle/JWSCYCLE.exe' --timeout 90
& '<YJK-bundled-python>' backend/tests/analysis-commercial-native-acceptance.py yjk --work-root '<acceptance-root>' --yjk-sdk '<YJK-sdk-site-packages>'
```

2026-10-13 evidence: PKPM `acceptance-commercial-pkpm-20261013-115755-ea18fbcc`
passed topology readback and solver result coverage in `sclaw_data/work`.
YJK attempts `acceptance-commercial-yjk-20261013-115925-fae10d8d` and
`acceptance-commercial-yjk-20261013-120011-f131697d` failed at SDK import
(`_cffi_backend` ABI/dependency and `ClrYJKAPI.dll` dependency respectively).
The configured full YJK installation path did not exist. No existing YJK project
was opened, attached, closed or modified.

These results establish the stated subset only. They do not certify the 300-task
plan, native self-weight OFF, native slab OFF, arbitrary material constants,
inclined columns or reaction recovery.

上述证据只覆盖已说明子集，不代表300题、自重关闭、楼板关闭、任意材料常数、斜柱或反力恢复全部可用。
