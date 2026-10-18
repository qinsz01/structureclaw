"""Code-determined design values with their sources.

GB 50017-2017 Table 4.4.1 (steel design strengths by grade and thickness group) and GB 50010-2010
Tables 4.1.3/4.1.4/4.1.5 and 4.2.2/4.2.3/4.2.5 (concrete and reinforcement). Every lookup returns
the value together with a human-readable source so checks can show where each number came from.
Values are N/mm2 (MPa); thicknesses are mm.
"""
from __future__ import annotations

import math
import re
from typing import Any, Dict, Optional, Tuple

# (upper thickness bound mm, f, fv, fy). A row applies to previous bound < t <= upper bound.
# Q355-Q460 yield strengths follow GB/T 1591-2018; Q345 is the GB 50017-2017 table row.
STEEL_TABLE_4_4_1: Dict[str, Tuple[Tuple[float, float, float, float], ...]] = {
    'Q235': ((16, 215, 125, 235), (40, 205, 120, 225), (100, 200, 115, 215)),
    'Q345': ((16, 305, 175, 345), (40, 295, 170, 335), (63, 290, 165, 325), (80, 280, 160, 315), (100, 270, 155, 305)),
    'Q355': ((16, 305, 175, 355), (40, 295, 170, 345), (63, 290, 165, 335), (80, 280, 160, 325), (100, 270, 155, 315)),
    'Q390': ((16, 345, 200, 390), (40, 330, 190, 380), (63, 310, 180, 360), (100, 295, 170, 340)),
    'Q420': ((16, 375, 215, 420), (40, 355, 205, 410), (63, 320, 185, 390), (100, 305, 175, 370)),
    'Q460': ((16, 410, 235, 460), (40, 390, 225, 450), (63, 355, 205, 430), (100, 340, 195, 410)),
}

STEEL_SOURCE = 'GB 50017-2017 表4.4.1 / Table 4.4.1'


def normalize_steel_grade(raw: Any) -> Optional[str]:
    """Q355B -> Q355; unknown or non-steel labels -> None."""
    if not isinstance(raw, str):
        return None
    match = re.fullmatch(r'(Q\d{3})[A-E]?', raw.strip().upper().replace(' ', ''))
    return match.group(1) if match and match.group(1) in STEEL_TABLE_4_4_1 else None


def _fmt(value: float) -> str:
    return f'{value:g}'


def steel_strength(grade: Any, thickness_mm: Any) -> Optional[Dict[str, Any]]:
    """f, fv, fy for a grade and governing plate thickness, or None outside the table."""
    base = normalize_steel_grade(grade)
    if base is None or isinstance(thickness_mm, bool) or not isinstance(thickness_mm, (int, float)):
        return None
    t = float(thickness_mm)
    if not math.isfinite(t) or t <= 0:
        return None
    lower = 0.0
    for upper, f, fv, fy in STEEL_TABLE_4_4_1[base]:
        if t <= upper:
            group = f't≤{_fmt(upper)}' if lower == 0 else f'{_fmt(lower)}<t≤{_fmt(upper)}'
            condition = f't={_fmt(t)}mm≤{_fmt(upper)}' if lower == 0 else f't={_fmt(t)}mm, {group}'
            return {'f': float(f), 'fv': float(fv), 'fy': float(fy), 'grade': base, 'thicknessMm': t, 'group': group,
                    'source': f'GB 50017-2017 表4.4.1, {base}, {condition}'}
        lower = float(upper)
    return None


def nominal_yield(grade: Any) -> Optional[float]:
    """Yield strength named by the grade (Q355 -> 355), used by εk."""
    base = normalize_steel_grade(grade)
    return float(base[1:]) if base else None


def epsilon_k(grade: Any) -> Optional[float]:
    """εk = sqrt(235/fy), fy being the yield strength named by the grade (GB 50017-2017 2.2)."""
    fy = nominal_yield(grade)
    return math.sqrt(235.0 / fy) if fy else None


# GB 50017-2017 Table 3.5.1, class S4: the class 6.1.1 needs for the full section modulus with γx = 1.0.
WIDTH_THICKNESS_S4 = {'flange': 15.0, 'beam_web': 124.0}

