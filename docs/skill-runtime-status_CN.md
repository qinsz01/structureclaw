# 技能与 Provider 运行时状态

可选技能仅为八种结构建模方法：beam、column、double-span-beam、frame、concrete-frame、portal-frame、truss、generic。
清单、阶段指导及 handler 位于 backend/src/agent-skills/structure-type/，默认由 LLM 自动路由。

Provider 元数据独立位于 backend/src/providers/catalog.yaml，目前包括六个求解器模式（OpenSees 静力、动力、抗震、非线性，PKPM 静力及 YJK 静力）、四种规范（GB50010/GB50011/GB50017/JGJ3）、四种输入解析器（DXF、表格、图片、PDF）及两个报告导出器（内置、PKPM 计算书）。执行代码仍保留原领域路径。
GET /api/v1/agent/providers 返回安装、配置及显式启用状态；商业许可证在实际作业验证前保持未知。

荷载、支座、组合、输入解释、验证和结果指导集中在 engineering/knowledge.ts，受 knowledge 运行策略控制。
这些主题及验证、后处理和可视化不再作为技能勾选。memory 与 shell 保留工具实现；重复的 skill-creation 和截面占位 handler 已删除。
section-common 的多边形积分迁入共享 structure_protocol/section_properties.py，并有数值测试；桥梁与异形的近似占位实现不再保留。

旧领域枚举以及 analysisSkillId/codeCheckSkillId 等 API 字段名保留兼容。保存的 Provider ID 映射为 Provider 偏好，纯文本及已移除 ID 作为有日志的无操作处理。
求解器和规范的可用性与结构技能选择独立。

技能或 Provider 变更时同步维护本文件、目录及中英文架构文档。环境就绪与已实现的物理能力属于不同证据，配置成功不代表支持任意分析请求。
