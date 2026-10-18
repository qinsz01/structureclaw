"""Unit tests for GB50017-2017 钢结构构件校核模块。

可直接运行: python -m pytest backend/src/agent-skills/code-check/gb50017/__tests__/test_code_check.py
或: python backend/src/agent-skills/code-check/gb50017/__tests__/test_code_check.py
"""
from __future__ import annotations

import sys
from pathlib import Path
from typing import Any, Dict, List

import pytest

import importlib.util
_spec = importlib.util.spec_from_file_location('gb50017_checks', Path(__file__).resolve().parent.parent / 'code_check.py')
gb50017 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(gb50017)

_generic_spec = importlib.util.spec_from_file_location('actual_code_checker', Path(__file__).resolve().parent.parent.parent / 'code_check.py')
_generic_module = importlib.util.module_from_spec(_generic_spec)
_generic_spec.loader.exec_module(_generic_module)


class MockCodeChecker(_generic_module.CodeChecker):
    """Exercise the production aggregation; only explicit test overrides are injected."""
    def __init__(self, overrides=None):
        super().__init__('GB50017')
        self._overrides = overrides or {}

    def _resolve_utilization(self, elem_id, item_name, context):
        supplied = self._overrides.get(elem_id, {})
        if item_name in supplied:
            return super()._resolve_utilization(elem_id, item_name, {'utilizationByElement': self._overrides})
        return super()._resolve_utilization(elem_id, item_name, context)


def _make_beam_element_data(**overrides) -> Dict[str, Any]:
    """Create a default beam elementData entry."""
    return {
        **{
            'type': 'beam',
            'section': {'A': 5000.0, 'Wnx': 200000.0, 'Wx': 200000.0, 'i': 50.0,
                        'I': 1e7, 'S': 100000.0, 'tw': 8.0, 'As': 2000.0},
            'material': {'f': 215.0, 'fv': 125.0, 'fy': 235.0},
            'forces': {'N': 50000.0, 'V': 30000.0, 'Mx': 30000000.0},
            'length': 6000.0,
            'phi': 0.85, 'beta1': 1.0,
        },
        **overrides,
    }


def _make_column_element_data(**overrides) -> Dict[str, Any]:
    return {
        **{
            'type': 'column',
            'section': {'A': 8000.0, 'imin': 40.0, 'i': 40.0, 'b': 200.0, 't': 12.0},
            'material': {'f': 215.0, 'fv': 125.0},
            'forces': {'N': 800000.0, 'V': 10000.0},
            'length': 4000.0,
            'phi': 0.75,
            'btLimit': 15.0,
            'lambdaLimit': 150.0,
        },
        **overrides,
    }


# ===========================================================================
# Tests
# ===========================================================================


class TestGetRules:
    def test_returns_correct_code_and_version(self):
        rules = gb50017.get_rules()
        assert rules['code'] == 'GB50017'
        assert rules['version'] == 'v2-member-checks'

    def test_rules_array_non_empty(self):
        rules = gb50017.get_rules()
        assert len(rules['rules']) >= 3

    def test_contains_expected_check_categories(self):
        rules = gb50017.get_rules()
        names = [r['name'] for r in rules['rules']]
        assert '强度验算' in names
        assert '稳定验算' in names
        assert '刚度验算' in names

    def test_strength_checks_include_normal_shear_equivalent(self):
        rules = gb50017.get_rules()
        strength = next(r for r in rules['rules'] if r['name'] == '强度验算')
        items = [c['item'] for c in strength['checks']]
        assert '正应力' in items
        assert '剪应力' in items
        assert '折算应力' in items

    def test_stability_checks_include_overall_local_axial(self):
        rules = gb50017.get_rules()
        stability = next(r for r in rules['rules'] if r['name'] == '稳定验算')
        items = [c['item'] for c in stability['checks']]
        assert '整体稳定' in items
        assert '轴压稳定' in items
        assert '局部稳定' in items

    def test_stiffness_checks_include_slenderness_deflection(self):
        rules = gb50017.get_rules()
        stiffness = next(r for r in rules['rules'] if r['name'] == '刚度验算')
        items = [c['item'] for c in stiffness['checks']]
        assert '长细比' in items
        assert '挠度' in items


