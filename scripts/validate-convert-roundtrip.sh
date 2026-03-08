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
import json
from pathlib import Path
import sys

sys.path.insert(0, 'core')
from main import ConvertRequest, convert_structure_model

sample_file = Path('core/schemas/examples/model_03_simple_truss.json')
source = json.loads(sample_file.read_text(encoding='utf-8'))

async def run() -> None:
    export_req = ConvertRequest(
        model=source,
        source_format='structuremodel-v1',
        target_format='simple-1',
    )
    exported = await convert_structure_model(export_req)

    import_req = ConvertRequest(
        model=exported['model'],
        source_format='simple-1',
        target_format='structuremodel-v1',
    )
    imported = await convert_structure_model(import_req)

    original = source
    round_trip = imported['model']

    assert round_trip['schema_version'] == '1.0.0'
    assert len(original['nodes']) == len(round_trip['nodes'])
    assert len(original['elements']) == len(round_trip['elements'])
    assert {n['id'] for n in original['nodes']} == {n['id'] for n in round_trip['nodes']}
    assert {e['id'] for e in original['elements']} == {e['id'] for e in round_trip['elements']}

    print('[ok] convert round-trip structuremodel-v1 -> simple-1 -> structuremodel-v1')

asyncio.run(run())
PY
