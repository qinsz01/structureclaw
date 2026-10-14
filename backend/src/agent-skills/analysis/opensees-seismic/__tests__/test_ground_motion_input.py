import hashlib
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ground_motion_input import motion_direction, unit_scale, values


def table(**changes):
    return {"headers": ["time (s)", "accel_g"], "rows": [[0, 0], [.02, .1], [.04, -.1]], **changes}


def test_complete_time_axis_and_units_are_explicit():
    parsed = values(table())
    assert parsed.values == [0, .1, -.1]
    assert parsed.inferred_dt == .02
    assert parsed.inferred_unit == "g"
    assert unit_scale("m/s²") == 1
    assert unit_scale("gal") == .01


@pytest.mark.parametrize("changes, error", [
    ({"rows": [[0,0],[.02,"bad"],[.04,-.1]]}, "BAD_CELL"),
    ({"rows": [[0,0],[.02],[.04,-.1]]}, "MISSING_CELL"),
    ({"rows": [[0,0],[.02,None],[.04,-.1]]}, "BAD_CELL"),
    ({"rows": [[0,0],[.02,float("nan")],[.04,-.1]]}, "BAD_CELL"),
    ({"rows": [[0,0],[.02,.1],[.02,-.1]]}, "NOT_UNIFORM_INCREASING"),
    ({"rows": [[0,0],[.02,.1],[.05,-.1]]}, "NOT_UNIFORM_INCREASING"),
    ({"dt": .03}, "DT_CONFLICT"),
    ({"unit": "banana"}, "UNIT_REQUIRED_OR_UNSUPPORTED"),
    ({"unit": "m/s2"}, "UNIT_CONFLICT"),
    ({"timeUnit": "fortnight"}, "TIME_UNIT_UNSUPPORTED"),
    ({"headers": ["time(min)","accel_g"]}, "TIME_UNIT_UNSUPPORTED"),
    ({"accelerationColumn": 1.5}, "COLUMN_REQUIRED_OR_AMBIGUOUS"),
    ({"accelerationColumn": "missing"}, "COLUMN_REQUIRED_OR_AMBIGUOUS"),
    ({"truncated": True}, "TRUNCATED_INPUT"),
])
def test_bad_cells_time_and_units_never_drop_shift_guess_or_interpolate(changes, error):
    with pytest.raises(ValueError, match=error):
        values(table(**changes))


def test_zero_column_index_and_unselected_labels_do_not_shift_columns():
    parsed=values({"headers":["accel_g","label","time_ms"],"rows":[[.1,"A",0],[.2,"B",20],[.3,"C",40]],
                   "accelerationColumn":0,"timeColumn":2})
    assert parsed.values == [.1,.2,.3]
    assert parsed.inferred_dt == .02


@pytest.mark.parametrize("record,error", [
    ({"values":[0,.1],"unit":"g"},"DT_REQUIRED"),
    ({"values":[0,.1],"dt":0,"unit":"g"},"DT_REQUIRED"),
    ({"values":[0,.1],"dt":.02},"UNIT_REQUIRED"),
    ({"values":[0,"bad",.1],"dt":.02,"unit":"g"},"BAD_CELL"),
    ({"headers":["0","bad"],"rows":[[.02,.1],[.04,.2]],"timeColumn":0,"accelerationColumn":1,"unit":"g"},"FIRST_SAMPLE_INVALID"),
])
def test_direct_records_have_no_hidden_defaults(record,error):
    with pytest.raises(ValueError,match=error): values(record)


def test_at2_header_numbers_are_not_samples_and_npts_is_exact():
    text="PEER record 1999 station 2024\nACCELERATION IN UNITS OF G\nNPTS= 4, DT= .02 SEC\n0 .1\n-.1 0\n"
    parsed=values({"content":text})
    assert parsed.values == [0,.1,-.1,0]
    assert parsed.inferred_dt == .02
    assert parsed.inferred_unit == "G"
    with pytest.raises(ValueError,match="SAMPLE_COUNT_MISMATCH"): values({"content":text.replace("NPTS= 4","NPTS= 5")})
    with pytest.raises(ValueError,match="BAD_CELL"): values({"content":text.replace("-.1 0","bad 0")})


def test_reference_reads_entire_workbook_sheet_and_rejects_tampering(tmp_path):
    original=tmp_path/'wave.xlsx'
    original.write_bytes(b'original workbook fixture, parsing is owned by xlsx in the backend')
    rawhash=hashlib.sha256(original.read_bytes()).hexdigest()
    parsed=tmp_path/'parsed.json'
    samples=[[i*.02,i*.001] for i in range(250)]
    payload={"format":"sclaw-parsed-input-v1","type":"excel","source":{"sha256":rawhash},
             "sheets":{"EW":{"headers":["time","accel_g"],"rows":samples,"truncated":False}}}
    parsed.write_text(json.dumps(payload),encoding='utf-8')
    reference={"format":payload['format'],"path":str(original),"sha256":rawhash,"parsedPath":str(parsed),
               "parsedSha256":hashlib.sha256(parsed.read_bytes()).hexdigest()}
    record={"fileReference":reference,"sheetName":"EW","direction":"x","values":[999]}
    result=values(record)
    assert len(result.values)==250 and result.values[-1]==.249
    assert result.source['sha256']==rawhash
    with pytest.raises(ValueError,match="SHEET_REQUIRED"): values({**record,"sheetName":"wrong"})
    original.write_bytes(b'changed')
    with pytest.raises(ValueError,match="FILE_HASH_MISMATCH"): values(record)


def test_directions_require_global_axes_and_cannot_disagree():
    assert motion_direction({}) is None
    assert motion_direction({"direction":"x"}) == 'x'
    for record in ({"direction":"z"},{"component":"EW"},{"direction":"x","axis":"y"}):
        with pytest.raises(ValueError,match="DIRECTION_"): motion_direction(record)