class TestResolveElementType:
    def test_beam_from_context(self):
        ctx = {'elementData': {'B1': {'type': 'beam'}}}
        assert gb50017._resolve_element_type('B1', ctx) == 'beam'

    def test_column_from_context(self):
        ctx = {'elementData': {'C1': {'type': 'column'}}}
        assert gb50017._resolve_element_type('C1', ctx) == 'column'

    def test_brace_from_context(self):
        ctx = {'elementData': {'X1': {'type': 'brace'}}}
        assert gb50017._resolve_element_type('X1', ctx) == 'brace'

    def test_column_from_naming_heuristic_col(self):
        assert gb50017._resolve_element_type('C1-col', {}) == 'column'

    def test_column_from_naming_heuristic_C_prefix(self):
        # 'C' alone doesn't contain 'col', falls to default beam
        assert gb50017._resolve_element_type('C-1', {}) == 'beam'
        # But 'col' in name works
        assert gb50017._resolve_element_type('C-col-1', {}) == 'column'

    def test_brace_from_naming_heuristic_brace_in_name(self):
        assert gb50017._resolve_element_type('X1-brace-1', {}) == 'brace'

    def test_brace_from_naming_heuristic_br_prefix(self):
        # 'br-1' does not contain 'brace', falls to beam
        assert gb50017._resolve_element_type('br-1', {}) == 'beam'

    def test_default_beam_when_no_data(self):
        assert gb50017._resolve_element_type('B1', {}) == 'beam'

    def test_default_beam_when_empty_element_data(self):
        assert gb50017._resolve_element_type('B1', {'elementData': {}}) == 'beam'


