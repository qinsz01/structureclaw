# Commercial native repair / 商业引擎原生修复

本轮已修复实际执行和数据传递错误，并增加真实软件验收。**两种软件均能完成隔离原生运行；任意正式 V2 模型的物理等价验收仍未完成。** 历史预览记录、论文标签与标答保持不变。

Both engines now complete isolated native runs for the documented fixtures. This
does not certify arbitrary formal V2 models. Historical preview records, paper
tags and reference answers remain unchanged.

## YJK

- 参考最新部署 `G:/qsz/yjk-flow-api-integration-a4-20260923-01/p50inline-1012/code` 的进程与通信实现。StructureClaw 使用自己的 `sclaw_data/engines/yjk8-sdk` 和 `yjk8-python` 副本；其设置中的失效安装路径已修正。
- SDK 采用匹配的 Python 3.10、显式 DLL 搜索目录和 `NDepend` 导入模式。驱动启动前进入 Windows Job，随后只绑定自身新建的原生 PID。缓冲管道完整写请求后再通知，所有等待有截止时间；不重发结果不确定的命令。
- 安装互斥保护沿用 API 的命名规则，指向已被 API 占用的安装会拒绝运行。完成或超时只关闭本次进程树。旧 GUI 附着、键盘注入、全局 PID 差集清理及异步仅启动路径已删除。
- 逐构件混凝土等级写入 `HNTDJ`，初始化标准层参数，检查 `CreateYDB` 返回状态。通过独立 SQLite 读回，按实际端点核对几何、截面和 C30/C40 等级，不依赖编号相同。
- 修复六分量内力行误判、稀疏节点标签枚举和工况中文乱码匹配。机器结果保留原始精度，坐标使用明确的 m/mm；原生读回已确认本机 SDK 坐标为 m。
- 原生站点保存有符号完整分量及自身端点顺序。12 根构件的原生端点与输入方向相反，故局部轴和站点位置仍标为未校准，未猜测符号变换。
- EXA/EYA 工况出现有内力但全部反力为零的可疑返回，标记 `partial` 并从规范化反力中移出；原始数据保留。恒载、无荷载的活载工况不受这个判据误伤。

The YJK adapter now uses a private runtime, contained process ownership, bounded
write-before-notify IPC, explicit RC member grades and full-precision results.
Sparse node labels and ASCII native case codes are handled explicitly. Suspicious
zero reactions are marked incomplete, and native endpoint/axis conventions remain
unverified instead of being silently transformed.

### Fresh acceptance / 新鲜原生验收

代码 `710a27f` 的最终新运行：`yjk-frame-20261013-164541-66e2fe`。

- 冻结输入和参考后启动，完整生成工程、求解、抽取并退出；只选择指定恒载 `D`。
- 2 层退台模型：16 个物理节点、20 根梁柱。交换 YDB 与保存 YMD 的几何、逐构件截面和等级均核对通过。
- 独立重量平衡：柱、梁、两块 100 mm 楼板按 25 kN/m³ 自重，叠加 2 kN/m² 面恒载，合计 **549.0 kN**；原生基底反力 **549.0 kN**，绝对容差 `1e-5 kN`，通过。这里明确采用软件默认楼板和自重假定，不把它作为任意 V2 杆系模型的等价证明。
- 先前新运行的原生报告交叉检查：质量平衡表、柱底轴力和基底反力总和一致；逐柱轴力与反力最大差 `3.679e-6 kN`。SDK 的非零转角真实存在，位移数量级与原生位移报告一致。
- 首次 50 秒连接期限超时的记录保留；随后使用 90 秒默认连接期限完成。不把超时归因为已证实的授权故障，也没有转接用户窗口。

The final fresh run passes native geometry/grade roundtrip and an independently
frozen 549 kN dead-load equilibrium check. Its slab and self-weight assumptions
are explicit. Earlier native failures remain recorded, not overwritten.

## PKPM

详见 [PKPM 修复与六次数值验收](pkpm-native-repair-20261013.md)。

- 修复竖向节点力写错槽位：原生第 0 槽，向下为正。
- 修复梁荷载读取忽略 `nload`，把固定容量数组尾部当成真实荷载的问题。
- 增加安装级锁、配置原字节恢复及本次完整进程树清理，解决超时遗留子进程。
- 6 次原生数值运行通过，包括向下 1 kN、向上 500 N、梁均布和两层结构；位移、符号、轴力及平衡按独立参考验证，原容差未放宽。

PKPM fixes cover gravity-load encoding, capacity-array readback and process
lifecycle. Six native numerical runs pass the documented independent references.

## Remaining boundary / 剩余边界

1. PKPM `601=60102` 一次性加载在当前批处理路径仍可重复卡在基础接口输出。省略此设置、采用原生施工模拟 1 的诊断成功，不能代表一次性加载支持；生产没有静默替换。
2. YJK 当前原生 `fea.dat` 的 C30/C40 刚度分别为 30000/32500 MPa，泊松比为 **0.25**；不能视为自动实现了输入中任意 E/G/nu/rho。原生楼板、自重、梁刚度放大和施工设置也仍需逐项绑定与验收。
3. 任意水平荷载/力矩、局部荷载、自定义工况、局部轴、站点位置及完整输出的通用校准尚未完成。已有局部验收不授权放开全部组合。
4. 正式 V2 的材料/设置门禁继续保留。YJK 兼容错误码仍为 `YJK_NATIVE_MATERIAL_GRADE_UNVERIFIED`，提示内容已更新，明确剩余障碍是完整物理校准而非牌号无法写入。

Formal V2 gates remain closed until explicit physical properties, effective
settings and requested result conventions are all verified. In particular, the
native 0.25 Poisson ratio and PKPM construction-simulation fallback cannot be
treated as equivalent to different requested inputs.

## API preservation and regression / API 保护与回归

- 最新 YJK API 的 4 份核心源码、控制器源码和生产配置，共 6 份 SHA256 前后一致。没有修改其文件、提交任务、重启服务或控制原用户进程；原 PID `4616/14708/16540` 仍在。
- 最终商业与工程状态回归：6 个 Jest suites、54 项测试通过；YJK 与商业合同 Python 38 项及 13 个 subtests 通过。另有 13 项真实 Windows IPC/进程测试与 PKPM 11 项 Python 测试通过。
- 原始产物保存在 `G:/StructureClaw-All/sclaw_data/work/`；输入、参考、读回、结果和 API 保护哈希见 [紧凑记录](reproducibility/commercial-native-repair-20261013.json)。
- 只推送个人 fork 开发分支；未移动历史标签，也未进行付费模型实验。

Six inspected API source/configuration hashes are unchanged, its existing
processes remain, and no API task or restart was issued. Regression checks pass;
the linked manifest records exact artifact hashes and the remaining limitations.

```powershell
& '<engineering-python>' backend/tests/analysis-yjk-native-calibration.py --installation '<private-yjk-sdk>' --python '<matching-python310>' --work-root '<new-work-root>' --timeout 240
```
