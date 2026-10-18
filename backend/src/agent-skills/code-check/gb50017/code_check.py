"""GB50017-2017 钢结构设计标准 — 构件校核实现。

覆盖第 7 章（强度）、第 8 章（稳定）、第 10 章（刚度）中梁、柱、支撑的
构件级验算。连接校核（第 9 章）不在本迭代范围内。
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple
import math
import sys
from pathlib import Path

_SHARED_PYTHON = Path(__file__).resolve().parents[3] / 'skill-shared' / 'python'
if _SHARED_PYTHON.exists() and str(_SHARED_PYTHON) not in sys.path:
    sys.path.insert(0, str(_SHARED_PYTHON))

from structure_protocol.design_code_tables import WIDTH_THICKNESS_S4, epsilon_k, nominal_yield, normalize_steel_grade, steel_strength  # noqa: E402


RULE_VERSION = 'v2-member-checks'
CODE_VERSION = 'GB50017-2017'
CHECK_IDS = {
    'normal_stress': '正应力', 'shear_stress': '剪应力', 'equivalent_stress': '折算应力',
    'lateral_stability': '整体稳定', 'axial_stability': '轴压稳定',
    'local_stability': '局部稳定', 'slenderness': '长细比', 'deflection': '挠度',
}

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
        'checkIds': CHECK_IDS,
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
# Code-determined design values (recorded with their sources; model values override)
# ---------------------------------------------------------------------------

def _finite(value: Any) -> Optional[float]:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    value = float(value)
    return value if math.isfinite(value) else None


def _h_shape(section: Dict[str, Any]) -> Optional[Dict[str, float]]:
    shape = section.get('shape') if isinstance(section.get('shape'), dict) else {}
    if shape.get('kind') not in {'H', 'I', 'built-up-I'}:
        return None
    dims = {key: _finite(shape.get(key)) for key in ('H', 'B', 'tw', 'tf')}
    if any(value is None or value <= 0 for value in dims.values()) or dims['H'] <= 2 * dims['tf'] or dims['B'] <= dims['tw']:
        return None
    return dims  # type: ignore[return-value]


def resolve_design_values(elem: Dict[str, Any], element_type: str) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
    """Fill code-determined inputs that the model does not supply; return the element copy and the sources.

    f, fv, fy: Table 4.4.1 by grade and governing plate thickness (flange tf for H sections).
    b/t and h0/tw: sharp-corner H geometry. εk = sqrt(235/fy) with the grade's nominal yield.
    Width-thickness limits: Table 3.5.1 class S4, the class 6.1.1 needs for the full section
    modulus with γx = 1.0 (γx is not used). β1 = 1.1 per 6.1.5 because the analysis model
    computes no local compressive stress σc. Slenderness limit 150 for columns (7.4.6) only.
    Judgment inputs (φb, l0, L/n, service case) are never filled.
    """
    material = dict(elem.get('material') or {}) if isinstance(elem.get('material'), dict) else {}
    section = dict(elem.get('section') or {}) if isinstance(elem.get('section'), dict) else {}
    result = {**elem, 'material': material, 'section': section}
    rows: List[Dict[str, Any]] = []
    grade = next((value for value in (material.get('grade'), material.get('name')) if normalize_steel_grade(value)), None)
    shape = _h_shape(section)

    def record(field: str, value: float, unit: str, origin: str, source: str) -> None:
        rows.append({'field': field, 'value': round(value, 6), 'unit': unit, 'origin': origin, 'source': source})

    thickness = shape['tf'] if shape else _finite(section.get('t')) or _finite(section.get('flangeThickness'))
    strength = steel_strength(grade, thickness) if grade and thickness else None
    for key in ('f', 'fv'):
        supplied = _finite(material.get(key))
        if supplied is not None and supplied > 0:
            record(f'material.design.{key}', supplied, 'MPa', 'model-input', f'materials.design.{key}')
        elif strength:
            material[key] = strength[key]
            record(f'material.design.{key}', strength[key], 'MPa', 'code-table', strength['source'])
    if strength:
        record('material.fy', strength['fy'], 'MPa', 'code-table', strength['source'])
    if shape:
        geometry = f"无圆角H形截面 {shape['H']:g}×{shape['B']:g}×{shape['tw']:g}×{shape['tf']:g} / sharp-corner H geometry"
        derived = {'b': (shape['B'] - shape['tw']) / 2, 't': shape['tf'], 'h0': shape['H'] - 2 * shape['tf'], 'tw': shape['tw']}
        for key, value in derived.items():
            if _finite(section.get(key)) is None:
                section[key] = value
            same = abs(section[key] - value) <= 1e-9 * max(1.0, abs(value))
            record(f'section.{key}', section[key], 'mm', 'geometry' if same else 'model-input',
                   geometry if same else f'sections.properties.{key}')
        for key, unit in (('Wnx', 'mm3'), ('Wz', 'mm3'), ('S', 'mm3'), ('imin', 'mm')):
            if _finite(section.get(key)) is not None:
                record(f'section.{key}', section[key], unit, 'geometry', geometry)
    eps = epsilon_k(grade) if grade else None
    if eps:
        record('epsilonK', eps, '1', 'clause', f'GB 50017-2017 εk=√(235/fy), fy={nominal_yield(grade):g} ({normalize_steel_grade(grade)})')
        if element_type in {'beam', 'column'} and _finite(elem.get('btLimit')) is None:
            result['btLimit'] = WIDTH_THICKNESS_S4['flange'] * eps
            record('member.design.btLimit', result['btLimit'], '1', 'clause', 'GB 50017-2017 表3.5.1 S4级翼缘 15εk（6.1.1 全截面模量、γx=1.0 所需）/ Table 3.5.1 class S4 flange (full section modulus, γx=1.0)')
        if element_type == 'beam' and shape and _finite(elem.get('webLimit')) is None:
            result['webLimit'] = WIDTH_THICKNESS_S4['beam_web'] * eps
            record('member.design.webLimit', result['webLimit'], '1', 'clause', 'GB 50017-2017 表3.5.1 S4级受弯构件腹板 124εk / Table 3.5.1 class S4 flexural web')
    if element_type == 'beam' and _finite(elem.get('beta1')) is None:
        result['beta1'] = 1.1
        record('member.design.beta1', 1.1, '1', 'clause', 'GB 50017-2017 6.1.5: σc=0（模型未计算局部压应力）取 β1=1.1 / σc=0 (no local compressive stress modelled)')
    if element_type == 'column' and _finite(elem.get('lambdaLimit')) is None:
        result['lambdaLimit'] = 150.0
        record('member.design.lambdaLimit', 150.0, '1', 'clause', 'GB 50017-2017 表7.4.6 柱 [λ]=150 / Table 7.4.6 columns')
    return result, rows


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
        return isinstance(val, (int, float)) and not isinstance(val, bool) and math.isfinite(val) and val >= 0

    def number(value, *, positive=False):
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return None
        value = float(value)
        return value if math.isfinite(value) and (not positive or value > 0) else None

    def positive(record, *keys):
        return next((value for key in keys if (value := number(record.get(key), positive=True)) is not None), None)

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
        h0, web_limit = positive(section, 'h0'), positive(elem, 'webLimit')
        ratios = [(b / t / bt_limit, b / t, bt_limit)]
        if h0 and tw and web_limit:
            ratios.append((h0 / tw / web_limit, h0 / tw, web_limit))
        governing = max(ratios, key=lambda row: row[0])
        save('局部稳定', governing[0], governing[1], governing[2], '1')
    # Geometric/mesh element length is not an effective buckling length. The
    # bridge supplies l0 only from explicit design data; do not infer restraints
    # or a length factor from the analysis discretization.
    l0, i_min, lambda_limit = positive(elem, 'l0'), positive(section, 'imin', 'i'), positive(elem, 'lambdaLimit')
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
        require(element, ['phi_b', 'phi'], 'member.design.phi_b', '整体稳定系数 φb（取决于侧向支承/受压翼缘自由长度）/ Lateral stability factor φb (depends on lateral bracing / unbraced compression-flange length)', '1')
    if item == '轴压稳定':
        axial()
        require(material, ['f'], 'material.design.f', '设计强度 / Design strength', 'MPa')
        require(element, ['phi_axial', 'phi'], 'member.design.phi_axial', '轴压稳定系数 / Axial stability factor', '1')
    if item == '局部稳定':
        require(section, ['flangeWidth', 'b'], 'section.b', '板件计算宽度 / Plate width', 'mm', 'section')
        require(section, ['flangeThickness', 't'], 'section.t', '板件厚度 / Plate thickness', 'mm', 'section')
        require(element, ['btLimit'], 'member.design.btLimit', '宽厚比限值及依据 / Width-thickness limit and basis', '1')
    if item == '长细比':
        require(element, ['l0'], 'member.design.l0', '明确的计算长度及约束依据 / Explicit effective length and restraint basis', 'mm')
        require(section, ['imin', 'i'], 'section.imin', '最小回转半径 / Minimum radius of gyration', 'mm', 'section')
        require(element, ['lambdaLimit'], 'member.design.lambdaLimit', '长细比限值 / Slenderness limit', '1')
    if item == '挠度':
        require(forces if 'deflection' in forces else element, ['deflection'], 'response.deflection', '使用工况相对挠度 / Service relative deflection', 'mm', 'result', False)
        require(element, ['serviceabilityLength', 'length'], 'member.length', '构件长度 / Member length', 'mm', 'geometry')
        require(element, ['deflectionLimitN'], 'member.design.deflectionLimitN', '挠度限值 L/n 的 n（取决于构件类别：主梁/次梁等）/ Denominator n of L/n (depends on member category: primary/secondary beam etc.)', '1')
        if not element.get('serviceabilityResult') and 'serviceabilityResult' in element:
            missing.append({'field': 'member.design.serviceability_result_keys', 'label': '使用工况或组合 / Service case or combination', 'unit': 'result key', 'source': 'design'})
    return missing

def _beam_slenderness_item(checker: Any, elem_id: str, context: Dict[str, Any]) -> Dict[str, Any]:
    """The code sets no slenderness limit for flexural members; only a limit given in the model is checked."""
    element = context.get('elementData', {}).get(elem_id, {})
    if isinstance(element, dict) and _finite(element.get('lambdaLimit')) is not None:
        return checker._calc_item(elem_id, '长细比', context, 'GB50017-2017 10.1.1', 'λ = l₀/i ≤ [λ]', 1.0)
    return {'item': '长细比', 'status': 'not_applicable', 'category': 'not_applicable', 'clause': 'GB50017-2017 7.4',
            'formula': 'λ = l₀/i ≤ [λ]', 'utilization': None, 'governingEligible': False,
            'message': 'GB 50017-2017 sets no slenderness limit for flexural members / 受弯构件无长细比限值规定。'}


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
                _beam_slenderness_item(checker, elem_id, context),
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
    element_data = context.get('elementData', {}) if isinstance(context.get('elementData'), dict) else {}
    design_values: List[Dict[str, Any]] = []
    if isinstance(element_data.get(elem_id), dict):
        enriched, design_values = resolve_design_values(element_data[elem_id], element_type)
        context = {**context, 'elementData': {**element_data, elem_id: enriched}}

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
    result['designValues'] = design_values
    return result