class TestComputeUtilizationOverrides:
    """Tests for _compute_utilization_overrides (returns new dict, no mutation)."""

    def test_computes_normal_stress_with_bending(self):
        ctx: Dict[str, Any] = {
            'elementData': {'E1': _make_beam_element_data()},
        }
        result = gb50017._compute_utilization_overrides('E1', ctx)
        # N=50000, A=5000 -> sigma_axial=10, Mx=3e7, Wnx=2e5 -> sigma_bending=150
        # utilization = (10 + 150) / 215 ≈ 0.744
        assert '正应力' in result
        expected = (50000.0 / 5000.0 + 30000000.0 / 200000.0) / 215.0
        assert result['正应力'] == pytest.approx(expected, abs=0.001)

    def test_computes_normal_stress_axial_only(self):
        ctx: Dict[str, Any] = {
            'elementData': {'E1': {
                'section': {'A': 5000.0},
                'material': {'f': 215.0},
                'forces': {'N': 50000.0, 'Mx': 0.0},
            }},
        }
        result = gb50017._compute_utilization_overrides('E1', ctx)
        assert result['正应力'] == pytest.approx(50000.0 / 5000.0 / 215.0, abs=0.001)

    def test_computes_shear_stress_with_S_I_tw(self):
        ctx: Dict[str, Any] = {
            'elementData': {'E1': _make_beam_element_data()},
        }
        result = gb50017._compute_utilization_overrides('E1', ctx)
        # V=30000, S=100000, I=1e7, tw=8 -> tau = 30000*100000/(1e7*8) = 37.5
        # fv=125 -> 37.5/125 = 0.3
        assert '剪应力' in result
        expected = 30000.0 * 100000.0 / (1e7 * 8.0) / 125.0
        assert result['剪应力'] == pytest.approx(expected, abs=0.001)

    def test_computes_shear_stress_with_As_fallback(self):
        ctx: Dict[str, Any] = {
            'elementData': {'E1': {
                'section': {'A': 5000.0, 'As': 2000.0},
                'material': {'fv': 125.0},
                'forces': {'V': 30000.0, 'N': 50000.0},
            }},
        }
        result = gb50017._compute_utilization_overrides('E1', ctx)
        assert '剪应力' in result
        expected = 30000.0 / 2000.0 / 125.0
        assert result['剪应力'] == pytest.approx(expected, abs=0.001)

    def test_computes_equivalent_stress_includes_bending(self):
        ctx: Dict[str, Any] = {
            'elementData': {'E1': _make_beam_element_data()},
        }
        result = gb50017._compute_utilization_overrides('E1', ctx)
        assert '折算应力' in result
        sigma_axial = 50000.0 / 5000.0  # 10
        sigma_bending = 30000000.0 / 200000.0  # 150
        tau = 30000.0 * 100000.0 / (1e7 * 8.0)  # 37.5
        expected = (sigma_axial ** 2 + sigma_bending ** 2
                    - sigma_axial * sigma_bending + 3 * tau ** 2) ** 0.5 / 215.0
        assert result['折算应力'] == pytest.approx(expected, abs=0.001)

    def test_computes_overall_stability(self):
        ctx: Dict[str, Any] = {
            'elementData': {'E1': _make_beam_element_data()},
        }
        result = gb50017._compute_utilization_overrides('E1', ctx)
        assert '整体稳定' in result
        assert result['整体稳定'] == pytest.approx(
            30000000.0 / (0.85 * 200000.0 * 215.0), abs=0.001
        )

    def test_computes_axial_compression_stability(self):
        ctx: Dict[str, Any] = {
            'elementData': {'C1': _make_column_element_data()},
        }
        result = gb50017._compute_utilization_overrides('C1', ctx)
        assert '轴压稳定' in result
        assert result['轴压稳定'] == pytest.approx(
            800000.0 / (0.75 * 8000.0 * 215.0), abs=0.001
        )

    def test_caller_override_not_overwritten(self):
        ctx: Dict[str, Any] = {
            'elementData': {'E1': _make_beam_element_data()},
            'utilizationByElement': {'E1': {'正应力': 0.73}},
        }
        result = gb50017._compute_utilization_overrides('E1', ctx)
        # Function returns computed values only; caller override is in ctx, not in result
        assert '正应力' not in result  # skipped because already in per_elem

    def test_no_computation_when_no_element_data(self):
        ctx: Dict[str, Any] = {}
        result = gb50017._compute_utilization_overrides('E1', ctx)
        assert result == {}

    def test_partial_data_computes_available_checks(self):
        ctx: Dict[str, Any] = {
            'elementData': {'E1': {
                'section': {'A': 5000.0},
                'material': {'f': 215.0},
                'forces': {'N': 50000.0, 'Mx': 0.0},
            }},
        }
        result = gb50017._compute_utilization_overrides('E1', ctx)
        assert '正应力' in result
        assert '剪应力' not in result

    def test_computes_slenderness(self):
        ctx: Dict[str, Any] = {
            'elementData': {'C1': _make_column_element_data(l0=4000.0)},
        }
        result = gb50017._compute_utilization_overrides('C1', ctx)
        assert '长细比' in result
        assert result['长细比'] == pytest.approx(4000.0 / 40.0 / 150.0, abs=0.001)

    def test_computes_deflection_only_when_limit_provided(self):
        ctx: Dict[str, Any] = {
            'elementData': {'B1': {
                'section': {'A': 5000.0},
                'material': {'f': 215.0},
                'forces': {'N': 0, 'deflection': 12.0},
                'length': 6000.0,
                'deflectionLimitN': 250,
            }},
        }
        result = gb50017._compute_utilization_overrides('B1', ctx)
        assert '挠度' in result
        assert result['挠度'] == pytest.approx(12.0 / (6000.0 / 250.0), abs=0.001)

    def test_no_deflection_without_explicit_limit(self):
        ctx: Dict[str, Any] = {
            'elementData': {'B1': {
                'section': {'A': 5000.0},
                'material': {'f': 215.0},
                'forces': {'N': 0, 'deflection': 12.0},
                'length': 6000.0,
                # no deflectionLimitN
            }},
        }
        result = gb50017._compute_utilization_overrides('B1', ctx)
        assert '挠度' not in result

    def test_computes_local_stability(self):
        ctx: Dict[str, Any] = {
            'elementData': {'C1': _make_column_element_data()},
        }
        result = gb50017._compute_utilization_overrides('C1', ctx)
        assert '局部稳定' in result
        assert result['局部稳定'] == pytest.approx(200.0 / 12.0 / 15.0, abs=0.001)

    def test_zero_area_does_not_crash(self):
        ctx: Dict[str, Any] = {
            'elementData': {'E1': {
                'section': {'A': 0.0},
                'material': {'f': 215.0},
                'forces': {'N': 50000.0, 'V': 30000.0},
            }},
        }
        result = gb50017._compute_utilization_overrides('E1', ctx)
        assert '正应力' not in result

    def test_does_not_mutate_context(self):
        ctx: Dict[str, Any] = {
            'elementData': {'E1': _make_beam_element_data()},
        }
        original_keys = set(ctx.keys())
        gb50017._compute_utilization_overrides('E1', ctx)
        assert set(ctx.keys()) == original_keys
        assert 'utilizationByElement' not in ctx


