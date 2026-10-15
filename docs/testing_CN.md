# 测试分类

本文是 StructureClaw 的测试地图，定义每类测试负责什么、由哪个命令运行，以及 CI workflow 之间哪里允许有重叠。

本文用于明确 issue #234 中的测试边界；当 workflow 边界调整时也需要同步更新。

## 分类定义

| 分类 | 负责内容 | 不负责内容 | 主要命令 |
| --- | --- | --- | --- |
| Unit | 纯函数、小型 helper、reducer、schema 解析、本地组件行为 | 进程启动、真实浏览器流程、真实 LLM 调用 | `npm test --prefix backend -- --runInBand` 或 `npm run test:run --prefix frontend` |
| Integration | 一个有边界的子系统，例如 route handler + service 行为，或带 provider 的页面渲染 | 完整安装启动、真实外部服务、模型质量评分 | Backend Jest 或 frontend Vitest integration 配置 |
| E2E | 面向用户的浏览器流程，运行在真实启动的应用上 | 确定性的工程分析回归、深层 backend contract、LLM 质量 benchmark | `npm run test:e2e --prefix frontend` |
| Regression | 不能随意漂移的确定性行为，尤其是工程分析与 backend contract bundle | 探索式浏览器检查、真实模型质量 | `node tests/runner.mjs backend-regression` 或 `node tests/runner.mjs analysis-regression` |
| Validation | 可单独选择的 contract 和 schema 校验 | 大范围 build/lint/test 组合 | `node tests/runner.mjs validate <name>` |
| Smoke | 支持平台上的安装、初始化、构建和生命周期兼容性 | 不拥有 unit、integration、E2E 覆盖 | `node tests/runner.mjs smoke-native` |
| LLM integration | 旧的真实 LLM 与 routing integration 检查 | 长期 agent 质量评分 | `node tests/runner.mjs llm-integration` |
| LLM benchmark | 带场景评分的真实 LangGraph agent 质量检查 | 快速确定性的 unit 或 contract 覆盖 | `node tests/runner.mjs llm-benchmark` |

## 测试归属

