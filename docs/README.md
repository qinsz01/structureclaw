# StructureClaw Documentation

This directory is the documentation hub for StructureClaw 1.0. Start with the handbook if you want to run the project, then move to the reference docs when you need API or protocol details.

## Start Here

- [Handbook](./handbook.md): setup, runtime modes, configuration, workflows, testing, and troubleshooting
- [Reference](./reference.md): API contracts, analysis endpoints, settings contract, SkillHub contract, and validation commands
- [Testing taxonomy](./testing.md): test categories, runner ownership, CI workflow boundaries, and overlap rules
- [Agent architecture](./agent-architecture.md): current 1.0.0 architecture for the LangGraph agent, skills, tools, and orchestration
- [Ablation profiles](./ablation.md): pre-registered run-policy profiles for matched benchmark ablations, selection precedence and recorded fields
- [Skill runtime status](./skill-runtime-status.md): current implementation maturity for each skill domain
- [China seismic workflow design](./china-seismic-workflow-design.md): planning document for LLM-understood, OpenSees-backed China seismic analysis

## Refactor And Experiment Controls

- [Clean-core refactor blueprint](./refactor/clean-core-blueprint.md): layering rules, step plan and fixed constraints of the 2026-10-17 refactor (branch refactor/clean-core, baseline tag pre-refactor-20261017)

## Engine And Schema Docs

- [Engine mapping](./schema/engine-mapping.md): StructureModel V2 mapping to OpenSees, PKPM, and YJK
- [Skill loading](./schema/skill-loading.md): how skill manifests and stage files are discovered
- [Utility tools](./schema/utility-tools.md): utility tool schema and runtime contract

## Archive

Dated repair, acceptance and preview records. They are kept for traceability and may describe superseded states; use the documents above for current behaviour.

- [Archive folder](./archive/): dated records and the 2026-10 acceptance-record JSON
- [Engineering core V2.1 (historical preview)](./archive/engineering-refactor.md)
- [Commercial engine repair, 2026-10-13](./archive/commercial-native-repair-20261013.md)
- [PKPM native repair, 2026-10-13](./archive/pkpm-native-repair-20261013.md)
- [OpenSees scenario compatibility, 2026-10-13](./archive/opensees-scenario-compatibility-20261013.md)

Dated records that remain at their current path because frozen evidence or current pages link to them:

- [Commercial native chain, 2026-10-13](./commercial-native-chain-20261013.md)
- [Native design profiles, 2026-10-14](./native-design-profiles-20261014.md)
- [Commercial native acceptance (preview)](./commercial-native-acceptance.md)
- [Engineering V2.2 convergence (preview)](./engineering-v2.2-convergence.md)

## Community And Release Docs

- [Contributing guide](../CONTRIBUTING.md)
- [Security policy](../SECURITY.md)
- [Roadmap](../ROADMAP.md)
- [Changelog](../CHANGELOG.md)

## Chinese Docs

- [中文文档入口](./README_CN.md)
- [中文手册](./handbook_CN.md)
- [中文参考文档](./reference_CN.md)
- [中文 Agent 架构](./agent-architecture_CN.md)
- [中文路线图](../ROADMAP_CN.md)
