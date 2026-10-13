from __future__ import annotations

import base64
import copy
import json
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "runtime"))
from native_displacements import read_native_displacements, NativeDisplacementUnavailable
from native_geometry import bind_native_geometry
import native_result_adapter


def test_actual_custom_case_six_dofs_are_bound_to_separate_native_file(tmp_path):
    data = json.loads((Path(__file__).parent / "fixtures/native-multiple-cases-displacements.json").read_text(encoding="utf-8"))
    for name, blob in data["files"].items():
        (tmp_path / name).write_bytes(base64.b64decode(blob))
    api = {key: {tuple(row["key"]): row["value"] for row in values} for key, values in data["api_translations"].items()}
    result = read_native_displacements(tmp_path, data["native_nodes"], api)
    assert set(result["caseDisplacements"]) == {"DL", "LL", "CRa"}
    assert data["nativeCaseNames"]["CRa"] == "W"
    assert all(len(rows) == 16 for rows in result["caseDisplacements"].values())
    assert all(set(row) == {"ux", "uy", "uz", "rx", "ry", "rz"} for rows in result["caseDisplacements"].values() for row in rows.values())
    changed = copy.deepcopy(api)
    changed["CRa"] = copy.deepcopy(changed["DL"])
    with pytest.raises(NativeDisplacementUnavailable, match="disagrees"):
        read_native_displacements(tmp_path, data["native_nodes"], changed)
    (tmp_path / "DISP_ZDY.SAT").write_bytes((tmp_path / "DISP_ZDY.SAT").read_bytes()[:-1])
    with pytest.raises(NativeDisplacementUnavailable, match="record length"):
        read_native_displacements(tmp_path, data["native_nodes"], api)


def test_real_frame_cuts_produce_complete_reactions_and_cancel_in_combination(monkeypatch):
    data = json.loads((Path(__file__).parent / "fixtures/native-two-floor-frame.json").read_text(encoding="utf-8"))
    artifacts = {name: base64.b64decode(blob) for name, blob in data["files"].items()}
    geometry = bind_native_geometry(data["model"], data["snapshot"], artifacts)
    monkeypatch.setattr(native_result_adapter, "read_native_geometry", lambda *_: geometry)
    # This integration test supplies complete six-vector inputs; the file
    # reader above independently verifies where actual native vectors came from.
    disps = {key: row for key, row in data["reference"]["D"]["displacements"].items() if key not in geometry["supports"]}
    case = {"status": "success", "displacements": disps, "memberStations": data["memberStations"]}
    settings = {"verified": True, "requested": dict.fromkeys(("self_weight", "rigid_floor", "rigid_offsets", "construction_stage", "p_delta"), False)}
    verified_material = json.loads((Path(__file__).parent / "fixtures/native-multiple-cases-displacements.json").read_text(encoding="utf-8"))["materialVerification"]
    result = {"summary": {"effectiveNativeSettings": settings, "nativeMaterialVerification": verified_material}, "warnings": [], "caseResults": {"D": case}}
    actual = native_result_adapter.complete_frame_results(data["model"], result, "unused.JWS")
    assert actual["capabilityStatus"] == "complete"
    assert len(actual["caseResults"]["D"]["reactions"]) == 8
    assert actual["reactionSource"] == actual["caseResults"]["D"]["reactionSource"]
    assert actual["boundaryDisplacementSource"] == actual["caseResults"]["D"]["boundaryDisplacementSource"]
    for node, row in actual["reactions"].items():
        for component in ("fx", "fy", "fz", "mx", "my", "mz"):
            assert row[component] == pytest.approx(data["reference"]["D"]["reactions"][node][component], rel=1e-5, abs=1e-5)
    actual["caseResults"]["copy"] = copy.deepcopy(actual["caseResults"]["D"])
    model = {**data["model"], "load_combinations": [{"id": "cancel", "factors": {"D": 1, "copy": -1}}]}
    combined = native_result_adapter.select_result(model, actual, ["D", "copy"], "cancel")
    assert combined["selectedResult"] == {"kind": "combination", "id": "cancel"}
    assert combined["summary"]["maxDisplacement"] == 0
    assert combined["source"] == combined["combinationResults"]["cancel"]["source"]
    assert "boundaryDisplacementSource" not in combined
    assert "reactionObjectSources" not in combined
    assert "reactionSource" not in combined
    assert all(value == 0 for row in combined["reactions"].values() for value in row.values())
    assert all(value == 0 for rows in combined["memberStations"].values() for row in rows for value in row["components"].values())
