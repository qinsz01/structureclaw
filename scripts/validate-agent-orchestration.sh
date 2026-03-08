#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

npm run build --prefix backend >/dev/null

node - <<'JS'
const assert = (cond, msg) => {
  if (!cond) {
    throw new Error(msg);
  }
};

const run = async () => {
  const { AgentService } = await import('./backend/dist/services/agent.js');

  // 0) protocol metadata
  {
    const protocol = AgentService.getProtocol();
    assert(protocol.version === '1.0.0', 'protocol version should be 1.0.0');
    assert(Array.isArray(protocol.tools) && protocol.tools.length >= 3, 'protocol tools should be present');
    assert(protocol.tools.some((t) => t.name === 'analyze'), 'analyze tool spec should exist');
    console.log('[ok] agent protocol metadata');
  }

  // 1) missing model -> clarification
  {
    const svc = new AgentService();
    const result = await svc.run({ message: '帮我算一下门式刚架' });
    assert(result.success === false, 'missing model should fail');
    assert(result.needsModelInput === true, 'missing model should require model input');
    console.log('[ok] agent missing-model clarification');
  }

  // 2) validate failure path
  {
    const svc = new AgentService();
    svc.engineClient.post = async (path) => {
      if (path === '/validate') {
        const err = new Error('validation failed');
        err.response = { data: { errorCode: 'INVALID_STRUCTURE_MODEL' } };
        throw err;
      }
      throw new Error(`unexpected path ${path}`);
    };

    const result = await svc.run({
      message: '做静力分析',
      context: {
        model: { schema_version: '1.0.0' },
      },
    });
    assert(result.success === false, 'validate failure should fail');
    assert(result.response.includes('模型校验失败'), 'validate failure response should be surfaced');
    assert(result.toolCalls.some((c) => c.tool === 'validate' && c.error), 'validate error trace should exist');
    console.log('[ok] agent validate-failure trace');
  }

  // 3) success orchestration path
  {
    const svc = new AgentService();
    svc.engineClient.post = async (path, payload) => {
      if (path === '/validate') {
        return { data: { valid: true, schemaVersion: '1.0.0' } };
      }
      if (path === '/analyze') {
        return {
          data: {
            schema_version: '1.0.0',
            analysis_type: payload.type,
            success: true,
            error_code: null,
            message: 'ok',
            data: {},
            meta: {},
          },
        };
      }
      throw new Error(`unexpected path ${path}`);
    };

    const result = await svc.run({
      message: '静力分析这个模型',
      context: {
        model: {
          schema_version: '1.0.0',
          nodes: [],
          elements: [],
          materials: [],
          sections: [],
        },
        autoAnalyze: true,
      },
    });

    assert(result.success === true, 'successful orchestration should succeed');
    assert(result.toolCalls.some((c) => c.tool === 'validate'), 'validate should be called');
    assert(result.toolCalls.some((c) => c.tool === 'analyze'), 'analyze should be called');
    console.log('[ok] agent success orchestration');
  }

  // 4) stream orchestration events
  {
    const svc = new AgentService();
    svc.run = async () => ({
      success: true,
      mode: 'rule-based',
      needsModelInput: false,
      plan: [],
      toolCalls: [],
      response: 'ok',
    });

    const events = [];
    for await (const chunk of svc.runStream({ message: 'stream test', mode: 'execute' })) {
      events.push(chunk.type);
    }

    assert(events[0] === 'start', 'stream first event should be start');
    assert(events.includes('result'), 'stream should include result event');
    assert(events[events.length - 1] === 'done', 'stream last event should be done');
    console.log('[ok] agent stream events');
  }
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
JS
