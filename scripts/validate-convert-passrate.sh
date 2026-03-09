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

formats = ('simple-1', 'compact-1')
samples = sorted(Path('core/schemas/examples').glob('model_*.json'))
threshold = 0.95

async def check_one(sample_path: Path, external_format: str) -> bool:
    source = json.loads(sample_path.read_text(encoding='utf-8'))
    exported = await convert_structure_model(ConvertRequest(
        model=source,
        source_format='structuremodel-v1',
        target_format=external_format,
    ))
    imported = await convert_structure_model(ConvertRequest(
        model=exported['model'],
        source_format=external_format,
        target_format='structuremodel-v1',
    ))
    round_trip = imported['model']
    return (
        len(source.get('nodes', [])) == len(round_trip.get('nodes', []))
        and len(source.get('elements', [])) == len(round_trip.get('elements', []))
        and {n['id'] for n in source.get('nodes', [])} == {n['id'] for n in round_trip.get('nodes', [])}
        and {e['id'] for e in source.get('elements', [])} == {e['id'] for e in round_trip.get('elements', [])}
    )

async def run() -> None:
    total = 0
    passed = 0
    failed = []

    for sample in samples:
        for fmt in formats:
            total += 1
            ok = await check_one(sample, fmt)
            if ok:
                passed += 1
            else:
                failed.append(f'{sample.name}::{fmt}')

    pass_rate = passed / total if total else 0.0
    print(f'[pass-rate] passed={passed} total={total} rate={pass_rate:.3f}')
    if failed:
        print('[failed]')
        for item in failed:
            print(f' - {item}')

    assert pass_rate >= threshold, f'round-trip pass rate {pass_rate:.3f} < {threshold:.2f}'
    print('[ok] convert round-trip pass rate meets threshold')

asyncio.run(run())
PY
