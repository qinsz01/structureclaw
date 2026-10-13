from __future__ import annotations

import copy
import json
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from native_reactions import NativeReactionUnavailable, column_end_actions, recover_support_reactions


@pytest.fixture
def cantilevers():
    data = json.loads((Path(__file__).parent / "fixtures/native-six-dof-cantilevers.json").read_text(encoding="utf-8"))
    nodes, members, geometry, supports, loads = {}, {}, {}, {}, {}
    native_to_source = {}
    for index, ref in enumerate(data["reference"]["references"]):
        source_id = ref["nodeId"]
        native_id = data["nodeMapping"][source_id]["pmid"]
        top_record = next(row for row in data["nativeNodes"] if row["pmid"] == native_id and row["floor"] == 1)
        bottom_record = next(row for row in data["nativeNodes"] if row["pmid"] == native_id and row["floor"] == 0)
        top, bottom, member = source_id, source_id + "-base", f"C{index}"
        nodes[top] = [value / 1000 for value in top_record["coordinates"]]
        nodes[bottom] = [value / 1000 for value in bottom_record["coordinates"]]
        members[member] = {"type": "column", "nodeStart": bottom, "nodeEnd": top}
        native_to_source[native_id + 1] = member
        geometry[member] = {
            "kind": "column", "bottomNodeId": bottom, "topNodeId": top,
            "bottomCoordinates": nodes[bottom], "topCoordinates": nodes[top],
            "angleDegrees": 0, "offsetsM": [0.] * 6, "releases": [False] * 12,
            "geometrySource": {"kind": "test-readback-contract", "nativeMemberId": native_id + 1},
        }
        supports[bottom] = {"restraints": [True] * 6, "nativeRestraints": [True] * 6,
                            "source": {"kind": "test-readback-contract"}}
        loads[bottom] = [0.] * 6
    station_rows = {native_to_source[row["member"][0]]: row["stations"] for row in data["apiStationRows"] if row["case"] == "LL"}
    args = dict(nodes=nodes, members=members, native_members=geometry, supports=supports,
                station_rows=station_rows, nodal_loads=loads, source_case="LL",
                result_source={"kind": "simultaneous-signed-stations", "caseId": "LL", "nativeRun": data["nativeRun"]})
    return args, data


def test_six_native_column_components_recover_independent_cantilever_equilibrium(cantilevers):
    args, data = cantilevers
    actual = recover_support_reactions(**args)
    length = data["reference"]["length_m"]
    # This is a convention calibration against equilibrium. A future native
    # acceptance run must freeze its force tolerance before solving; the saved
    # displacement reference does not specify force/moment absolute tolerances.
    residuals = []
    for index, load in enumerate(data["reference"]["loadVectors"]):
        fx, fy, fz, mx, my, mz = load
        expected = (-fx, -fy, -fz, -mx + length * fy, -my - length * fx, -mz)
        row = actual["reactions"][f"N{index}-base"]
        residuals.extend(abs(row[key] - value) for key, value in zip(("fx", "fy", "fz", "mx", "my", "mz"), expected))
        assert row["source"]["kind"] == "derived-node-equilibrium"
        assert row["R"] == pytest.approx((row["fx"]**2 + row["fy"]**2 + row["fz"]**2)**.5)
    # Preserve the observed float32 calibration bound, not a changed native-run
    # pass criterion. Raw forces are retained in the fixture without rounding.
    assert max(residuals) == 1.9073486328125e-6
    assert actual["source"]["nativeCutOrder"] == ["bottom", "top"]


def test_endpoint_reversal_and_direct_support_load_keep_correct_sign(cantilevers):
    args, _ = cantilevers
    original = recover_support_reactions(**args)["reactions"]["N0-base"]
    member = args["members"]["C0"]
    member["nodeStart"], member["nodeEnd"] = member["nodeEnd"], member["nodeStart"]
    applied = [2., -3., 4., -5., 6., -7.]
    args["nodal_loads"]["N0-base"] = applied
    row = recover_support_reactions(**args)["reactions"]["N0-base"]
    for key, value in zip(("fx", "fy", "fz", "mx", "my", "mz"), applied):
        assert row[key] == original[key] - value


@pytest.mark.parametrize("mutation,pattern", [
    (lambda a: a["station_rows"]["C0"].pop(), "complete simultaneous"),
    (lambda a: a["station_rows"].pop("C0"), "missing incident member"),
    (lambda a: a["result_source"].update(kind="signed-component-envelope"), "simultaneous signed"),
    (lambda a: a["result_source"].update(caseId="DL"), "case-bound"),
    (lambda a: a["nodal_loads"].pop("N0-base"), "explicit support nodal load"),
    (lambda a: a["supports"]["N0-base"]["nativeRestraints"].__setitem__(5, False), "restraints must agree"),
    (lambda a: a["native_members"]["C0"].update(angleDegrees=90), "rotated native"),
    (lambda a: a["native_members"]["C0"].update(offsetsM=[.1, 0, 0, 0, 0, 0]), "offset endpoint"),
    (lambda a: a["native_members"]["C0"].pop("geometrySource"), "native readback source"),
])
def test_incomplete_or_uncalibrated_evidence_cannot_produce_reactions(cantilevers, mutation, pattern):
    args, _ = cantilevers
    mutation(args)
    with pytest.raises(NativeReactionUnavailable, match=pattern):
        recover_support_reactions(**args)


def test_unknown_incident_beam_is_not_dropped_from_support_equilibrium(cantilevers):
    args, _ = cantilevers
    args["members"]["beam-at-base"] = {"type": "beam", "nodeStart": "N0-base", "nodeEnd": "N1-base"}
    with pytest.raises(NativeReactionUnavailable, match="missing incident member beam-at-base"):
        recover_support_reactions(**args)


def test_inclined_column_and_native_coordinate_unit_mismatch_are_rejected(cantilevers):
    args, _ = cantilevers
    shifted = copy.deepcopy(args)
    shifted["nodes"]["N0"][0] += .3
    shifted["native_members"]["C0"]["topCoordinates"][0] = shifted["nodes"]["N0"][0]
    with pytest.raises(NativeReactionUnavailable, match="inclined"):
        recover_support_reactions(**shifted)
    args["native_members"]["C0"]["topCoordinates"] = [0., 0., 3000.]
    with pytest.raises(NativeReactionUnavailable, match="coordinates differ"):
        recover_support_reactions(**args)
