"""GB50010-2010 混凝土结构设计规范 — 构件校核实现。

覆盖第 6 章（承载能力极限状态）、第 7 章（构造与稳定）中梁、柱的
构件级验算。采用 gb50017 范式：_compute_utilization_overrides()
从 elementData 读取 OpenSees 真实内力，计算实际利用率。
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

import math
import sys
from pathlib import Path

_SHARED_PYTHON = Path(__file__).resolve().parents[3] / 'skill-shared' / 'python'
if _SHARED_PYTHON.exists() and str(_SHARED_PYTHON) not in sys.path:
    sys.path.insert(0, str(_SHARED_PYTHON))

from structure_protocol.design_code_tables import CONCRETE_GRADES, REBAR_GRADES, concrete_value, rebar_value  # noqa: E402


def get_rules() -> Dict[str, Any]:
    return {
        'code': 'GB50010',
        'version': 'v2-rc-frame-member-checks',
        'rules': [
            {
                'name': '梁承载力与正常使用验算',
                'elementType': ['beam'],
                'checks': ['正截面受弯', '斜截面受剪', '钢筋净距', '挠度', '裂缝宽度'],
            },
            {
                'name': '柱承载力与稳定验算',
                'elementType': ['column'],
                'checks': ['轴压比', '偏心受压', '斜截面受剪', '长细比', '钢筋净距'],
            },
        ],
    }


def _resolve_element_context(elem_id: str, context: Dict[str, Any]) -> Dict[str, Any]:
    mapping = context.get('elementContextById', {})
    if isinstance(mapping, dict):
        value = mapping.get(elem_id)
        if isinstance(value, dict):
            return value
    return {}


def _resolve_element_type(elem_id: str, context: Dict[str, Any]) -> str:
    element_context = _resolve_element_context(elem_id, context)
    raw_type = element_context.get('type')
    if raw_type:
        normalized = str(raw_type).strip().lower()
        if normalized in {'beam', 'column'}:
            return normalized
        if 'column' in normalized:
            return 'column'
        if 'beam' in normalized:
            return 'beam'
        return normalized

    element_data = context.get('elementData', {})
    element = element_data.get(elem_id, {}) if isinstance(element_data, dict) else {}
    if isinstance(element, dict) and element.get('type'):
        return str(element['type']).strip().lower()

    lower = elem_id.lower()
    if lower.startswith('c') or 'column' in lower or 'col' in lower:
        return 'column'
    return 'beam'


# ---------------------------------------------------------------------------
# Material property lookup — GB/T 50010-2010 Tables 4.1.3, 4.1.5, 4.2.3
# ---------------------------------------------------------------------------

# Centralised tables: structure_protocol/design_code_tables.py (GB 50010-2010 4.1.3/4.1.4/4.1.5, 4.2.2/4.2.3/4.2.5).
_CONCRETE_GRADES: Dict[str, Dict[str, float]] = CONCRETE_GRADES
_REBAR_GRADES: Dict[str, Dict[str, float]] = REBAR_GRADES


def _design_value_sources(concrete_grade: str | None, rebar_grade: str | None, elem_data: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Source of each strength the checks use: the model's own value (it overrides), otherwise the code table."""
    material = elem_data.get('material', {}) if isinstance(elem_data.get('material'), dict) else {}
    rows: List[Dict[str, Any]] = []
    for key, lookup, grade, label in (('fc', concrete_value, concrete_grade, 'material.design.fc'),
                                      ('ft', concrete_value, concrete_grade, 'material.design.ft'),
                                      ('fy', rebar_value, rebar_grade, 'material.design.fy'),
                                      ('fyv', rebar_value, rebar_grade, 'material.design.fyv')):
        value = material.get(key)
        found = lookup(grade, key)
        # A model value equal to the table value is the table value; a different one is an explicit override.
        if isinstance(value, (int, float)) and not isinstance(value, bool) and not (found and abs(float(value) - found['value']) <= 1e-9):
            rows.append({'field': label, 'value': float(value), 'unit': 'MPa', 'origin': 'model-input', 'source': f'materials.design.{key}'})
            continue
        if found:
            rows.append({'field': label, 'value': found['value'], 'unit': 'MPa', 'origin': 'code-table', 'source': found['source']})
    return rows


