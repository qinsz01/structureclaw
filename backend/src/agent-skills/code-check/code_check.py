"""规范校核统一入口。

各规范的具体校核实现位于对应 skill 子目录的 ``code_check.py`` 中。
"""

from __future__ import annotations

from functools import lru_cache
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from types import ModuleType
from typing import Dict, Any, List, Optional
import logging
import math
import sys

logger = logging.getLogger(__name__)

SHARED_PYTHON_DIR = Path(__file__).resolve().parents[2] / 'skill-shared' / 'python'
if SHARED_PYTHON_DIR.exists():
    shared_python_path = str(SHARED_PYTHON_DIR)
    if shared_python_path not in sys.path:
        sys.path.insert(0, shared_python_path)


@lru_cache(maxsize=None)
def _load_local_skill_module(relative_path: str) -> ModuleType:
    target = Path(__file__).resolve().parent / relative_path
    if not target.exists():
        raise ImportError(f"Skill module not found: {target}")

    module_name = "_code_check_skill_" + relative_path.replace("/", "_").replace(".", "_").replace("-", "_")
    spec = spec_from_file_location(module_name, target)
    if spec is None or spec.loader is None:
        raise ImportError(f"Unable to load spec for: {target}")

    module = module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@lru_cache(maxsize=None)
def _discover_code_skill_paths() -> Dict[str, str]:
    base_dir = Path(__file__).resolve().parent
    code_skill_paths: Dict[str, str] = {}

    for child in sorted(base_dir.iterdir(), key=lambda item: item.name):
        if not child.is_dir() or child.name.startswith('__'):
            continue

        skill_file = child / 'code_check.py'
        if not skill_file.exists():
            continue

        relative_path = f'{child.name}/code_check.py'
        module = _load_local_skill_module(relative_path)

        code: Optional[str] = None
        rule_loader = getattr(module, 'get_rules', None)
        if callable(rule_loader):
            loaded = rule_loader()
            if isinstance(loaded, dict) and isinstance(loaded.get('code'), str):
                code = loaded['code']

        if not code:
            code = child.name.upper()

        if code in code_skill_paths:
            raise RuntimeError(f'Duplicate code-check skill code discovered: {code}')

        code_skill_paths[code] = relative_path

    return code_skill_paths


