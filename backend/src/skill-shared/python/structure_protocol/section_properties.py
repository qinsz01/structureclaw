"""Section geometry in mm; explicit properties (m²/m⁴) take precedence."""
from __future__ import annotations

import math

# Consumed numeric properties, shared by physical validation and the exported
# field/unit contract. Other legacy annotations remain readable.
SECTION_PROPERTY_UNITS = {
    'A': 'm2', 'As': 'm2', 'Asy': 'm2', 'Asz': 'm2',
    'Iy': 'm4', 'Iz': 'm4', 'J': 'm4',
    'Wx': 'm3', 'Wz': 'm3', 'Wnx': 'm3', 'S': 'm3', 'Sz': 'm3',
    'tw': 'm', 'tz': 'm', 'b': 'm', 't': 'm', 'imin': 'm',
}


def geometry_properties(shape):
    kind = shape.kind
    h, b = shape.H, shape.B
    if kind == 'rectangular' and h and b:
        wide, narrow = max(h, b), min(h, b)
        return {'A': b*h/1e6, 'Iy': b*h**3/12e12, 'Iz': h*b**3/12e12,
            'J': wide*narrow**3*(1/3-.21*narrow/wide*(1-narrow**4/(12*wide**4)))/1e12}
    if kind in {'circular', 'pipe', 'hollow-circular'} and shape.d:
        d, inner = shape.d, shape.d2 or (shape.d-2*shape.T if shape.T else 0)
        if kind != 'circular' and not (shape.d2 or shape.T):
            return None
        if not 0 <= inner < d:
            raise ValueError('Circular section requires 0 <= inner diameter < outer diameter')
        return {'A': math.pi*(d*d-inner*inner)/4e6,
                'Iy': math.pi*(d**4-inner**4)/64e12, 'Iz': math.pi*(d**4-inner**4)/64e12,
                'J': math.pi*(d**4-inner**4)/32e12}
    if kind in {'H', 'I', 'built-up-I'} and all((h, b, shape.tw, shape.tf)):
        tw, tf = shape.tw, shape.tf
        if h <= 2*tf or b <= tw:
            raise ValueError('I section requires positive clear web height and flange outstand / '
                             'I 形截面的腹板净高和翼缘外伸宽度必须为正')
        if shape.tf2 not in (None, tf) or shape.B2 not in (None, b):
            return None  # Unequal flanges still require explicit properties.
        # Fillets are omitted from this sharp-corner idealization; the caller
        # records that approximation and preserves the supplied radius.
        hw = h-2*tf
        return {'A': (2*b*tf+tw*hw)/1e6,
            'Iy': (tw*hw**3/12+2*b*tf**3/12+2*b*tf*((hw+tf)/2)**2)/1e12,
            'Iz': (2*tf*b**3/12+hw*tw**3/12)/1e12,
            'J': (2*b*tf**3+hw*tw**3)/3e12}
    if kind in {'box', 'built-up-box'} and all((h, b, shape.T)):
        t = shape.T
        if min(h, b) <= 2*t:
            raise ValueError('Box thickness must be less than half its smallest dimension')
        return {'A': (b*h-(b-2*t)*(h-2*t))/1e6,
            'Iy': (b*h**3-(b-2*t)*(h-2*t)**3)/12e12,
            'Iz': (h*b**3-(h-2*t)*(b-2*t)**3)/12e12}
    return None


def _check_derived_section_metadata(section):
    """Accept geometry provenance only when its claim can be recomputed now."""
    extra = section.get('extra') or {}
    if 'derived_properties' not in extra:
        return
    record = extra['derived_properties']
    error = f"Section '{section.get('id')}' extra.derived_properties conflicts with geometry/properties / 截面派生来源与当前几何或属性不符"
    if not isinstance(record, dict) or set(record) != {'method', 'fields', 'shape'} or record.get('method') != 'section-geometry-v1':
        raise ValueError(error)
    from .structure_model_v2 import SectionShape
    shape = SectionShape.model_validate(section.get('shape'))
    if record.get('shape') != shape.model_dump(exclude_none=True):
        raise ValueError(error)
    expected = geometry_properties(shape)
    fields = record.get('fields')
    if not expected or not isinstance(fields, list) or not fields or any(not isinstance(key, str) for key in fields):
        raise ValueError(error)
    if len(set(fields)) != len(fields) or set(fields) - set(expected):
        raise ValueError(error)
    properties = section.get('properties') or {}
    for key in fields:
        value = properties.get(key)
        if (type(value) not in (int, float) or not math.isfinite(value)
                or not math.isclose(value, expected[key], rel_tol=1e-6, abs_tol=1e-14)):
            raise ValueError(error + f' ({key})')


def validate_derived_section_metadata(section):
    """Stale provenance is advisory; it never replaces supplied numerical values."""
    try:
        _check_derived_section_metadata(section)
    except (ValueError, TypeError, KeyError, AttributeError):
        return {'code': 'SECTION_PROVENANCE_CONFLICT', 'severity': 'warning', 'message': {
            'en': 'Derived provenance conflicts with current geometry/properties; using current values.',
            'zh': '截面派生来源与当前几何或属性不符；采用当前显式数值。'}}
    return None


