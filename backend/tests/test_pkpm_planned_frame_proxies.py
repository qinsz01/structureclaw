"""Check proxy topology, independent boundary state and global equilibrium."""
import copy
import math
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pkpm_planned_frame_proxies import model
from native_frame_reference import solve


@pytest.mark.parametrize("case,state,nodes,columns,beams,total_down", [
    ("INT-089", 1, 27, 18, 24, 1056.),
    ("INT-089", 2, 27, 18, 24, 1056.),
    ("MM-089", 1, 36, 24, 34, 1216.),
])
def test_proxy_static_stability_and_six_component_equilibrium(case, state, nodes, columns, beams, total_down):
    source = model(case, state)
    assert len(source["nodes"]) == nodes
    assert sum(row["type"] == "column" for row in source["elements"]) == columns
    assert sum(row["type"] == "beam" for row in source["elements"]) == beams
    positions = {row["id"]: np.array([row[k] for k in ("x", "y", "z")]) for row in source["nodes"]}
    members = {row["id"]: row for row in source["elements"]}
    forces, moments = np.zeros(3), np.zeros(3)
    for load in source["load_cases"][0]["loads"]:
        if load["type"] == "distributed":
            a, b = (positions[key] for key in members[load["element"]]["nodes"])
            force, point = np.array([0., 0., load["wz"] * np.linalg.norm(b-a)]), (a+b)/2
        else:
            force, point = np.array([load.get(k, 0.) for k in ("fx", "fy", "fz")]), positions[load["node"]]
        forces += force
        moments += np.cross(point, force)
    assert forces[2] == -total_down
    assert forces[:2] == pytest.approx([20., 10.] if case == "MM-089" else [0., 0.])
    reference = solve(source, "D")
    for key, reaction in reference["reactions"].items():
        force = np.array([reaction[k] for k in ("fx", "fy", "fz")])
        forces += force
        moments += np.array([reaction[k] for k in ("mx", "my", "mz")]) + np.cross(positions[key], force)
    assert forces == pytest.approx([0., 0., 0.], abs=1e-8)
    assert moments == pytest.approx([0., 0., 0.], abs=1e-7)
    pins = [row for row in source["nodes"] if row["restraints"] == [True]*3+[False]*3]
    expected = {(0., 0.), (12., 10.)} if case == "INT-089" else {(4., 5.), (8., 5.)}
    assert {(row["x"], row["y"]) for row in pins} == expected
    for row in pins:
        assert [reference["reactions"][row["id"]][key] for key in ("mx", "my", "mz")] == pytest.approx([0.]*3, abs=1e-8)
    assert all(math.isfinite(value) for values in reference["displacements"].values() for value in values.values())


def test_clarified_update_preserves_corners_center_loads_supports_and_properties():
    first, second = model("INT-089", 1), model("INT-089", 2)
    before = copy.deepcopy(first)
    changed = []
    for original, updated in zip(first["elements"], second["elements"]):
        if original != updated:
            assert original["type"] == "column" and original["section"] == "C2" and updated["section"] == "C4"
            assert {**original, "section": "C4"} == updated
            changed.append(original["id"])
    assert len(changed) == 8  # Four non-corner edge columns on each natural floor.
    for key in ("nodes", "load_cases", "sections", "materials", "stories", "analysis_control"):
        assert first[key] == second[key]
    second["nodes"][0]["x"] = -1
    assert first == before


def test_six_mm_groups_and_section_units_are_explicit():
    source = model("MM-089")
    assert {row["section"] for row in source["elements"]} == {"C1", "C2", "C3", "B1", "B2", "B3"}
    for row in source["elements"]:
        if row["id"].startswith("y"):
            assert row["section"] == "B1"
        elif row["id"].startswith("x"):
            assert row["section"] == ("B3" if row["id"].split("-")[1] == "1" else "B2")
    sections = {row["id"]: row for row in source["sections"]}
    assert sections["C1"]["properties"] == pytest.approx({"A": .25, "Iy": .005208333333333333,
                                                         "Iz": .005208333333333333, "J": .008802083333333334})
    assert sections["C3"]["properties"]["J"] / sections["C1"]["properties"]["J"] == pytest.approx(1.4**4)
    assert source["metadata"]["capabilityProxy"]["notBenchmarkScoringTruth"] is True


@pytest.mark.parametrize("case,state", [("unknown", 1), ("MM-089", 2), ("INT-089", 3), ("INT-089", True)])
def test_only_frozen_proxy_states_are_available(case, state):
    with pytest.raises(ValueError):
        model(case, state)