| 位置 | 分类归属 | Runner |
| --- | --- | --- |
| `backend/tests/*.test.mjs` | Backend unit 或 backend integration，取决于 fixture 范围 | `npm test --prefix backend -- --runInBand` |
| `backend/src/**/__tests__/*.test.mjs` | Backend unit 或聚焦的子系统 integration | `npm test --prefix backend -- --runInBand` |
| `backend/src/agent-skills/**/__tests__/*` | Skill unit、handler 或 skill integration 覆盖 | `npm test --prefix backend -- --runInBand` 或 skill 专用 npm script |
| `frontend/tests/*.test.ts(x)` 以及 `frontend/tests/lib/**`、`frontend/tests/stores/**`、非 console 的 `frontend/tests/components/**` | Frontend unit 与配置覆盖 | `npm run test:run --prefix frontend` |
| `frontend/tests/components/console/**` | 组合后的 AI console、能力 hydration、流式响应和 provider 交互的 frontend integration 覆盖 | `npm run test:run:integration --prefix frontend` |
| `frontend/tests/accessibility/semantic.test.tsx` | 组合后的 console 页面语义与可访问性 integration 冒烟 | `npm run test:run:integration --prefix frontend` |
| `frontend/tests/integration/**` | 页面、provider、route group 的 frontend integration 覆盖 | `npm run test:run:integration --prefix frontend` |
| `frontend/tests/e2e/**` | Playwright 浏览器 E2E 覆盖 | `npm run test:e2e --prefix frontend` |
| `tests/regression/backend-validations.js` | 命名 validation contract | `node tests/runner.mjs validate <name>` |
| `tests/regression/backend-regression.js` | Backend regression bundle | `node tests/runner.mjs backend-regression` |
| `tests/regression/analysis-runner.py` | Analysis regression fixture | `node tests/runner.mjs analysis-regression` |
| `tests/smoke/**` | Native install 与 build smoke 检查 | `node tests/runner.mjs smoke-native` |
| `tests/llm-integration/**` | 旧 LLM integration harness 与 helper unit test | `node tests/runner.mjs llm-integration` 加本地 helper 测试 |
| `tests/llm-benchmark/**` | LangGraph agent benchmark 场景与评分（git submodule，源仓库 [structureclaw-benchmark](https://github.com/structureclaw/structureclaw-benchmark)） | `node tests/runner.mjs llm-benchmark` |

公共 benchmark 子模块包含可复现评测所需的版本化评测集、冻结真值、运行器
和评分运行时。

OpenClaw 外部 harness 复用同一套评测集与评分器：

```bash
node tests/runner.mjs openclaw-benchmark --dry-run
node tests/runner.mjs openclaw-benchmark --scenario <id> --mode all
```

该入口将 OpenClaw 固定为 `2026.6.33`、模型固定为 Paratera `GLM-5.2`
（实验标签 `glm-5.2-paratera`），并禁用模型 fallback。默认任务并发数为 10；
OpenSees、PKPM、YJK 仍分别使用容量为 1 的
独立求解器锁，YJK 还保留运行后 5 秒冷却。标准工作流场景运行 `auto` 和
`generic-only`，交互与多模态场景只运行 `auto`。

## CI Workflow 边界

| Workflow | 用途 | 说明 |
| --- | --- | --- |
| `.github/workflows/backend-regression.yml` | Linux 和 Windows 上的 backend regression | 通过 `tests/runner.mjs` 运行 backend regression bundle。 |
| `.github/workflows/frontend-regression.yml` | Linux 和 Windows 上的 frontend 静态与 unit regression | 运行 frontend type-check、lint 和 unit Vitest 覆盖。 |
| `.github/workflows/analysis-regression.yml` | Linux 和 Windows 上的确定性 analysis regression | 构建 backend，准备 analysis Python，然后运行分析 fixture。 |
| `.github/workflows/e2e.yml` | 不使用供应商密钥的隔离 Playwright 浏览器流程 | 在 `master` 和 `work/research-next` 的相关前端及工程代码变更、手动触发，或允许用户评论 `/test-e2e` 时运行。 |
| `.github/workflows/install-smoke.yml` | Native install/build 兼容性 smoke | 调用 `node tests/runner.mjs smoke-native`；frontend 和 backend 静态检查由各自 regression workflow 负责。 |
| `.github/workflows/llm-integration.yml` | 真实 LLM integration 检查 | 在 `master`、手动触发，或允许用户评论 `/test-llm` 时运行。 |
| `.github/workflows/llm-benchmark.yml` | 可信触发的真实 LLM benchmark | 使用公共 benchmark 运行器与评测集。 |
| `.github/workflows/publish-npm.yml` | 发布前 gate | 为保护发布重复运行部分检查。它不拥有新增测试覆盖。 |

## Frontend Vitest 拆分

Frontend 现在有两个 Vitest 配置，归属互斥：

- `frontend/vitest.config.ts` 负责快速 unit / 配置覆盖，并显式排除 `tests/integration/**`、`tests/components/console/**`、`tests/accessibility/**` 和 `tests/e2e/**`。
- `frontend/vitest.integration.config.ts` 负责 app route、provider、console integration 覆盖，并包含 `tests/integration/**/*.test.tsx`、`tests/components/console/**/*.test.tsx` 和 `tests/accessibility/semantic.test.tsx`。
- 新增 console shell 测试、依赖 provider 的页面测试、route 测试，或需要 integration backend fixture 的测试，即使渲染的是 React component，也应放入 integration runner。

## 隔离的浏览器 E2E

先执行 `node sclaw build`，再用 `npm exec --prefix frontend -- playwright install chromium` 安装匹配的浏览器，最后执行 `npm run test:e2e --prefix frontend`。Playwright 在 `127.0.0.1:31515` 启动真实后端及导出前端的独立副本，SQLite 数据库和设置均新建于 `.tmp/playwright-*`，不复用日常应用端口，不导入个人 LLM 密钥。测试产物保留于 `frontend/test-results` 和 `frontend/playwright-report`。

启动脚本要求 Python 能导入 FastAPI 和 OpenSeesPy；运行环境在其他位置时，用 `SCLAW_E2E_PYTHON` 显式指定。`SCLAW_E2E_PORT` 可选择其他独立端口，31415 和 31416 禁用。`SCLAW_E2E_ATTACH=1` 只允许连接由 `frontend/tests/e2e/start-server.mjs` 建立、且运行身份及数据库路径核验一致的实例。不要对同一实例并行执行多条测试命令：设置测试和本地 LLM 夹具共享该实例的配置。

启动前严格核对前端构建指纹。后端目前只有源码时间戳检查，无法识别删除文件或保留时间戳的修改，因此不能替代上面的完整构建步骤。

默认浏览器测试使用本地脚本化 LLM 响应验证编排；应用、模型事务、OpenSees、结果查询和报告服务仍真实执行。这些脚本证明产品行为，不评价模型质量。付费 live 冒烟必须显式设置 `SCLAW_E2E_LIVE=1`，并另外启动独立实例，通过该实例自己的设置页面或 API 配置 LLM。仅在 shell 中存在密钥不会启用 live 测试。Live 冒烟检查交付和可见失败，不进行 benchmark 评分。

Live 运行时设置 `SCLAW_E2E_ATTACH=1` 和对应端口，执行 `npm run test:e2e --prefix frontend -- structural-analysis.spec.ts`。Live 模式允许加载 `structural-analysis.spec.ts` 和 `live-run-settings.spec.ts`；脚本化 LLM 夹具拒绝在此模式下修改设置。真实调用会消耗已配置服务的额度；不自动重试失败用例。

确定性工程流程覆盖真实 OpenSees 求解、指定位置的查询/报告/图形一致性、JSON 导出、刷新、修改失效、历史读取和撤销重算。运行控制通过中英文网页检查指导文本、上下文、记忆权限、纠错、暂停续答及工具预算的实际行为。建模方式与固定路由的控件传递由浏览器验证，具体执行分支仍由对应 runtime 回归负责；这些不是模型答题能力测试。

### 手工审核的真实梁设计回放

要逐轮复现真实模型与真实求解器流程，使用 `frontend/tests/e2e/manual/live-beam-browser.cjs`。先构建，再用独立 `SCLAW_E2E_PORT` 启动 `frontend/tests/e2e/start-server.mjs`，通过该隔离实例的设置页面或 API 配置 LLM。回放程序核对服务凭据文件、实例 ID 和独立数据库路径，拒绝日常产品端口及脚本化／未配置的模型，不改 provider 设置、不复制密钥。

将 `frontend/tests/e2e/manual/beam-design.example.json` 复制到未跟踪位置，修改对应端口、语言（`en` 或 `zh`）、原始问题、运行开关和证据目录。不加 `--run` 只准备浏览器；显式加上后才发送真实请求：

```bash
node frontend/tests/e2e/manual/live-beam-browser.cjs --config=.tmp/live-beam.json --run
```

每轮结束后，先检查真实问题及保存的工具轨迹，再向 `pending-reply.json` 指明的 `reply-N.json` 写入 `{"text":"审核后的澄清答复"}`，浏览器才会继续发送。写入 `{"finish":true}` 结束。示例不会预先选择答案或编造材料、截面、设计条件；人为给定的测试假定必须明确标注。可选的 `expectedAnalysis.metrics` 和 `absoluteTolerance` 将实际分析摘要与独立给定参考值比较，这些参考值不发送给 agent。

每次尝试使用新浏览器上下文及带时间戳的证据目录，保留会话、运行状态、流事件、分析运行、工具消息、截图、Playwright trace 和浏览器错误，包括失败尝试。完成要求当前有效分析／报告及所请求的完整通过校核；仅澄清不算完成。不自动重试。这是产品流程验收，不是 Bench 准确率结果；运行中不要重新构建或重启被测后端。

可选的 `expectedModelValues` 直接检查 `/agent/input-review` 返回的已保存模型，不把断言值发送给对话。每条规则使用点分隔的 `path` 和 `value`；可用 `collection` 配合可选的 `id` 或 `where` 筛选对象。例如 `{"collection":"elements","where":{"type":"beam"},"path":"design.l0","value":4800}` 会检查所有梁，不依赖单元编号，且没有匹配梁时失败。`minMatches` 可要求多个匹配对象，`absoluteTolerance` 用于数值容差。即使报告声称通过，缺失或不一致的输入仍使 `summary.pass` 为 false。断言只应填写本轮明确提供的条件，并保留原失败证据。


## 如何选择测试

使用能证明行为的最小分类：

- Backend 逻辑或 route 行为：添加或运行定向 Jest；如果可能影响 contract，再运行 `node tests/runner.mjs backend-regression`。
- Frontend 组件或状态行为：添加或运行 Vitest，并运行 `npm run type-check --prefix frontend`。Console shell、依赖 provider 的页面、route 或 accessibility 覆盖应使用 integration Vitest runner。
- 跨页面浏览器行为：使用 Playwright E2E。
- 工程分析输出、converter 行为、schema contract 或 agent orchestration payload：使用命名 validation 或 analysis regression。
- CLI setup、install、build 和平台兼容性：使用 smoke test。
- 真实 LLM agent 质量：使用 LLM benchmark。不要把模型质量断言塞进确定性的 unit 或 E2E 测试。

## 重叠规则

- 每个测试文件应有一个分类归属和一个主要 runner。
- CI workflow 可以调用组合命令做 gate，但 CI 中重复运行某个命令不代表测试归属转移。
- Release 和 smoke workflow 可以重复 build、lint 或 test 命令作为兼容性 gate。除非 workflow 本身就是目标，否则不要在那里新增分类专属断言。
- 不要用 E2E 测试覆盖确定性的 backend contract 或工程 fixture。
- 不要用 unit、validation 或 E2E 测试判断真实 LLM 答案质量。应使用 `tests/llm-benchmark/**`。
- 为后续 test issue 增加覆盖时，先把新测试放到负责该行为的分类下；只有当该分类缺少 CI 入口时，才补 CI wiring。

## 当前明确出来的差距

- E2E 覆盖导航、i18n/theme、capabilities、database admin、运行控制及真实工程服务的浏览器交付流程。真实模型调用单独按需运行；它不是完整的 agent 质量套件。
- Frontend integration 测试已有本地命令，但 integration runner 稳定前暂不接入 CI。
- `install-smoke.yml` 现在只负责 native install/build 兼容性。
- `llm-integration` 和 `llm-benchmark` 现在都会触及真实 LLM 行为。新增 agent 质量场景应优先走 benchmark 路径。
- Issue #234 应先确定边界和文档。缺失覆盖由单独的后续 issue 补测试。