def validate_section_physics(section):
    props = section.properties
    for key in SECTION_PROPERTY_UNITS:
        if key in props and (isinstance(props[key], bool) or not isinstance(props[key], (float, int))
                             or not math.isfinite(props[key]) or props[key] <= 0):
            raise ValueError(f"Section '{section.id}' {key} must be finite and positive")
    if 'Wnx' in props and 'Wx' in props and props['Wnx'] > props['Wx']*1.05:
        raise ValueError(f"Section '{section.id}' net Wnx exceeds gross modulus by more than 5% / "
                         '净截面模量 Wnx 超过毛截面模量的 1.05 倍')
    diagnostics = []
    extra = {key: value for key, value in section.extra.items()
             if key not in {'section_diagnostics', 'property_geometry_delta'}}

    def note(code, en, zh, severity='warning'):
        diagnostics.append({'code': code, 'severity': severity, 'message': {'en': en, 'zh': zh}})
        section.extra = {**extra, 'section_diagnostics': diagnostics}

    provenance = validate_derived_section_metadata(section.model_dump(exclude_none=True))
    if provenance:
        diagnostics.append(provenance)
    # Retain conflicts after canonicalizing type/dimensions on a previous pass.
    diagnostics.extend(row for row in section.extra.get('section_diagnostics', [])
                       if row.get('code') in {'SECTION_TYPE_CONFLICT', 'SECTION_DIMENSION_CONFLICT'})
    section.extra = {**extra, **({'section_diagnostics': diagnostics} if diagnostics else {})}
    if section.standard_steel_name and (section.shape or props):
        note('SECTION_CATALOG_LABEL', 'Explicit geometry/properties used; the catalogue name is only a label.',
             '采用显式几何和属性；目录名称仅作标签。')
    if not section.shape:
        return
    shape = section.shape
    for name, value in shape.model_dump(exclude_none=True).items():
        if name != 'kind' and isinstance(value, (float, int)) and not math.isfinite(value):
            raise ValueError(f"Section '{section.id}' shape.{name} must be finite")
    kind_aliases = {'H':'I', 'built-up-I':'I', 'built-up-box':'box', 'hollow-circular':'pipe'}
    known_kinds = {'rectangular','circular','pipe','I','box','T','channel','angle'}
    declared_kind = kind_aliases.get(section.type, section.type)
    geometric_kind = kind_aliases.get(shape.kind, shape.kind)
    if declared_kind in known_kinds and declared_kind != geometric_kind:
        extra['type_shape_conflict'] = {'type': section.type, 'shape.kind': shape.kind}
        note('SECTION_TYPE_CONFLICT', f"type '{section.type}' conflicts with shape.kind '{shape.kind}'; using shape.",
             f'类型 {section.type} 与几何类型 {shape.kind} 不同；采用 shape。')
        section.type = shape.kind
    for legacy, canonical in (('width', 'B'), ('height', 'H'), ('diameter', 'd'), ('thickness', 'T')):
        a, b = getattr(section, legacy), getattr(shape, canonical)
        if a is not None and b is not None and not math.isclose(a, b, rel_tol=1e-6, abs_tol=1e-9):
            extra[f'{legacy}_shape_conflict'] = {legacy: a, f'shape.{canonical}': b}
            note('SECTION_DIMENSION_CONFLICT', f'{legacy}={a} conflicts with shape.{canonical}={b}; using shape.',
                 f'{legacy}={a} 与 shape.{canonical}={b} 不同；采用 shape。')
            setattr(section, legacy, b)
    derived = geometry_properties(shape)
    if derived is None:
        if any(key in props for key in ('A', 'Iy', 'Iz')):
            note('SECTION_GEOMETRY_UNVERIFIED', 'Geometry comparison unavailable; using explicit section properties.',
                 '无法比较该几何的截面属性；采用显式截面数值。')
        return
    if shape.kind in {'H', 'I', 'built-up-I'} and shape.r:
        note('SECTION_FILLET_IGNORED',
             f'Geometry derivation/comparison ignores fillet r={shape.r:g} mm (sharp corners); explicit user properties take precedence.',
             f'几何推导和比较不计圆角 r={shape.r:g} mm，采用尖角近似；用户显式提供的属性仍优先。')
    # Gross elastic moduli have the same geometric source as I. A net modulus
    # may be smaller (e.g. documented holes), but must never exceed the gross one.
    h = shape.H or shape.d
    b = shape.B or shape.d
    moduli = {'Wx': derived['Iy']/(h/2000), 'Wz': derived['Iz']/(b/2000)} if h and b else {}
    compared = {key: value for key, value in derived.items() if key != 'J'} | moduli
    if shape.kind in {'circular', 'pipe', 'hollow-circular'}:
        compared['J'] = derived['J']
    delta = {}
    for key, expected in compared.items():
        # Five significant figures suffice for serialized engineering properties.
        if key in props and not math.isclose(props[key], expected, rel_tol=5e-5, abs_tol=1e-14):
            difference = (props[key]/expected-1)*100
            delta[key] = difference
            note('SECTION_PROPERTY_GEOMETRY_DELTA',
                 f'{key}: user/catalogue section property used; differs from sharp-corner geometry by {difference:+.2f}%.',
                 f'{key}：截面属性采用用户/目录值，与不计圆角的几何值相差 {difference:+.2f}%。',
                 'warning' if abs(difference) > 5 else 'info')
    if delta:
        section.extra = {**section.extra, 'property_geometry_delta': delta}
    gross = props.get('Wx', props.get('Iy', derived['Iy'])/(h/2000)) if h else None
    if 'Wnx' in props and gross and props['Wnx'] > gross*1.05:
        raise ValueError(f"Section '{section.id}' net Wnx exceeds gross modulus by more than 5% / "
                         '净截面模量 Wnx 超过毛截面模量的 1.05 倍')
    # J depends on the stated torsion model. Preserve an explicit J; otherwise
    # record the documented solid-rectangle/thin-wall approximation as its source.
    missing = {key: value for key, value in derived.items() if key not in props}
    if missing:
        section.properties = {**props, **missing}
        section.extra = {**section.extra, 'derived_properties': {
            'method': 'section-geometry-v1', 'fields': sorted(missing), 'shape': shape.model_dump(exclude_none=True)}}
