"""Independent analytical checks for the native acceptance oracle itself."""
import math

import pytest

from native_frame_reference import solve


@pytest.mark.parametrize('a,b,point', [(0., 4., False), (1., 3., False),
                                      (1.3, 1.3, True), (4., 4., True)])
def test_cantilever_free_end_with_load_breaks(a, b, point):
    length, load, young, shear = 4., 7., 206000000., 79230769.23076923
    area, inertia = .3*.6, .3*.6**3/12
    member_load = ({'type': 'point', 'position': a, 'fz': -load} if point else
                   {'type': 'distributed', 'start': a, 'end': b, 'wz': -load})
    model = {
        'nodes': [{'id': 'A', 'x': 0, 'y': 0, 'z': 0, 'restraints': [True]*6},
                  {'id': 'B', 'x': length, 'y': 0, 'z': 0}],
        'elements': [{'id': 'beam', 'type': 'beam', 'nodes': ['A', 'B'], 'material': 'steel', 'section': 'rect'}],
        'materials': [{'id': 'steel', 'E': young/1000, 'G': shear/1000, 'nu': .3}],
        'sections': [{'id': 'rect', 'shape': {'kind': 'rectangular', 'B': 300, 'H': 600}}],
        'load_cases': [{'id': 'D', 'loads': [{'element': 'beam', **member_load}]}],
    }
    result = solve(model, 'D')
    if point:
        displacement = load*a*a*(3*length-a)/(6*young*inertia)+load*a/(shear*5*area/6)
        rotation = load*a*a/(2*young*inertia)
        total, moment = load, load*a
    else:
        primitive = lambda x: (length*x**3-x**4/4)/(6*young*inertia)+x*x/(2*shear*5*area/6)
        displacement = load*(primitive(b)-primitive(a))
        rotation = load*(b**3-a**3)/(6*young*inertia)
        total, moment = load*(b-a), load*(b*b-a*a)/2
    assert math.isclose(result['displacements']['B']['uz'], -displacement, rel_tol=1e-12, abs_tol=1e-15)
    assert math.isclose(result['displacements']['B']['ry'], rotation, rel_tol=1e-12, abs_tol=1e-15)
    assert math.isclose(result['reactions']['A']['fz'], total, rel_tol=1e-12, abs_tol=1e-12)
    assert math.isclose(result['reactions']['A']['my'], -moment, rel_tol=1e-12, abs_tol=1e-12)
