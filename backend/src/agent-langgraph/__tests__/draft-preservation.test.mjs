import { describe, expect, test } from "@jest/globals";

describe("draft extraction preservation", () => {
  test("prefers explicit tool messages and falls back to graph user messages", async () => {
    const { resolveToolInputMessage } = await import("../../../dist/agent-langgraph/tools.js");

    expect(resolveToolInputMessage(
      "请分析这个混凝土框架",
      "请分析这个钢框架",
    )).toBe("请分析这个混凝土框架");
    expect(resolveToolInputMessage(
      "",
      "请分析这个钢框架",
    )).toBe("请分析这个钢框架");
    expect(resolveToolInputMessage(
      undefined,
      "请分析这个钢框架",
    )).toBe("请分析这个钢框架");
    expect(resolveToolInputMessage(
      "",
      "",
      [{ role: "user", content: "请分析这个钢框架" }],
    )).toBe("请分析这个钢框架");
    expect(resolveToolInputMessage("直接工具调用消息", "")).toBe("直接工具调用消息");
  });

  test("adds canonical attachment details when tool input omits them", async () => {
    const { resolveToolInputMessage } = await import("../../../dist/agent-langgraph/tools.js");

    const prompt = "请根据这张结构图识别类型并分析";
    const canonical = [
      prompt,
      "",
      "[已上传文件]",
      "下面会提供附件的解析内容。",
      "- frame-sketch.png (uploads/frame-sketch.png)",
      "",
      "[附件视觉摘要: frame-sketch.png]",
      "结构类型：两层单跨钢框架；跨度 6m；层高 3.6m；楼面荷载 10 kN/m2。",
    ].join("\n");

    const resolved = resolveToolInputMessage(prompt, canonical);
    expect(resolved).toContain(prompt);
    expect(resolved.split(prompt)).toHaveLength(2);
    expect(resolved).toContain("[附件视觉摘要: frame-sketch.png]");
    expect(resolved).toContain("两层单跨钢框架");
    expect(resolved).not.toContain("[已上传文件]");
    expect(resolved).not.toContain("uploads/frame-sketch.png");
  });

  test("strips benchmark retry feedback before structural extraction", async () => {
    const { resolveRetryTaskMessage } = await import("../../../dist/agent-langgraph/tools.js");

    expect(resolveRetryTaskMessage([
      "上次尝试失败：structural_type 检查失败：期望 frame，实际得到 concrete-frame。",
      "",
      "2层单跨钢框架，层高3.6m，跨度6m，楼面荷载10kN/m，请进行静力分析。",
    ].join("\n"))).toBe("2层单跨钢框架，层高3.6m，跨度6m，楼面荷载10kN/m，请进行静力分析。");

    expect(resolveRetryTaskMessage([
      "Previous attempt failed: structural_type check failed: expected frame, got concrete-frame.",
      "",
      "Analyze a two-story single-bay steel frame.",
    ].join("\n"))).toBe("Analyze a two-story single-bay steel frame.");

    expect(resolveRetryTaskMessage("请把这个结构改成混凝土框架")).toBe("请把这个结构改成混凝土框架");
  });

});

  test('extraction cannot turn an agent restatement into user-supplied dimensions', async () => {
    const { resolveExtractionInputMessage } = await import('../../../dist/agent-langgraph/tools.js');
    expect(resolveExtractionInputMessage('Q235B, I20a, web 5mm, flange 7mm', 'Q235B + I20a')).toBe('Q235B + I20a');
    expect(resolveExtractionInputMessage('direct external tool input', '')).toBe('direct external tool input');
  });
  test('extraction uses the latest actual clarification answer without losing previous draft fields', async () => {
    const { resolveExtractionInputMessage } = await import('../../../dist/agent-langgraph/tools.js');
    const messages=[{role:'user',content:'10m beam, 1kN at midspan'},
      {role:'tool',name:'ask_user_clarification',content:JSON.stringify({type:'clarification_answered',answer:'Q235B + I20a'})},
      {role:'assistant',content:'I will assume a 5mm web'}];
    expect(resolveExtractionInputMessage('web 5mm', '10m beam, 1kN at midspan', messages)).toBe('Q235B + I20a');
    messages.push({role:'user',content:'Change the section to 100X200'});
    expect(resolveExtractionInputMessage('100X300', 'Change the section to 100X200', messages)).toBe('Change the section to 100X200');
  });

test.each(['接受', '不接受，用Q355B', '可以'])('clarification answer %s retains its question as unconfirmed context and canonical attachment evidence', async answer => {
  const {resolveExtractionInputMessage}=await import('../../../dist/agent-langgraph/tools.js');
  const canonical='按附件设计梁\n\n[附件解析: beam.csv]\nspan_m,load_kn\n10,1';
  const question='材料Q235B、截面I20a，是否接受？';
  const messages=[{role:'user',content:canonical},{role:'tool',name:'ask_user_clarification',content:JSON.stringify({type:'clarification_answered',question,answer})}];
  const resolved=resolveExtractionInputMessage('ASSISTANT_INVENTED_COEFFICIENT',canonical,messages);
  expect(resolved).not.toContain('ASSISTANT_INVENTED_COEFFICIENT');
  expect(JSON.parse(resolved.split('\n')[1])).toEqual({question,answer});
  expect(resolved).toContain('unconfirmed context, not user-supplied facts');
  expect(resolved).toContain('rejected or unselected alternatives remain unconfirmed');
  expect(resolved).toContain('[附件解析: beam.csv]');
});

test('option labels and numeric answers remain bound to the recorded clarification', async () => {
  const {resolveExtractionInputMessage}=await import('../../../dist/agent-langgraph/tools.js');
  const question='梁跨度(m)是多少？', answer='10', options=[{label:'10m',value:'10'}];
  const resolved=resolveExtractionInputMessage('20m','design beam',[{role:'tool',name:'ask_user_clarification',content:JSON.stringify({type:'clarification_answered',question,options,answer})}]);
  expect(JSON.parse(resolved.split('\n')[1])).toEqual({question,options,answer});
  expect(resolved).toContain('A bare yes to multiple alternatives does not select one');
});

test('external hosts retain canonical turn evidence and can supply input directly when no turn message exists', async () => {
  const {resolveExtractionInputMessage}=await import('../../../dist/agent-langgraph/tools.js');
  expect(resolveExtractionInputMessage('assistant restatement','actual first task',[])).toBe('actual first task');
  expect(resolveExtractionInputMessage('assistant restatement','actual clarification in a new turn',[])).toBe('actual clarification in a new turn');
  expect(resolveExtractionInputMessage('direct host input','',[])).toBe('direct host input');
});

test('a resumed answer retains earlier actual user evidence lost by a previous extraction', async () => {
  const { resolveExtractionInputMessage } = await import('../../../dist/agent-langgraph/tools.js');
  const reply = (question, answer) => ({ role: 'tool', name: 'ask_user_clarification',
    content: JSON.stringify({ type: 'clarification_answered', question, answer }) });
  const resolved = resolveExtractionInputMessage('Invented Q999', '10m beam', [
    { role: 'user', content: '10m beam' }, reply('Material and section?', '材料Q235钢，截面工字钢I20a'),
    { role: 'assistant', content: 'Use invented Q999' }, reply('Confirm dimensions?', '200×100×7×11.4 mm'),
  ]);
  expect(resolved).toContain('材料Q235钢，截面工字钢I20a');
  expect(resolved).toContain('200×100×7×11.4 mm');
  expect(resolved).not.toContain('Q999');
  expect(resolved).toContain('unless superseded');
});
