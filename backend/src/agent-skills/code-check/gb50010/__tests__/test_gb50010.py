"""Unit tests for GB50010 (混凝土设计规范) code-check module."""
from __future__ import annotations

import importlib.util
from pathlib import Path
from typing import Any, Dict

import pytest

_MODULE_PATH = str(Path(__file__).resolve().parent.parent / "code_check.py")
_spec = importlib.util.spec_from_file_location("gb50010_code_check", _MODULE_PATH)
gb50010 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(gb50010)


class MockCodeChecker:

    def __init__(self, overrides: Dict[str, Dict[str, float]] | None = None):
        self._overrides = overrides or {}

    def _resolve_utilization(self, elem_id, item_name, context):
        per_elem = self._overrides.get(elem_id, {})
        raw = per_elem.get(item_name)
        if isinstance(raw, (int, float)):
            return max(0.0, float(raw))
        # Fallback: read computed overrides from context (set by
        # _compute_utilization_overrides + check_element merge)
        ube = context.get('utilizationByElement', {})
        if isinstance(ube, dict):
            per_elem_ctx = ube.get(elem_id, {})
            if isinstance(per_elem_ctx, dict):
                raw = per_elem_ctx.get(item_name)
                if isinstance(raw, (int, float)):
                    return max(0.0, float(raw))
        return 0.55

    def _calc_item(self, elem_id, item_name, context, clause, formula, limit):
        utilization = self._resolve_utilization(elem_id, item_name, context)
        return {
            'item': item_name,
            'status': 'pass' if utilization <= 1.0 else 'fail',
            'utilization': round(utilization, 4),
            'clause': clause,
            'formula': formula,
            'inputs': {
                'demand': round(utilization * limit, 4),
                'capacity': round(limit, 4),
                'limit': limit,
            },
        }

    def _build_element_result(self, elem_id, element_type, checks, code_version):
        all_items = [item for check in checks for item in check.get('items', [])]
        controlling = max(all_items, key=lambda i: float(i.get('utilization', 0.0)), default={})
        all_passed = all(i.get('status') == 'pass' for i in all_items)
        return {
            'elementId': elem_id,
            'elementType': element_type,
            'status': 'pass' if all_passed else 'fail',
            'checks': checks,
            'controlling': {
                'item': controlling.get('item'),
                'utilization': controlling.get('utilization', 0.0),
                'clause': controlling.get('clause'),
            },
            'code': code_version,
        }


class TestGetRules:

    def test_code_field(self):
        assert gb50010.get_rules()['code'] == 'GB50010'

    def test_version_field(self):
        assert gb50010.get_rules()['version'] == 'v2-rc-frame-member-checks'

    def test_rules_cover_beams_and_columns(self):
        rules = gb50010.get_rules()['rules']
        assert len(rules) == 2
        assert rules[0]['elementType'] == ['beam']
        assert rules[1]['elementType'] == ['column']

    def test_rules_include_rebar_spacing(self):
        rules = gb50010.get_rules()['rules']
        assert '钢筋净距' in rules[0]['checks']  # beam
        assert '钢筋净距' in rules[1]['checks']  # column


class TestCheckElementStructure:

    def test_returns_dict(self):
        checker = MockCodeChecker()
        result = gb50010.check_element(checker, 'B1', {})
        assert isinstance(result, dict)

    def test_beam_without_spacing_metadata_skips_construction_group(self):
        checker = MockCodeChecker()
        result = gb50010.check_element(checker, 'B1', {})
        # No elementData → no spacing metadata → only 2 groups (承载力 + 正常使用)
        assert len(result['checks']) == 2
        assert result['checks'][0]['name'] == '承载力验算'
        assert result['checks'][1]['name'] == '正常使用验算'

    def test_beam_with_spacing_metadata_has_construction_group(self):
        elem_data = {
            'type': 'beam',
            'section': {'width': 300, 'height': 500, 'A': 150000, 'Iy': 3.125e9},
            'material': {'fc': 14.3, 'fy': 360, 'E': 30000},
            'forces': {'N': 0, 'V': 100000, 'Mx': 50e6},
            'length': 6000,
            'bar_count': 3, 'sn': 40, 'main_dia': 20,
            'As': 628, 'Asv': 101, 'stirrup_dia': 8, 'stirrup_spacing': 200, 'cover': 20, 'crack_cover': 25,
        }
        context = {'elementData': {'B1': elem_data}}
        checker = MockCodeChecker()
        result = gb50010.check_element(checker, 'B1', context)
        assert len(result['checks']) == 3

    def test_bearing_capacity_group(self):
        checker = MockCodeChecker()
        result = gb50010.check_element(checker, 'B1', {})
        group1 = result['checks'][0]
        assert group1['name'] == '承载力验算'
        assert len(group1['items']) == 2

    def test_construction_group(self):
        elem_data = {
            'type': 'beam',
            'section': {'width': 300, 'height': 500, 'A': 150000, 'Iy': 3.125e9},
            'material': {'fc': 14.3, 'fy': 360, 'E': 30000},
            'forces': {'N': 0, 'V': 100000, 'Mx': 50e6},
            'length': 6000,
            'bar_count': 3, 'sn': 40, 'main_dia': 20,
            'As': 628, 'Asv': 101, 'stirrup_dia': 8, 'stirrup_spacing': 200, 'cover': 20, 'crack_cover': 25,
        }
        context = {'elementData': {'B1': elem_data}}
        checker = MockCodeChecker()
        result = gb50010.check_element(checker, 'B1', context)
        group2 = result['checks'][1]
        assert group2['name'] == '构造验算'
        assert len(group2['items']) == 1
        assert group2['items'][0]['item'] == '钢筋净距'

    def test_serviceability_group(self):
        checker = MockCodeChecker()
        result = gb50010.check_element(checker, 'B1', {})
        # no elementData → 2 groups → serviceability at index [1]
        group2 = result['checks'][1]
        assert group2['name'] == '正常使用验算'
        assert len(group2['items']) == 2


