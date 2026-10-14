from __future__ import annotations

from copy import deepcopy
import json
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from native_fe import parse_fe
from yjk_native_stations import canonical_axes, member_geometry, map_stations, StationConventionUnavailable


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
    assert result[0]["components"] == {"N": -6, "Vy": -4, "Vz": 5, "T": 7, "My": 2, "Mz": -3}
    assert result[-1]["components"]["My"] == -6
    assert result[0]["nativeComponents"] == rows[0]


def test_reversed_member_maps_position_and_cut_direction_together(tmp_path):
    rows = [[-2 + i, 3, 4, 5, -6, 7] for i in range(9)]
    forward = map_stations(rows, geometry(model(tmp_path)))
    reverse = map_stations(rows, geometry(model(tmp_path), True))
    assert reverse[0]["nativeStationIndex"] == 8
    assert reverse[0]["positionM"] == 0
    assert reverse[0]["components"] == {"N": -6, "Vy": -4, "Vz": -5, "T": 7, "My": -6, "Mz": 3}
    assert forward[-1]["components"]["N"] == reverse[0]["components"]["N"]


@pytest.mark.parametrize("field,values", [("E", [0, 0, 0.1, 0, 0, 0]), ("RZL", [0.2, 0]), ("R", [0, 0, 0, 1, 0, 0])])
def test_offsets_and_releases_are_not_silently_mapped(tmp_path, field, values):
    fe = model(tmp_path)
    fe["frames"]["9"][field] = values
    with pytest.raises(StationConventionUnavailable, match="offsets/releases"):
        geometry(fe)


def test_verified_pair_of_bending_releases_keeps_station_axes_and_torsion(tmp_path):
    fe = model(tmp_path)
    fe['frames']['9']['R'] = [100.,0.,100.,0.,0.,0.]
    member = {'type':'beam','nodes':['b','a'],'releases':{'j':{'ry':True,'rz':True}}}
    g = member_geometry(fe, {'id':9,'node_i':1,'node_j':2}, member, {'1':'a','2':'b'},
        {'a':{'x_m':0,'y_m':0,'z_m':3},'b':{'x_m':4,'y_m':0,'z_m':3}})
    assert g['source']['nativeEndReleases']['hinges'] == [1,0]
    rows = map_stations([[0,0,4,5,6,7]]*9,g)
    assert rows[-1]['components']['My']==0 and rows[-1]['components']['Mz']==0
    assert rows[-1]['components']['T']==7
    member['releases']={'i':{'ry':True,'rz':True}}
    with pytest.raises(StationConventionUnavailable,match='offsets/releases'):
        member_geometry(fe, {'id':9,'node_i':1,'node_j':2}, member, {'1':'a','2':'b'},
            {'a':{'x_m':0,'y_m':0,'z_m':3},'b':{'x_m':4,'y_m':0,'z_m':3}})


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


def test_explicit_reference_is_shared_with_opensees_and_retained_in_station_mapping(tmp_path):
    fe = model(tmp_path)
    g = member_geometry(fe, {"id": 9, "node_i": 1, "node_j": 2},
        {"v2_id": "beam", "nodes": ["a", "b"]}, {"1": "a", "2": "b"},
        {"a": {"x_m": 0, "y_m": 0, "z_m": 3}, "b": {"x_m": 4, "y_m": 0, "z_m": 3}},
        metadata={"elementReferenceVectors": {"beam": [0, 1, 0]}})
    assert g["axes"] == [[1, 0, 0], [0, 0, -1], [0, 1, 0]]
    station = map_stations([[2, 3, 4, 5, 6, 7]] * 9, g)[0]
    assert station["components"]["Vy"] == -5
    assert station["components"]["Vz"] == -4


def test_executed_column_rotation_controls_force_axes(tmp_path):
    fe = model(tmp_path)
    fe["nodes"] = {"1": [0, 0, 3], "2": [0, 0, 0]}
    fe["frames"]["9"].update(kind="COLUMN", DIR=[-1, 0, 0])
    g = member_geometry(fe, {"id": 9, "node_i": 1, "node_j": 2},
        {"nodes": ["b", "a"]}, {"1": "a", "2": "b"},
        {"a": {"x_m": 0, "y_m": 0, "z_m": 3}, "b": {"x_m": 0, "y_m": 0, "z_m": 0}})
    assert g["nativeAxes"] == [[0, 0, -1], [0, 1, 0], [-1, 0, 0]]
    assert g["axes"] == [[0, 0, 1], [0, -1, 0], [1, 0, 0]]
    assert g["stationCount"] == 2


def test_native_nonfinite_station_component_is_rejected(tmp_path):
    rows = [[0] * 6 for _ in range(9)]
    rows[2][3] = float("nan")
    with pytest.raises(ValueError, match="six finite"):
        map_stations(rows, geometry(model(tmp_path)))


