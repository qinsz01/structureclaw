from copy import deepcopy
from pathlib import Path
import json
import math
import sys

import pytest

sys.path[:0] = [str(Path(__file__).resolve().parents[1]),
               str(Path(__file__).resolve().parents[2] / "runtime")]
from native_story_geometry import compile_story_geometry, exact_mm
from native_materials import compile_orientation
from model_contract import validate_building_model
from native_fe import parse_fe
from native_stations import member_geometry, map_stations


def roof(high=8):
    nodes, members = [], []
    for i, (x, y) in enumerate(((0, 0), (6, 0), (0, 5), (6, 5))):
        nodes.extend([dict(id=f"b{i}", x=x, y=y, z=0, restraints=[True]*6),
                      dict(id=f"t{i}", x=x, y=y, z=6 if y == 0 else high, restraints=[False]*6)])
        members.append(dict(id=f"c{i}", type="column", nodes=[f"b{i}", f"t{i}"], material="m", section="c"))
    for i, (a, b) in enumerate(((0, 1), (2, 3), (0, 2), (1, 3))):
        members.append(dict(id=f"r{i}", type="beam", nodes=[f"t{a}", f"t{b}"], material="m", section="r"))
    return dict(nodes=nodes, elements=members, materials=[dict(id="m", category="steel", E=206000)],
                sections=[dict(id="c"), dict(id="r")], stories=[dict(id="roof", elevation=0, height=8)],
                load_cases=[], analysis_control=dict(self_weight=False, rigid_floor=False, rigid_offsets=False,
                    p_delta=False, construction_stage=False))


@pytest.mark.parametrize("high,offset", [(8, 0), (9, 1000)])
def test_distinct_roof_elevations_keep_one_natural_storey_and_exact_offsets(high, offset):
    model = roof(high)
    original = deepcopy(model)
    validate_building_model(model)
    layout = compile_story_geometry(model)
    assert model == original
    assert len(layout["stories"]) == 1
    assert layout["nodes"]["t0"]["height_offset_mm"] == -2000
    assert layout["nodes"]["t2"]["height_offset_mm"] == offset
    assert layout["members"]["r2"] == dict(floor_index=1, floor="roof", start_height_mm=6000, end_height_mm=high*1000)
    orientation = compile_orientation(model, model["elements"][-2], {n["id"]: n for n in model["nodes"]})
    assert orientation["nativeRotationDegrees"] == pytest.approx(0)
    assert orientation["canonicalAxes"][0][2] > 0


def test_multistorey_roof_outside_nominal_level_requires_explicit_story():
    model = roof(9)
    model["stories"] = [dict(id="lower", elevation=0, height=4), dict(id="roof", elevation=4, height=4)]
    with pytest.raises(ValueError, match="explicit natural story"):
        compile_story_geometry(model)


def test_two_physical_heights_at_the_same_native_plan_node_are_rejected():
    model = roof()
    model["nodes"].append(dict(id="independent", x=0, y=0, z=7))
    with pytest.raises(ValueError, match="multiple independent heights"):
        compile_story_geometry(model)


def test_cross_story_beam_and_nonadjacent_column_are_rejected():
    model = roof()
    model["nodes"][1]["story"] = "not-the-roof"
    with pytest.raises(ValueError, match="invalid natural story"):
        compile_story_geometry(model)
    model = roof()
    model["elements"][-1]["nodes"][0] = "b0"
    with pytest.raises(ValueError, match="same natural floor"):
        compile_story_geometry(model)


@pytest.mark.parametrize("value", [True, float("nan"), float("inf"), .0005])
def test_coordinate_conversion_never_rounds_a_physical_height(value):
    with pytest.raises(ValueError):
        exact_mm(value, "roof height")


def test_frozen_sloping_roof_native_end_actions_match_independent_reference(tmp_path):
    fixture = json.loads((Path(__file__).parent / "fixtures/native-sloping-roof-six-components.json").read_text(encoding="utf-8"))
    path = tmp_path / "fea.dat"
    path.write_text(fixture["fea"], encoding="gb18030")
    fe, model, mapping = parse_fe(path), fixture["model"], fixture["mapping"]
    lookup = {key: next((n["id"] for n in model["nodes"]
                        if math.dist(point, [n[a] for a in ("x", "y", "z")]) < 1e-7), None)
              for key, point in fe["nodes"].items()}
    for identifier, member in fixture["members"].items():
        element = next(row for row in model["elements"] if row["id"] == identifier)
        geometry = member_geometry(fe, member, {**mapping["elements"][identifier], **element},
            lookup, mapping["nodes"], metadata=model["metadata"])
        assert geometry["length"] == pytest.approx(math.sqrt(29))
        assert geometry["stationCount"] == 9
        for case in fixture["cases"].values():
            data = case[identifier]
            stations = map_stations(data["nativeRows"], geometry)
            assert stations[4]["positionM"] == pytest.approx(math.sqrt(29)/2)
            for station, offset, signs in ((stations[0], 0, [-1, 1, 1, -1, -1, -1]),
                                           (stations[-1], 6, [1, -1, -1, 1, 1, 1])):
                for index, key in enumerate(("N", "Vy", "Vz", "T", "My", "Mz")):
                    expected = signs[index] * data["referenceLocalEndActions"][offset+index]
                    assert station["components"][key] == pytest.approx(expected, rel=1e-5, abs=1e-5)
