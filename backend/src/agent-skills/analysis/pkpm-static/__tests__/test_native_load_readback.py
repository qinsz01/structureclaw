import base64
import json
from pathlib import Path
import struct
import sys

import pytest

SKILL = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(SKILL), str(SKILL.parent/'runtime'), str(SKILL.parents[2]/'skill-shared/python')]
from native_load_readback import read_beam_load_inputs

SAMPLES = json.loads((Path(__file__).parent/'fixtures/native-beam-load-inputs.json').read_text(encoding='utf8'))


def files(tmp_path, sample=0):
    sample = SAMPLES[sample]
    for name, payload in sample['files'].items():
        (tmp_path/name).write_bytes(base64.b64decode(payload))
    return sample['model']


@pytest.mark.parametrize('sample,count,cases', [(0, 40, {1, 2}), (1, 14, {201})])
def test_two_floor_standard_and_custom_cases_bind_input_records(tmp_path, sample, count, cases):
    model = files(tmp_path, sample)
    result = read_beam_load_inputs(tmp_path, model)
    rows = [row for values in result['members'].values() for row in values]
    assert len(rows) == count
    assert {row['nativeCaseId'] for row in rows} == cases
    assert {row['nativeFloor'] for row in rows} == {1, 2}
    for row in rows:
        payload = (tmp_path/row['file']).read_bytes()
        actual = struct.unpack_from('<f', payload, row['byteOffset']+12)[0]
        assert actual == row['globalZIntensityKnM']
        assert actual == struct.unpack('<f', struct.pack('<f', -float(row['intensityToken'])))[0]


@pytest.mark.parametrize('change', ['case', 'text', 'member', 'span', 'quantity', 'schema'])
def test_unverified_input_change_is_rejected(tmp_path, change):
    model = files(tmp_path)
    if change in ('text', 'schema'):
        path = tmp_path/'spas_sat.txt'
        before, after = (b',8,0,0,0,0,-0,8,', b',9,0,0,0,0,-0,9,') if change == 'text' else (b'20221025', b'20251025')
        data = path.read_bytes()
        assert before in data
        path.write_bytes(data.replace(before, after, 1))
    else:
        row = next(iter(read_beam_load_inputs(tmp_path, model)['members'].values()))[0]
        path = tmp_path/row['file']; data = bytearray(path.read_bytes())
        index, value = {'case': (2, 1), 'member': (0, 999), 'span': (6, 5.5), 'quantity': (3, -9)}[change]
        struct.pack_into('<f', data, row['byteOffset']+4*index, value)
        path.write_bytes(data)
    with pytest.raises(ValueError, match='Native beam load input'):
        read_beam_load_inputs(tmp_path, model)
