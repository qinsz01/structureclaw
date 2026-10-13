"""Deterministic section geometry; never reconcile contradictory numeric inputs.

Dimensions are mm; A is m2 and I/J are m4. The comparison tolerance (1e-6
relative) permits numeric serialization roundoff, not alternate section physics.
Historical catalog tables are not a verified source of rolled-section properties.
"""
from __future__ import annotations

import math


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
        if h <= 2*tf or b <= tw or shape.tf2 not in (None, tf) or shape.B2 not in (None, b) or shape.r:
            return None  # No unverified unequal-flange/fillet approximation.
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


def validate_section_physics(section):
    props = section.properties
    for key in ('A', 'Iy', 'Iz', 'J', 'Wx', 'Wz', 'Wnx', 'S', 'Sz', 'As', 'Asz', 'tw', 'tz'):
        if key in props and (isinstance(props[key], bool) or not isinstance(props[key], (float, int))
                             or not math.isfinite(props[key]) or props[key] <= 0):
            raise ValueError(f"Section '{section.id}' {key} must be finite and positive")
    if section.standard_steel_name and (section.shape or props):
        raise ValueError(f"Section '{section.id}' combines a catalog name and explicit geometry/properties; "
                         'catalog mapping is not calibrated. Supply one reviewed numerical section source.')
    if not section.shape:
        return
    shape = section.shape
    for legacy, canonical in (('width', 'B'), ('height', 'H'), ('diameter', 'd'), ('thickness', 'T')):
        a, b = getattr(section, legacy), getattr(shape, canonical)
        if a is not None and b is not None and not math.isclose(a, b, rel_tol=1e-6, abs_tol=1e-9):
            raise ValueError(f"Section '{section.id}' {legacy} conflicts with shape.{canonical}")
    derived = geometry_properties(shape)
    if derived is None:
        if any(key in props for key in ('A', 'Iy', 'Iz')):
            raise ValueError(f"Section '{section.id}' geometry/property consistency is unverified for shape '{shape.kind}'")
        return
    for key in ('A', 'Iy', 'Iz'):
        if key in props and not math.isclose(float(props[key]), derived[key], rel_tol=1e-6, abs_tol=1e-14):
            raise ValueError(f"Section '{section.id}' properties.{key}={props[key]} conflicts with geometry ({derived[key]})")
    # Gross elastic moduli have the same geometric source as I. A net modulus
    # may be smaller (e.g. documented holes), but must never exceed the gross one.
    h = shape.H or shape.d
    b = shape.B or shape.d
    moduli = {'Wx': derived['Iy']/(h/2000), 'Wz': derived['Iz']/(b/2000)} if h and b else {}
    for key, expected in moduli.items():
        if key in props and not math.isclose(props[key], expected, rel_tol=1e-6, abs_tol=1e-14):
            raise ValueError(f"Section '{section.id}' properties.{key} conflicts with geometry ({expected})")
    if 'Wnx' in props and 'Wx' in moduli and props['Wnx'] > moduli['Wx']*(1+1e-6):
        raise ValueError(f"Section '{section.id}' net Wnx exceeds gross geometric modulus")
    if shape.kind in {'circular', 'pipe', 'hollow-circular'} and 'J' in props:
        if not math.isclose(props['J'], derived['J'], rel_tol=1e-6, abs_tol=1e-14):
            raise ValueError(f"Section '{section.id}' properties.J conflicts with circular geometry ({derived['J']})")
    # J depends on the stated torsion model. Preserve an explicit J; otherwise
    # record the documented solid-rectangle/thin-wall approximation as its source.
    missing = {key: value for key, value in derived.items() if key not in props}
    if missing:
        section.properties = {**props, **missing}
        section.extra = {**section.extra, 'derived_properties': {
            'method': 'section-geometry-v1', 'fields': sorted(missing), 'shape': shape.model_dump(exclude_none=True)}}