class TestCheckElementBeam:
    def test_beam_has_strength_checks(self):
        checker = MockCodeChecker()
        ctx = {'elementData': {'B1': _make_beam_element_data()}}
        result = gb50017.check_element(checker, 'B1', ctx)
        strength = next(c for c in result['checks'] if c['name'] == '强度验算')
        items = [i['item'] for i in strength['items']]
        assert '正应力' in items
        assert '剪应力' in items
        assert '折算应力' in items

    def test_beam_has_stability_checks(self):
        checker = MockCodeChecker()
        ctx = {'elementData': {'B1': _make_beam_element_data()}}
        result = gb50017.check_element(checker, 'B1', ctx)
        stability = next(c for c in result['checks'] if c['name'] == '稳定验算')
        items = [i['item'] for i in stability['items']]
        assert '整体稳定' in items
        assert '局部稳定' in items

    def test_beam_has_deflection_check(self):
        checker = MockCodeChecker()
        ctx = {'elementData': {'B1': _make_beam_element_data()}}
        result = gb50017.check_element(checker, 'B1', ctx)
        stiffness = next(c for c in result['checks'] if c['name'] == '刚度验算')
        items = [i['item'] for i in stiffness['items']]
        assert '挠度' in items

    def test_beam_element_type_in_result(self):
        checker = MockCodeChecker()
        ctx = {'elementData': {'B1': _make_beam_element_data()}}
        result = gb50017.check_element(checker, 'B1', ctx)
        assert result['elementType'] == 'beam'
        assert result['code'] == 'GB50017-2017'

    def test_beam_computed_utilization_includes_bending(self):
        checker = MockCodeChecker()
        ctx = {'elementData': {'B1': _make_beam_element_data()}}
        result = gb50017.check_element(checker, 'B1', ctx)
        strength = next(c for c in result['checks'] if c['name'] == '强度验算')
        normal = next(i for i in strength['items'] if i['item'] == '正应力')
        expected = (50000.0 / 5000.0 + 30000000.0 / 200000.0) / 215.0
        assert normal['utilization'] == pytest.approx(expected, abs=0.001)


