import copy
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT.parent / "pkpm-static"),
               str(ROOT.parents[2] / "skill-shared" / "python")]
from commercial_context import project_commercial_model, attach_native_design_context
from native_settings import control_parameters
from native_materials import verify_solver_materials


@pytest.mark.parametrize("engine", ["pkpm", "yjk"])
def test_omitted_controls_are_off_and_recorded_without_changing_source(engine):
    source = {"materials": [], "elements": []}
    before = copy.deepcopy(source)
    projection = project_commercial_model(source, engine)
    assert source == before
    assert set(projection["analysisModel"]["analysis_control"].values()) == {False}
    assert len(projection["assumptions"]) == 5
    result = attach_native_design_context({}, source, projection, native_project="absent.jws", parameters={})
    assert result["assumptions"] == projection["assumptions"]
    if engine == "pkpm":
        assert control_parameters(projection["analysisModel"]["analysis_control"])[0] == {601: 1, 606: 0, 608: 0, 609: 0, 641: 0}


def test_explicit_controls_and_story_diaphragms_are_preserved():
    source = {"analysis_control": {"p_delta": True}, "stories": [{"rigid_diaphragm": True}]}
    projection = project_commercial_model(source, "pkpm")
    assert projection["analysisModel"]["analysis_control"]["p_delta"] is True
    assert "rigid_floor" not in projection["analysisModel"]["analysis_control"]


def test_two_storey_grade_defaults_reach_native_material_readback(tmp_path):
    import struct
    source = {"materials": [{"id": "lower", "grade": "C40"}, {"id": "upper", "grade": "C30"}],
              "elements": [{"id": "C1", "material": "lower"}, {"id": "C2", "material": "upper"}]}
    projection = project_commercial_model(source, "pkpm")
    materials = projection["analysisModel"]["materials"]
    assert [row["E"] for row in materials] == [32500, 30000]
    payload = struct.pack("<4i", 3, 20190824, 2, 96)
    records = {}
    for index, row in enumerate(materials, 1):
        name = f"SCLAW_{index}"
        payload += struct.pack("<i32s3i6d", index, name.encode(), index, 15, 0, 0., row["E"] * 1000, row["nu"], 0., 0., 0.)
        records[row["id"]] = {"nativeMaterialId": index, "nativeName": name,
                              "requested": {"E": row["E"], "nu": row["nu"], "unitWeight": 0.}}
    (tmp_path / "UserMaterial.SAT").write_bytes(payload)
    assert set(verify_solver_materials(tmp_path, records)["materials"]) == {"lower", "upper"}
    assert len(projection["assumptions"]) == 11
    source["materials"][0].update(E=31000, nu=.23, rho=2400)
    assert project_commercial_model(source, "pkpm")["analysisModel"]["materials"][0]["E"] == 31000
