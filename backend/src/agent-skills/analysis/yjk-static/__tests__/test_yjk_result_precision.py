from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest


@pytest.fixture
def driver(monkeypatch):
    monkeypatch.delenv("SC_YJK_SELECTED_CASE", raising=False)
    path = Path(__file__).resolve().parents[1] / "yjk_driver.py"
    spec = importlib.util.spec_from_file_location("yjk_precision_under_test", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def mapping():
    return {
        "nodes": {
            "N1": {"yjk_std_floor_node_id": 1, "x_mm": 0, "y_mm": 0, "z_mm": 0},
            "N2": {"yjk_std_floor_node_id": 2, "x_mm": 3000, "y_mm": 0, "z_mm": 0},
        },
        "elements": {
            "B1": {"type": "beam", "floor_index": 1, "nodes": ["N1", "N2"]},
        },
    }


def test_reused_standard_floor_id_cannot_override_global_geometry(driver):
    extracted = {"meta": {"coordinateUnit": "m"}, "nodes": [
        {"id": 1, "x": 3, "y": 0, "z": 0},
        {"id": 2, "x": 0, "y": 0, "z": 0},
    ]}
    assert driver._build_result_node_lookup(extracted, mapping()) == {"1": "N2", "2": "N1"}


@pytest.mark.parametrize("unit,x", [("m", 3), ("mm", 3000)])
def test_declared_coordinate_unit_is_applied_once(driver, unit, x):
    extracted = {"meta": {"coordinateUnit": unit}, "nodes": [{"id": 7, "x": x, "y": 0, "z": 0}]}
    assert driver._build_result_node_lookup(extracted, mapping()) == {"7": "N2"}


def test_wrong_declared_unit_is_not_silently_guessed(driver):
    extracted = {"meta": {"coordinateUnit": "m"}, "nodes": [{"id": 2, "x": 3000, "y": 0, "z": 0}]}
    diagnostics = {}
    assert driver._build_result_node_lookup(extracted, mapping(), diagnostics) == {"2": "2"}
    assert diagnostics["node_unmapped"] == 1


def test_unknown_coordinate_unit_rejected(driver):
    with pytest.raises(RuntimeError, match="coordinate unit"):
        driver._build_result_node_lookup({"meta": {"coordinateUnit": "ft"}}, mapping())


def test_missing_coordinate_not_replaced_with_zero(driver):
    with pytest.raises(RuntimeError, match="coordinate z is not numeric"):
        driver._build_result_node_lookup({"nodes": [{"id": 1, "x": 0, "y": 0}]}, mapping())


def test_coincident_model_nodes_are_ambiguous(driver):
    model_mapping = mapping()
    model_mapping["nodes"]["N3"] = {"x_mm": 0, "y_mm": 0, "z_mm": 0}
    with pytest.raises(RuntimeError, match="ambiguous"):
        driver._build_result_node_lookup({"nodes": []}, model_mapping)


def test_conflicting_converter_coordinate_units_rejected(driver):
    model_mapping = mapping()
    model_mapping["nodes"]["N2"].update({"x_m": 4, "y_m": 0, "z_m": 0})
    with pytest.raises(RuntimeError, match="conflicting coordinates"):
        driver._build_result_node_lookup({"nodes": []}, model_mapping)


def test_submillimetre_coordinate_is_not_rounded_to_another_node(driver):
    model_mapping = mapping()
    model_mapping["nodes"]["N2"]["x_mm"] = 0.25
    extracted = {"meta": {"coordinateUnit": "mm"}, "nodes": [{"id": 2, "x": 0.25, "y": 0, "z": 0}]}
    assert driver._build_result_node_lookup(extracted, model_mapping) == {"2": "N2"}


def test_machine_values_and_envelopes_keep_native_precision(driver):
    uz = -2.777777777777778e-7
    rotation = 2.123456789e-10
    axial = -1.234567891234
    reaction = 0.000123456789
    extracted = {
        "meta": {"coordinateUnit": "m"},
        "load_cases": [{"id": 1, "key": "lc_1", "name": "DL"}],
        "nodes": [{"id": 1, "x": 0, "y": 0, "z": 0}, {"id": 2, "x": 3, "y": 0, "z": 0}],
        "node_disp": {"lc_1": [
            {"id": node, "ux": 0, "uy": 0, "uz": uz, "rx": rotation, "ry": 0, "rz": 0}
            for node in (1, 2)
        ]},
        "node_reactions": {"lc_1": [
            {"id": node, "fx": reaction, "fy": 0, "fz": 0, "mx": 0, "my": 0, "mz": rotation}
            for node in (1, 2)
        ]},
        "members": {"beams": [{"id": 5, "floor": 1, "node_i": 1, "node_j": 2}]},
        "member_forces": {"beams": {"lc_1": [{"id": 5, "floor": 1, "sections": [[0, 0, 0, 0, axial, 0]]}]}},
    }
    result = driver._build_analysis_result(
        extracted=extracted, mapping=mapping(), ydb_path="model.ydb", yjk_project="model.yjk",
        work_dir="work", results_path="results.json", steps=[],
    )
    for selected in (result, result["caseResults"]["lc_1"]):
        assert selected["displacements"]["N2"]["uz"] == uz
        assert selected["displacements"]["N2"]["rx"] == rotation
        assert selected["forces"]["B1"]["N"] == axial
        assert selected["reactions"]["N1"]["fx"] == reaction
        assert selected["reactions"]["N1"]["mz"] == rotation
    assert result["envelope"]["maxAbsDisplacement"] == abs(uz)
    assert result["envelope"]["maxAbsAxialForce"] == abs(axial)
    assert result["envelope"]["maxAbsReaction"] == reaction
    assert result["envelopeTables"]["nodeDisplacement"]["N2"]["maxAbsDisplacement"] == abs(uz)
    assert result["envelopeTables"]["nodeReaction"]["N1"]["fx"] == reaction
    assert result["summary"]["maxDisplacement"] == abs(uz)