class TestClauseReferences:

    def test_flexure_clause(self):
        checker = MockCodeChecker()
        result = gb50010.check_element(checker, 'B1', {})
        items = result['checks'][0]['items']
        assert items[0]['clause'] == 'GB50010-2010 6.2.1'

    def test_shear_clause(self):
        checker = MockCodeChecker()
        result = gb50010.check_element(checker, 'B1', {})
        items = result['checks'][0]['items']
        assert items[1]['clause'] == 'GB50010-2010 6.3.1'

    def test_deflection_clause(self):
        checker = MockCodeChecker()
        result = gb50010.check_element(checker, 'B1', {})
        items = result['checks'][1]['items']  # no elementData → 2 groups
        assert items[0]['clause'] == 'GB50010-2010 3.3.2'

    def test_crack_clause(self):
        checker = MockCodeChecker()
        result = gb50010.check_element(checker, 'B1', {})
        items = result['checks'][1]['items']  # no elementData → 2 groups
        assert items[1]['clause'] == 'GB50010-2010 3.4.5'


class TestCheckElementResult:

    def test_element_type_beam(self):
        checker = MockCodeChecker()
        result = gb50010.check_element(checker, 'B1', {})
        assert result['elementType'] == 'beam'

    def test_element_type_column_from_context(self):
        checker = MockCodeChecker()
        result = gb50010.check_element(checker, 'E1', {
            'elementContextById': {
                'E1': {
                    'type': 'column',
                    'section': {'id': '1', 'name': '400X400'},
                    'material': {
                        'id': '1', 'name': 'C30', 'grade': 'C30',
                        'category': 'concrete', 'fc': 14.3, 'ft': 1.43,
                        'ftk': 2.01, 'Ec': 30000, 'E': 30000,
                        'ecu': 0.0033, 'alpha1': 1.0, 'beta1': 0.80,
                    },
                    'concreteGrade': 'C30',
                    'rebarGrade': 'HRB400',
                },
            },
        })
        assert result['elementType'] == 'column'
        assert result['checks'][0]['name'] == '柱承载力验算'
        assert result['checks'][0]['items'][0]['item'] == '轴压比'
        assert result['elementContext']['concreteGrade'] == 'C30'
        assert result['elementContext']['rebarGrade'] == 'HRB400'

    def test_element_type_column_from_id_prefix(self):
        checker = MockCodeChecker()
        result = gb50010.check_element(checker, 'C1', {})
        assert result['elementType'] == 'column'

    def test_chapter_summaries_capture_controlling_failure(self):
        checker = MockCodeChecker(overrides={'C1': {'轴压比': 1.2}})
        result = gb50010.check_element(checker, 'C1', {})
        assert result['status'] == 'fail'
        assert result['chapterCount'] == 2
        assert result['chapters'][0]['status'] == 'fail'
        assert result['chapters'][0]['controllingClause'] == 'GB50010-2010 6.2.15'

    def test_chapter_summaries_treat_none_utilization_as_zero(self):
        summaries = gb50010._build_chapter_summaries([
            {
                'chapter': 'test',
                'items': [
                    {'status': 'pass', 'utilization': None, 'clause': 'ignored'},
                    {'status': 'pass', 'utilization': 0.6, 'clause': 'controls'},
                ],
            },
        ])

        assert summaries[0]['maxUtilization'] == 0.6
        assert summaries[0]['controllingClause'] == 'controls'

    def test_code_version(self):
        checker = MockCodeChecker()
        result = gb50010.check_element(checker, 'B1', {})
        assert result['code'] == 'GB50010-2010'

    def test_all_pass_default(self):
        checker = MockCodeChecker()
        result = gb50010.check_element(checker, 'B1', {})
        assert result['status'] == 'pass'

    def test_fail_with_high_utilization(self):
        checker = MockCodeChecker(overrides={'B1': {'正截面受弯': 1.5}})
        result = gb50010.check_element(checker, 'B1', {})
        assert result['status'] == 'fail'

    def test_element_id_echoed(self):
        checker = MockCodeChecker()
        result = gb50010.check_element(checker, 'E5', {})
        assert result['elementId'] == 'E5'


