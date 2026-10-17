# StructureClaw 文档入口

本目录是 StructureClaw 1.0 的文档中心。想运行项目先看手册；需要 API、协议或扩展细节时，再看参考文档。

## 从这里开始

- [使用手册](./handbook_CN.md)：安装、运行模式、配置、工作流、测试与排障
- [参考文档](./reference_CN.md)：API 契约、分析接口、配置契约、SkillHub 契约与验证命令
- [测试分类](./testing_CN.md)：测试分类、runner 归属、CI workflow 边界和重叠规则
- [Agent 架构](./agent-architecture_CN.md)：LangGraph agent、skill、tool 与编排层的 1.0.0 当前架构
- [消融 profile](./ablation_CN.md)：预注册的运行策略消融 profile、选择优先级与记录字段
- [Skill 运行时状态](./skill-runtime-status_CN.md)：各 skill domain 当前实现成熟度
- [中国抗震全流程设计](./china-seismic-workflow-design_CN.md)：基于 LLM 语义理解和 OpenSees 的中国抗震分析规划文档

## 重构与实验控制

- [Clean-core 重构蓝图](./refactor/clean-core-blueprint.md)（英文）：2026-10-17 重构的分层规则、步骤计划与固定约束（分支 refactor/clean-core，基线标签 pre-refactor-20261017）

## 引擎与 Schema 文档

- [引擎映射](./schema/engine-mapping.md)：StructureModel V2 到 OpenSees、PKPM、YJK 的映射
- [Skill 加载机制](./schema/skill-loading_CN.md)：skill manifest 与阶段 Markdown 文件如何被发现
- [Utility tools](./schema/utility-tools_CN.md)：工具 schema 与运行时契约

## 归档

以下为带日期的修复、验收与预览记录，用于追溯，可能描述已被取代的状态；当前行为请以上述文档为准。

- [归档目录](./archive/)：带日期的记录与 2026-10 验收记录 JSON
- [V2.1 工程内核（历史预览）](./archive/engineering-refactor.md)
- [2026-10-13 商业引擎修复](./archive/commercial-native-repair-20261013.md)
- [2026-10-13 PKPM 原生修复](./archive/pkpm-native-repair-20261013.md)
- [2026-10-13 OpenSees 场景兼容性](./archive/opensees-scenario-compatibility-20261013.md)

以下带日期的记录仍保留在当前路径，因为冻结证据或现行页面会链接到它们：

- [2026-10-13 商业原生链路](./commercial-native-chain-20261013.md)
- [2026-10-14 原生设计 profile](./native-design-profiles-20261014.md)
- [商业原生验收（预览）](./commercial-native-acceptance.md)
- [工程 V2.2 收敛（预览）](./engineering-v2.2-convergence.md)

## 社区与发布文档

- [贡献指南](../CONTRIBUTING_CN.md)
- [安全策略](../SECURITY_CN.md)
- [路线图](../ROADMAP_CN.md)
- [更新日志](../CHANGELOG.md)

## English Docs

- [English documentation hub](./README.md)
- [Handbook](./handbook.md)
- [Reference](./reference.md)
- [Agent architecture](./agent-architecture.md)
- [Roadmap](../ROADMAP.md)