def _resolve_material_props(
    concrete_grade: str | None,
    rebar_grade: str | None,
    elem_data: Dict[str, Any],
) -> Dict[str, float]:
    """Resolve full concrete/rebar design properties.

    Prefers values from elementData.material (model design values from
    concrete-frame material records). Falls back to built-in lookup table
    when elementData is incomplete (e.g. for analysis engines that don't
    populate full design values).
    """
    material_raw = elem_data.get('material', {})
    material = material_raw if isinstance(material_raw, dict) else {}

    # Concrete — prefer elementData, fallback to lookup
    lookup_concrete = _CONCRETE_GRADES.get(concrete_grade or '', {})

    def _get(key: str, fallback_key: str | None = None, default: float = 0.0) -> float:
        val = material.get(key)
        if isinstance(val, (int, float)):
            return float(val)
        if fallback_key:
            val = material.get(fallback_key)
            if isinstance(val, (int, float)):
                return float(val)
        return float(lookup_concrete.get(key, default))

    # Rebar — prefer elementData, fallback to lookup
    lookup_rebar = _REBAR_GRADES.get(rebar_grade or '', {})

    def _get_rebar(key: str, default: float = 0.0) -> float:
        val = material.get(key)
        if isinstance(val, (int, float)):
            return float(val)
        return float(lookup_rebar.get(key, default))

    return {
        # Concrete design values (from model or lookup)
        'fc':     _get('fc'),
        'ft':     _get('ft'),
        'ftk':    _get('ftk'),
        'Ec':     _get('Ec', 'E'),
        'ecu':    _get('ecu'),
        'alpha1': _get('alpha1'),
        'beta1':  _get('beta1'),
        # Rebar design values (from model or lookup)
        'fy':     _get_rebar('fy'),
        'fyv':    _get_rebar('fyv'),
        'fy_comp': _get_rebar('fy_compression'),
        'Es':     _get_rebar('Es'),
    }


# ---------------------------------------------------------------------------
# Utilization computation from elementData (gb50017 paradigm)
# ---------------------------------------------------------------------------

_STABILITY_COEFF_TABLE: List[tuple[float, float]] = [
    (8, 1.00), (10, 0.98), (12, 0.95), (14, 0.92),
    (16, 0.87), (18, 0.81), (20, 0.75), (22, 0.70),
    (24, 0.65), (26, 0.60), (28, 0.56), (30, 0.52),
]


def _stability_coeff(l0b: float) -> float:
    """Axial compression stability coefficient φ (GB50010-2010 Table 6.2.15)."""
    if l0b <= 8:
        return 1.00
    if l0b >= 30:
        return 0.52
    for i in range(len(_STABILITY_COEFF_TABLE) - 1):
        a, phi_a = _STABILITY_COEFF_TABLE[i]
        b, phi_b = _STABILITY_COEFF_TABLE[i + 1]
        if a <= l0b <= b:
            return phi_a + (phi_b - phi_a) * (l0b - a) / (b - a)
    return 0.52


