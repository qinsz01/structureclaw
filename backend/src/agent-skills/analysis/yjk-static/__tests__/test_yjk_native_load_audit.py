from copy import deepcopy
import json
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from native_fe import parse_fe
from native_load_audit import audit_loads


def fixture(tmp_path):
    data = json.loads((Path(__file__).parent / 'fixtures/native-frame-six-components.json').read_text(encoding='utf8'))
    path = tmp_path / 'fea.dat'
    path.write_text(data['fea'], encoding='gb18030')
    data['mapping']['ydb_path'] = str(tmp_path / 'input.ydb')
    return data, parse_fe(path)


def test_real_seven_case_native_loads_bind_signed_components_and_case_ownership(tmp_path):
    data, fe = fixture(tmp_path)
    report = audit_loads(data['model'], data['mapping'], fe)
    assert report['passed']
    assert set(report['sourceCases']) == {'AX', 'UDL', 'FX', 'FY', 'MX', 'MY', 'MZ'}
    assert report['feaSha256'] == fe['sha256']


@pytest.mark.parametrize('change', ['case', 'sign', 'location'])
def test_correct_total_with_wrong_case_direction_or_target_fails(tmp_path, change):
    data, fe = fixture(tmp_path)
    model = deepcopy(data['model'])
    cases = {row['id']: row for row in model['load_cases']}
    if change == 'case':
        cases['FX']['loads'], cases['FY']['loads'] = cases['FY']['loads'], cases['FX']['loads']
    elif change == 'sign':
        cases['MX']['loads'][0]['mx'] *= -1
    else:
        cases['FX']['loads'][0]['node'] = 'N1_0'
    with pytest.raises(ValueError, match='loads differ'):
        audit_loads(model, data['mapping'], fe)


