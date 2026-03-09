#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ -x core/.venv-uv-lite/bin/python ]]; then
  PYTHON_BIN="core/.venv-uv-lite/bin/python"
elif [[ -x core/.venv/bin/python ]]; then
  PYTHON_BIN="core/.venv/bin/python"
else
  echo "No Python environment found at core/.venv or core/.venv-uv-lite" >&2
  exit 1
fi

"$PYTHON_BIN" - <<'PY'
import asyncio
import sys

sys.path.insert(0, 'core')
from main import CodeCheckRequest, code_check

async def run() -> None:
    result = await code_check(CodeCheckRequest(
        model_id='trace-demo',
        code='GB50017',
        elements=['E1'],
        context={
            'analysisSummary': {'analysisType': 'static', 'success': True},
            'utilizationByElement': {'E1': {'正应力': 0.73}},
        },
    ))

    assert result['traceability']['modelId'] == 'trace-demo'
    assert result['traceability']['analysisSummary']['analysisType'] == 'static'
    detail = result['details'][0]
    item = detail['checks'][0]['items'][0]
    assert item['clause']
    assert item['formula']
    assert item['inputs']['demand'] >= 0
    assert item['utilization'] >= 0
    print('[ok] code-check traceability contract')

asyncio.run(run())
PY