def _compute_utilization_overrides(
    elem_id: str, context: Dict[str, Any], evidence: Optional[Dict[str, Any]] = None,
) -> Dict[str, float]:
    """Compute utilization ratios from elementData for GB50010.

    Reads OpenSees real forces (N, V, Mx), section geometry (b, h, A, I),
    and material grades from elementContextById to compute actual
    utilization ratios per GB50010-2010 formulas.

    Returns a new dict of computed overrides. Does NOT mutate context.
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

    # Resolve element context for grade info
    element_context = _resolve_element_context(elem_id, context)
    concrete_grade = element_context.get('concreteGrade') or material.get('concreteGrade') or material.get('grade')
    rebar_grade = element_context.get('rebarGrade') or material.get('rebarGrade')
    mat = _resolve_material_props(concrete_grade, rebar_grade, elem)

    def number(value, *, positive=False):
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return None
        value = float(value)
        return value if math.isfinite(value) and (not positive or value > 0) else None

    def positive(record, *keys):
        return next((number(record[key], positive=True) for key in keys if key in record), None)

    overrides = context.get('utilizationByElement', {})
    per_elem = overrides.get(elem_id, {}) if isinstance(overrides, dict) else {}
    per_elem = per_elem if isinstance(per_elem, dict) else {}
    computed: Dict[str, float] = {}

    def save(name, value, demand=None, capacity=None, unit=None):
        if name not in per_elem and math.isfinite(value) and value >= 0:
            computed[name] = value
            if evidence is not None and demand is not None and capacity is not None:
                evidence[name] = {'demand': demand, 'capacity': capacity, 'unit': unit}

    b, h, A = positive(section, 'width', 'B'), positive(section, 'height', 'H'), positive(section, 'A')
    inertia = positive(section, 'I', 'Iy')
    N, V, M = (number(forces.get(key)) for key in ('N', 'V', 'Mx'))
    length, l0 = positive(elem, 'length'), positive(elem, 'l0')
    fc, ft, fy, fyv = (positive(mat, key) for key in ('fc', 'ft', 'fy', 'fyv'))
    As, Asv = positive(elem, 'As'), positive(elem, 'Asv')
    spacing = positive(elem, 'stirrup_spacing')
    h0 = positive(elem, 'h0')
    cover, stirrup_dia, main_dia = (number(elem.get(key)) for key in ('cover', 'stirrup_dia', 'main_dia'))
    if h0 is None and h and cover is not None and cover >= 0 and stirrup_dia is not None and stirrup_dia > 0 and main_dia is not None and main_dia > 0:
        h0 = h - cover - stirrup_dia - main_dia / 2
    if h0 is not None and (h0 <= 0 or h and h0 >= h):
        h0 = None

    axial_limit = positive(elem, 'axialRatioLimit')
    if N is not None and A and fc and axial_limit:
        save('轴压比', abs(N) / (fc * A * axial_limit), abs(N), fc*A*axial_limit, 'N')
    lambda_limit = positive(elem, 'lambdaLimit')
    if l0 and A and inertia and lambda_limit:
        save('长细比', l0 / math.sqrt(inertia / A) / lambda_limit, l0/math.sqrt(inertia/A), lambda_limit, '1')

    # Retain the existing simplified interaction only as a screening estimate.
    if N is not None and M is not None and A and b and h and h0 and As and fc and fy and l0:
        nu = 0.9 * fc * A
        mu = 0.9 * fy * As * h0
        phi = _stability_coeff(l0 / min(b, h)) if abs(N) > 0.3 * nu else 1.0
        save('偏心受压', abs(N) / (phi * nu) + abs(M) / mu)

    if V is not None and b and h0 and ft and fyv and Asv and spacing:
        capacity = 0.7 * ft * b * h0 + min(fyv, 360) * Asv * h0 / spacing
        save('斜截面受剪', abs(V) / capacity, abs(V), capacity, 'N')

    alpha1, beta1, Es, ecu = (positive(mat, key) for key in ('alpha1', 'beta1', 'Es', 'ecu'))
    if M is not None and b and h0 and As and fc and fy and alpha1 and beta1 and Es and ecu:
        x = fy * As / (alpha1 * fc * b)
        xb = beta1 / (1 + fy / (Es * ecu)) * h0
        # Beyond the implemented singly-reinforced section branch, request a full check.
        if x <= xb:
            capacity = alpha1 * fc * b * x * (h0 - x / 2)
            if capacity > 0:
                save('正截面受弯', abs(M) / capacity, abs(M), capacity, 'N.mm')

    displacement = number(forces.get('deflection', elem.get('deflection')))
    deflection_limit_n = positive(elem, 'deflectionLimitN')
    service_length = positive(elem, 'serviceabilityLength') or length
    if displacement is not None and service_length and deflection_limit_n:
        save('挠度', abs(displacement) / (service_length / deflection_limit_n), abs(displacement), service_length/deflection_limit_n, 'mm')

    service_moment = number(forces.get('M_service'))
    crack_cover = number(elem.get('crack_cover'))
    ftk, crack_limit, alpha_cr = positive(mat, 'ftk'), positive(elem, 'crackWidthLimit'), positive(elem, 'alpha_cr')
    if service_moment is not None and b and h and h0 and As and main_dia and main_dia > 0 and crack_cover is not None and crack_cover >= 0 and ftk and Es and crack_limit and alpha_cr:
        rho = max(As / (0.5 * b * h), 0.01)
        sigma = abs(service_moment) / (0.87 * h0 * As)
        psi = max(0.2, min(1.1 - 0.65 * ftk / (rho * sigma), 1.0)) if sigma else 0.2
        width = alpha_cr * psi * sigma / Es * (1.9 * crack_cover + 0.08 * main_dia / rho)
        save('裂缝宽度', width / crack_limit, width, crack_limit, 'mm')

    count, clear_spacing = number(elem.get('bar_count')), number(elem.get('sn'))
    if count is not None and count > 1 and clear_spacing is not None and main_dia and main_dia > 0:
        spacing_limit = max(1.5 * main_dia, 50 if _resolve_element_type(elem_id, context) == 'column' else 30)
        if clear_spacing > 0:
            save('钢筋净距', spacing_limit / clear_spacing, spacing_limit, clear_spacing, 'mm')
    return computed


def missing_inputs(elem_id: str, item: str, context: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Operands an unexecuted check lacks; code-table values are looked up from the grades."""
    element_data = context.get('elementData', {})
    element = element_data.get(elem_id, {}) if isinstance(element_data, dict) else {}
    element = element if isinstance(element, dict) else {}
    section = element.get('section', {}) if isinstance(element.get('section'), dict) else {}
    forces = element.get('forces', {}) if isinstance(element.get('forces'), dict) else {}
    material = element.get('material', {}) if isinstance(element.get('material'), dict) else {}
    element_context = _resolve_element_context(elem_id, context)
    mat = _resolve_material_props(element_context.get('concreteGrade') or material.get('concreteGrade') or material.get('grade'),
                                  element_context.get('rebarGrade') or material.get('rebarGrade'), element)
    missing: List[Dict[str, Any]] = []

    def valid(record: Dict[str, Any], keys: List[str], positive: bool = True) -> bool:
        return any(isinstance(record.get(key), (int, float)) and not isinstance(record.get(key), bool)
                   and math.isfinite(record[key]) and (not positive or record[key] > 0) for key in keys)

    def require(record: Dict[str, Any], keys: List[str], field: str, label: str, unit: str, source: str, positive: bool = True) -> None:
        if not valid(record, keys, positive) and not any(row['field'] == field for row in missing):
            missing.append({'field': field, 'label': label, 'unit': unit, 'source': source})

    concrete = lambda key, label: require(mat, [key], f'material.design.{key}', f'{label}（由混凝土强度等级按 GB 50010 确定）/ {label} (from the concrete grade, GB 50010)', 'MPa', 'design')
    rebar = lambda key, label: require(mat, [key], f'material.design.{key}', f'{label}（由钢筋牌号按 GB 50010 表4.2.3 确定）/ {label} (from the rebar grade, GB 50010 Table 4.2.3)', 'MPa', 'design')
    width = lambda: require(section, ['width', 'B'], 'section.width', '截面宽度 b / Section width b', 'mm', 'section')
    height = lambda: require(section, ['height', 'H'], 'section.height', '截面高度 h / Section height h', 'mm', 'section')
    depth = lambda: require(element, ['h0'], 'member.design.h0', '有效高度 h0（或保护层与钢筋直径）/ Effective depth h0 (or cover and bar diameters)', 'mm', 'design')
    steel = lambda key, label: require(element, [key], f'member.design.reinforcement.values.{key}', label, 'mm2' if key in ('As', 'Asv') else 'mm', 'design')
    if item == '轴压比':
        require(forces, ['N'], 'forces.N', '轴力 / Axial force', 'N', 'result', False)
        require(section, ['A'], 'section.A', '截面面积 / Section area', 'mm2', 'section')
        concrete('fc', '混凝土抗压强度设计值 fc / Concrete design strength fc')
        require(element, ['axialRatioLimit'], 'member.design.axialRatioLimit', '轴压比限值及依据 / Axial-compression ratio limit and basis', '1', 'design')
    elif item == '长细比':
        require(element, ['l0'], 'member.design.l0', '计算长度及约束依据 / Effective length and restraint basis', 'mm', 'design')
        require(element, ['lambdaLimit'], 'member.design.lambdaLimit', '长细比限值 / Slenderness limit', '1', 'design')
    elif item == '偏心受压':
        require(forces, ['N'], 'forces.N', '轴力 / Axial force', 'N', 'result', False)
        require(forces, ['Mx'], 'forces.Mx', '弯矩 / Bending moment', 'N.mm', 'result', False)
        width(); height(); depth()
        steel('As', '纵筋面积 As / Longitudinal reinforcement area As')
        concrete('fc', '混凝土抗压强度设计值 fc / Concrete design strength fc')
        rebar('fy', '钢筋抗拉强度设计值 fy / Rebar design strength fy')
        require(element, ['l0'], 'member.design.l0', '计算长度及约束依据 / Effective length and restraint basis', 'mm', 'design')
    elif item == '斜截面受剪':
        require(forces, ['V'], 'forces.V', '剪力 / Shear force', 'N', 'result', False)
        width(); depth()
        concrete('ft', '混凝土抗拉强度设计值 ft / Concrete tensile design strength ft')
        rebar('fyv', '箍筋抗拉强度设计值 fyv / Stirrup design strength fyv')
        steel('Asv', '箍筋面积 Asv / Stirrup area Asv')
        steel('stirrup_spacing', '箍筋间距 s / Stirrup spacing s')
    elif item == '正截面受弯':
        require(forces, ['Mx'], 'forces.Mx', '弯矩 / Bending moment', 'N.mm', 'result', False)
        width(); depth()
        steel('As', '纵筋面积 As / Longitudinal reinforcement area As')
        concrete('fc', '混凝土抗压强度设计值 fc / Concrete design strength fc')
        rebar('fy', '钢筋抗拉强度设计值 fy / Rebar design strength fy')
    elif item == '挠度':
        require(forces if 'deflection' in forces else element, ['deflection'], 'response.deflection', '使用工况相对挠度 / Service relative deflection', 'mm', 'result', False)
        require(element, ['deflectionLimitN'], 'member.design.deflectionLimitN', '挠度限值 L/n 的 n 及依据（取决于构件类别）/ Denominator n of L/n and basis (depends on member category)', '1', 'design')
    elif item == '裂缝宽度':
        require(forces, ['M_service'], 'member.design.serviceability_result_keys', '使用工况或组合 / Service case or combination', 'result key', 'design', False)
        width(); height(); depth()
        steel('As', '纵筋面积 As / Longitudinal reinforcement area As')
        steel('main_dia', '纵筋直径 / Main bar diameter')
        steel('crack_cover', '裂缝计算保护层厚度 / Cover for crack width', )
        require(element, ['crackWidthLimit'], 'member.design.crackWidthLimit', '裂缝宽度限值及依据 / Crack-width limit and basis', 'mm', 'design')
        require(element, ['alpha_cr'], 'member.design.alpha_cr', '构件受力特征系数 αcr / Member stress-type factor αcr', '1', 'design')
    return missing


