from copy import deepcopy
import json
from pathlib import Path
import sys

import pytest

sys.path[:0] = [str(Path(__file__).resolve().parents[1]), str(Path(__file__).resolve().parents[2] / "runtime")]
from native_self_weight import compile_self_weight, native_weight_records, verify_weight_results
from native_settings import control_parameters


def model():
    return {"nodes": [{"id": "a", "x": 0, "y": 0, "z": 0}, {"id": "b", "x": 0, "y": 0, "z": 3},
                      {"id": "c", "x": 4, "y": 0, "z": 3}],
            "elements": [{"id": "C", "type": "column", "nodes": ["a", "b"], "material": "m", "section": "s"},
                         {"id": "B", "type": "beam", "nodes": ["b", "c"], "material": "m", "section": "s"}],
            "sections": [{"id": "s", "type": "rectangular", "shape": {"kind": "rectangular", "B": 400, "H": 500}}],
            "materials": [{"id": "m", "rho": 2500}], "load_cases": [{"id": "D", "type": "dead", "loads": []}],
            "analysis_control": {"self_weight": True, "gravity_m_s2": 10}}


@pytest.mark.parametrize("direction,sign", [("-z", -1), ("z", 1)])
def test_authored_area_density_and_gravity_define_each_native_member_load(direction, sign):
    source = model()
    source["analysis_control"]["gravity_direction"] = direction
    before = deepcopy(source)
    plan = compile_self_weight(source)
    assert [row["intensityVectorKnM"] for row in plan["members"]] == [[0., 0., sign * 5.]] * 2
    assert [row["totalForceKn"] for row in plan["members"]] == [sign * 15., sign * 20.]
    records = native_weight_records(source, plan)
    assert [row["nativeValues"][1] for row in records] == [sign * 5., -sign * 5.]
    assert control_parameters(source["analysis_control"])[1] == {801: 0., 803: 0.}
    assert source == before


def test_numeric_area_is_not_native_reference_carrier_area():
    source = model()
    source["sections"] = [{"id": "s", "type": "custom", "properties": {
        "A": .08, "Iy": .001, "Iz": .002, "J": .0015, "Asy": .08*5/6, "Asz": .08*5/6}}]
    plan = compile_self_weight(source)
    assert [row["intensityKnM"] for row in plan["members"]] == [-2., -2.]
    assert [row["areaM2"] for row in plan["members"]] == [.08, .08]


@pytest.mark.parametrize("change", ["unknown-case", "ambiguous-case", "density", "horizontal-gravity"])
def test_ambiguous_or_unmapped_weight_never_becomes_a_native_default(change):
    source = model()
    if change == "unknown-case":
        source["analysis_control"]["self_weight_case_id"] = "missing"
    elif change == "ambiguous-case":
        source["load_cases"].append({"id": "D2", "type": "dead"})
    elif change == "density":
        source["materials"][0]["rho"] = 0
    else:
        source["analysis_control"]["gravity_direction"] = "-x"
    with pytest.raises(ValueError):
        compile_self_weight(source)


@pytest.mark.parametrize("index", [0, 1, 2])
def test_real_native_geometric_and_numeric_weights_preserve_case_direction_and_area(tmp_path, index):
    import base64
    import struct
    fixture = json.loads((Path(__file__).parent / "fixtures/native-selfweight.json").read_text(encoding="utf8"))[index]
    for name, value in fixture["files"].items():
        (tmp_path / name).write_bytes(base64.b64decode(value))
    model = fixture["model"]
    plan = compile_self_weight(model)
    actual = verify_weight_results(model, plan, fixture["cases"], tmp_path)
    assert actual["verified"] is True
    assert actual["selfWeight"]["loadCaseId"] == "G"
    assert all(row["areaM2"] == (.16 if index == 0 else .08) for row in plan["members"])
    loads = [row for row in fixture["nativeLoadMapping"]["loads"] if row["id"].startswith("self-weight:")]
    assert len(loads) == 7
    assert all(row["caseId"] == "G" and row["nativeReadbackValues"] ==
               [struct.unpack("<f", struct.pack("<f", value))[0] for value in row["nativeValues"]] for row in loads)
    if index == 2:
        assert fixture["requestedCaseIds"] == ["D"]
        assert fixture["selectedResult"] == {"kind": "case", "id": "D"}
        assert set(fixture["cases"]) == {"D", "G"}  # independent weight verification is retained
    changed = deepcopy(model)
    changed["materials"][0]["rho"] *= 2
    with pytest.raises(ValueError, match="weight/case differs"):
        verify_weight_results(changed, compile_self_weight(changed), fixture["cases"], tmp_path)
    with pytest.raises(ValueError, match="case was not verified"):
        verify_weight_results(model, plan, {"D": fixture["cases"]["D"]}, tmp_path)
    bad_cut = deepcopy(fixture["cases"])
    bad_cut["G"]["memberStations"]["beam0"][3]["components"]["Vz"] += 1
    with pytest.raises(ValueError, match="weight/case differs"):
        verify_weight_results(model, plan, bad_cut, tmp_path)