class TestCheckElementColumn:
    def test_column_has_axial_compression_stability(self):
        checker = MockCodeChecker()
        ctx = {'elementData': {'C1': _make_column_element_data()}}
        result = gb50017.check_element(checker, 'C1', ctx)
        stability = next(c for c in result['checks'] if c['name'] == '稳定验算')
        items = [i['item'] for i in stability['items']]
        assert '轴压稳定' in items

    def test_column_has_slenderness(self):
        checker = MockCodeChecker()
        ctx = {'elementData': {'C1': _make_column_element_data()}}
        result = gb50017.check_element(checker, 'C1', ctx)
        stiffness = next(c for c in result['checks'] if c['name'] == '刚度验算')
        items = [i['item'] for i in stiffness['items']]
        assert '长细比' in items

    def test_column_element_type_in_result(self):
        checker = MockCodeChecker()
        ctx = {'elementData': {'C1': _make_column_element_data()}}
        result = gb50017.check_element(checker, 'C1', ctx)
        assert result['elementType'] == 'column'

    def test_column_no_beam_overall_stability(self):
        checker = MockCodeChecker()
        ctx = {'elementData': {'C1': _make_column_element_data()}}
        result = gb50017.check_element(checker, 'C1', ctx)
        stability = next(c for c in result['checks'] if c['name'] == '稳定验算')
        items = [i['item'] for i in stability['items']]
        assert '整体稳定' not in items  # beam-only check


class TestCheckElementBrace:
    def test_brace_has_axial_strength(self):
        checker = MockCodeChecker()
        ctx = {'elementData': {'X1-brace-1': {'type': 'brace', 'section': {'A': 3000.0}, 'material': {'f': 215.0}, 'forces': {'N': 200000.0}}}}
        result = gb50017.check_element(checker, 'X1-brace-1', ctx)
        strength = next(c for c in result['checks'] if c['name'] == '强度验算')
        assert strength['items'][0]['item'] == '正应力'

    def test_brace_has_slenderness(self):
        checker = MockCodeChecker()
        ctx = {'elementData': {'X1-brace-1': {'type': 'brace', 'section': {'A': 3000.0, 'i': 30.0}, 'material': {'f': 215.0}, 'forces': {'N': 200000.0}, 'length': 5000.0, 'lambdaLimit': 200.0}}}
        result = gb50017.check_element(checker, 'X1-brace-1', ctx)
        stiffness = next(c for c in result['checks'] if c['name'] == '刚度验算')
        items = [i['item'] for i in stiffness['items']]
        assert '长细比' in items

    def test_brace_element_type_in_result(self):
        checker = MockCodeChecker()
        ctx = {'elementData': {'X1-brace-1': {'type': 'brace', 'section': {'A': 3000.0}, 'material': {'f': 215.0}, 'forces': {'N': 200000.0}}}}
        result = gb50017.check_element(checker, 'X1-brace-1', ctx)
        assert result['elementType'] == 'brace'


class TestBackwardCompatibility:
    def test_traceability_contract(self):
        """Replicates validate_code_check_traceability from analysis-runner.py."""
        checker = MockCodeChecker(overrides={'E1': {'正应力': 0.73}})
        ctx = {
            'analysisSummary': {'analysisType': 'static', 'success': True},
            'utilizationByElement': {'E1': {'正应力': 0.73}},
        }
        result = gb50017.check_element(checker, 'E1', ctx)

        assert result['code'] == 'GB50017-2017'
        item = result['checks'][0]['items'][0]
        assert item['clause'] == 'GB50017-2017 7.1.1'
        assert item['formula']
        assert item['inputs']['demand'] >= 0
        assert item['utilization'] >= 0

    def test_missing_element_data_requests_inputs(self):
        """Without elementData no engineering result is manufactured."""
        checker = MockCodeChecker()
        ctx = {'utilizationByElement': {}}
        result = gb50017.check_element(checker, 'E1', ctx)

        assert result['elementId'] == 'E1'
        assert result['status'] == 'input_required'
        all_items = [i for c in result['checks'] for i in c.get('items', [])]
        assert len(all_items) > 0
        for item in all_items:
            assert item['utilization'] is None
            # GB 50017-2017 sets no slenderness limit for flexural members.
            assert item['status'] == ('not_applicable' if item['item'] == '长细比' else 'input_required')

    def test_caller_override_priority(self):
        """When both elementData and utilizationByElement provide values, caller wins."""
        checker = MockCodeChecker()
        ctx = {
            'elementData': {'E1': _make_beam_element_data()},
            'utilizationByElement': {'E1': {'正应力': 0.90}},
        }
        result = gb50017.check_element(checker, 'E1', ctx)
        strength = next(c for c in result['checks'] if c['name'] == '强度验算')
        normal = next(i for i in strength['items'] if i['item'] == '正应力')
        assert normal['utilization'] == pytest.approx(0.90, abs=0.01)

    def test_first_check_is_strength_normal_stress(self):
        """First check group is 强度验算, first item is 正应力 — matches existing contract."""
        checker = MockCodeChecker()
        result = gb50017.check_element(checker, 'E1', {})
        assert result['checks'][0]['name'] == '强度验算'
        assert result['checks'][0]['items'][0]['item'] == '正应力'
        assert result['checks'][0]['items'][0]['clause'] == 'GB50017-2017 7.1.1'

    def test_context_not_mutated_by_check_element(self):
        """check_element should not mutate the original context."""
        checker = MockCodeChecker()
        ctx: Dict[str, Any] = {
            'elementData': {'E1': _make_beam_element_data()},
        }
        original_ctx = dict(ctx)
        gb50017.check_element(checker, 'E1', ctx)
        assert ctx == original_ctx