def _has_spacing_metadata(elem_id: str, context: Dict[str, Any]) -> bool:
    """Check whether the element has complete rebar spacing metadata in elementData."""
    element_data = context.get('elementData', {})
    if not isinstance(element_data, dict):
        return False
    elem = element_data.get(elem_id)
    if not isinstance(elem, dict):
        return False
    return (
        isinstance(elem.get('bar_count'), (int, float))
        and isinstance(elem.get('sn'), (int, float))
        and isinstance(elem.get('main_dia'), (int, float))
    )


def _check_beam(checker: Any, elem_id: str, context: Dict[str, Any]) -> List[Dict[str, Any]]:
    return [
        {
            'chapter': '第6章 承载能力极限状态',
            'name': '承载力验算',
            'items': [
                checker._calc_item(elem_id, '正截面受弯', context, 'GB50010-2010 6.2.1', 'M <= α1*f_c*b*x*(h0-0.5*x)', 0.95),
                checker._calc_item(elem_id, '斜截面受剪', context, 'GB50010-2010 6.3.1', 'V <= Vc + Vs', 0.95),
            ],
        },
        *([{
            'chapter': '第9章 构造规定',
            'name': '构造验算',
            'items': [
                checker._calc_item(elem_id, '钢筋净距', context, 'GB50010-2010 9.2.1', 's_n >= max(1.5d, 30)', 1.0),
            ],
        }] if _has_spacing_metadata(elem_id, context) else []),
        {
            'name': '正常使用验算',
            'items': [
                checker._calc_item(elem_id, '挠度', context, 'GB50010-2010 3.3.2', 'f <= l/250', 1.0),
                checker._calc_item(elem_id, '裂缝宽度', context, 'GB50010-2010 3.4.5', 'w_max <= w_lim', 1.0),
            ],
        },
    ]


