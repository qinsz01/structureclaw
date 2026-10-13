from pathlib import Path
import struct
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from native_materials import verify_solver_materials


def material_file(root, *, E=206000000., nu=.3):
    header = struct.pack("<4i", 3, 20190824, 1, 96)
    row = struct.pack("<i32s3i6d", 1, b"SCLAW_1", 31, 15, 0, 0., E, nu, 0., 0., 0.)
    (root / "UserMaterial.SAT").write_bytes(header + row)
    return {"M1": {"nativeMaterialId": 31, "nativeName": "SCLAW_1",
                   "requested": {"unitWeight": 0., "E": 206000., "nu": .3}}}


def test_generated_solver_material_keeps_actual_stiffness_and_disabled_weight(tmp_path):
    data = material_file(tmp_path)
    verified = verify_solver_materials(tmp_path, data)
    assert verified["source"] == "UserMaterial.SAT"
    assert verified["nativeCodeDesignSupported"] is False
    assert len(verified["sha256"]) == 64


@pytest.mark.parametrize("E,nu", [(200000000., .3), (206000000., .25)])
def test_native_material_changes_are_rejected_even_after_sdk_readback(tmp_path, E, nu):
    data = material_file(tmp_path, E=E, nu=nu)
    with pytest.raises(RuntimeError, match="material differs"):
        verify_solver_materials(tmp_path, data)


def test_unknown_or_truncated_native_records_are_rejected(tmp_path):
    data = material_file(tmp_path)
    path = tmp_path / "UserMaterial.SAT"
    path.write_bytes(path.read_bytes()[:-1])
    with pytest.raises(RuntimeError, match="schema"):
        verify_solver_materials(tmp_path, data)