class TestClauseReferences:
    def test_beam_clauses_reference_gb50017_2017(self):
        checker = MockCodeChecker()
        ctx = {'elementData': {'B1': _make_beam_element_data()}}
        result = gb50017.check_element(checker, 'B1', ctx)
        all_items = [i for c in result['checks'] for i in c.get('items', [])]
        for item in all_items:
            assert item['clause'].startswith('GB50017-2017')

    def test_beam_strength_clause_7_1_1(self):
        checker = MockCodeChecker()
        ctx = {'elementData': {'B1': _make_beam_element_data()}}
        result = gb50017.check_element(checker, 'B1', ctx)
        normal = result['checks'][0]['items'][0]
        assert '7.1.1' in normal['clause']

    def test_column_axial_stability_clause_8_1_1(self):
        checker = MockCodeChecker()
        ctx = {'elementData': {'C1': _make_column_element_data()}}
        result = gb50017.check_element(checker, 'C1', ctx)
        stability = next(c for c in result['checks'] if c['name'] == '稳定验算')
        axial = next(i for i in stability['items'] if i['item'] == '轴压稳定')
        assert '8.1.1' in axial['clause']

    def test_column_slenderness_clause_10_1_1(self):
        checker = MockCodeChecker()
        ctx = {'elementData': {'C1': _make_column_element_data()}}
        result = gb50017.check_element(checker, 'C1', ctx)
        stiffness = next(c for c in result['checks'] if c['name'] == '刚度验算')
        slenderness = next(i for i in stiffness['items'] if i['item'] == '长细比')
        assert '10.1.1' in slenderness['clause']