def _check_column(checker: Any, elem_id: str, context: Dict[str, Any]) -> List[Dict[str, Any]]:
    return [
        {
            'chapter': '第6章 承载能力极限状态',
            'name': '柱承载力验算',
            'items': [
                checker._calc_item(elem_id, '轴压比', context, 'GB50010-2010 6.2.15', 'N/(f_c*A) <= 轴压比限值', 0.90),
                checker._calc_item(elem_id, '偏心受压', context, 'GB50010-2010 6.2.17', 'N-M interaction <= 1.0', 1.0),
                checker._calc_item(elem_id, '斜截面受剪', context, 'GB50010-2010 6.3.12', 'V <= Vc + Vs', 0.95),
            ],
        },
        {
            'chapter': '第7章 构造与稳定',
            'name': '柱稳定与构造验算',
            'items': [
                checker._calc_item(elem_id, '长细比', context, 'GB50010-2010 6.2.20', 'l0/i <= 限值', 1.0),
                *([checker._calc_item(elem_id, '钢筋净距', context, 'GB50010-2010 9.3.1', 's_n >= max(1.5d, 50)', 1.0)]
                  if _has_spacing_metadata(elem_id, context) else []),
            ],
        },
    ]


def check_element(checker: Any, elem_id: str, context: Dict[str, Any]) -> Dict[str, Any]:
    """GB50010-2010 构件校核入口 — gb50017 范式。

    1. 从 elementData 计算真实利用率 (_compute_utilization_overrides)
    2. 合并到 utilizationByElement 并构建 enriched context
    3. 缺失资料不生成利用率，由统一入口标明待补输入
    """
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

    if element_type not in {'column', 'beam'}:
        return checker._build_element_result(elem_id, element_type, [{'name': '适用范围 / Applicability', 'items': [{
            'item': '构件类型 / Member type', 'status': 'unsupported', 'category': 'unsupported',
            'message': 'Only concrete beam and column checks are implemented / 当前仅实现混凝土梁柱校核。',
        }]}], 'GB50010-2010')
    checks = _check_column(checker, elem_id, merged_ctx) if element_type == 'column' else _check_beam(checker, elem_id, merged_ctx)
    result = checker._build_element_result(elem_id, element_type, checks, 'GB50010-2010')
    for check in result['checks']:
        for item in check['items']:
            if item['item'] == '钢筋净距':
                data = context.get('elementData', {}).get(elem_id, {})
                spacing, diameter = data.get('sn'), data.get('main_dia')
                if isinstance(spacing, (int, float)) and spacing <= 0 and isinstance(diameter, (int, float)) and diameter > 0:
                    required = max(1.5*diameter, 50 if element_type == 'column' else 30)
                    item.update(status='fail', category='fail', utilization=None, governingEligible=False,
                        inputs={'basis':'engineering-inequality', 'actual':spacing, 'minimum':required, 'unit':'mm', 'operator':'>='},
                        message='Clear reinforcement spacing is below its required positive minimum / 钢筋净距小于正的构造下限。')
            if item['item'] == '偏心受压' and item['item'] in computed:
                item.update(status='unsupported', category='unsupported', screeningUtilization=item['utilization'],
                            utilization=None, governingEligible=False,
                            message='Simplified interaction is screening only; full eccentric-compression capacity is not implemented / 简化线性交互仅作筛查，完整偏压承载力尚未实现。')
    result = checker._build_element_result(elem_id, element_type, result['checks'], 'GB50010-2010')
    result['chapters'] = checker._build_chapter_summaries(result['checks'])
    result['chapterCount'] = len(result['chapters'])
    result['elementContext'] = {
        'type': element_type,
        'section': element_context.get('section'),
        'material': element_context.get('material'),
        'concreteGrade': element_context.get('concreteGrade'),
        'rebarGrade': element_context.get('rebarGrade'),
    }
    data = context.get('elementData', {}).get(elem_id, {}) if isinstance(context.get('elementData'), dict) else {}
    material = data.get('material', {}) if isinstance(data, dict) and isinstance(data.get('material'), dict) else {}
    result['designValues'] = _design_value_sources(
        element_context.get('concreteGrade') or material.get('concreteGrade') or material.get('grade'),
        element_context.get('rebarGrade') or material.get('rebarGrade'), data if isinstance(data, dict) else {})
    return result
