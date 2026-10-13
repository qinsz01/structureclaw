from __future__ import annotations

from copy import deepcopy
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from native_fe import parse_fe
from native_stations import canonical_axes, member_geometry, map_stations, StationConventionUnavailable


def model(tmp_path):
    path = tmp_path / "fea.dat"
    path.write_text("""*UNIT
UNIT=0,0,0
*STRUCTURE
GRAV=10
*NODE
1 C=0,0,3
2 C=4,0,3
*SECTION
7 P=0.15,0.003125,0.001125,0.00281737
*MATERIAL
5 P=30000000,0.25,0,0,0.00001
*FRAME
9 T=BEAM N=1,2 M=5 SEC=7 DIR=0,0,1 E=0,0,0,0,0,0 RZL=0,0 &
 RF=1,1,1,1,1,1 R=0,0,0,0,0,0
""", encoding="ascii")
    return parse_fe(path)


def geometry(fe, reverse=False):
    return member_geometry(fe, {"id": 9, "node_i": 1, "node_j": 2},
        {"nodes": ["b", "a"] if reverse else ["a", "b"]}, {"1": "a", "2": "b"},
        {"a": {"x_m": 0, "y_m": 0, "z_m": 3}, "b": {"x_m": 4, "y_m": 0, "z_m": 3}})


def test_fe_readback_preserves_multiline_effective_properties(tmp_path):
    fe = model(tmp_path)
    assert fe["frames"]["9"]["RF"] == [1] * 6
    assert fe["frames"]["9"]["materialId"] == "5"
    assert fe["materials"]["5"]["P"][:2] == [30000000, 0.25]
    assert fe["sections"]["7"]["P"][0] == 0.15
    assert len(fe["sha256"]) == 64


def test_documented_beam_stations_keep_signed_simultaneous_vectors(tmp_path):
    g = geometry(model(tmp_path))
    rows = [[-2 + i, 3, 4, 5, -6, 7] for i in range(9)]
    result = map_stations(rows, g)
    assert [r["positionM"] for r in result] == [i / 2 for i in range(9)]
    assert result[0]["components"] == {"N": -6, "Vy": 4, "Vz": 5, "T": 7, "My": 2, "Mz": -3}
    assert result[-1]["components"]["My"] == -6
    assert result[0]["nativeComponents"] == rows[0]


def test_reversed_member_maps_position_and_cut_direction_together(tmp_path):
    rows = [[-2 + i, 3, 4, 5, -6, 7] for i in range(9)]
    forward = map_stations(rows, geometry(model(tmp_path)))
    reverse = map_stations(rows, geometry(model(tmp_path), True))
    assert reverse[0]["nativeStationIndex"] == 8
    assert reverse[0]["positionM"] == 0
    assert reverse[0]["components"] == {"N": -6, "Vy": 4, "Vz": -5, "T": 7, "My": -6, "Mz": 3}
    assert forward[-1]["components"]["N"] == reverse[0]["components"]["N"]


@pytest.mark.parametrize("field,values", [("E", [0, 0, 0.1, 0, 0, 0]), ("RZL", [0.2, 0]), ("R", [0, 0, 0, 1, 0, 0])])
def test_offsets_and_releases_are_not_silently_mapped(tmp_path, field, values):
    fe = model(tmp_path)
    fe["frames"]["9"][field] = values
    with pytest.raises(StationConventionUnavailable, match="offsets/releases"):
        geometry(fe)


def test_undocumented_station_count_is_rejected(tmp_path):
    with pytest.raises(StationConventionUnavailable, match="station count"):
        map_stations([[0] * 6] * 7, geometry(model(tmp_path)))


def test_fe_endpoint_conflict_is_rejected(tmp_path):
    fe = model(tmp_path)
    fe["frames"]["9"]["nodes"] = ["2", "1"]
    with pytest.raises(StationConventionUnavailable, match="endpoints differ"):
        geometry(fe)


def test_collinear_axes_match_canonical_z_up_convention():
    assert canonical_axes([0, 0, 0], [0, 0, 3]) == [[0, 0, 1], [0, -1, 0], [1, 0, 0]]


def test_native_nonfinite_station_component_is_rejected(tmp_path):
    rows = [[0] * 6 for _ in range(9)]
    rows[2][3] = float("nan")
    with pytest.raises(ValueError, match="six finite"):
        map_stations(rows, geometry(model(tmp_path)))