def test_frozen_native_six_component_cases_satisfy_independent_nodal_equilibrium(tmp_path):
    """Reference is equilibrium of authored unit loads, not production output.

    Includes X/Y shear, axial force, both moments, torsion, reverse endpoints,
    beam eight-division stations and four native direct base reactions.
    """
    fixture = json.loads((Path(__file__).parent / "fixtures/native-frame-six-components.json").read_text())
    path = tmp_path / "fea.dat"
    path.write_text(fixture["fea"], encoding="gb18030", newline="")
    fe = parse_fe(path)
    model = fixture["model"]
    mapping = fixture["mapping"]
    node_lookup = {str(native["id"]): next(node["id"] for node in model["nodes"]
                   if [node[k] for k in ("x", "y", "z")] == [native[k] for k in ("x", "y", "z")])
                   for native in fixture["nodes"]}
    definitions = {str(row["id"]): row for members in fixture["members"].values() for row in members}
    tolerance = fixture["provenance"]["reference"]["relativeTolerance"]
    for index, (case_key, case) in enumerate(fixture["cases"].items()):
        sums = {node["id"]: [0.] * 6 for node in model["nodes"]}
        for members in case["forces"].values():
            for force in members:
                definition = definitions[str(force["id"])]
                endpoints = {node_lookup[str(definition[k])] for k in ("node_i", "node_j")}
                element_id, element = next((key, row) for key, row in mapping["elements"].items() if set(row["nodes"]) == endpoints)
                geo = member_geometry(fe, definition, element, node_lookup, mapping["nodes"])
                stations = map_stations(force["sections"], geo)
                assert [r["positionM"] for r in stations] == sorted(r["positionM"] for r in stations)
                if case_key == "lc_8" and element["type"] == "beam":
                    # Independent equilibrium under the authored -1 kN/m UDL
                    # verifies every eighth-span coordinate, not just endpoints.
                    first = stations[0]["components"]
                    for station in stations:
                        position, values = station["positionM"], station["components"]
                        assert values["Vz"] == pytest.approx(first["Vz"] - position, abs=tolerance)
                        assert values["My"] == pytest.approx(first["My"] - first["Vz"] * position + position ** 2 / 2,
                                                            abs=tolerance)
                for node_id, row, side in ((element["nodes"][0], stations[0], 1), (element["nodes"][1], stations[-1], -1)):
                    c = row["components"]
                    local = [-c["N"], c["Vy"], c["Vz"], -c["T"], -c["My"], -c["Mz"]]
                    for k in range(6):
                        sums[node_id][k] += side * sum(local[(k // 3) * 3 + axis] * geo["axes"][axis][k % 3] for axis in range(3))
        expected = {node_lookup[str(row["id"])]: [row[k] for k in ("fx", "fy", "fz", "mx", "my", "mz")]
                    for row in case["reactions"]}
        authored = model["load_cases"][index]
        for load in authored["loads"]:
            if load["type"] == "nodal":
                for k, key in enumerate(("fx", "fy", "fz", "mx", "my", "mz")):
                    expected[load["node"]][k] += load.get(key, 0.)
        for node, values in sums.items():
            assert values == pytest.approx(expected[node], abs=tolerance), (case_key, node)
    axial = fixture["cases"]["lc_7"]
    reference = fixture["provenance"]["reference"]["AX"]
    for row in axial["displacements"]:
        if int(row["id"]) >= 1000000:
            assert row["uz"] == pytest.approx(reference["eachUzM"], abs=reference["toleranceM"])
    assert sum(row["fz"] for row in axial["reactions"]) == pytest.approx(reference["sumFzKn"], abs=tolerance)


def test_point_load_cut_has_no_invented_continuous_side(tmp_path):
    geo = geometry(model(tmp_path))
    geo["discontinuities"] = [2.0]
    rows = map_stations([[0] * 6] * 9, geo)
    assert 2 not in [row["positionM"] for row in rows]
    assert rows[0]["side"] == "right"
    assert rows[-1]["side"] == "left"


@pytest.mark.parametrize("selection", [None, {"id": "UDL", "labels": ["UDL", "SC002_UDL"]}])
@pytest.mark.parametrize("explicit_snapshot", [False, True])
def test_native_normalizer_binds_source_cases_and_exact_stations(tmp_path, monkeypatch, selection, explicit_snapshot):
    import yjk_driver
    fixture = json.loads((Path(__file__).parent / "fixtures/native-frame-six-components.json").read_text())
    (tmp_path / "fea.dat").write_text(fixture["fea"], encoding="gb18030", newline="")
    (tmp_path / ("model.json" if explicit_snapshot else "input.json")).write_text(json.dumps(fixture["model"]), encoding="utf-8")
    if selection:
        monkeypatch.setenv("SC_YJK_SELECTED_CASE", json.dumps(selection))
    else:
        monkeypatch.delenv("SC_YJK_SELECTED_CASE", raising=False)
    cases = fixture["cases"]
    extracted = {"meta": {"coordinateUnit": "m"}, "nodes": fixture["nodes"], "members": fixture["members"],
                 "load_cases": [{"id": int(key[3:]), "key": key, "expName": f"{bound['nativeName']} -- custom native case"}
                                for key, bound in zip(cases, fixture["mapping"]["load_cases"])],
                 "member_forces": {category: {key: value["forces"][category] for key, value in cases.items()}
                                   for category in ("beams", "columns", "braces")},
                 "node_disp": {key: value["displacements"] for key, value in cases.items()},
                 "node_reactions": {key: value["reactions"] for key, value in cases.items()}}
    result = yjk_driver._build_analysis_result(extracted=extracted, mapping=fixture["mapping"],
        ydb_path="loadprobe.ydb", yjk_project="loadprobe", work_dir=str(tmp_path), results_path="results.json", steps=[],
        source_model=fixture["model"] if explicit_snapshot else None)
    expected = {"UDL"} if selection else {case["id"] for case in fixture["model"]["load_cases"]}
    assert set(result["caseResults"]) == expected
    case = result["caseResults"]["UDL"]
    assert case["nativeCode"] == "SC002_UDL"
    assert case["nativeResultKey"] == "lc_8"
    assert case["nativeContext"]["stationConventionsVerified"] is True
    assert case["forceSemantics"] == "simultaneous-signed-stations"
    assert case["memberStations"]["B0"][4]["positionM"] == 2
    assert sum(row["fz"] for row in case["reactions"].values()) == pytest.approx(16, abs=1e-5)
