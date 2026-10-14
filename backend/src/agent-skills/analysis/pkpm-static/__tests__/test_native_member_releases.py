from copy import deepcopy
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from native_member_releases import beam_release_plan, write_beam_release


@pytest.mark.parametrize("start,end,code", [(False, False, 1), (True, False, 2), (False, True, 3), (True, True, 4)])
def test_official_beam_support_codes_preserve_bending_and_torsion(start, end, code):
    element = {"id": "B", "type": "beam", "releases": {
        "i": {"ry": start, "rz": start}, "j": {"ry": end, "rz": end}}}
    before = deepcopy(element)
    plan = beam_release_plan(element)
    assert plan["nativeCode"] == code
    assert plan["hinges"] == [int(start), int(end)]
    assert plan["releases"] == [False] * 4 + [start] * 2 + [False] * 4 + [end] * 2
    assert element == before


@pytest.mark.parametrize("release", [
    {"i": {"ry": True}}, {"i": {"rx": True}}, {"i": {"ux": True}},
    {"i": {"ry": 1, "rz": True}}, {"reference_frame": "global"},
    {"i": {"ry": True, "rz": True}, "releaseI": {}}, {"start": {"ry": True, "rz": True}},
])
def test_partial_bending_or_unsupported_release_dofs_cannot_be_silently_changed(release):
    with pytest.raises(ValueError):
        beam_release_plan({"type": "beam", "releases": release})


def test_sdk_write_must_read_back_exact_code():
    from types import SimpleNamespace
    class Member:
        def SetSpecial(self, field, value):
            self.value = value
        def GetSpecial(self, field):
            return self.value
    member = Member()
    api = SimpleNamespace(SpecialBeam=SimpleNamespace(IDSp_Constrain_Support=4))
    element = {"type": "beam", "releases": {"releaseJ": {"ry": True, "rz": True}}}
    assert write_beam_release(api, member, element)["nativeCode"] == 3
    member.GetSpecial = lambda *_: 1
    with pytest.raises(RuntimeError, match="readback"):
        write_beam_release(api, member, element)


def test_native_reversal_maps_the_physical_released_end():
    element = {"type": "beam", "nodes": ["B", "A"], "releases": {"j": {"ry": True, "rz": True}}}
    assert beam_release_plan(element, ["A", "B"])["nativeCode"] == 2
    assert beam_release_plan(element, ["B", "A"])["nativeCode"] == 3
    with pytest.raises(ValueError, match="endpoints"):
        beam_release_plan(element, ["A", "C"])


def test_real_native_release_readback_and_stations_preserve_requested_physical_ends():
    import base64
    import json
    from native_geometry import bind_native_geometry, NativeGeometryUnavailable
    from native_frame_stations import map_frame_stations
    data = json.loads((Path(__file__).parent / "fixtures/native-beam-releases.json").read_text(encoding="utf8"))
    artifacts = {key: base64.b64decode(value) for key, value in data["files"].items()}
    geometry = bind_native_geometry(data["model"], data["snapshot"], artifacts)
    results = map_frame_stations(data["model"], geometry, data["memberStations"])
    for identity, ends in (("beam0", (0, -1)), ("beam1", (0,)), ("beam2", (-1,))):
        for end in ends:
            assert results[identity][end]["components"]["My"] == 0
            assert results[identity][end]["components"]["Mz"] == 0
        assert abs(results[identity][0]["components"]["T"]) > 1  # torsion is retained
    assert abs(results["beam1"][-1]["components"]["My"]) > 1
    assert abs(results["beam2"][0]["components"]["My"]) > 1
    assert data["releaseReadback"]["members"]["beam2"]["supportCode"] == 2
    changed = deepcopy(data["model"])
    next(row for row in changed["elements"] if row["id"] == "beam2")["releases"] = {"i": {"ry": True, "rz": True}}
    with pytest.raises(NativeGeometryUnavailable, match="releases differ"):
        bind_native_geometry(changed, data["snapshot"], artifacts)
