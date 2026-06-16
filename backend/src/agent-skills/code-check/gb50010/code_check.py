"""GB50010-2010 混凝土结构设计规范 — 构件校核实现。

覆盖第 6 章（承载能力极限状态）、第 7 章（构造与稳定）中梁、柱的
构件级验算。采用 gb50017 范式：_compute_utilization_overrides()
从 elementData 读取 OpenSees 真实内力，计算实际利用率。
"""
from __future__ import annotations

from typing import Any, Dict, List

import math


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

    lower = elem_id.lower()
    if lower.startswith('c') or 'column' in lower or 'col' in lower:
        return 'column'
    return 'beam'


# ---------------------------------------------------------------------------
# Material property lookup — GB/T 50010-2010 Tables 4.1.3, 4.1.5, 4.2.3
# ---------------------------------------------------------------------------

_CONCRETE_GRADES: Dict[str, Dict[str, float]] = {
    'C20':  {'fck': 13.4, 'ftk': 1.54, 'fc': 9.6,  'ft': 1.10, 'Ec': 25500, 'ecu': 0.0033, 'alpha1': 1.0,  'beta1': 0.80},
    'C25':  {'fck': 16.7, 'ftk': 1.78, 'fc': 11.9, 'ft': 1.27, 'Ec': 28000, 'ecu': 0.0033, 'alpha1': 1.0,  'beta1': 0.80},
    'C30':  {'fck': 20.1, 'ftk': 2.01, 'fc': 14.3, 'ft': 1.43, 'Ec': 30000, 'ecu': 0.0033, 'alpha1': 1.0,  'beta1': 0.80},
    'C35':  {'fck': 23.4, 'ftk': 2.20, 'fc': 16.7, 'ft': 1.57, 'Ec': 31500, 'ecu': 0.0033, 'alpha1': 1.0,  'beta1': 0.80},
    'C40':  {'fck': 26.8, 'ftk': 2.39, 'fc': 19.1, 'ft': 1.71, 'Ec': 32500, 'ecu': 0.0033, 'alpha1': 1.0,  'beta1': 0.80},
    'C45':  {'fck': 29.6, 'ftk': 2.51, 'fc': 21.1, 'ft': 1.80, 'Ec': 33500, 'ecu': 0.0033, 'alpha1': 0.99, 'beta1': 0.79},
    'C50':  {'fck': 32.4, 'ftk': 2.64, 'fc': 23.1, 'ft': 1.89, 'Ec': 34500, 'ecu': 0.0033, 'alpha1': 0.98, 'beta1': 0.78},
    'C55':  {'fck': 35.5, 'ftk': 2.74, 'fc': 25.3, 'ft': 1.96, 'Ec': 35500, 'ecu': 0.00325,'alpha1': 0.97, 'beta1': 0.77},
    'C60':  {'fck': 38.5, 'ftk': 2.85, 'fc': 27.5, 'ft': 2.04, 'Ec': 36000, 'ecu': 0.0032, 'alpha1': 0.96, 'beta1': 0.76},
    'C65':  {'fck': 41.5, 'ftk': 2.93, 'fc': 29.7, 'ft': 2.09, 'Ec': 36500, 'ecu': 0.00315,'alpha1': 0.95, 'beta1': 0.75},
    'C70':  {'fck': 44.5, 'ftk': 2.99, 'fc': 31.8, 'ft': 2.14, 'Ec': 37000, 'ecu': 0.0031, 'alpha1': 0.94, 'beta1': 0.74},
    'C75':  {'fck': 47.4, 'ftk': 3.05, 'fc': 33.8, 'ft': 2.18, 'Ec': 37500, 'ecu': 0.00305,'alpha1': 0.93, 'beta1': 0.73},
    'C80':  {'fck': 50.2, 'ftk': 3.11, 'fc': 35.9, 'ft': 2.22, 'Ec': 38000, 'ecu': 0.003,  'alpha1': 0.92, 'beta1': 0.72},
}

