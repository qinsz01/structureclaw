from __future__ import annotations

import base64
import copy
import json
from pathlib import Path
import struct
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from native_displacements import read_native_displacements, NativeDisplacementUnavailable


@pytest.fixture
def native(tmp_path):
    data = json.loads((Path(__file__).parent / "fixtures/native-six-dof-cantilevers.json").read_text())
    for name, encoded in data["files"].items():
        (tmp_path / name).write_bytes(base64.b64decode(encoded))
    cases = {case: {tuple(row["node"]): {key: row[key] for key in ("ux", "uy", "uz")} for row in rows}
             for case, rows in data["apiCases"].items()}
    return tmp_path, data, cases


def test_all_six_native_components_match_frozen_independent_cantilevers(native):
    root, data, cases = native
    result = read_native_displacements(root, data["nativeNodes"], cases)
    reference = data["reference"]
    for expected in reference["references"]:
        pmid = data["nodeMapping"][expected["nodeId"]]["pmid"]
        actual = result["caseDisplacements"]["LL"][(pmid, 1)]
        for key in ("ux", "uy", "uz", "rx", "ry", "rz"):
            absolute = reference["absoluteTranslationTolerance_m"] if key[0] == "u" else reference["absoluteRotationTolerance_rad"]
            assert actual[key] == pytest.approx(expected[key], rel=reference["relativeTolerance"], abs=absolute), key
    assert set(result["caseDisplacements"]) == {"DL", "LL"}
    assert "LL2" not in result["caseDisplacements"]
    assert len(result["missingNodeRotations"]) == 4
    assert all(floor == 0 for _, floor in result["missingNodeRotations"])
    assert result["source"]["translationCrossCheck"] == "float32-exact-public-api"


def test_sdk_values_are_cross_checked_at_every_native_node(native):
    root, data, cases = native
    first = next(iter(cases["LL"].values()))
    first["uz"] *= -1
    with pytest.raises(NativeDisplacementUnavailable, match="uz disagrees"):
        read_native_displacements(root, data["nativeNodes"], cases)


def test_wrong_case_order_cannot_silently_relabel_results(native):
    root, data, cases = native
    path = root / "WDISPGKNO.OUT"
    path.write_bytes(b"DISP1.SAT LL\r\nDISP1.SAT DL\r\n")
    with pytest.raises(NativeDisplacementUnavailable, match="disagrees"):
        read_native_displacements(root, data["nativeNodes"], cases)


def test_dofs_are_not_read_from_an_unverified_constraint_index(native):
    root, data, cases = native
    path = root / "NODEINDEX.SAT"
    buffer = bytearray(path.read_bytes())
    struct.pack_into("<f", buffer, 8, 1.)
    path.write_bytes(buffer)
    with pytest.raises(NativeDisplacementUnavailable, match="constraint mapping"):
        read_native_displacements(root, data["nativeNodes"], cases)


def test_missing_or_truncated_result_rows_fail_closed(native):
    root, data, cases = native
    path = root / "DISP.SAT"
    path.write_bytes(path.read_bytes()[:-4])
    with pytest.raises(NativeDisplacementUnavailable, match="coverage differs"):
        read_native_displacements(root, data["nativeNodes"], cases)


def test_ambiguous_and_wrong_unit_node_geometry_is_rejected(native):
    root, data, cases = native
    nodes = copy.deepcopy(data["nativeNodes"])
    nodes[0]["coordinates"] = nodes[1]["coordinates"]
    with pytest.raises(NativeDisplacementUnavailable, match="Ambiguous"):
        read_native_displacements(root, nodes, cases)
    nodes = copy.deepcopy(data["nativeNodes"])
    for row in nodes:
        row["coordinates"] = [value / 1000 for value in row["coordinates"]]
    with pytest.raises(NativeDisplacementUnavailable, match="not bound"):
        read_native_displacements(root, nodes, cases)


def test_sdk_missing_node_is_not_filled_with_zero_rotations(native):
    root, data, cases = native
    cases["LL"].pop(next(iter(cases["LL"])))
    with pytest.raises(NativeDisplacementUnavailable, match="coverage differs"):
        read_native_displacements(root, data["nativeNodes"], cases)