# GB 50010-2010 Tables 4.1.3 (fck, ftk), 4.1.4 (fc, ft), 4.1.5 (Ec) and 6.2.6 (ecu, alpha1, beta1).
CONCRETE_GRADES: Dict[str, Dict[str, float]] = {
    'C15':  {'fck': 10.0, 'ftk': 1.27, 'fc': 7.2,  'ft': 0.91, 'Ec': 22000, 'ecu': 0.0033, 'alpha1': 1.0,  'beta1': 0.80},
    'C20':  {'fck': 13.4, 'ftk': 1.54, 'fc': 9.6,  'ft': 1.10, 'Ec': 25500, 'ecu': 0.0033, 'alpha1': 1.0,  'beta1': 0.80},
    'C25':  {'fck': 16.7, 'ftk': 1.78, 'fc': 11.9, 'ft': 1.27, 'Ec': 28000, 'ecu': 0.0033, 'alpha1': 1.0,  'beta1': 0.80},
    'C30':  {'fck': 20.1, 'ftk': 2.01, 'fc': 14.3, 'ft': 1.43, 'Ec': 30000, 'ecu': 0.0033, 'alpha1': 1.0,  'beta1': 0.80},
    'C35':  {'fck': 23.4, 'ftk': 2.20, 'fc': 16.7, 'ft': 1.57, 'Ec': 31500, 'ecu': 0.0033, 'alpha1': 1.0,  'beta1': 0.80},
    'C40':  {'fck': 26.8, 'ftk': 2.39, 'fc': 19.1, 'ft': 1.71, 'Ec': 32500, 'ecu': 0.0033, 'alpha1': 1.0,  'beta1': 0.80},
    'C45':  {'fck': 29.6, 'ftk': 2.51, 'fc': 21.1, 'ft': 1.80, 'Ec': 33500, 'ecu': 0.0033, 'alpha1': 1.0,  'beta1': 0.80},
    'C50':  {'fck': 32.4, 'ftk': 2.64, 'fc': 23.1, 'ft': 1.89, 'Ec': 34500, 'ecu': 0.0033, 'alpha1': 1.0,  'beta1': 0.80},
    'C55':  {'fck': 35.5, 'ftk': 2.74, 'fc': 25.3, 'ft': 1.96, 'Ec': 35500, 'ecu': 0.00325, 'alpha1': 0.99, 'beta1': 0.79},
    'C60':  {'fck': 38.5, 'ftk': 2.85, 'fc': 27.5, 'ft': 2.04, 'Ec': 36000, 'ecu': 0.0032, 'alpha1': 0.98, 'beta1': 0.78},
    'C65':  {'fck': 41.5, 'ftk': 2.93, 'fc': 29.7, 'ft': 2.09, 'Ec': 36500, 'ecu': 0.00315, 'alpha1': 0.97, 'beta1': 0.77},
    'C70':  {'fck': 44.5, 'ftk': 2.99, 'fc': 31.8, 'ft': 2.14, 'Ec': 37000, 'ecu': 0.0031, 'alpha1': 0.96, 'beta1': 0.76},
    'C75':  {'fck': 47.4, 'ftk': 3.05, 'fc': 33.8, 'ft': 2.18, 'Ec': 37500, 'ecu': 0.00305, 'alpha1': 0.95, 'beta1': 0.75},
    'C80':  {'fck': 50.2, 'ftk': 3.11, 'fc': 35.9, 'ft': 2.22, 'Ec': 38000, 'ecu': 0.003,  'alpha1': 0.94, 'beta1': 0.74},
}

# GB 50010-2010 (2015) Tables 4.2.2 (fyk, fstk), 4.2.3 (fy, fy', fyv) and 4.2.5 (Es).
REBAR_GRADES: Dict[str, Dict[str, float]] = {
    'HPB300': {'fyk': 300, 'fstk': 420, 'fy': 270, 'fy_compression': 270, 'fyv': 270, 'Es': 210000},
    'HRB335': {'fyk': 335, 'fstk': 455, 'fy': 300, 'fy_compression': 300, 'fyv': 300, 'Es': 200000},
    'HRB400': {'fyk': 400, 'fstk': 540, 'fy': 360, 'fy_compression': 360, 'fyv': 360, 'Es': 200000},
    'HRBF400': {'fyk': 400, 'fstk': 540, 'fy': 360, 'fy_compression': 360, 'fyv': 360, 'Es': 200000},
    'RRB400': {'fyk': 400, 'fstk': 540, 'fy': 360, 'fy_compression': 360, 'fyv': 360, 'Es': 200000},
    'HRB500': {'fyk': 500, 'fstk': 630, 'fy': 435, 'fy_compression': 410, 'fyv': 360, 'Es': 200000},
    'HRBF500': {'fyk': 500, 'fstk': 630, 'fy': 435, 'fy_compression': 410, 'fyv': 360, 'Es': 200000},
}

CONCRETE_TABLES = {'fc': '表4.1.4-1', 'ft': '表4.1.4-2', 'fck': '表4.1.3-1', 'ftk': '表4.1.3-2', 'Ec': '表4.1.5',
                   'ecu': '6.2.6', 'alpha1': '6.2.6', 'beta1': '6.2.6'}
REBAR_TABLES = {'fy': '表4.2.3-1', 'fy_compression': '表4.2.3-1', 'fyv': '表4.2.3-1 (≤360, 6.3.4)', 'fyk': '表4.2.2-1',
                'fstk': '表4.2.2-1', 'Es': '表4.2.5'}


def normalize_grade(raw: Any) -> Optional[str]:
    return raw.strip().upper().replace(' ', '') if isinstance(raw, str) and raw.strip() else None


def concrete_value(grade: Any, key: str) -> Optional[Dict[str, Any]]:
    base = normalize_grade(grade)
    row = CONCRETE_GRADES.get(base or '')
    if row is None or key not in row:
        return None
    return {'value': float(row[key]), 'source': f'GB 50010-2010 {CONCRETE_TABLES[key]}, {base}'}


def rebar_value(grade: Any, key: str) -> Optional[Dict[str, Any]]:
    base = normalize_grade(grade)
    row = REBAR_GRADES.get(base or '')
    if row is None or key not in row:
        return None
    return {'value': float(row[key]), 'source': f'GB 50010-2010 {REBAR_TABLES[key]}, {base}'}
