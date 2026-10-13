"""Validate explicit V2 load kind and units before any adapter can ignore them."""


def validate_load_contract(load):
    kind = str(load.get('type', '')).lower()
    if kind not in {'', 'nodal', 'distributed', 'point', 'displacement', 'settlement'}:
        raise ValueError(f"Unsupported structural load type '{kind}'")
    if 'load_type' in load:
        raise ValueError("Use the explicit V2 load.type field; load_type cannot be ignored")
    member = any(load.get(k) is not None for k in ('element', 'elementId', 'element_id'))
    kind = kind or ('distributed' if member else 'nodal')
    canonical = {'force':'kN', 'moment':'kN.m', 'distributed':'kN/m',
                 'length':'m', 'position':'m', 'displacement':'m', 'rotation':'rad'}

    def require_unit(value, expected, field):
        if not isinstance(value, str) or value.replace('·', '.').replace('*', '.') != expected:
            raise ValueError(f"V2 load {field} must be '{expected}'; convert explicit source units before analysis")

    for name, expected in canonical.items():
        for key in (f'{name}_unit', f'{name}Unit'):
            if key in load:
                require_unit(load[key], expected, key)
    if 'units' in load:
        if not isinstance(load['units'], dict):
            raise ValueError('V2 load.units must explicitly map quantity names to canonical units')
        for name, value in load['units'].items():
            if name not in canonical:
                raise ValueError(f"Unknown V2 load quantity unit '{name}'")
            require_unit(value, canonical[name], f'units.{name}')
    if 'unit' in load:
        if kind == 'distributed':
            expected = 'kN/m'
        elif kind in {'displacement', 'settlement'}:
            translations = any(k in load for k in ('ux','uy','uz'))
            rotations = any(k in load for k in ('rx','ry','rz'))
            if translations and rotations:
                raise ValueError('Mixed translation/rotation requires explicit units mapping, not one unit')
            expected = 'rad' if rotations else 'm'
        else:
            forces = any(k in load for k in ('fx','fy','fz','forces'))
            moments = any(k in load for k in ('mx','my','mz')) or str(load.get('direction',load.get('axis',''))) in {'mx','my','mz','rx','ry','rz'}
            if forces and moments:
                raise ValueError('Mixed force/moment load requires explicit units mapping, not one unit')
            expected = 'kN.m' if moments else 'kN'
        require_unit(load['unit'], expected, 'unit')
    if isinstance(load.get('points'), list):
        for point in load['points']:
            if not isinstance(point, dict):
                raise ValueError('Piecewise load points must be objects')
            validate_load_contract({**point, 'type':'distributed'})
