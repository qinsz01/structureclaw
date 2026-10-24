from __future__ import annotations

import base64
import copy
import json
from pathlib import Path
import struct
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from native_geometry import bind_native_geometry, NativeGeometryUnavailable
from native_reactions import recover_support_reactions


@pytest.fixture
def native():
    data = json.loads((Path(__file__).parent / "fixtures/native-two-floor-frame.json").read_text(encoding="utf-8"))
    artifacts = {name: base64.b64decode(value) for name, value in data["files"].items()}
    return data, artifacts


def test_solved_two_floor_geometry_and_all_six_reactions_match_frozen_reference(native):
    data, artifacts = native
    geometry = bind_native_geometry(data["model"], data["snapshot"], artifacts)
    assert len(geometry["native_members"]) == 36
    assert len(geometry["supports"]) == 8
    assert len(geometry["native_result_keys"]) == 36
    assert data["snapshot"]["floors"][1]["bottomM"] == 3.5999999046325684
    assert data["snapshot"]["floors"][1]["heightMm"] == 3600
    result = recover_support_reactions(
        **{key: geometry[key] for key in ("nodes", "members", "native_members", "supports")},
        station_rows=data["memberStations"], nodal_loads={key: [0.] * 6 for key in geometry["supports"]},
        source_case="D", result_source={"kind": "simultaneous-signed-stations", "caseId": "D"})
    tolerance = data["reference"]["tolerance"]
    assert set(result["reactions"]) == {row["id"] for row in data["model"]["nodes"] if all(row["restraints"])}
    for node_id in result["reactions"]:
        expected = data["reference"]["D"]["reactions"][node_id]
        for component, value in expected.items():
            absolute = tolerance["forceKN" if component.startswith("f") else "momentKNm"]
            assert result["reactions"][node_id][component] == pytest.approx(value, rel=tolerance["relative"], abs=absolute)
        source = result["reactions"][node_id]["source"]
        assert source["kind"] == "derived-node-equilibrium"
        assert source["boundary"]["rotationSource"] == "prescribed-boundary"
        assert source["boundary"]["nativeCases"] == ["DL", "LL"]


@pytest.mark.parametrize("representation", ["omitted", "null", "explicit"])
def test_optional_free_restraints_keep_the_same_verified_native_geometry(native, representation):
    data, artifacts = native
    model = copy.deepcopy(data["model"])
    expected = bind_native_geometry(model, data["snapshot"], artifacts)
    for node in model["nodes"]:
        if not any(node["restraints"]):
            if representation == "omitted":
                node.pop("restraints")
            elif representation == "null":
                node["restraints"] = None
    before = copy.deepcopy(model)
    actual = bind_native_geometry(model, data["snapshot"], artifacts)
    for key in ("nodes", "members", "native_members", "supports"):
        assert actual[key] == expected[key]
    assert model == before


@pytest.mark.parametrize("change", ["unit", "offset", "angle", "release", "missing", "boundary", "boundary-null"])
def test_native_geometry_cannot_claim_changed_or_incomplete_physics(native, change):
    data, artifacts = native
    model, snapshot = copy.deepcopy(data["model"]), copy.deepcopy(data["snapshot"])
    if change == "unit":
        snapshot["floors"][1]["bottomM"] /= 1000
    elif change in ("offset", "angle"):
        snapshot["floors"][0]["members"][0]["segment"][2 if change == "offset" else 5] = 1
    elif change == "release":
        snapshot["floors"][0]["members"][0]["supportCode"] = 3
    elif change == "missing":
        snapshot["floors"][0]["members"].pop()
    elif change == "boundary":
        model["nodes"][0]["restraints"][3] = False
    elif change == "boundary-null":
        model["nodes"][0]["restraints"] = None
    with pytest.raises(NativeGeometryUnavailable):
        bind_native_geometry(model, snapshot, artifacts)


@pytest.mark.parametrize("change", ["mpc", "free-base", "base-motion", "missing-case"])
def test_fixed_base_requires_complete_native_dof_evidence(native, change):
    data, artifacts = native
    if change == "mpc":
        blob = bytearray(artifacts["ConstraintNodeNo.SAT"])
        struct.pack_into("<i", blob, 16, 1)
        artifacts["ConstraintNodeNo.SAT"] = bytes(blob)
    elif change == "free-base":
        blob = bytearray(artifacts["NODEINDEX.SAT"])
        struct.pack_into("<f", blob, 8, 1.)
        artifacts["NODEINDEX.SAT"] = bytes(blob)
    elif change == "base-motion":
        blob = bytearray(artifacts["DISP1.SAT"])
        struct.pack_into("<f", blob, 2 * 72 + 4, 1.)
        artifacts["DISP1.SAT"] = bytes(blob)
    else:
        artifacts["WDISPGKNO.OUT"] = b"1 DL\n"
    with pytest.raises(NativeGeometryUnavailable):
        bind_native_geometry(data["model"], data["snapshot"], artifacts)