class CodeChecker:
    """规范校核器"""

    def __init__(self, code: str):
        """
        初始化规范校核器

        Args:
            code: 规范代码，如 'GB50010'
        """
        self.code_skill_paths = _discover_code_skill_paths()
        self.supported_codes = sorted(self.code_skill_paths.keys())

        if code not in self.code_skill_paths:
            raise ValueError(f"不支持的规范: {code}。支持的规范: {self.supported_codes}")

        self.code = code
        self.skill_module = _load_local_skill_module(self.code_skill_paths[code])
        self.rules = self._load_rules(code)

    def check(self, model_id: str, elements: List[str], context: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """
        执行规范校核

        Args:
            model_id: 模型ID
            elements: 需要校核的单元ID列表
            context: 可选上下文（分析摘要、单元参数、覆盖利用率等）

        Returns:
            校核结果
        """
        logger.info(f"Starting code check for {len(elements)} elements using {self.code}")
        context = context or {}

        results = {
            'code': self.code,
            'status': 'success',
            'summary': {
                'total': 0,
                'passed': 0,
                'failed': 0,
                'warnings': 0,
                'notApplicable': 0,
                'inputRequired': 0,
                'unsupported': 0,
                'maxUtilization': None,
                'controllingElement': None,
                'controllingCheck': None,
            },
            'traceability': {
                'modelId': model_id,
                'ruleVersion': self.rules.get('version', 'latest'),
                'analysisSummary': context.get('analysisSummary', {}),
            },
            'details': []
        }

        for elem_id in elements:
            check_result = self._apply_requested_checks(elem_id, self._check_element(elem_id, context), context)
            results['details'].append(check_result)

            items = self._flatten_result_items(check_result)
            results['summary']['total'] += len(items)
            for item in items:
                bucket = self._summary_bucket(item)
                results['summary'][bucket] += 1

            controlling = check_result.get('controlling', {})
            if not isinstance(controlling, dict):
                controlling = {}
            utilization = self._item_utilization(controlling)
            if utilization is not None and (results['summary']['maxUtilization'] is None or utilization >= results['summary']['maxUtilization']):
                results['summary']['maxUtilization'] = utilization
                results['summary']['controllingElement'] = elem_id
                results['summary']['controllingCheck'] = controlling.get('item')

        summary = results['summary']
        incomplete = summary['inputRequired'] + summary['unsupported'] + summary['warnings']
        incomplete += sum(item.get('unresolvedForceStateCount', 0) for detail in results['details'] for item in self._flatten_result_items(detail))
        results['completionStatus'] = 'incomplete' if incomplete or not elements else 'complete'
        results['complianceStatus'] = (
            'fail' if summary['failed'] else 'incomplete' if incomplete or not elements
            else 'pass' if summary['passed'] else 'not_applicable'
        )
        scopes = {row['elementId']: row['checkScope'] for row in results['details'] if 'checkScope' in row}
        if scopes:
            results['checkScope'] = {'mode': 'selected', 'limited': any(scope['omittedChecks'] for scope in scopes.values()), 'elements': scopes}
        return results

    def _apply_requested_checks(self, elem_id: str, result: Dict[str, Any], context: Dict[str, Any]) -> Dict[str, Any]:
        element = context.get('elementData', {}).get(elem_id, {})
        requested = element.get('requestedChecks') if isinstance(element, dict) else None
        if requested is None:
            return result
        available = {item.get('item') for item in self._flatten_result_items(result)}
        aliases = self.rules.get('checkIds', {})
        valid_list = isinstance(requested, list) and bool(requested) and all(isinstance(item, str) and item.strip() for item in requested)
        names = [aliases.get(item.strip(), item.strip()) for item in requested] if valid_list else []
        if not names or any(name not in available for name in names):
            return self._build_element_result(elem_id, result.get('elementType', ''), [{
                'name': '校核范围 / Check scope', 'items': [{
                    'item': '校核范围 / Check scope', 'status': 'input_required', 'category': 'input_required',
                    'utilization': None, 'governingEligible': False,
                    'missingInputs': [{'field': 'member.design.requested_checks', 'label': '明确的适用校核项 / Explicit applicable checks', 'unit': 'check IDs', 'source': 'design', 'choices': sorted(name for name in available if isinstance(name, str))}],
                    'availableChecks': sorted(name for name in available if isinstance(name, str)),
                    'message': 'Requested checks must be a nonempty list of applicable check IDs or names / 所选校核须为非空且适用于该构件的检查项列表。',
                }],
            }], result.get('code', self.code))
        selected = set(names)
        omitted = sorted(name for name in available if name not in selected)
        checks = [{**group, 'items': [item if item.get('item') in selected else {
            'item': item.get('item'), 'clause': item.get('clause'), 'formula': item.get('formula'),
            'status': 'not_applicable', 'category': 'not_applicable', 'scopeReason': 'not_requested',
            'utilization': None, 'governingEligible': False,
            'message': 'Outside the explicitly requested checks; no compliance conclusion for this item / 该项不在用户明确选择的校核范围内，不代表该项通过。',
        } for item in group.get('items', [])]} for group in result.get('checks', [])]
        scoped = {**result, **self._build_element_result(elem_id, result.get('elementType', ''), checks, result.get('code', self.code)),
                  'checkScope': {'requestedChecks': list(dict.fromkeys(names)), 'omittedChecks': omitted}}
        if 'chapters' in scoped:
            scoped['chapters'] = self._build_chapter_summaries(scoped['checks'])
        return scoped

    @staticmethod
    def _flatten_result_items(check_result: Dict[str, Any]) -> List[Dict[str, Any]]:
        checks = check_result.get('checks')
        if not isinstance(checks, list):
            return [check_result]

        items_for_summary: List[Dict[str, Any]] = []
        for check in checks:
            if not isinstance(check, dict):
                continue
            items = check.get('items')
            if not isinstance(items, list):
                continue
            for item in items:
                if not isinstance(item, dict):
                    continue
                items_for_summary.append(item)

        return items_for_summary or [check_result]

    @staticmethod
    def _summary_bucket(item: Dict[str, Any]) -> str:
        status = str(item.get('status', '')).strip().lower()
        category = str(item.get('category', '')).strip().lower()
        if status == 'input_required' or category == 'input_required':
            return 'inputRequired'
        if status in {'unsupported', 'not_implemented'} or category == 'unsupported':
            return 'unsupported'
        if status in {'pass', 'passed'}:
            return 'passed'
        if status in {'not_applicable', 'not-applicable', 'n/a'}:
            return 'notApplicable'
        if status in {'fail', 'failed'}:
            return 'failed'
        if category in {'diagnostic', 'trace'}:
            return 'notApplicable'
        return 'warnings'

    @staticmethod
    def _item_utilization(item: Dict[str, Any]) -> Optional[float]:
        raw = item.get('utilization')
        if raw is None or isinstance(raw, bool):
            return None
        try:
            value = float(raw)
        except (TypeError, ValueError):
            return None
        return value if math.isfinite(value) and value >= 0 else None

    @staticmethod
    def _is_governing_eligible(item: Dict[str, Any]) -> bool:
        if item.get('governingEligible') is False:
            return False
        status = str(item.get('status', '')).strip().lower()
        if status not in {'pass', 'passed', 'fail', 'failed'}:
            return False
        category = str(item.get('category', '')).strip().lower()
        return category not in {'input_required', 'unsupported', 'diagnostic', 'trace'} and CodeChecker._item_utilization(item) is not None

    def _select_controlling_item(self, all_items: List[Dict[str, Any]]) -> Dict[str, Any]:
        eligible = [item for item in all_items if self._is_governing_eligible(item)]
        return max(eligible, key=self._item_utilization, default={})

    @staticmethod
    def _normalize_item(item: Dict[str, Any]) -> Dict[str, Any]:
        """Separate unexecuted checks from measured engineering failures."""
        item = dict(item)
        category = item.get('category')
        if category == 'input_required' or item.get('status') == 'input_required':
            item.update(status='input_required', utilization=None, governingEligible=False, displayUtilization='N/A')
        elif category == 'unsupported' or item.get('status') in {'not_implemented', 'unsupported'}:
            item.update(status='unsupported', utilization=None, governingEligible=False, displayUtilization='N/A')
        return item

    @classmethod
    def _aggregate_status(cls, items: List[Dict[str, Any]]) -> str:
        buckets = [cls._summary_bucket(item) for item in items]
        if 'failed' in buckets:
            return 'fail'
        if 'unsupported' in buckets:
            return 'unsupported'
        if 'inputRequired' in buckets:
            return 'input_required'
        if 'warnings' in buckets or not buckets:
            return 'incomplete'
        return 'pass' if 'passed' in buckets else 'not_applicable'

    def _build_chapter_summaries(self, checks: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        chapters = []
        for check in checks:
            items = check.get('items', [])
            controlling = self._select_controlling_item(items)
            chapters.append({
                'chapter': check.get('chapter') or check.get('name'),
                'status': self._aggregate_status(items),
                'itemCount': len(items),
                'maxUtilization': self._item_utilization(controlling),
                'controllingClause': controlling.get('clause'),
            })
        return chapters

    def _check_element(self, elem_id: str, context: Dict[str, Any]) -> Dict[str, Any]:
        """校核单个构件"""
        check_func = getattr(self.skill_module, 'check_element', None)
        if callable(check_func):
            element_data = context.get('elementData', {})
            element = element_data.get(elem_id, {}) if isinstance(element_data, dict) else {}
            states = element.get('forceStates', []) if isinstance(element, dict) else []
            if not isinstance(states, list) or not states:
                return check_func(self, elem_id, context)
            results = []
            for state in states:
                if not isinstance(state, dict) or not isinstance(state.get('forces'), dict):
                    continue
                state_element = {**element, 'forces': state['forces'], 'forceStates': []}
                if state.get('unsupportedReason'):
                    state_element['forceInputIssue'] = state['unsupportedReason']
                state_context = {**context, 'elementData': {**element_data, elem_id: state_element}}
                result = check_func(self, elem_id, state_context)
                for item in self._flatten_result_items(result):
                    item['forceState'] = {key: value for key, value in state.items() if key != 'forces'}
                results.append(result)
            if not results:
                return check_func(self, elem_id, context)
            groups: Dict[str, Dict[str, Any]] = {}
            for result in results:
                for group in result.get('checks', []):
                    target = groups.setdefault(group['name'], {**group, 'items': {}})
                    for item in group.get('items', []):
                        target['items'].setdefault(item['item'], []).append(item)
            checks = []
            for group in groups.values():
                items = []
                for candidates in group['items'].values():
                    status = self._aggregate_status(candidates)
                    candidates_for_status = [item for item in candidates if item.get('status') == status]
                    governing = self._select_controlling_item(candidates_for_status or candidates)
                    selected = governing or (candidates_for_status or candidates)[0]
                    unresolved = sum(self._summary_bucket(item) in {'inputRequired', 'unsupported', 'warnings'} for item in candidates)
                    items.append({**selected, 'checkedForceStateCount': len(candidates), 'unresolvedForceStateCount': unresolved})
                checks.append({**group, 'items': items})
            first = results[0]
            combined = {**first, **self._build_element_result(elem_id, first.get('elementType', ''), checks, first.get('code', self.code))}
            if 'chapters' in combined:
                combined['chapters'] = self._build_chapter_summaries(combined['checks'])
            combined['forceStateCount'] = len(results)
            combined['forceCoverage'] = element.get('forceCoverage')
            return combined

        return {
            'elementId': elem_id,
            'status': 'not_implemented',
            'message': f'{self.code} 校核尚未实现',
        }

    def _build_element_result(self, elem_id: str, element_type: str, checks: List[Dict[str, Any]], code_version: str) -> Dict[str, Any]:
        checks = [{**check, 'items': [self._normalize_item(item) for item in check.get('items', [])]} for check in checks]
        all_items = [item for check in checks for item in check.get('items', [])]
        controlling = self._select_controlling_item(all_items)

        return {
            'elementId': elem_id,
            'elementType': element_type,
            'status': self._aggregate_status(all_items),
            'checks': checks,
            'controlling': {
                'item': controlling.get('item'),
                'utilization': self._item_utilization(controlling),
                'clause': controlling.get('clause'),
            },
            'code': code_version,
        }

    def _calc_item(
        self,
        elem_id: str,
        item_name: str,
        context: Dict[str, Any],
        clause: str,
        formula: str,
        limit: float,
    ) -> Dict[str, Any]:
        element = context.get('elementData', {}).get(elem_id, {})
        unsupported = element.get('forceInputIssue') if isinstance(element, dict) else None
        if item_name in {'挠度', '裂缝宽度'} and isinstance(element, dict) and element.get('serviceabilityExcluded'):
            return {'item': item_name, 'status': 'not_applicable', 'category': 'not_applicable',
                    'clause': clause, 'formula': formula, 'utilization': None, 'governingEligible': False,
                    'message': 'This result is outside the explicitly selected service cases / 本结果不属于显式指定的正常使用工况。'}
        force_items = {'正应力', '剪应力', '折算应力', '整体稳定', '轴压稳定', '偏心受压', '正截面受弯', '斜截面受剪'}
        if unsupported and item_name in force_items:
            return {'item': item_name, 'status': 'unsupported', 'category': 'unsupported',
                    'utilization': None, 'governingEligible': False, 'clause': clause, 'formula': formula,
                    'message': unsupported}
        utilization = self._resolve_utilization(elem_id, item_name, context)
        if utilization is None:
            missing_loader = getattr(getattr(self, 'skill_module', None), 'missing_inputs', None)
            missing = missing_loader(elem_id, item_name, context) if callable(missing_loader) else []
            return {
                'item': item_name, 'status': 'input_required', 'category': 'input_required',
                'utilization': None, 'governingEligible': False, 'displayUtilization': 'N/A',
                'clause': clause, 'formula': formula,
                'inputs': {'demand': None, 'capacity': None, 'limit': limit},
                'missingInputs': missing,
                'message': 'Required finite calculation inputs are missing or invalid / 缺少有效计算参数，尚未完成校核。',
            }
        demand = round(utilization * limit, 4)
        capacity = round(limit, 4)
        calculation = context.get('computedEvidenceByElement', {}).get(elem_id, {}).get(item_name)
        return {
            'item': item_name,
            'status': 'pass' if utilization <= 1.0 else 'fail',
            'utilization': round(utilization, 4),
            'clause': clause,
            'formula': formula,
            'evidenceSource': 'elementData' if item_name in context.get('computedItemsByElement', {}).get(elem_id, []) else 'provided_utilization',
            'calculationInputs': {key: value for key, value in element.items() if key not in {'forceStates', 'extra', 'metadata'}} if item_name in context.get('computedItemsByElement', {}).get(elem_id, []) else None,
            'inputs': {'basis': 'engineering-demand-capacity', **calculation, 'limit': 1.0} if calculation else {
                'basis': 'normalized_utilization',
                'demand': demand,
                'capacity': capacity,
                'limit': limit,
            },
        }

    def _resolve_utilization(self, elem_id: str, item_name: str, context: Dict[str, Any]) -> Optional[float]:
        overrides = context.get('utilizationByElement', {})
        if isinstance(overrides, dict):
            per_elem = overrides.get(elem_id, {})
            if isinstance(per_elem, dict):
                raw = per_elem.get(item_name)
                if isinstance(raw, (int, float)) and not isinstance(raw, bool) and math.isfinite(raw) and raw >= 0:
                    return float(raw)
        return None

    def _load_rules(self, code: str) -> Dict[str, Any]:
        """加载规范规则"""
        rule_loader = getattr(self.skill_module, 'get_rules', None)
        if callable(rule_loader):
            loaded = rule_loader()
            if isinstance(loaded, dict):
                return loaded

        return {
            'code': code,
            'version': 'v1-minimal',
            'rules': [],
        }
