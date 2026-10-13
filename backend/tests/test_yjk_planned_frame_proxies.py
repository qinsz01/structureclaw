"""Independent stability/equilibrium and exact topology checks for YJK probes."""
import math
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from yjk_planned_frame_proxies import model
from native_frame_reference import solve


@pytest.mark.parametrize("case,count,total", [("INT-081", (26, 18, 23), 1810.),
                                             ("MM-084", (18, 11, 14), 1320.),
                                             ("MM-087", (25, 16, 20), 968.)])
def test_six_component_balance_and_topology(case, count, total):
    source = model(case)
    assert (len(source["nodes"]), sum(e["type"] == "column" for e in source["elements"]),
            sum(e["type"] == "beam" for e in source["elements"])) == count
    positions = {n["id"]: np.array([n[k] for k in ("x", "y", "z")]) for n in source["nodes"]}
    elements = {e["id"]: e for e in source["elements"]}
    force, moment = np.zeros(3), np.zeros(3)
    for load in source["load_cases"][0]["loads"]:
        if load["type"] == "nodal":
            f, point = np.array([0., 0., load["fz"]]), positions[load["node"]]
        else:
            a, b = [positions[key] for key in elements[load["element"]]["nodes"]]
            f, point = np.array([0., 0., load["wz"]*np.linalg.norm(b-a)]), (a+b)/2
        force += f
        moment += np.cross(point, f)
    assert force[2] == pytest.approx(-total)
    reference = solve(source, "D")
    for key, reaction in reference["reactions"].items():
        f = np.array([reaction[k] for k in ("fx", "fy", "fz")])
        force += f
        moment += np.cross(positions[key], f) + np.array([reaction[k] for k in ("mx", "my", "mz")])
    assert force == pytest.approx(np.zeros(3), abs=1e-8)
    assert moment == pytest.approx(np.zeros(3), abs=1e-7)
    assert all(math.isfinite(value) for row in reference["displacements"].values() for value in row.values())


def test_transfer_midpoint_is_connected_without_a_column_or_release():
    source = model("MM-084")
    at = [e for e in source["elements"] if "n1-0-2" in e["nodes"]]
    assert len(at) == 3 and all(e["type"] == "beam" and not e.get("releases") for e in at)
    assert sorted(e["section"] for e in at) == ["B1", "BT", "BT"]
    assert {tuple(e["nodes"]) for e in at if e["section"] == "BT"} == {
        ("n0-0-2", "n1-0-2"), ("n1-0-2", "n2-0-2")}


def test_roof_extensions_are_flexible_unloaded_except_for_tip_forces():
    source = model("INT-081")
    for j in (0, 2):
        tip = next(n for n in source["nodes"] if n["id"] == f"roof-tip-{j}")
        assert tip["x"] == 7.2 and tip["restraints"] == [False]*6
        attached = [e for e in source["elements"] if tip["id"] in e["nodes"]]
        assert len(attached) == 1 and attached[0]["type"] == "beam"
        assert not attached[0].get("offsets") and not attached[0].get("releases")
        assert not any(load.get("element") == attached[0]["id"] for load in source["load_cases"][0]["loads"])


def test_upper_wings_share_only_the_center_corner():
    source = model("MM-087")
    top = {n["id"] for n in source["nodes"] if n["z"] == 7.2}
    assert "n0-2-2" not in top and "n2-0-2" not in top
    center = [e for e in source["elements"] if "n1-1-2" in e["nodes"]]
    assert len(center) == 5 and sum(e["type"] == "column" for e in center) == 1
    assert source["analysis_control"]["rigid_floor"] is False
