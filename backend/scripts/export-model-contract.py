"""Export the Python-owned V2 contract for synchronous TypeScript consumers.

Run with the product Python environment. --check detects drift without writing.
"""
import argparse
import json
import sys
from pathlib import Path

backend = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(backend / "src/skill-shared/python"))
from structure_protocol.structure_model_v2 import StructureModelV2

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--check", action="store_true")
args = parser.parse_args()
target = backend / "src/engineering/structure-model-v2.schema.json"
content = json.dumps(StructureModelV2.model_json_schema(), ensure_ascii=False, indent=2) + "\n"
if args.check:
    if not target.exists() or json.loads(target.read_text(encoding="utf-8")) != json.loads(content):
        raise SystemExit("V2 contract is stale: run backend/scripts/export-model-contract.py")
    print("V2 contract matches the Python model")
else:
    target.write_text(content, encoding="utf-8", newline="\n")
    print(f"Exported {target.name}")
