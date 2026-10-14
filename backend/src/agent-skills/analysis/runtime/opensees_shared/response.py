"""Canonical right-handed local end actions; no section-diagram reconstruction."""
import math


def member_end_actions(builder, ops, element):
    """Same signed elastic end-force contract for static and transient frames."""
    tag = builder._ops_element_tag(element.id)
    area = builder._section_property(builder.sections[element.section], 'A')
    if element.type in {'beam', 'column'}:
        force = canonical_frame_end_actions(ops.eleResponse(tag, 'localForce'), builder.dimension,
                                            element.rotation_angle)
        force.update(axial=force['n1']['N'], stress=force['n1']['N']/area)
    else:
        raw = ops.eleResponse(tag, 'axialForce')
        if len(raw) != 1 or not math.isfinite(float(raw[0])):
            raise ValueError(f'OpenSees returned incomplete or non-finite axial force for {element.id}')
        axial = float(raw[0])
        force = {'axial': axial, 'stress': axial/area, 'axialConvention': 'tension-positive',
                 'n1': {'N': -axial}, 'n2': {'N': axial}}
    return {**force, 'referenceFrame': 'element-local',
            'localAxes': dict(zip(('x', 'y', 'z'), builder._element_axes(element).tolist())),
            'source': {'kind': 'solver-direct', 'quantity': 'elastic-element-end-resisting-actions',
                       'includesDampingForces': False, 'includesInertiaForces': False}}


def canonical_frame_end_actions(values, dimension, rotation_degrees=0.0):
    values = [float(v) for v in values]
    expected = 6 if dimension == '2d' else 12
    if len(values) != expected or not all(math.isfinite(v) for v in values):
        raise ValueError('OpenSees returned incomplete or non-finite local frame actions')
    ends = []
    for v in (values[:expected//2], values[expected//2:]):
        if dimension == '2d':
            c, s = ((1,0),(0,1),(-1,0),(0,-1))[round(float(rotation_degrees or 0)/90)%4]
            ends.append(dict(N=v[0], V=v[1], M=-v[2], V2=s*v[1], V3=c*v[1],
                             T=0.0, M2=-c*v[2], M3=s*v[2]))
        else:
            ends.append(dict(N=v[0], V=math.hypot(v[1],v[2]), M=math.hypot(v[4],v[5]),
                             V2=v[1], V3=v[2], T=v[3], M2=v[4], M3=v[5]))
    return {'n1': ends[0], 'n2': ends[1], 'rawComponents': values,
            'rawReferenceFrame': 'OpenSees-element-local', 'referenceFrame': 'element-local',
            'responseCoordinateConvention': 'global-xyz'}