_REBAR_GRADES: Dict[str, Dict[str, float]] = {
    'HPB300': {'fyk': 300, 'fstk': 420, 'fy': 270, 'fy_compression': 270, 'fyv': 270, 'Es': 210000},
    'HRB335': {'fyk': 335, 'fstk': 455, 'fy': 300, 'fy_compression': 300, 'fyv': 300, 'Es': 200000},
    'HRB400': {'fyk': 400, 'fstk': 540, 'fy': 360, 'fy_compression': 360, 'fyv': 360, 'Es': 200000},
    'HRBF400':{'fyk': 400, 'fstk': 540, 'fy': 360, 'fy_compression': 360, 'fyv': 360, 'Es': 200000},
    'RRB400': {'fyk': 400, 'fstk': 540, 'fy': 360, 'fy_compression': 360, 'fyv': 360, 'Es': 200000},
    'HRB500': {'fyk': 500, 'fstk': 630, 'fy': 435, 'fy_compression': 410, 'fyv': 360, 'Es': 200000},
    'HRBF500':{'fyk': 500, 'fstk': 630, 'fy': 435, 'fy_compression': 410, 'fyv': 360, 'Es': 200000},
}


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
        'fc':     _get('fc', default=14.3),
        'ft':     _get('ft', default=1.43),
        'ftk':    _get('ftk', default=2.01),
        'Ec':     _get('Ec', 'E', 30000),
        'ecu':    _get('ecu', default=0.0033),
        'alpha1': _get('alpha1', default=1.0),
        'beta1':  _get('beta1', default=0.80),
        # Rebar design values (from model or lookup)
        'fy':     _get_rebar('fy', 360),
        'fyv':    _get_rebar('fyv', 360),
        'fy_comp': _get_rebar('fy_compression', 360),
        'Es':     _get_rebar('Es', _get_rebar('E', 200000)),
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
    elem_id: str, context: Dict[str, Any],
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
    concrete_grade = element_context.get('concreteGrade')
    rebar_grade = element_context.get('rebarGrade')
    mat = _resolve_material_props(concrete_grade, rebar_grade, elem)

    # Section geometry (mm)
    b = section.get('width') or section.get('B')
    h = section.get('height') or section.get('H')
    A_mm2 = section.get('A')
    I_min = section.get('I') or section.get('Iy')

    # Rebar design — from model element metadata, or computed minimums
    As_design = elem.get('As')               # total rebar area (mm²) — model design value
    Asv_design = elem.get('Asv')             # stirrup area (mm²)
    stirrup_dia = elem.get('stirrup_dia')    # stirrup diameter (mm)
    stirrup_spacing = elem.get('stirrup_spacing')  # stirrup spacing (mm)
    main_dia = elem.get('main_dia')          # main bar diameter (mm)
    cover = elem.get('cover')                # concrete cover (mm)
    crack_cover = elem.get('crack_cover')    # cover for crack check (mm)

    # Forces (N, N·mm)
    N_newton = forces.get('N')  # axial force in N
    V_newton = forces.get('V')  # shear force in N
    Mx = forces.get('Mx')       # moment (N·mm from OpenSees envelope)

    # Element length (mm)
    length_mm = elem.get('length')

    # Existing caller overrides take priority
    existing = context.get('utilizationByElement', {})
    if isinstance(existing, dict):
        per_elem = existing.get(elem_id, {})
        if not isinstance(per_elem, dict):
            per_elem = {}
    else:
        per_elem = {}

    def _has_override(key: str) -> bool:
        val = per_elem.get(key)
        return isinstance(val, (int, float))

    computed: Dict[str, float] = {}

    # ---------- COLUMN CHECKS ----------

    # 轴压比 (§6.2.15): N / (fc * A)
    if not _has_override('轴压比') and N_newton is not None and A_mm2 is not None and mat['fc'] > 0:
        try:
            N_kn = abs(float(N_newton)) / 1000.0  # N → kN
            fc_mpa = mat['fc']  # N/mm²
            A = float(A_mm2)  # mm²
            computed['轴压比'] = (N_kn * 1000) / (fc_mpa * A)
        except (ZeroDivisionError, ValueError, TypeError):
            pass

    # 长细比 (§6.2.20): l0/i / limit
    if not _has_override('长细比') and length_mm is not None and A_mm2 is not None and I_min is not None:
        try:
            A = float(A_mm2)
            I = float(I_min)
            L = float(length_mm)
            if A > 0 and I > 0:
                i_min = math.sqrt(I / A)
                slenderness = L / i_min
                # General limit for concrete columns: 120 (GB50010-2010 §6.2.20)
                limit = float(elem.get('lambdaLimit', 120))
                if limit > 0:
                    computed['长细比'] = slenderness / limit
        except (ZeroDivisionError, ValueError, TypeError):
            pass

    # 偏心受压 (§6.2.17): simplified N-M interaction using φ·fc·A + fy·As
    if not _has_override('偏心受压') and N_newton is not None and Mx is not None and b is not None and h is not None and A_mm2 is not None:
        try:
            B = float(b)
            H = float(h)
            A = float(A_mm2)
            N_kn = abs(float(N_newton)) / 1000.0  # N → kN
            M_knm = abs(float(Mx)) / 1e6            # N·mm → kN·m

            # Rebar: use model design value, fallback to min 0.6% (§9.3.1)
            h0 = H - (float(cover) if isinstance(cover, (int, float)) else 40)
            if isinstance(As_design, (int, float)) and float(As_design) > 0:
                As_total = float(As_design)
            else:
                rho_min = max(0.006, 0.55 * mat['ft'] / mat['fy'])
                As_total = rho_min * A

            # Section capacity estimates
            N_capacity = 0.9 * mat['fc'] * A / 1000.0  # N → kN
            M_capacity = 0.9 * mat['fy'] * As_total * h0 / 1e6  # kN·m

            # Simplified linear interaction: N/Nu + M/Mu
            if N_capacity > 0:
                n_ratio = N_kn / N_capacity
            else:
                n_ratio = 0.0

            if M_knm > 0 and M_capacity > 0:
                m_ratio = M_knm / M_capacity
                # For high axial load, stability reduction
                if N_kn > 0.3 * N_capacity and length_mm is not None:
                    L = float(length_mm)
                    l0b = L / min(B, H)
                    phi = _stability_coeff(l0b)
                    n_ratio = N_kn / (phi * N_capacity) if phi > 0 else n_ratio
                computed['偏心受压'] = n_ratio + m_ratio if M_knm > 0 else n_ratio
            else:
                computed['偏心受压'] = n_ratio

        except (ZeroDivisionError, ValueError, TypeError):
            pass

    # 斜截面受剪 — column (§6.3.12): V / (Vc + Vs)
    if not _has_override('斜截面受剪') and V_newton is not None and b is not None and h is not None:
        try:
            B = float(b)
            H = float(h)
            V_kn = abs(float(V_newton)) / 1000.0  # N → kN
            h0 = H - 40

            # Concrete shear contribution: Vc = 0.7 * ft * b * h0 / 1000
            Vc = 0.7 * mat['ft'] * B * h0 / 1000.0  # kN

            # Stirrup: use model design values, fallback to Φ8@200
            fyv_capped = min(mat['fyv'], 360)  # §4.2.3 cap
            s = float(stirrup_spacing) if isinstance(stirrup_spacing, (int, float)) else 200.0
            if isinstance(Asv_design, (int, float)) and float(Asv_design) > 0:
                Asv = float(Asv_design)
            else:
                Asv = 2 * math.pi * 8**2 / 4  # 2-leg Φ8 ≈ 100.5 mm²
            Vs = fyv_capped * Asv * h0 / s / 1000.0  # kN

            V_capacity = Vc + Vs
            if V_capacity > 0:
                computed['斜截面受剪'] = V_kn / V_capacity

        except (ZeroDivisionError, ValueError, TypeError):
            pass

    # ---------- BEAM CHECKS ----------

    # 正截面受弯 (§6.2.1 / §6.2.10): M / Mu
    if not _has_override('正截面受弯') and Mx is not None and b is not None and h is not None:
        try:
            B = float(b)
            H = float(h)
            M_knm = abs(float(Mx)) / 1e6  # N·mm → kN·m
            h0 = H - 40

            # Rebar: use model design value, fallback to min 0.2% (§8.5)
            if isinstance(As_design, (int, float)) and float(As_design) > 0:
                As_min = float(As_design)
            else:
                rho_min = max(0.002, 0.45 * mat['ft'] / mat['fy'])
                As_min = rho_min * B * h0

            # Equivalent stress block (§6.2.6)
            x = mat['fy'] * As_min / (mat['alpha1'] * mat['fc'] * B) if mat['fc'] > 0 and B > 0 else 0
            xi_b = mat['beta1'] / (1 + mat['fy'] / (mat['Es'] * mat['ecu']))  # balanced xi
            xb = xi_b * h0
            x = min(x, xb)  # ensure under-reinforced
            Mu = mat['alpha1'] * mat['fc'] * B * x * (h0 - x / 2) / 1e6  # kN·m
            if Mu > 0:
                computed['正截面受弯'] = M_knm / Mu

        except (ZeroDivisionError, ValueError, TypeError):
            pass

    # 挠度 (§3.3.2): simplified — assume simply-supported, check mid-span
    if not _has_override('挠度') and Mx is not None and b is not None and h is not None and length_mm is not None:
        try:
            B = float(b)
            H = float(h)
            L = float(length_mm)  # mm
            M_knm = abs(float(Mx)) / 1e6  # N·mm → kN·m

            # EI from section and Ec
            I_cracked = B * H**3 / 12  # gross section I, mm⁴
            # Reduced stiffness: Bs = 0.85 * Ec * I (short-term, §7.2.3 simplified)
            Bs = 0.85 * mat['Ec'] * I_cracked  # N·mm²
            if Bs > 0:
                # Deflection for simply-supported uniform load: f = 5Ml²/(48EI)
                # Use service moment ≈ 0.6 * ULS moment (approximate)
                M_service = M_knm * 0.6 * 1e6  # N·mm
                f_max = 5 * M_service * L**2 / (48 * Bs)  # mm
                f_limit = L / 250  # common limit
                if f_limit > 0:
                    computed['挠度'] = f_max / f_limit

        except (ZeroDivisionError, ValueError, TypeError):
            pass

    # 裂缝宽度 (§7.1.2): ω_max = α_cr·ψ·σ_sk/Es·(1.9·c_s+0.08·d_eq/ρ_te)
    if not _has_override('裂缝宽度') and Mx is not None and b is not None and h is not None:
        try:
            B = float(b)
            H = float(h)
            M_knm = abs(float(Mx)) / 1e6
            h0 = H - (float(cover) if isinstance(cover, (int, float)) else 40)

            # Rebar: use model design values, fallback to minimum
            if isinstance(As_design, (int, float)) and float(As_design) > 0:
                As_crack = float(As_design)
            else:
                rho_min = max(0.002, 0.45 * mat['ft'] / mat['fy'])
                As_crack = rho_min * B * h0

            d_main = float(main_dia) if isinstance(main_dia, (int, float)) else (
                25 if H >= 600 else (20 if H >= 400 else 16))
            c_s = float(crack_cover) if isinstance(crack_cover, (int, float)) else 25

            # Effective tension zone
            A_te = 0.5 * B * H
            rho_te = As_crack / A_te if A_te > 0 else 0.01
            rho_te = max(rho_te, 0.01)  # minimum per §7.1.2

            # Service load steel stress (§7.1.4)
            M_service = M_knm * 0.6 * 1e6  # N·mm
            sigma_sk = M_service / (0.87 * h0 * As_crack) if As_crack > 0 and h0 > 0 else 0

            # Strain nonuniformity coefficient ψ
            if mat['ftk'] > 0 and rho_te > 0 and sigma_sk > 0:
                psi = 1.1 - 0.65 * mat['ftk'] / (rho_te * sigma_sk)
                psi = max(0.2, min(psi, 1.0))  # bounds
            else:
                psi = 0.2

            # Crack width (mm)
            alpha_cr = 1.9  # bending member
            d_eq = d_main
            if mat['Es'] > 0:
                omega = alpha_cr * psi * sigma_sk / mat['Es'] * (
                    1.9 * c_s + 0.08 * d_eq / rho_te
                )
                # Limit: 0.3mm (indoor normal environment, §3.4.5)
                w_lim = 0.3
                if w_lim > 0:
                    computed['裂缝宽度'] = omega / w_lim
        except (ZeroDivisionError, ValueError, TypeError):
            pass

    # 钢筋净距 (§9.2.1 beam / §9.3.1 column): s_n >= limit
    bar_count = elem.get('bar_count')
    sn = elem.get('sn')
    main_dia = elem.get('main_dia')
    if isinstance(bar_count, (int, float)) and isinstance(sn, (int, float)) and isinstance(main_dia, (int, float)):
        try:
            elem_type = _resolve_element_type(elem_id, context)
            if elem_type == 'column':
                sn_limit = max(1.5 * float(main_dia), 50.0)  # §9.3.1
            else:
                sn_limit = max(1.5 * float(main_dia), 30.0)  # §9.2.1 (top bars, conservative)
            if sn_limit > 0:
                if float(sn) > 0:
                    computed['钢筋净距'] = sn_limit / float(sn)
                elif float(bar_count) > 1:
                    computed['钢筋净距'] = 99.0  # physically impossible layout → fail
        except (ZeroDivisionError, ValueError, TypeError):
            pass

    return computed


