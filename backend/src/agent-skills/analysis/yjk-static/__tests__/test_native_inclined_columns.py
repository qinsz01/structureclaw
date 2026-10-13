from copy import deepcopy
import json
import math
from pathlib import Path
import sys

import pytest

sys.path[:0] = [str(Path(__file__).resolve().parents[1]),
               str(Path(__file__).resolve().parents[2] / "runtime")]
from model_contract import validate_building_model
from native_materials import audit_inclined_column_identity, compile_orientation
from native_fe import parse_fe
from native_stations import member_geometry, map_stations, StationConventionUnavailable


def model():
    nodes, elements = [], []
    for index, (x, y) in enumerate(((0, 0), (4, 0), (4, 4), (0, 4))):
        nodes.extend([{"id": f"b{index}", "x": x, "y": y, "z": 0, "restraints": [True]*6},
                      {"id": f"t{index}", "x": x + (.3 if index == 0 else 0), "y": y, "z": 3,
                       "restraints": [False]*6}])
        elements.append({"id": f"c{index}", "type": "column", "nodes": [f"b{index}", f"t{index}"],
                         "material": "m", "section": "s"})
    return {"nodes": nodes, "elements": elements, "materials": [{"id": "m", "category": "steel", "E": 206000}],
            "sections": [{"id": "s"}], "stories": [{"id": "floor", "elevation": 0, "height": 3}],
            "load_cases": [], "analysis_control": {"self_weight": False, "rigid_floor": False,
                "rigid_offsets": False, "p_delta": False, "construction_stage": False}}


def test_ordinary_inclined_column_preserves_physical_role_and_endpoints():
    data = model()
    original = deepcopy(data)
    validate_building_model(data)
    assert data == original
    assert data["elements"][0]["type"] == "column"
    assert data["nodes"][1]["x"] == .3


def test_column_classification_scope_does_not_silently_relabel_a_steep_brace():
    data = model()
    data["nodes"][1]["x"] = 2
    with pytest.raises(ValueError, match="inclination"):
        validate_building_model(data)


def test_inclined_identity_requires_native_column_kind_nontruss_and_rigid_dofs():
    frame = {"kind": "BRACE", "R": [0.]*6, "E": [0.]*6}
    member = {"native_geometry": {"brace_kind": 2, "brace_column_kind": 4, "is_truss": 0}}
    assert audit_inclined_column_identity(frame, member)["passed"]
    for field, bad in (("brace_kind", 3), ("brace_kind", None), ("is_truss", 1), ("is_truss", None)):
        modified = deepcopy(member)
        modified["native_geometry"][field] = bad
        assert not audit_inclined_column_identity(frame, modified)["passed"]
    frame["R"][4] = 1
    assert not audit_inclined_column_identity(frame, member)["passed"]
    assert not audit_inclined_column_identity(frame, None)["passed"]


def test_inclined_section_uses_shared_reference_vector_without_changing_connectivity():
    data = model()
    data["metadata"] = {"elementReferenceVectors": {"c0": [0, 0, 1]}}
    nodes = {row["id"]: row for row in data["nodes"]}
    result = compile_orientation(data, data["elements"][0], nodes)
    assert result["nativeRotationDegrees"] == pytest.approx(0.)
    assert result["canonicalAxes"][0] == pytest.approx([.3/(9.09**.5), 0, 3/(9.09**.5)])


def test_frozen_native_inclined_column_matches_independent_six_load_end_actions(tmp_path):
    fixture = json.loads((Path(__file__).parent / "fixtures/native-inclined-column-six-components.json").read_text(encoding="utf-8"))
    path = tmp_path / "fea.dat"
    path.write_text(fixture["fea"], encoding="gb18030", newline="")
    fe, data, mapping = parse_fe(path), fixture["model"], fixture["mapping"]
    member_id = fixture["memberId"]
    physical = next(row for row in data["elements"] if row["id"] == member_id)
    nodes = {tag: next(node["id"] for node in data["nodes"]
                      if math.dist(point, [node[key] for key in ("x", "y", "z")]) < 1e-7)
             for tag, point in fe["nodes"].items() if any(
                 math.dist(point, [node[key] for key in ("x", "y", "z")]) < 1e-7 for node in data["nodes"])}
    args = (fe, fixture["nativeMember"], {**mapping["elements"][member_id], **physical}, nodes, mapping["nodes"])
    geometry = member_geometry(*args, metadata=data.get("metadata"))
    for case in fixture["cases"].values():
        stations = map_stations(case["nativeRows"], geometry)
        expected = case["referenceLocalEndActions"]
        for row, offset, signs in ((stations[0], 0, [-1, 1, 1, -1, -1, -1]),
                                   (stations[-1], 6, [1, -1, -1, 1, 1, 1])):
            for i, key in enumerate(("N", "Vy", "Vz", "T", "My", "Mz")):
                assert row["components"][key] == pytest.approx(signs[i] * expected[offset+i],
                    rel=fixture["provenance"]["relativeTolerance"], abs=fixture["provenance"]["absoluteTolerance"])
    # The omitted RZL variant is allowed only with explicit native classification.
    fixture["nativeMember"]["native_geometry"]["brace_kind"] = 3
    with pytest.raises(StationConventionUnavailable, match="offsets/releases"):
        member_geometry(*args, metadata=data.get("metadata"))
