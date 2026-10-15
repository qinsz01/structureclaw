"""GB50017-2017 钢结构设计标准 — 构件校核实现。

覆盖第 7 章（强度）、第 8 章（稳定）、第 10 章（刚度）中梁、柱、支撑的
构件级验算。连接校核（第 9 章）不在本迭代范围内。
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional
import math


RULE_VERSION = 'v2-member-checks'
CODE_VERSION = 'GB50017-2017'

CHAPTERS = [
    {
        'id': 'chapter-7-strength',
        'title': '第7章 强度验算',
        'checks': ['正应力', '剪应力', '折算应力'],
    },
    {
        'id': 'chapter-8-stability',
        'title': '第8章 稳定验算',
        'checks': ['整体稳定', '轴压稳定', '局部稳定', '长细比'],
    },
    {
        'id': 'chapter-10-serviceability',
        'title': '第10章 正常使用极限状态',
        'checks': ['挠度'],
    },
]


def get_rules() -> Dict[str, Any]:
    return {
        'code': 'GB50017',
        'version': RULE_VERSION,
        'chapters': CHAPTERS,
        'rules': [
            {
                'name': '强度验算',
                'clause': 'GB50017-2017 Chapter 7',
                'elementType': ['beam', 'column', 'brace'],
                'checks': [
                    {
                        'item': '正应力',
                        'clause': '7.1.1',
                        'formula': '(|N|/A + |Mₓ|/Wₙₓ) / f ≤ 1.0',
                        'limit': 1.0,
                        'params': ['N', 'Mx', 'A', 'Wnx', 'f'],
                    },
                    {
                        'item': '剪应力',
                        'clause': '7.1.2',
                        'formula': 'τ = V·S/(I·tw) ≤ f_v',
                        'limit': 1.0,
                        'params': ['V', 'S', 'I', 'tw', 'fv'],
                    },
                    {
                        'item': '折算应力',
                        'clause': '7.1.4',
                        'formula': '√(σₓ² + σ_b² - σₓ·σ_b + 3τ²) ≤ β₁·f',
                        'limit': 1.0,
                        'params': ['sigma_axial', 'sigma_bending', 'tau', 'beta1', 'f'],
                    },
                ],
            },
            {
                'name': '稳定验算',
                'clause': 'GB50017-2017 Chapter 8',
                'elementType': ['beam', 'column', 'brace'],
                'checks': [
                    {
                        'item': '整体稳定',
                        'clause': '8.2.1',
                        'formula': 'M/(φb·Wₓ·f) ≤ 1.0',
                        'limit': 1.0,
                        'params': ['Mx', 'phi', 'Wnx', 'f'],
                    },
                    {
                        'item': '轴压稳定',
                        'clause': '8.1.1',
                        'formula': 'N/(φ·A·f) ≤ 1.0',
                        'limit': 1.0,
                        'params': ['N', 'phi', 'A', 'f'],
                    },
                    {
                        'item': '局部稳定',
                        'clause': '8.4.1',
                        'formula': 'b/t ≤ [b/t]',
                        'limit': 1.0,
                        'params': ['b', 't', 'btLimit'],
                    },
                ],
            },
            {
                'name': '刚度验算',
                'clause': 'GB50017-2017 Chapter 10',
                'elementType': ['beam', 'column', 'brace'],
                'checks': [
                    {
                        'item': '长细比',
                        'clause': '10.1.1',
                        'formula': 'λ = l₀/i ≤ [λ]',
                        'limit': 1.0,
                        'params': ['l0', 'i', 'lambdaLimit'],
                    },
                    {
                        'item': '挠度',
                        'clause': '10.2.1',
                        'formula': 'f_max ≤ L/n',
                        'limit': 1.0,
                        'params': ['deflection', 'L', 'deflectionLimitN'],
                    },
                ],
            },
        ],
    }


# ---------------------------------------------------------------------------
# Element type resolution
# ---------------------------------------------------------------------------

def _resolve_element_context(elem_id: str, context: Dict[str, Any]) -> Dict[str, Any]:
    """Resolve element context from elementContextById (upstream PR #134)."""
    mapping = context.get('elementContextById', {})
    if isinstance(mapping, dict):
        value = mapping.get(elem_id)
        if isinstance(value, dict):
            return value
    return {}


def _resolve_element_type(elem_id: str, context: Dict[str, Any]) -> str:
    """Determine element type from context or naming heuristics."""
    # Prefer elementContextById (upstream)
    element_context = _resolve_element_context(elem_id, context)
    raw_type = element_context.get('type')
    if raw_type:
        normalized = str(raw_type).strip().lower()
        if normalized in {'column', 'brace', 'beam'}:
            return normalized
        if 'column' in normalized:
            return 'column'
        if 'brace' in normalized:
            return 'brace'
        return normalized

    # Fallback: elementData
    element_data = context.get('elementData', {})
    if isinstance(element_data, dict):
        elem = element_data.get(elem_id, {})
        if isinstance(elem, dict) and 'type' in elem:
            return str(elem['type']).lower()

    # Fallback: naming heuristics
    lower = elem_id.lower()
    if 'col' in lower:
        return 'column'
    if 'brace' in lower:
        return 'brace'
    return 'beam'


# ---------------------------------------------------------------------------
# Utilization computation from elementData
# ---------------------------------------------------------------------------

def _compute_utilization_overrides(
    elem_id: str, context: Dict[str, Any], evidence: Optional[Dict[str, Any]] = None,
) -> Dict[str, float]:
    """Compute utilization ratios from elementData.

    Returns a new dict of computed overrides. Does NOT mutate context.
    Caller overrides (already in utilizationByElement) are respected —
    this function only computes values that are NOT already present.
    """
    element_data = context.get('elementData', {})
    if not isinstance(element_data, dict):
        return {}
    elem = element_data.get(elem_id)
    if not isinstance(elem, dict):
        return {}

    section = elem.get('section', {})
    material = elem.get('material', {})
    forces = elem.get('forces', {})
    if not isinstance(section, dict) or not isinstance(material, dict) or not isinstance(forces, dict):
        return {}

    # Existing caller overrides — these take priority
    existing = context.get('utilizationByElement', {})
    if isinstance(existing, dict):
        per_elem = existing.get(elem_id, {})
        if not isinstance(per_elem, dict):
            per_elem = {}
    else:
        per_elem = {}

    computed: Dict[str, float] = {}

    def _has_override(key: str) -> bool:
        """Check if caller provided a numeric override for this check item."""
        val = per_elem.get(key)
        return isinstance(val, (int, float))

    def number(value, *, positive=False):
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return None
        value = float(value)
        return value if math.isfinite(value) and (not positive or value > 0) else None

    def positive(record, *keys):
        return next((number(record[key], positive=True) for key in keys if key in record), None)

    def save(name, value, demand=None, capacity=None, unit=None):
        if not _has_override(name) and math.isfinite(value) and value >= 0:
            computed[name] = value
            if evidence is not None and demand is not None and capacity is not None:
                evidence[name] = {'demand': demand, 'capacity': capacity, 'unit': unit}

    A, f, fv = positive(section, 'A'), positive(material, 'f'), positive(material, 'fv')
    N, V, Mx = (number(forces.get(key)) for key in ('N', 'V', 'Mx'))
    Wnx = positive(section, 'Wnx', 'Wx')
    I, S, tw = positive(section, 'I', 'Iy', 'Ix'), positive(section, 'S'), positive(section, 'tw')
    sigma_axial = abs(N) / A if N is not None and A else None
    sigma_bending = 0.0 if Mx == 0 else abs(Mx) / Wnx if Mx is not None and Wnx else None
    if _resolve_element_type(elem_id, context) == 'brace' and Mx is None:
        sigma_bending = 0.0
    if sigma_axial is not None and sigma_bending is not None and f:
        save('正应力', (sigma_axial + sigma_bending) / f, sigma_axial + sigma_bending, f, 'MPa')

    tau = None
    if V is not None:
        if I and S and tw:
            tau = abs(V) * S / (I * tw)
        elif positive(section, 'As'):
            tau = abs(V) / positive(section, 'As')
        if tau is not None and fv:
            save('剪应力', tau / fv, tau, fv, 'MPa')
    beta1 = positive(elem, 'beta1')
    if sigma_axial is not None and sigma_bending is not None and tau is not None and beta1 and f:
        equivalent = math.sqrt(sigma_axial ** 2 + sigma_bending ** 2 - sigma_axial * sigma_bending + 3 * tau ** 2)
        save('折算应力', equivalent / (beta1 * f), equivalent, beta1*f, 'MPa')

    phi_b, phi_axial = positive(elem, 'phi_b', 'phi'), positive(elem, 'phi_axial', 'phi')
    if Mx is not None and phi_b and Wnx and f:
        save('整体稳定', abs(Mx) / (phi_b * Wnx * f), abs(Mx), phi_b*Wnx*f, 'N.mm')
    if N is not None and phi_axial and A and f:
        save('轴压稳定', abs(N) / (phi_axial * A * f), abs(N), phi_axial*A*f, 'N')
    b, t, bt_limit = positive(section, 'flangeWidth', 'b'), positive(section, 'flangeThickness', 't'), positive(elem, 'btLimit')
    if b and t and bt_limit:
        save('局部稳定', b / t / bt_limit, b/t, bt_limit, '1')
    l0, i_min, lambda_limit = positive(elem, 'l0', 'length'), positive(section, 'imin', 'i'), positive(elem, 'lambdaLimit')
    if l0 and i_min and lambda_limit:
        save('长细比', l0 / i_min / lambda_limit, l0/i_min, lambda_limit, '1')
    displacement = number(forces.get('deflection', elem.get('deflection')))
    L, n_limit = positive(elem, 'serviceabilityLength', 'length'), positive(elem, 'deflectionLimitN')
    if displacement is not None and L and n_limit:
        save('挠度', abs(displacement) / (L / n_limit), abs(displacement), L/n_limit, 'mm')

    return computed


# ---------------------------------------------------------------------------
# Element-type-specific check builders
# ---------------------------------------------------------------------------

def missing_inputs(elem_id: str, item: str, context: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Explain the actual unavailable operands; never ask users to invent solver results."""
    element = context.get('elementData', {}).get(elem_id, {})
    section, material, forces = (element.get(key, {}) for key in ('section', 'material', 'forces'))
    missing: List[Dict[str, Any]] = []

    def require(record, keys, field, label, unit, source='design', positive=True):
        valid = any(isinstance(record.get(key), (int, float)) and not isinstance(record.get(key), bool)
                    and math.isfinite(record[key]) and (not positive or record[key] > 0) for key in keys)
        if not valid:
            missing.append({'field': field, 'label': label, 'unit': unit, 'source': source})

    def axial():
        require(forces, ['N'], 'forces.N', '轴力 / Axial force', 'N', 'result', False)
        require(section, ['A'], 'section.A', '截面面积 / Section area', 'mm2', 'section')

    def bending():
        require(forces, ['Mx'], 'forces.Mx', '弯矩 / Bending moment', 'N.mm', 'result', False)
        if forces.get('Mx') != 0:
            require(section, ['Wnx', 'Wx'], 'section.Wnx', '净截面模量 / Net section modulus', 'mm3', 'section')

    def shear():
        require(forces, ['V'], 'forces.V', '剪力 / Shear force', 'N', 'result', False)
        if not any(isinstance(section.get(key), (int, float)) and section[key] > 0 for key in ['As']):
            for keys, field, label, unit in [(['I', 'Iy', 'Ix'], 'I', '截面惯性矩 / Section inertia', 'mm4'),
                                            (['S'], 'S', '截面静矩 / First moment of area', 'mm3'),
                                            (['tw'], 'tw', '腹板厚度 / Web thickness', 'mm')]:
                require(section, keys, f'section.{field}', label, unit, 'section')

    if item in {'正应力', '折算应力'}:
        axial()
        if not (_resolve_element_type(elem_id, context) == 'brace' and forces.get('Mx') is None):
            bending()
        require(material, ['f'], 'material.design.f', '抗拉抗压抗弯设计强度 / Design normal strength', 'MPa')
    if item in {'剪应力', '折算应力'}:
        shear()
        if item == '剪应力':
            require(material, ['fv'], 'material.design.fv', '抗剪设计强度 / Design shear strength', 'MPa')
    if item == '折算应力':
        require(element, ['beta1'], 'member.design.beta1', '折算应力系数 / Equivalent-stress factor', '1')
    if item == '整体稳定':
        bending()
        require(material, ['f'], 'material.design.f', '设计强度 / Design strength', 'MPa')
        require(element, ['phi_b', 'phi'], 'member.design.phi_b', '整体稳定系数及支承依据 / Lateral stability factor and support basis', '1')
    if item == '轴压稳定':
        axial()
        require(material, ['f'], 'material.design.f', '设计强度 / Design strength', 'MPa')
        require(element, ['phi_axial', 'phi'], 'member.design.phi_axial', '轴压稳定系数 / Axial stability factor', '1')
    if item == '局部稳定':
        require(section, ['flangeWidth', 'b'], 'section.b', '板件计算宽度 / Plate width', 'mm', 'section')
        require(section, ['flangeThickness', 't'], 'section.t', '板件厚度 / Plate thickness', 'mm', 'section')
        require(element, ['btLimit'], 'member.design.btLimit', '宽厚比限值及依据 / Width-thickness limit and basis', '1')
    if item == '长细比':
        require(element, ['l0', 'length'], 'member.design.l0', '计算长度 / Effective length', 'mm')
        require(section, ['imin', 'i'], 'section.imin', '最小回转半径 / Minimum radius of gyration', 'mm', 'section')
        require(element, ['lambdaLimit'], 'member.design.lambdaLimit', '长细比限值 / Slenderness limit', '1')
    if item == '挠度':
        require(forces if 'deflection' in forces else element, ['deflection'], 'response.deflection', '使用工况相对挠度 / Service relative deflection', 'mm', 'result', False)
        require(element, ['length'], 'member.length', '构件长度 / Member length', 'mm', 'geometry')
        require(element, ['deflectionLimitN'], 'member.design.deflectionLimitN', '挠度限值 L/n 的 n 及依据 / Denominator n of L/n and basis', '1')
        if not element.get('serviceabilityResult') and 'serviceabilityResult' in element:
            missing.append({'field': 'member.design.serviceability_result_keys', 'label': '使用工况或组合 / Service case or combination', 'unit': 'result key', 'source': 'design'})
    return missing

def _check_beam(checker: Any, elem_id: str, context: Dict[str, Any]) -> List[Dict[str, Any]]:
    return [
        {
            'chapter': '第7章 强度验算',
            'name': '强度验算',
            'items': [
                checker._calc_item(elem_id, '正应力', context, 'GB50017-2017 7.1.1', '(|N|/A + |Mₓ|/Wₙₓ) / f ≤ 1.0', 1.0),
                checker._calc_item(elem_id, '剪应力', context, 'GB50017-2017 7.1.2', 'τ = V·S/(I·tw) ≤ f_v', 1.0),
                checker._calc_item(elem_id, '折算应力', context, 'GB50017-2017 7.1.4', '√(σₓ²+σ_b²-σₓ·σ_b+3τ²) ≤ β₁·f', 1.0),
            ],
        },
        {
            'chapter': '第8章 稳定验算',
            'name': '稳定验算',
            'items': [
                checker._calc_item(elem_id, '整体稳定', context, 'GB50017-2017 8.2.1', 'M/(φb·Wₓ·f) ≤ 1.0', 1.0),
                checker._calc_item(elem_id, '局部稳定', context, 'GB50017-2017 8.4.1', 'b/t ≤ [b/t]', 1.0),
            ],
        },
        {
            'chapter': '第10章 正常使用极限状态',
            'name': '刚度验算',
            'items': [
                checker._calc_item(elem_id, '长细比', context, 'GB50017-2017 10.1.1', 'λ = l₀/i ≤ [λ]', 1.0),
                checker._calc_item(elem_id, '挠度', context, 'GB50017-2017 10.2.1', 'f_max ≤ L/n', 1.0),
            ],
        },
    ]


def _check_column(checker: Any, elem_id: str, context: Dict[str, Any]) -> List[Dict[str, Any]]:
    return [
        {
            'chapter': '第7章 强度验算',
            'name': '强度验算',
            'items': [
                checker._calc_item(elem_id, '正应力', context, 'GB50017-2017 7.1.1', 'σ = N/Aₙ ≤ f', 1.0),
            ],
        },
        {
            'chapter': '第8章 稳定验算',
            'name': '稳定验算',
            'items': [
                checker._calc_item(elem_id, '轴压稳定', context, 'GB50017-2017 8.1.1', 'N/(φ·A·f) ≤ 1.0', 1.0),
                checker._calc_item(elem_id, '局部稳定', context, 'GB50017-2017 8.4.1', 'b/t ≤ [b/t]', 1.0),
            ],
        },
        {
            'chapter': '第10章 正常使用极限状态',
            'name': '刚度验算',
            'items': [
                checker._calc_item(elem_id, '长细比', context, 'GB50017-2017 10.1.1', 'λ = l₀/i ≤ [λ]', 1.0),
            ],
        },
    ]


def _check_brace(checker: Any, elem_id: str, context: Dict[str, Any]) -> List[Dict[str, Any]]:
    return [
        {
            'chapter': '第7章 强度验算',
            'name': '强度验算',
            'items': [
                checker._calc_item(elem_id, '正应力', context, 'GB50017-2017 7.1.1', 'σ = N/Aₙ ≤ f', 1.0),
            ],
        },
        {
            'chapter': '第8章 稳定验算',
            'name': '稳定验算',
            'items': [
                checker._calc_item(elem_id, '轴压稳定', context, 'GB50017-2017 8.1.1', 'N/(φ·A·f) ≤ 1.0', 1.0),
                checker._calc_item(elem_id, '局部稳定', context, 'GB50017-2017 8.4.1', 'b/t ≤ [b/t]', 1.0),
            ],
        },
        {
            'chapter': '第10章 正常使用极限状态',
            'name': '刚度验算',
            'items': [
                checker._calc_item(elem_id, '长细比', context, 'GB50017-2017 10.1.1', 'λ = l₀/i ≤ [λ]', 1.0),
            ],
        },
    ]


# ---------------------------------------------------------------------------
# Chapter summaries (from upstream PR #134)
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Main dispatcher
# ---------------------------------------------------------------------------

_BUILDERS = {
    'beam': _check_beam,
    'column': _check_column,
    'brace': _check_brace,
}


def check_element(checker: Any, elem_id: str, context: Dict[str, Any]) -> Dict[str, Any]:
    """GB50017-2017 构件校核入口。"""
    element_context = _resolve_element_context(elem_id, context)
    element_type = _resolve_element_type(elem_id, context)

    # Compute utilization overrides immutably — merge into a copy of context
    evidence: Dict[str, Any] = {}
    computed = _compute_utilization_overrides(elem_id, context, evidence)
    if computed:
        existing_ube = context.get('utilizationByElement')
        if not isinstance(existing_ube, dict):
            existing_ube = {}
        existing_elem = existing_ube.get(elem_id)
        if not isinstance(existing_elem, dict):
            existing_elem = {}
        merged_ctx = {
            **context,
            'computedItemsByElement': {elem_id: list(computed)},
            'computedEvidenceByElement': {elem_id: evidence},
            'utilizationByElement': {
                **existing_ube,
                elem_id: {
                    **existing_elem,
                    **computed,
                },
            },
        }
    else:
        merged_ctx = context

    if element_type not in _BUILDERS:
        return checker._build_element_result(elem_id, element_type, [{'name': '适用范围 / Applicability', 'items': [{
            'item': '构件类型 / Member type', 'status': 'unsupported', 'category': 'unsupported',
            'message': 'Only beam, column and brace checks are implemented / 当前仅实现梁、柱和支撑校核。',
        }]}], CODE_VERSION)
    builder = _BUILDERS[element_type]
    normalized_type = element_type
    checks = builder(checker, elem_id, merged_ctx)
    section = context.get('elementData', {}).get(elem_id, {}).get('section', {})
    if (section.get('shape') or {}).get('kind') in {'rectangular', 'circular'}:
        for group in checks:
            for item in group.get('items', []):
                if item['item'] == '局部稳定':
                    item.update(status='not_applicable', category='not_applicable', utilization=None, governingEligible=False,
                        message='Plate local buckling is not applicable to a solid rectangle/circle / 实心矩形或圆形无薄板局部屈曲验算项。')
    result = checker._build_element_result(elem_id, normalized_type, checks, CODE_VERSION)
    result['chapters'] = checker._build_chapter_summaries(result['checks'])
    result['chapterCount'] = len(result['chapters'])
    result['elementContext'] = {
        'type': normalized_type,
        'section': element_context.get('section'),
        'material': element_context.get('material'),
    }
    return result