def _build_chapter_summaries(checks: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    chapters = []
    for check in checks:
        chapter_name = check.get('chapter') or check.get('name')
        items = check.get('items', [])
        max_utilization = 0.0
        status = 'pass'
        controlling_clause = None
        for item in items:
            util_val = item.get('utilization')
            utilization = float(util_val) if util_val is not None else 0.0
            if utilization >= max_utilization:
                max_utilization = utilization
                controlling_clause = item.get('clause')
            if item.get('status') != 'pass':
                status = 'fail'
        chapters.append({
            'chapter': chapter_name,
            'status': status,
            'itemCount': len(items),
            'maxUtilization': round(max_utilization, 4),
            'controllingClause': controlling_clause,
        })
    return chapters


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
    3. elementData 为空时优雅回退（保留原有确定性 fallback 行为）
    """
    element_context = _resolve_element_context(elem_id, context)
    element_type = _resolve_element_type(elem_id, context)

    # Compute utilization overrides immutably — merge into a copy of context
    computed = _compute_utilization_overrides(elem_id, context)
    if computed:
        existing_ube = context.get('utilizationByElement')
        if not isinstance(existing_ube, dict):
            existing_ube = {}
        existing_elem = existing_ube.get(elem_id)
        if not isinstance(existing_elem, dict):
            existing_elem = {}
        merged_ctx = {
            **context,
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

    checks = _check_column(checker, elem_id, merged_ctx) if element_type == 'column' else _check_beam(checker, elem_id, merged_ctx)
    result = checker._build_element_result(elem_id, element_type, checks, 'GB50010-2010')
    result['chapters'] = _build_chapter_summaries(checks)
    result['chapterCount'] = len(result['chapters'])
    result['elementContext'] = {
        'type': element_type,
        'section': element_context.get('section'),
        'material': element_context.get('material'),
        'concreteGrade': element_context.get('concreteGrade'),
        'rebarGrade': element_context.get('rebarGrade'),
    }
    return result