class TestElementDataBridgeIntegration:
    """Verify elementData from TS bridge is consumable by gb50017 real formulas.

    Simulates the full flow: steel frame model + OpenSees-like analysis result
    → extractElementDataForCodeCheck() → gb50017._compute_utilization_overrides()
    → hand-verified utilization values.
    """

    def _bridge_like_2d_frame_element_data(self):
        """Simulate elementData as produced by extractElementDataForCodeCheck()
        for a simple 2D frame: 1 story, 1 bay, 3.6m height, 6m span.

        Column C1: HW300X300, Q355, N=500kN (axial only)
        Beam B2:  HN300X150, Q355, M=54kN·m (pure bending)
        """
        return {
            'C1': {
                'type': 'column',
                'section': {
                    'A': 11920.0,           # 0.01192 m² → mm²
                    'I': 204000000.0,       # Iy mm⁴
                    'Wx': 1360000.0,        # Wnx ≈ Iy/(H/2) = 2.04e8/150
                    'Wnx': 1360000.0,
                    'i': 130.8,
                    'S': 760000.0,
                    'tw': 10.0,
                    'As': 2820.0,
                    'G': 79000.0,
                    'shape': {'kind': 'H', 'H': 0.3, 'B': 0.3, 'tw': 0.010, 'tf': 0.015},
                },
                'material': {
                    'name': 'Q355',
                    'grade': 'Q355',
                    'category': 'steel',
                    'fy': 355.0,
                    'f': 295.0,             # design strength Q355 t≤16mm
                    'fv': 170.0,
                    'E': 206000.0,
                },
                'forces': {
                    'N': 500000.0,           # 500 kN → N (envelope: n1/n2 max abs)
                    'V': 12000.0,
                    'Mx': 35000000.0,        # 35 kN·m → N·mm
                },
                'length': 3600.0,            # 3.6m → mm
            },
            'B2': {
                'type': 'beam',
                'section': {
                    'A': 4870.0,             # 0.00487 m² → mm²
                    'I': 72100000.0,         # Iy mm⁴
                    'Wx': 480000.0,          # Wnx ≈ Iy/(H/2) = 7.21e7/150
                    'Wnx': 480000.0,
                    'i': 121.7,
                    'S': 286000.0,
                    'tw': 6.5,
                    'As': 1833.0,
                    'G': 79000.0,
                    'shape': {'kind': 'H', 'H': 0.3, 'B': 0.15, 'tw': 0.0065, 'tf': 0.009},
                },
                'material': {
                    'name': 'Q355',
                    'grade': 'Q355',
                    'category': 'steel',
                    'fy': 355.0,
                    'f': 295.0,
                    'fv': 170.0,
                    'E': 206000.0,
                },
                'forces': {
                    'N': 8000.0,
                    'V': 36000.0,
                    'Mx': 54000000.0,        # 54 kN·m → N·mm
                },
                'length': 6000.0,            # 6m → mm
            },
        }

    def test_column_axial_stress_matches_hand_calc(self):
        """C1: N=500kN, A=11920mm², Mx=35kN·m, Wnx=1.36e6mm³, f=295
        σ_axial=41.95, σ_bend=25.74, utilization=(41.95+25.74)/295≈0.2294"""
        ctx = {'elementData': self._bridge_like_2d_frame_element_data()}
        result = gb50017._compute_utilization_overrides('C1', ctx)

        assert '正应力' in result
        σ = 500000.0 / 11920.0 + 35000000.0 / 1360000.0  # 41.95 + 25.74
        expected = σ / 295.0
        assert result['正应力'] == pytest.approx(expected, abs=0.001)

    def test_column_not_using_hash_fallback(self):
        """The hash fallback produces 0.55~0.95 — our real value is ~0.23,
        proving gb50017 consumed elementData, not the fallback."""
        ctx = {'elementData': self._bridge_like_2d_frame_element_data()}
        result = gb50017._compute_utilization_overrides('C1', ctx)

        assert result['正应力'] < 0.5, (
            f"Expected real utilization ~0.23, got {result['正应力']}. "
            f"If 0.55~0.95, hash fallback was used instead of elementData."
        )

    def test_beam_bending_stress_matches_hand_calc(self):
        """B2: N=8kN, M=54kN·m, A=4870mm², Wnx=480000mm³, f=295
        σ_axial=1.64, σ_bend=112.5, utilization=(1.64+112.5)/295≈0.3869"""
        ctx = {'elementData': self._bridge_like_2d_frame_element_data()}
        result = gb50017._compute_utilization_overrides('B2', ctx)

        assert '正应力' in result
        σ = 8000.0 / 4870.0 + 54000000.0 / 480000.0  # 1.64 + 112.50
        expected = σ / 295.0
        assert result['正应力'] == pytest.approx(expected, abs=0.001)

    def test_beam_shear_stress_computed(self):
        """B2: V=36kN, S=286000mm³, I=7.21e7mm⁴, tw=6.5mm, fv=170
        τ = V*S/(I*tw) = 36000*286000/(7.21e7*6.5) ≈ 21.95, utilization≈0.129"""
        ctx = {'elementData': self._bridge_like_2d_frame_element_data()}
        result = gb50017._compute_utilization_overrides('B2', ctx)

        assert '剪应力' in result
        tau = 36000.0 * 286000.0 / (72100000.0 * 6.5)  # ≈ 21.95 N/mm²
        expected = tau / 170.0  # ≈ 0.1291
        assert result['剪应力'] == pytest.approx(expected, abs=0.001)

    def test_column_has_chapter_summary_in_full_check(self):
        """Full check_element flow should include chapter summaries."""
        checker = MockCodeChecker()
        ctx = {'elementData': self._bridge_like_2d_frame_element_data()}
        result = gb50017.check_element(checker, 'C1', ctx)

        assert result['elementType'] == 'column'
        assert 'chapters' in result
        assert any(c['chapter'] == '第7章 强度验算' for c in result['chapters'])


