from __future__ import annotations

import base64
import copy
import json
from pathlib import Path
import struct
import sys

import pytest

sys.path[:0] = [str(Path(__file__).resolve().parents[1]), str(Path(__file__).resolve().parents[2] / "runtime")]
from native_displacements import read_native_displacements
from native_geometry import bind_native_geometry, NativeGeometryUnavailable
from native_stages import compile_free_rotations
import native_result_adapter


@pytest.fixture
def pinned(tmp_path):
    data = json.loads((Path(__file__).parent / "fixtures/native-pinned-frame.json").read_text(encoding="utf-8"))
    artifacts = {name: base64.b64decode(blob) for name, blob in data["files"].items()}
    for name, blob in artifacts.items():
        (tmp_path / name).write_bytes(blob)
    return data, artifacts, tmp_path


def test_actual_native_pin_complete_dofs_reactions_and_end_forces(pinned, monkeypatch):
    data, artifacts, directory = pinned
    geometry = bind_native_geometry(data["model"], data["snapshot"], artifacts)
    api = {key: {tuple(row["key"]): row["value"] for row in rows} for key, rows in data["api_translations"].items()}
    native = read_native_displacements(directory, data["native_nodes"], api)
    # The fixture coordinates independently bind each physical node to API IDs.
    by_point = {(row["x"], row["y"], row["z"]): row["id"] for row in data["model"]["nodes"]}
    keys = {(row["pmid"], row["floor"]): by_point[tuple(round(x / 1000, 7) for x in row["coordinates"])] for row in data["native_nodes"]}
    case = {"status": "success", "displacements": {keys[k]: v for k, v in native["caseDisplacements"]["DL"].items()},
            "nativeConstraintDisplacements": {keys[k]: v for k, v in native["constraintDisplacements"]["DL"].items()},
            "memberStations": data["memberStations"]}
    settings = {"verified": True, "requested": dict.fromkeys(("self_weight", "rigid_floor", "rigid_offsets", "construction_stage", "p_delta"), False)}
    result = {"summary": {"effectiveNativeSettings": settings, "nativeMaterialVerification": data["materialVerification"]},
              "caseResults": {"D": case}, "warnings": []}
    monkeypatch.setattr(native_result_adapter, "read_native_geometry", lambda *_: geometry)
    actual = native_result_adapter.complete_frame_results(data["model"], result, "unused")
    for node, vector in actual["displacements"].items():
        for component, value in vector.items():
            assert value == pytest.approx(data["reference"]["D"]["displacements"][node][component], rel=1e-5, abs=1e-11)
    for node, vector in actual["reactions"].items():
        for component in ("fx", "fy", "fz", "mx", "my", "mz"):
            assert vector[component] == pytest.approx(data["reference"]["D"]["reactions"][node][component], rel=1e-5, abs=1e-5)
    pin = next(key for key, row in geometry["supports"].items() if not row["restraints"][3])
    assert case["boundaryDisplacementSource"][pin]["kind"] == "solver-direct-constraint-dofs"
    assert actual["displacements"][pin]["ry"] != 0
    assert actual["displacements"][pin]["uz"] != 0  # preserve the native penalty residual
    for member, rows in actual["memberStations"].items():
        end_actions = data["reference"]["D"]["localEndActions"][member]
        for end, row in ((0, rows[0]), (1, rows[-1])):
            signs = (-1, 1, 1, -1, -1, -1) if end == 0 else (1, -1, -1, 1, 1, 1)
            for i, component in enumerate(("N", "Vy", "Vz", "T", "My", "Mz")):
                assert row["components"][component] == pytest.approx(signs[i] * end_actions[end * 6 + i], rel=1e-5, abs=1e-5)


def test_compilation_preserves_the_exact_free_rotation_contract(pinned):
    data, artifacts, directory = pinned
    for name in ("ConstraintNode.SAT", "ConstraintNodeSK.SAT"):
        (directory / name).write_bytes(artifacts[name + ".precompile"])
    receipt = compile_free_rotations(directory, [{"stiffness": [100000000376832.] * 3 + [0.] * 3}])
    assert len(receipt) == 2
    for row in receipt:
        assert (directory / row["path"]).read_bytes() == artifacts[row["path"]]
    bad = copy.deepcopy(artifacts)
    blob = bytearray(bad["ConstraintNode.SAT"])
    struct.pack_into("<d", blob, 88 + 3 * 8, 1.)
    bad["ConstraintNode.SAT"] = bytes(blob)
    with pytest.raises(NativeGeometryUnavailable, match="exactly free"):
        bind_native_geometry(data["model"], data["snapshot"], bad)
