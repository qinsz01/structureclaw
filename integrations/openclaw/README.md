# StructureClaw tools for OpenClaw

This local plugin calls the installed StructureClaw application. Tool parameters, model state, editing, undo, analysis, result queries, reports, attachment evidence, and permissions use the same backend services as the product. It has no dependency on Bench, task files, answer files, or an external agent loop.

The plugin needs an installed StructureClaw package or an already built source checkout, with its normal dependencies and Python environment configured. A running HTTP server is only needed to use the existing file-upload endpoint. The engineering calls themselves run in owned Node subprocesses using the application services.

## Install

Install the directory shipped with StructureClaw:

```sh
openclaw plugins install /absolute/path/to/structureclaw/integrations/openclaw
```

Configure the plugin in OpenClaw (use absolute paths):

```json
{
  "plugins": {
    "entries": {
      "structureclaw": {
        "enabled": true,
        "config": {
          "structureclawRoot": "/absolute/path/to/structureclaw",
          "dataDir": "/absolute/path/to/structureclaw-data",
          "workspaceRoot": "/absolute/path/to/engineering-workspace",
          "locale": "en",
          "runPolicy": {
            "budgets": { "maxToolCallsPerTurn": 40 }
          }
        }
      }
    }
  },
  "tools": { "allow": ["structureclaw"] }
}
```

`dataDir` must match the application's `SCLAW_DATA_DIR` when sharing its uploads, settings, and engine installations. Omit it to use the application's ordinary default. Server settings remain the permission ceiling: plugin configuration cannot enable a tool denied by StructureClaw. All plugin tools are optional on the OpenClaw side.

Inspect registration with `openclaw plugins inspect structureclaw --runtime --json`. The adapter uses the documented `registerTool(factory, options)` API and trusted factory `agentId`, `sessionKey`, and `sessionId`. A host lacking any identity field is rejected; `/new` or `/reset` selects a new engineering conversation. Use a host version providing this contract and its required Node version. Upstream APIs are experimental; pin the deployed OpenClaw version. [Official plugin API documentation](https://docs.openclaw.ai/plugins/building-plugins).

## Use

1. Call `sclaw_session` with `{ "action": "begin", "message": "the user's engineering request" }`. An optional `model` and `modelFormat` import through normal application validation. The response records the effective RunPolicy and application session ID.
2. Use `sclaw_build_model`, `sclaw_query_model`, `sclaw_edit_model`, `sclaw_undo_model`, `sclaw_run_analysis`, `sclaw_query_results`, `sclaw_run_code_check`, and `sclaw_generate_report`. Their argument schemas are the live application schemas; only the `sclaw_` prefix is added. Available tools are filtered by application policy at registration and checked again by the session before execution.
3. A new user request needs an operator-admitted turn. The agent cannot reset its own budget. Save the plugin's `config` object above as `plugin-config.json`, then the operator runs:

   ```sh
   node integrations/openclaw/manage-session.mjs --config plugin-config.json --session openclaw-... --message-file user-request.txt
   ```

   This retains the model/history and starts the next application turn. `--message "request"` is also supported. The management entry is not an agent tool. The current host contract does not supply a proven user-message boundary, so the plugin does not infer one or automatically reset counters.
4. After an interrupted or unknown outcome, use `action: "inspect"`. If it reports a recoverable recorded completion, call `action: "recover"` with the returned `stateHash` as `expectedStateHash` and `claim.token` (or `null`) as `expectedClaimToken`. Recovery never reruns a solver or model edit. If status is `outcome_unknown`, inspect the original run; do not repeat the call automatically.

The plugin never accepts an application session ID from tool arguments. It derives one from the trusted host's agent and conversation incarnation. Restarting the plugin resumes persisted state and counters. A repeated host tool-call ID is rejected with its recorded run/call IDs after completion, including after restart or a new turn; it cannot repeat an edit or solver run. It does not export the entire model/result archive into every tool reply.

## Attachments

Use the existing StructureClaw upload endpoint with the `attachmentUploadConversationId` returned by `sclaw_session`:

```sh
curl -F "file=@drawing.pdf" "http://127.0.0.1:31415/api/v1/files/upload?conversationId=openclaw-..."
```

Use your configured backend address. The upload endpoint accepts this identifier without a database conversation row. After attaching the files for the next user request, the operator starts that turn with `manage-session.mjs`; its attachment allowlist contains only files in that conversation's upload directory. Call `sclaw_analyze_file` with the upload response's `relPath`. PDF paging, targeted image regions, required fields, and ground-motion input use the ordinary tool schema. Image recognition uses StructureClaw's configured vision provider; it is not supplied by the host's LLM context.

Direct callers of `createPublicToolSession` must now explicitly provide trusted `attachmentPaths` when beginning a turn. An omitted list grants no attachment access; resume cannot expand the list. This does not affect model-only callers. No new attachment storage or second engineering state is maintained by the plugin.

## Boundaries and verification

OpenClaw owns conversation text, its model budget, and its agent loop. StructureClaw only enforces its own tool/LLM operations. `context.history: "current-turn"` is rejected for this external host; the plugin does not claim to prune host memory. Sandboxed host calls are rejected because a local Node bridge cannot enforce that sandbox. Calls cancelled before admission do not start; cancellation after admission waits for completion and reports it. No timeout restarts or automatic replay occur.

Run `node --test integrations/openclaw/__tests__/bridge.test.mjs` from a built source checkout. Tests use real application subprocesses and the real multipart upload route, covering schema equality, policy, durable budgets, repeated-call rejection, session isolation, attachment denial, and cancellation before admission. Actual runtime registration was also checked with OpenClaw **2026.6.33**, Node **24.14.1**, in an isolated host configuration: four policy-selected tools loaded without diagnostics. Reproduce with `node integrations/openclaw/__tests__/host-loader.mjs /path/to/openclaw/openclaw.mjs`. A complete Gateway/LLM conversation remains a separate deployment check. No paid model or commercial solver is needed.
