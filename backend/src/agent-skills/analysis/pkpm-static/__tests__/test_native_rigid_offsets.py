import base64
from copy import deepcopy
import json
from pathlib import Path
import sys

import pytest

SKILL = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(SKILL), str(SKILL.parent/"runtime"), str(SKILL.parents[2]/"skill-shared/python")]
from native_rigid_offsets import compile_load_records, material_plan, read_rigid_offsets, verify_case_equilibrium, verify_rigid_offsets
from native_loads import plan_native_loads

FIXTURE = json.loads((Path(__file__).parent/"fixtures/native-rigid-offsets.json").read_text(encoding="utf8"))


def native_files(tmp_path, variant="passed"):
    data = deepcopy(FIXTURE[variant])
    for name in ("DATA.SAT", "LoadZDY.SAT", "spas_sat.txt"):
        (tmp_path/name).write_bytes(base64.b64decode(data[name]))
    (tmp_path/"native-rigid-load-compilation.json").write_text(json.dumps(data["receipt"]), encoding="utf8")
    return data


def test_real_native_lengths_and_source_load_receipt(tmp_path):
    data = native_files(tmp_path)
    result = verify_rigid_offsets(tmp_path, data["analysisModel"])
    beam = result["members"]["beam"]
    assert beam["startLengthM"] == pytest.approx(.275, abs=1e-6)
    assert beam["elasticEndM"] == pytest.approx(5.725, abs=1e-6)
    assert beam["nativeStationDomain"] == "elastic-span"
    assert result["members"]["c0"]["nativeStationDomain"] == "physical-endpoints"
    assert result["sourceLoadSemanticsPreserved"]
    assert result["loadCompilation"]["sourceFeaSha256"] == result["sourceFeaSha256"]
    row = result['loadCompilation']['elementLoads'][0]
    assert row['sourceLoadIndex'] == 1
    assert row['nativeWireReadback']['intensityToken'] == '1.81667'
    assert row['sourceIntensityVectorKnM'] == [0., 0., -2.]
    assert row['effectiveElasticIntensityVectorKnM'][2] != -2.


def test_solver_wire_and_sdk_quantization_are_read_not_fitted_to_response(tmp_path):
    data = native_files(tmp_path, 'deepReversed')
    row = verify_rigid_offsets(tmp_path, data['analysisModel'])['loadCompilation']['elementLoads'][0]
    assert row['nativeWireReadback']['sdkValues'][1] == 19.33333396911621
    assert row['nativeWireReadback']['globalZIntensityKnM'] == -19.33329963684082
    assert row['effectiveElasticIntensityVectorKnM'][2] == -19.999964792153545
    # Computed force/displacement files are deliberately absent from tmp_path.
    assert sorted(path.name for path in tmp_path.iterdir()) == ['DATA.SAT', 'LoadZDY.SAT', 'native-rigid-load-compilation.json', 'spas_sat.txt']
    receipt = data['receipt']
    next(item for item in receipt['nativeReadback'] if item['targetType'] == 'beam')['nativeReadbackValues'][1] *= 2
    (tmp_path/'native-rigid-load-compilation.json').write_text(json.dumps(receipt), encoding='utf8')
    with pytest.raises(ValueError, match='quantization'):
        verify_rigid_offsets(tmp_path, data['analysisModel'])


def test_same_topology_changed_load_cannot_reuse_receipt(tmp_path):
    data = native_files(tmp_path)
    data["analysisModel"]["load_cases"][0]["loads"][0]["fz"] *= 2
    with pytest.raises(ValueError, match="another model"):
        verify_rigid_offsets(tmp_path, data["analysisModel"])


def test_reversed_source_endpoints_reverse_native_lengths(tmp_path):
    data = native_files(tmp_path, "smallMomentFailure")
    result = read_rigid_offsets(tmp_path, data["analysisModel"])
    beam = result["members"]["beam"]
    assert beam["sourceNodeIds"] == ["t1", "t0"]
    assert beam["startLengthM"] == beam["source"]["nativeValuesM"][1]
    assert result["members"]["c0"]["startLengthM"] == 0
    assert result["members"]["c0"]["endLengthM"] == pytest.approx(.1)


def test_line_load_compilation_keeps_full_force_and_first_moment(tmp_path):
    data = native_files(tmp_path)
    source = data["analysisModel"]
    before = deepcopy(source)
    rigid = read_rigid_offsets(tmp_path, source)
    rows, ledger = compile_load_records(source, {"loads": plan_native_loads(source)}, rigid)
    assert source == before
    record = ledger[0]
    ri, end = record["elasticIntervalM"]
    q = record["sourceIntensityVectorKnM"][2]
    node_loads = record["rigidSegmentNodeLoads"]
    force = q*(end-ri)+sum(row["forceVectorKn"][2] for row in node_loads)
    moment_y = -q*(end**2-ri**2)/2+sum(row["momentVectorKnM"][1] for row in node_loads)-6*node_loads[1]["forceVectorKn"][2]
    assert force == pytest.approx(q*6)
    assert moment_y == pytest.approx(-q*6**2/2)
    assert len([row for row in rows if row["targetType"] == "node"]) == 4


@pytest.mark.parametrize("case", ["D", "W"])
def test_real_native_node_and_cut_equilibrium(case):
    data = FIXTURE["passed"]
    assert verify_case_equilibrium(data["analysisModel"], data["cases"][case], case)["verified"]


def test_native_small_moment_loss_fails_despite_successful_sdk_save():
    data = FIXTURE["smallMomentFailure"]
    with pytest.raises(ValueError, match="node/t0"):
        verify_case_equilibrium(data["analysisModel"], data["cases"]["D"], "D")


def test_deep_column_rigid_regions_and_reversed_design_positions(tmp_path):
    data = native_files(tmp_path, "deepReversed")
    from structure_protocol.structure_model_v2 import StructureModelV2
    StructureModelV2.model_validate(data["sourceModel"])
    rigid = verify_rigid_offsets(tmp_path, data["analysisModel"])
    assert rigid["members"]["c0"]["endLengthM"] == pytest.approx(.1)
    for key, case in data["cases"].items():
        assert verify_case_equilibrium(data["analysisModel"], case, key)["verified"]
    positions = {row["nativeStationIndex"]: row["positionM"] for row in data["cases"]["D"]["memberStations"]["beam"]}
    beam_records = [row for row in data["designRecords"] if row["elementId"] == "beam"]
    assert len(beam_records) == 18
    assert all(row["positionM"] == positions[row["nativeStationIndex"]] for row in beam_records)
    assert positions[0] == pytest.approx(5.9)
    assert positions[8] == pytest.approx(.1)


def test_elastic_standard_profile_is_not_a_design_request():
    source = deepcopy(FIXTURE["passed"]["analysisModel"])
    plan = material_plan(source)
    assert "request" not in plan
    assert plan["materials"]["M1"]["E"] == source["materials"][0]["E"]
    source["materials"][0]["G"] *= .9
    with pytest.raises(ValueError, match="source model is unchanged"):
        material_plan(source)


def test_numeric_carrier_cannot_supply_rigid_end_geometry():
    source = deepcopy(FIXTURE["passed"]["analysisModel"])
    source["sections"][0] = {"id": "C", "type": "custom", "properties": {"A": .48, "Iy": .0256, "Iz": .0144, "J": .031}}
    with pytest.raises(ValueError, match="real rectangular geometry"):
        material_plan(source)
