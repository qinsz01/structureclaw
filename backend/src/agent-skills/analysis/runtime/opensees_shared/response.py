"""Canonical right-handed local end actions; no section-diagram reconstruction."""
import math


def canonical_frame_end_actions(values, dimension):
    values = [float(v) for v in values]
    expected = 6 if dimension == '2d' else 12
    if len(values) != expected or not all(math.isfinite(v) for v in values):
        raise ValueError('OpenSees returned incomplete or non-finite local frame actions')
    ends = []
    for v in (values[:expected//2], values[expected//2:]):
        if dimension == '2d':
            ends.append(dict(N=v[0], V=v[1], M=-v[2], V2=0.0, V3=v[1], T=0.0, M2=-v[2], M3=0.0))
        else:
            ends.append(dict(N=v[0], V=math.hypot(v[1],v[2]), M=math.hypot(v[4],v[5]),
                             V2=v[1], V3=v[2], T=v[3], M2=v[4], M3=v[5]))
    return {'n1': ends[0], 'n2': ends[1], 'rawComponents': values,
            'rawReferenceFrame': 'OpenSees-element-local', 'referenceFrame': 'element-local',
            'responseCoordinateConvention': 'global-xyz'}
