from __future__ import annotations

import base64
import copy
import hashlib
import json
from pathlib import Path
import struct
import sys
import zlib

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "runtime"))
from native_numeric_sections import compile_numeric_sections, verify_numeric_sections, has_numeric_sections, _members
from native_model_contract import pkpm_numeric_section_properties


@pytest.fixture
def solved(tmp_path):
    fixture = json.loads((Path(__file__).parent / "fixtures/native-numeric-frame.json").read_text(encoding="utf-8"))
    payloads = {name: zlib.decompress(base64.b64decode(value)) for name, value in fixture["files"].items()}
    for name, raw in payloads.items():
        assert hashlib.sha256(raw).hexdigest() == fixture["sha256"][name]
    (tmp_path / "SDATA.SAT").write_bytes(payloads["SDATA.SAT.precompile"])
    return tmp_path, fixture["model"], payloads


def test_compiler_binds_all_members_and_preserves_the_source_and_unrelated_native_bytes(solved):
    root, model, payloads = solved
    original = copy.deepcopy(model)
    evidence = compile_numeric_sections(root, model)
    assert len(evidence["members"]) == 42
    assert model == original
    assert evidence["carrier"]["codeDesignGeometry"] is False
    before, after = payloads["SDATA.SAT.precompile"], (root / "SDATA.SAT.compiled").read_bytes()
    changed = {i for i, (a, b) in enumerate(zip(before, after)) if a != b}
    allowed = {i for row in evidence["members"].values() for i in range(row["byteOffset"], row["byteOffset"] + 16)}
    assert changed and changed <= allowed
    assert evidence["members"]["c0-0-1"]["nativeValuesAJIyIz"][2] == pytest.approx(.0037333333333333337 * .6)
    assert evidence["members"]["c0-0-1"]["nativeValuesAJIyIz"][3] == pytest.approx(.01143333333333333 * .6)
    for name in ("SDATA.SAT", "DATA.SAT"):
        (root / name).write_bytes(payloads[name])
    checked = verify_numeric_sections(root, model)
    assert checked["verified"] is True
    assert len(checked["solverDataSha256"]) == 64


@pytest.mark.parametrize("change", ["model", "solved-property", "receipt", "missing-member", "compiled-input"])
def test_receipt_cannot_certify_changed_models_or_incomplete_native_consumption(solved, change):
    root, model, payloads = solved
    evidence = compile_numeric_sections(root, model)
    (root / "DATA.SAT").write_bytes(payloads["DATA.SAT"])
    if change == "model":
        model["sections"][0]["properties"]["Iy"] *= 1.5
    elif change == "solved-property":
        blob = bytearray(payloads["DATA.SAT"])
        offset = _members(blob, model)["c0-0-1"]["offset"] + 128
        struct.pack_into("<f", blob, offset, 1.)
        (root / "DATA.SAT").write_bytes(blob)
    elif change == "compiled-input":
        (root / "SDATA.SAT.compiled").write_bytes(payloads["SDATA.SAT.precompile"])
    else:
        if change == "receipt":
            evidence["members"]["c0-0-1"]["sourceSectionId"] = "unrelated"
        else:
            evidence["members"].pop("c0-0-1")
        (root / "native-section-compilation.json").write_text(json.dumps(evidence), encoding="utf-8")
    with pytest.raises(ValueError):
        verify_numeric_sections(root, model)


@pytest.mark.parametrize("change", ["geometry", "record-kind", "duplicate-pointer", "truncated"])
def test_unknown_native_layout_never_gets_numeric_property_substitution(solved, change):
    root, model, payloads = solved
    blob = bytearray(payloads["SDATA.SAT.precompile"])
    item = _members(blob, model)["c0-0-1"]
    if change == "geometry":
        struct.pack_into("<f", blob, item["offset"] + 24, 99.)
    elif change == "record-kind":
        struct.pack_into("<f", blob, item["offset"] + 136, 26.)
    elif change == "duplicate-pointer":
        blob[404:408] = blob[400:404]
    else:
        blob = blob[:10000]
    (root / "SDATA.SAT").write_bytes(blob)
    with pytest.raises(ValueError):
        compile_numeric_sections(root, model)


def test_custom_properties_require_the_calibrated_shear_area_and_no_geometric_claim(solved):
    _, model, _ = solved
    section = copy.deepcopy(model["sections"][0])
    props = pkpm_numeric_section_properties(section)
    assert props["Asy"] == props["Asz"] == props["A"] * 5 / 6
    section["properties"]["Asy"] *= .5
    with pytest.raises(Exception, match="Asy=Asz"):
        pkpm_numeric_section_properties(section)
    section = copy.deepcopy(model["sections"][0])
    section["width"] = 500
    with pytest.raises(Exception, match="geometric overrides"):
        pkpm_numeric_section_properties(section)


def test_unused_numeric_section_after_edit_does_not_request_native_compilation(solved):
    _, model, _ = solved
    model["sections"].append({"id": "geometric", "type": "rectangular", "shape": {"kind": "Rectangle", "B": 500, "H": 500}})
    assert has_numeric_sections(model) is True
    for member in model["elements"]:
        member["section"] = "geometric"
    assert has_numeric_sections(model) is False
