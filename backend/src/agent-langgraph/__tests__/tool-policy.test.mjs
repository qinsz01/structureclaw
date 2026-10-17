import { describe, expect, test } from "@jest/globals";

describe("LangGraph tool policy", () => {
  test("checkpointed tool policy overrides missing resume-request configuration", async () => {
    const { deriveToolContext } = await import("../../../dist/agent-langgraph/tool-context.js");
    const context = deriveToolContext({
      toolAccessPolicy: {
        enabledToolIds: ["detect_structure_type", "ask_user_clarification"],
        disabledToolIds: ["calculate"],
        fileAccessAllowlist: [".uploads/case/input.dxf"],
      },
    }, undefined, { allowShell: false });

    expect([...context.activeToolIds]).toEqual(["ask_user_clarification", "detect_structure_type"]);
    expect(context.fileAccessAllowlist).toEqual([".uploads/case/input.dxf"]);
  });

  test("tools node restores checkpointed access policy before resolving tools", async () => {
    const { toolContextForNode } = await import("../../../dist/agent-langgraph/graph.js");
    const configurable = Object.freeze({ allowShell: false });
    const state = {
      selectedSkillIds: ["beam"],
      toolAccessPolicy: {
        enabledToolIds: ["analyze_file"],
        disabledToolIds: ["read_file"],
        fileAccessAllowlist: [".uploads/case/input.dxf"],
      },
    };

    const context = toolContextForNode(state, configurable);

    expect({ ...context, activeToolIds: [...context.activeToolIds] }).toEqual({
      activeToolIds: ["analyze_file"],
      skillScope: ["beam"],
      maxToolCallsPerTurn: undefined,
      fileAccessAllowlist: [".uploads/case/input.dxf"],
    });
  });

  test("explicit empty enabledToolIds binds no tools", async () => {
    const { resolveActiveToolIds } = await import("../../../dist/agent-langgraph/tool-policy.js");

    const result = resolveActiveToolIds({
      requestedEnabledToolIds: [],
      requestedDisabledToolIds: undefined,
      allowShell: false,
    });

    expect(result.activeToolIds).toEqual([]);
    expect(result.deniedToolIds).toEqual({});
    expect(result.unknownToolIds).toEqual([]);
  });

  test("undefined enabledToolIds binds default core tools", async () => {
    const { resolveActiveToolIds } = await import("../../../dist/agent-langgraph/tool-policy.js");

    const result = resolveActiveToolIds({
      requestedEnabledToolIds: undefined,
      requestedDisabledToolIds: undefined,
      allowShell: false,
    });

    expect(result.activeToolIds).toEqual([
      "analyze_file",
      "ask_user_clarification",
      "build_model",
      "calculate",
      "delete_path",
      "detect_structure_type",
      "edit_model",
      "extract_draft_params",
      "generate_report",
      "glob_files",
      "grep_files",
      "memory",
      "move_path",
      "query_model",
      "query_results",
      "read_file",
      "replace_in_file",
      "review_input",
      "run_analysis",
      "run_code_check",
      "set_session_config",
      "undo_model",
      "validate_model",
      "write_file",
    ]);
    expect(result.deniedToolIds.shell).toContain("SHELL_DISABLED");
  });

  test("disabledToolIds remove tools from the active set", async () => {
    const { resolveActiveToolIds } = await import("../../../dist/agent-langgraph/tool-policy.js");

    const result = resolveActiveToolIds({
      requestedEnabledToolIds: undefined,
      requestedDisabledToolIds: ["run_analysis", "set_session_config"],
      allowShell: false,
    });

    expect(result.activeToolIds).not.toContain("run_analysis");
    expect(result.activeToolIds).not.toContain("set_session_config");
    expect(result.deniedToolIds.run_analysis).toContain("DISABLED_BY_REQUEST");
    expect(result.deniedToolIds.set_session_config).toContain("DISABLED_BY_REQUEST");
  });

  test("unknown requested tools are reported and excluded", async () => {
    const { resolveActiveToolIds } = await import("../../../dist/agent-langgraph/tool-policy.js");

    const result = resolveActiveToolIds({
      requestedEnabledToolIds: ["detect_structure_type", "shell"],
      requestedDisabledToolIds: ["missing_tool"],
      allowShell: false,
    });

    expect(result.activeToolIds).toEqual(["detect_structure_type"]);
    expect(result.unknownToolIds).toEqual(["missing_tool"]);
    expect(result.deniedToolIds.shell).toContain("SHELL_DISABLED");
  });
});
