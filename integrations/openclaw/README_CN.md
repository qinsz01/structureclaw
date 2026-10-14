# OpenClaw 的 StructureClaw 工程工具

此本地插件直接调用已安装的 StructureClaw 本体。工具参数、模型状态、修改与撤销、分析、结果查询、报告、附件证据和权限均复用本体服务，不依赖 Bench、题库、标答或另一套智能体循环。

需先安装 StructureClaw，或构建源码，并配置好本体依赖、Python 与计算引擎。只有上传附件需要运行现有 HTTP 服务；工程工具通过本体服务在独立 Node 子进程中执行。

## 安装

```sh
openclaw plugins install /绝对路径/structureclaw/integrations/openclaw
```

OpenClaw 配置示例（Windows 路径建议使用 `/`）：

```json
{
  "plugins": {
    "entries": {
      "structureclaw": {
        "enabled": true,
        "config": {
          "structureclawRoot": "G:/StructureClaw-All/structureclaw",
          "dataDir": "G:/StructureClaw-All/sclaw_data",
          "workspaceRoot": "G:/my-engineering-workspace",
          "locale": "zh",
          "runPolicy": { "budgets": { "maxToolCallsPerTurn": 40 } }
        }
      }
    }
  },
  "tools": { "allow": ["structureclaw"] }
}
```

共享上传、配置和计算引擎时，`dataDir` 应与本体 `SCLAW_DATA_DIR` 相同；省略则使用本体默认目录。插件配置不能突破本体设置中的工具权限上限。OpenClaw 侧所有工具均为可选，需要启用。

使用 `openclaw plugins inspect structureclaw --runtime --json` 检查注册。插件依赖官方 `registerTool(factory, options)` 以及可信上下文中的 `agentId`、`sessionKey`、`sessionId`；缺少身份字段会明确拒绝。宿主 `/new`、`/reset` 后使用新的工程会话。请选择提供上述接口的 OpenClaw 版本及其要求的 Node 版本，并固定部署版本；上游插件 API 仍在演进。[官方插件文档](https://docs.openclaw.ai/plugins/building-plugins)。

## 使用

1. 先调用 `sclaw_session`：`{"action":"begin","message":"用户当前的工程要求"}`。可选 `model`、`modelFormat` 会通过本体正式模型校验导入。返回实际生效的运行配置和本体会话 ID。
2. 调用 `sclaw_build_model`、`sclaw_query_model`、`sclaw_edit_model`、`sclaw_undo_model`、`sclaw_run_analysis`、`sclaw_query_results`、`sclaw_run_code_check`、`sclaw_generate_report` 等。参数 schema 直接来自本体，仅工具名增加 `sclaw_` 前缀。注册与执行时均遵守本体权限。
3. 新用户要求由操作员明确接纳，智能体不能自行重置预算。将上述插件 `config` 对象保存为 `plugin-config.json`，操作员执行：

   ```sh
   node integrations/openclaw/manage-session.mjs --config plugin-config.json --session openclaw-... --message-file user-request.txt
   ```

   也可用 `--message "新用户要求"`。模型和历史保留，本体开始下一轮预算；此管理入口不注册为智能体工具。当前宿主接口未提供可证明的真实新用户消息边界，插件不会猜测或自动重置。
4. 中断后先 `action:"inspect"`。若返回可恢复的已完成记录，再以返回的 `stateHash` 和 `claim.token`（无 claim 则 `null`）调用 `recover`，分别放入 `expectedStateHash`、`expectedClaimToken`。恢复只发布已有记录，不重跑修改或求解。`outcome_unknown` 必须检查原运行，不能自动重放。

模型不能通过工具参数指定其他本体会话 ID。身份由可信宿主上下文生成，插件重载后仍读取同一持久状态和预算。已完成的宿主调用 ID 再次投递时，会返回原运行/调用标识并拒绝重放；跨重载或新一轮也不会重复修改或求解。每次响应不会重复发送整个工程模型和结果档案。

## 附件

使用现有本体上传接口，`conversationId` 取 `sclaw_session` 返回的 `attachmentUploadConversationId`：

```sh
curl -F "file=@drawing.pdf" "http://127.0.0.1:31415/api/v1/files/upload?conversationId=openclaw-..."
```

地址应替换为实际后端地址。该上传接口不要求数据库中已有 Conversation 行。上传下一轮所需附件后，操作员用 `manage-session.mjs` 接纳新要求，只授权当前会话上传目录中的文件；随后用上传返回的 `relPath` 调用 `sclaw_analyze_file`。PDF 分页、图像定点区域、必需字段、地震波输入均使用本体原参数。图像识别使用本体已配置的视觉模型。

直接调用 `createPublicToolSession` 的可信程序，开始一轮时应显式传入 `attachmentPaths`。缺省表示没有附件授权；resume 不能扩大权限。纯建模调用不受影响。插件没有新建另一套附件库或工程状态。

## 边界与验证

OpenClaw 管理自己的聊天上下文、模型预算和智能体循环；本体只控制自身工具及模型调用。外部宿主不支持 `context.history:"current-turn"`，会明确拒绝，不能假称已裁剪宿主记忆。本地桥不能执行宿主沙箱约束，沙箱调用也会拒绝。取消发生在接纳前则不启动；已接纳操作等待收尾并记录取消请求，不因超时重启或自动重放。

构建后运行 `node --test integrations/openclaw/__tests__/bridge.test.mjs`。测试使用真实本体子进程和原 multipart 上传路由，验证 schema 一致、权限、持久预算、重复调用拒绝、会话隔离、附件越权拒绝及接纳前取消。此外已用 **OpenClaw 2026.6.33 / Node 24.14.1** 在隔离宿主配置中实际加载：四个授权工具注册成功，无诊断错误。可用 `node integrations/openclaw/__tests__/host-loader.mjs /路径/openclaw/openclaw.mjs` 复现。完整 Gateway/模型对话仍属于另外的部署验收。无需付费模型或商业求解器。

本体的 `backend/tests/engineering-package-acceptance.mjs` 也会从仅安装生产依赖的 tarball 中加载此桥：读取工具定义、建立隔离会话、执行 `calculate` 和 `query_model`，并检查重载后预算不重置、已完成调用不重放。最终 runtime-probe 记录会单独报告安装包中的桥接结果。