if __name__ == '__main__':
    pytest.main([__file__, '-v'])


class TestExplicitEffectiveLength:
    @pytest.mark.parametrize('segment_lengths', [[6000.0], [3000.0, 3000.0], [1500.0] * 4])
    def test_discretizing_one_physical_member_cannot_supply_effective_length(self, segment_lengths):
        # The bridge always supplies geometric length in mm. Refining a 6 m
        # member must not turn that geometry into an unconfirmed design l0.
        elements = {f'E{i}': _make_beam_element_data(
            length=length, lambdaLimit=150.0, requestedChecks=['slenderness'])
            for i, length in enumerate(segment_lengths)}
        result = _generic_module.CodeChecker('GB50017').check('same-physical-member', list(elements),
                                                               {'elementData': elements})
        assert result['completionStatus'] == 'incomplete'
        assert result['complianceStatus'] == 'incomplete'
        assert result['summary']['passed'] == 0
        assert result['summary']['inputRequired'] == len(elements)
        for detail in result['details']:
            item = next(item for group in detail['checks'] for item in group['items'] if item['item'] == '长细比')
            assert item['status'] == 'input_required'
            assert item['utilization'] is None
            assert item['governingEligible'] is False
            assert [row['field'] for row in item['missingInputs']] == ['member.design.l0']
            assert item['missingInputs'][0]['source'] == 'design'

    def test_explicit_effective_length_controls_check_instead_of_shorter_mesh_length(self):
        # Explicit l0=9 m, i=40 mm: lambda=225 > 150, regardless of mesh length.
        # Falling back to the 1.5 m cell would incorrectly report lambda=37.5.
        element = _make_column_element_data(length=1500.0, l0=9000.0, requestedChecks=['slenderness'])
        result = _generic_module.CodeChecker('GB50017').check('confirmed-effective-length', ['E'],
                                                               {'elementData': {'E': element}})
        item = next(item for group in result['details'][0]['checks'] for item in group['items']
                    if item['item'] == '长细比')
        assert item['status'] == 'fail'
        assert item['utilization'] == pytest.approx(1.5)
        assert item['inputs']['demand'] == pytest.approx(225.0)
        assert item['inputs']['capacity'] == pytest.approx(150.0)
        assert result['completionStatus'] == 'complete'
        assert result['complianceStatus'] == 'fail'
        assert element['length'] == 1500.0 and element['l0'] == 9000.0

    @pytest.mark.parametrize('invalid_l0', [0, -1, True, float('nan'), float('inf')])
    def test_invalid_effective_length_cannot_fall_back_to_valid_geometry(self, invalid_l0):
        context = {'elementData': {'E': _make_column_element_data(l0=invalid_l0)}}
        assert '长细比' not in gb50017._compute_utilization_overrides('E', context)
        missing = gb50017.missing_inputs('E', '长细比', context)
        assert [row['field'] for row in missing] == ['member.design.l0']
