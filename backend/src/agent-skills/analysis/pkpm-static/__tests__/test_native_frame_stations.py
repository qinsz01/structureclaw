from __future__ import annotations

import base64
import copy
import json
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from native_geometry import bind_native_geometry
from native_frame_stations import map_frame_stations, NativeStationUnavailable


@pytest.fixture
def native():
    data = json.loads((Path(__file__).parent / "fixtures/native-two-floor-frame.json").read_text(encoding="utf-8"))
    artifacts = {name: base64.b64decode(value) for name, value in data["files"].items()}
    geometry = bind_native_geometry(data["model"], data["snapshot"], artifacts)
    return data, geometry


def test_all_native_cut_components_match_independent_frozen_timoshenko_frame(native):
    data, geometry = native
    result = map_frame_stations(data["model"], geometry, data["memberStations"])
    tolerance = data["reference"]["tolerance"]
    keys = ("N", "Vy", "Vz", "T", "My", "Mz")
    checks = 0
    for member_id, stations in result.items():
        reference = data["reference"]["D"]["localEndActions"][member_id]
        for end, station in ((0, stations[0]), (1, stations[-1])):
            signs = (-1, 1, 1, -1, -1, -1) if end == 0 else (1, -1, -1, 1, 1, 1)
            for i, component in enumerate(keys):
                expected = signs[i] * reference[end * 6 + i]
                assert station["components"][component] == pytest.approx(expected, rel=tolerance["relative"], abs=tolerance["forceKN" if i < 3 else "momentKNm"]), (member_id, end, component)
                checks += 1
        if member_id.startswith(("x", "y")):
            # The frozen source model applies 8 kN/m downward uniformly to
            # every horizontal beam. This formula uses the independent
            # reference endpoint action, not another native result row.
            loads = [load for case in data["model"]["load_cases"] for load in case["loads"] if load.get("element") == member_id]
            assert loads and all(load["type"] == "distributed" and load.get("wz") == -8 for load in loads)
            for station in stations[1:-1]:
                x = station["positionM"]
                expected = [-reference[0], reference[1], reference[2] - 8 * x,
                            -reference[3], -reference[4] - reference[2] * x + 4 * x*x,
                            -reference[5] + reference[1] * x]
                for i, component in enumerate(keys):
                    assert station["components"][component] == pytest.approx(expected[i], rel=tolerance["relative"], abs=tolerance["forceKN" if i < 3 else "momentKNm"]), (member_id, x, component)
                    checks += 1
    assert checks == 1272


def test_physical_endpoint_reversal_and_local_axis_rotation_are_vector_transforms(native):
    data, geometry = native
    forward = map_frame_stations(data["model"], geometry, data["memberStations"])
    model = copy.deepcopy(data["model"])
    for member in model["elements"]:
        member["nodes"].reverse()
    reverse = map_frame_stations(model, geometry, data["memberStations"])
    for member_id, rows in forward.items():
        for first, second in zip(rows, reversed(reverse[member_id])):
            for offset, names in ((0, ("N", "Vy", "Vz")), (3, ("T", "My", "Mz"))):
                signs = (1, -1, -1) if offset == 0 else (1, 1, 1)
                a = [sum(signs[i] * first["components"][name] * first["localAxes"][i][k] for i, name in enumerate(names)) for k in range(3)]
                b = [sum(signs[i] * second["components"][name] * second["localAxes"][i][k] for i, name in enumerate(names)) for k in range(3)]
                assert a == pytest.approx([-v for v in b], abs=1e-12)
    # Rotating the output section axes changes components, not global action.
    for member in model["elements"]:
        member["rotation_angle"] = 90
    rotated = map_frame_stations(model, geometry, data["memberStations"])
    for member_id, rows in reverse.items():
        assert rotated[member_id][0]["components"]["N"] == pytest.approx(rows[0]["components"]["N"])
        assert abs(rotated[member_id][0]["components"]["Vy"]) == pytest.approx(abs(rows[0]["components"]["Vz"]), abs=1e-12)


@pytest.mark.parametrize("change", ["missing-member", "missing-cut", "duplicate-cut", "nonfinite", "native-angle", "no-evidence"])
def test_incomplete_native_station_evidence_is_rejected(native, change):
    data, geometry = native
    rows = copy.deepcopy(data["memberStations"])
    member_id = next(iter(rows))
    if change == "missing-member":
        rows.pop(member_id)
    elif change == "missing-cut":
        rows[member_id].pop()
    elif change == "duplicate-cut":
        rows[member_id][0]["nativeStation"] = 1
    elif change == "nonfinite":
        rows[member_id][0]["nativeComponents"][0] = float("nan")
    elif change == "native-angle":
        geometry["native_members"][member_id]["angleDegrees"] = 1
    elif change == "no-evidence":
        geometry["native_members"][member_id]["geometrySource"] = {}
    with pytest.raises(NativeStationUnavailable):
        map_frame_stations(data["model"], geometry, rows)
