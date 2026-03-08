#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "Core regression checks"

echo
echo "==> Analyze response contract"
./scripts/validate-analyze-contract.sh

echo
echo "==> Static regression cases"
./scripts/validate-static-regression.sh

echo
echo "==> StructureModel v1 examples"
./scripts/validate-structure-examples.sh

echo
echo "==> Convert round-trip"
./scripts/validate-convert-roundtrip.sh

echo
echo "Core regression checks passed."