class TestComputedUtilizationOverrides:
    """Integration tests: verify _compute_utilization_overrides produces real
    utilization values from elementData (mirrors gb50017 paradigm)."""

    def _make_concrete_element_data(self, **overrides):
        """Build elementData dict for a rectangular concrete element."""
        base = {
            'type': 'beam',
            'section': {
                'width': 300, 'height': 500, 'A': 150000, 'Iy': 3.125e9,
                'shape': {'kind': 'rectangular', 'B': 0.3, 'H': 0.5},
            },
            'material': {'fc': 14.3, 'fy': 360, 'E': 30000, 'nu': 0.2, 'rho': 2500},
            'forces': {'N': 0, 'V': 100000, 'Mx': 50e6},
            'length': 6000,
            # Rebar design — from model element metadata
            'As': 628,         # 2Φ20
            'Asv': 101,        # 2-leg Φ8
            'stirrup_dia': 8,
            'stirrup_spacing': 200,
            'main_dia': 20,
            'cover': 20,
            'crack_cover': 25,
        }
        base.update(overrides)
        return base

    def _make_context(self, elem_data, concrete_grade='C30', rebar_grade='HRB400', elem_type='beam'):
        return {
            'elementData': {'B1': elem_data},
            'elementContextById': {
                'B1': {
                    'type': elem_type,
                    'concreteGrade': concrete_grade,
                    'rebarGrade': rebar_grade,
                    'section': {'id': '1', 'name': '300X500'},
                    'material': {'id': '1', 'grade': 'C30', 'category': 'concrete'},
                },
            },
        }

    def test_beam_flexure_computes_real_value(self):
        """正截面受弯: elementData with real Mx → computed utilization."""
        elem_data = self._make_concrete_element_data()
        context = self._make_context(elem_data)
        computed = gb50010._compute_utilization_overrides('B1', context)
        assert '正截面受弯' in computed
        assert isinstance(computed['正截面受弯'], float)
        assert computed['正截面受弯'] > 0

    def test_beam_shear_computes_real_value(self):
        """斜截面受剪: V=100kN on 300×500 beam → realistic utilization."""
        elem_data = self._make_concrete_element_data(forces={'N': 0, 'V': 100000, 'Mx': 50e6})
        context = self._make_context(elem_data)
        computed = gb50010._compute_utilization_overrides('B1', context)
        assert '斜截面受剪' in computed
        assert isinstance(computed['斜截面受剪'], float)
        assert computed['斜截面受剪'] > 0

    def test_column_axial_ratio_from_element_data(self):
        """轴压比: N=1000kN, 400×400 C30 column → computed ratio."""
        elem_data = self._make_concrete_element_data(
            type='column',
            section={'width': 400, 'height': 400, 'A': 160000, 'Iy': 2.133e9,
                     'shape': {'kind': 'rectangular', 'B': 0.4, 'H': 0.4}},
            forces={'N': 1000000, 'V': 0, 'Mx': 0},
        )
        context = self._make_context(elem_data, elem_type='column')
        computed = gb50010._compute_utilization_overrides('B1', context)
        assert '轴压比' in computed
        assert isinstance(computed['轴压比'], float)
        # N=1000kN, fc=14.3, A=160000mm² → 1000*1000/(14.3*160000) ≈ 0.437
        assert 0.3 < computed['轴压比'] < 0.7

    def test_column_slenderness_computes_from_geometry(self):
        """长细比: l=3600mm, 400×400 section → λ computation."""
        elem_data = self._make_concrete_element_data(
            type='column',
            section={'width': 400, 'height': 400, 'A': 160000, 'Iy': 2.133e9,
                     'shape': {'kind': 'rectangular', 'B': 0.4, 'H': 0.4}},
            forces={'N': 1000000, 'V': 0, 'Mx': 0},
            length=3600,
        )
        context = self._make_context(elem_data, elem_type='column')
        computed = gb50010._compute_utilization_overrides('B1', context)
        assert '长细比' in computed
        assert isinstance(computed['长细比'], float)
        assert computed['长细比'] > 0

    def test_empty_element_data_returns_empty_dict(self):
        """No elementData → no computed overrides — graceful fallback."""
        computed = gb50010._compute_utilization_overrides('B1', {})
        assert computed == {}

    def test_missing_element_id_returns_empty_dict(self):
        """elementData exists but element ID not found → safe return."""
        context = {'elementData': {'OTHER': {'type': 'beam'}}}
        computed = gb50010._compute_utilization_overrides('B1', context)
        assert computed == {}

    def test_material_fallback_from_element_data_when_no_context_grades(self):
        """When elementContextById has no grades, fall back to elementData.material."""
        elem_data = self._make_concrete_element_data(
            material={'fc': 14.3, 'fy': 360, 'E': 30000},
        )
        context = {
            'elementData': {'B1': elem_data},
            'elementContextById': {},
        }
        computed = gb50010._compute_utilization_overrides('B1', context)
        assert '正截面受弯' in computed

    def test_beam_deflection_uses_element_data(self):
        """挠度: Mx + length + section → simplified deflection ratio."""
        elem_data = self._make_concrete_element_data(
            forces={'N': 0, 'V': 50000, 'Mx': 30e6},
            length=6000,
        )
        context = self._make_context(elem_data)
        computed = gb50010._compute_utilization_overrides('B1', context)
        assert '挠度' in computed
        assert isinstance(computed['挠度'], float)
        assert computed['挠度'] > 0

    def test_eccentric_compression_with_moment(self):
        """偏心受压: N + Mx → N-M interaction utilization."""
        elem_data = self._make_concrete_element_data(
            type='column',
            section={'width': 400, 'height': 400, 'A': 160000, 'Iy': 2.133e9,
                     'shape': {'kind': 'rectangular', 'B': 0.4, 'H': 0.4}},
            forces={'N': 800000, 'V': 50000, 'Mx': 80e6},
            length=3600,
        )
        context = self._make_context(elem_data, elem_type='column')
        computed = gb50010._compute_utilization_overrides('B1', context)
        assert '偏心受压' in computed
        assert isinstance(computed['偏心受压'], float)
        assert computed['偏心受压'] > 0

    def test_check_element_uses_real_values_via_merged_context(self):
        """End-to-end: check_element with elementData → real utilization
        flows through _calc_item instead of mock 0.55 default."""
        elem_data = self._make_concrete_element_data(
            forces={'N': 0, 'V': 100000, 'Mx': 50e6},
        )
        context = self._make_context(elem_data)
        checker = MockCodeChecker()
        result = gb50010.check_element(checker, 'B1', context)

        assert result['elementType'] == 'beam'
        assert result['code'] == 'GB50010-2010'

        # Find 正截面受弯 item — should have real computed utilization, not mock 0.55
        flexure_item = result['checks'][0]['items'][0]
        assert flexure_item['item'] == '正截面受弯'
        # Real utilization should differ from the 0.55 mock default
        assert flexure_item['utilization'] != 0.55
        assert flexure_item['utilization'] > 0

    def test_crack_width_computes_real_value(self):
        """裂缝宽度: Mx+geometry → ω_max/w_lim  utilization."""
        elem_data = self._make_concrete_element_data(
            section={'width': 300, 'height': 500, 'A': 150000, 'Iy': 3.125e9,
                     'shape': {'kind': 'rectangular', 'B': 0.3, 'H': 0.5}},
            material={'fc': 14.3, 'ft': 1.43, 'ftk': 2.01, 'Ec': 30000, 'E': 30000,
                      'Es': 200000, 'ecu': 0.0033, 'alpha1': 1.0, 'beta1': 0.80},
            forces={'N': 0, 'V': 50000, 'Mx': 40e6},
            length=6000,
        )
        context = self._make_context(elem_data)
        computed = gb50010._compute_utilization_overrides('B1', context)
        assert '裂缝宽度' in computed
        assert isinstance(computed['裂缝宽度'], float)
        assert computed['裂缝宽度'] > 0

    def test_material_design_values_from_element_data(self):
        """When elementData has full concrete design values (ft/ftk/Ec/alpha1/
        beta1/ecu), _resolve_material_props uses them directly — not lookup."""
        elem_data = self._make_concrete_element_data(
            material={
                'fc': 23.1, 'ft': 1.89, 'ftk': 2.64, 'Ec': 34500, 'E': 34500,
                'ecu': 0.0033, 'alpha1': 0.98, 'beta1': 0.78,
            },
        )
        mat = gb50010._resolve_material_props('C30', 'HRB400', elem_data)
        # C50 design values from elementData — NOT C30 fallback
        assert mat['fc'] == 23.1
        assert mat['ft'] == 1.89
        assert mat['ftk'] == 2.64
        assert mat['alpha1'] == 0.98
        assert mat['beta1'] == 0.78

    def test_material_falls_back_when_element_data_incomplete(self):
        """When elementData has only fc, fall back to lookup table for others."""
        elem_data = self._make_concrete_element_data(
            material={'fc': 14.3},  # only fc, no ft/ftk/etc.
        )
        mat = gb50010._resolve_material_props('C30', 'HRB400', elem_data)
        assert mat['fc'] == 14.3  # from elementData
        assert mat['ft'] == 1.43  # from C30 lookup
        assert mat['ftk'] == 2.01  # from C30 lookup
        assert mat['alpha1'] == 1.0  # from C30 lookup

    def test_beam_rebar_spacing_from_element_data(self):
        """钢筋净距(beam): sn=40mm with main_dia=20 → limit=max(30,30)=30 → util=30/40=0.75."""
        elem_data = self._make_concrete_element_data(
            bar_count=3, sn=40, main_dia=20,
        )
        context = self._make_context(elem_data)
        computed = gb50010._compute_utilization_overrides('B1', context)
        assert '钢筋净距' in computed
        assert isinstance(computed['钢筋净距'], float)
        # sn_limit = max(1.5*20, 30) = 30, sn=40 → util = 30/40 = 0.75
        assert computed['钢筋净距'] == pytest.approx(0.75, rel=0.01)

    def test_beam_rebar_spacing_violation(self):
        """钢筋净距(beam): sn=15mm with main_dia=20 → limit=30 → util=30/15=2.0 (fail)."""
        elem_data = self._make_concrete_element_data(
            bar_count=4, sn=15, main_dia=20,
        )
        context = self._make_context(elem_data)
        computed = gb50010._compute_utilization_overrides('B1', context)
        assert '钢筋净距' in computed
        assert computed['钢筋净距'] > 1.0

    def test_column_rebar_spacing_from_element_data(self):
        """钢筋净距(column): sn=60mm with main_dia=20 → limit=max(30,50)=50 → util=50/60≈0.833."""
        elem_data = self._make_concrete_element_data(
            type='column', bar_count=8, sn=60, main_dia=20,
        )
        context = self._make_context(elem_data, elem_type='column')
        computed = gb50010._compute_utilization_overrides('B1', context)
        assert '钢筋净距' in computed
        assert isinstance(computed['钢筋净距'], float)
        # sn_limit = max(1.5*20, 50) = 50, sn=60 → util = 50/60 ≈ 0.833
        assert computed['钢筋净距'] == pytest.approx(0.833, rel=0.01)

    def test_column_rebar_spacing_violation(self):
        """钢筋净距(column): sn=40mm with main_dia=20 → limit=50 → util=50/40=1.25."""
        elem_data = self._make_concrete_element_data(
            type='column', bar_count=6, sn=40, main_dia=20,
        )
        context = self._make_context(elem_data, elem_type='column')
        computed = gb50010._compute_utilization_overrides('B1', context)
        assert '钢筋净距' in computed
        assert computed['钢筋净距'] > 1.0

    def test_rebar_spacing_skips_when_no_bar_count(self):
        """No bar_count → 钢筋净距 not computed."""
        elem_data = self._make_concrete_element_data(bar_count=None, sn=40, main_dia=20)
        context = self._make_context(elem_data)
        computed = gb50010._compute_utilization_overrides('B1', context)
        assert '钢筋净距' not in computed

    def test_rebar_spacing_fails_on_zero_or_negative_sn(self):
        """sn=0 with bar_count>1 → utilization=99.0 (physically impossible layout)."""
        elem_data = self._make_concrete_element_data(
            bar_count=3, sn=0, main_dia=20,
        )
        context = self._make_context(elem_data)
        computed = gb50010._compute_utilization_overrides('B1', context)
        assert '钢筋净距' in computed
        assert computed['钢筋净距'] == 99.0


if __name__ == '__main__':
    pytest.main([__file__, '-v'])
