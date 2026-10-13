from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest


@pytest.fixture
def extractor(monkeypatch):
    monkeypatch.setenv("SC_YJK_EXTRACT_NO_AUTORUN", "1")
    path = Path(__file__).resolve().parents[1] / "extract_results.py"
    spec = importlib.util.spec_from_file_location("yjk_extractor_under_test", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize("first_moment", [0, -4, 2.5])
def test_single_force_vector_retains_every_signed_component(extractor, first_moment):
    row = [first_moment, -5, 6, -7, -8, 9]
    assert extractor._normalize_sections(row) == [row]


def test_sdk_count_and_rows_preserves_order_and_discards_unused_capacity(extractor):
    rows = [[1, -2, 3, -4, -5, 6], [-7, 8, -9, 10, -11, 12], [0] * 6]
    assert extractor._normalize_sections((2, rows)) == rows[:2]


def test_force_row_collection_is_not_a_count_wrapper(extractor):
    rows = [[1, 2, 3, 4, 5, 6], [-1, -2, -3, -4, -5, -6]]
    assert extractor._normalize_sections(rows) == rows


def test_absent_rotation_is_not_replaced_with_zero(extractor):
    assert extractor._node_vector_entry(3, [1, 2, 3], ("ux", "uy", "uz", "rx", "ry", "rz")) is None


def test_nonfinite_native_force_rejected(extractor):
    with pytest.raises(RuntimeError, match="not finite"):
        extractor._normalize_sections([0, 0, 0, 0, float("nan"), 0])


def test_incomplete_xyz_does_not_manufacture_z_zero(extractor):
    class IncompletePre:
        @staticmethod
        def XYZ(node_id):
            return [3, 4]

    with pytest.raises(RuntimeError, match="coordinates are incomplete"):
        extractor._node_coordinate_entry(IncompletePre(), extractor._new_debug(), 1)


def test_failed_coordinate_api_does_not_create_origin(extractor):
    with pytest.raises(RuntimeError, match="coordinate x is not numeric"):
        extractor._node_coordinate_entry(object(), extractor._new_debug(), 1)


def test_separate_coordinate_api_preserves_explicit_values(extractor):
    class SeparatePre:
        @staticmethod
        def X(node_id):
            return 3

        @staticmethod
        def Y(node_id):
            return 4

        @staticmethod
        def Z(node_id):
            return 5

    assert extractor._node_coordinate_entry(SeparatePre(), extractor._new_debug(), 7) == {
        "id": 7, "x": 3, "y": 4, "z": 5,
    }
