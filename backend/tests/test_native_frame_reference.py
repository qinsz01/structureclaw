"""Independent analytical checks for the native acceptance oracle itself."""
import math

import pytest

from native_frame_reference import solve


@pytest.mark.parametrize('component', ['fx', 'fy', 'fz', 'mx', 'my', 'mz'])
def test_numeric_custom_cantilever_matches_six_closed_form_effects(component):
    length, force, E, G = 3., 7., 203000000., 76321000.
    p = {'A': .134, 'Iy': .00241, 'Iz': .00117, 'J': .000837, 'Asy': .067, 'Asz': .039}
    model = {'nodes': [{'id': 'A', 'x': 0., 'y': 0., 'z': 0., 'restraints': [True]*6},
                       {'id': 'B', 'x': length, 'y': 0., 'z': 0.}],
        'materials': [{'id': 'M', 'E': E/1000, 'G': G/1000, 'nu': .31}],
        'sections': [{'id': 'S', 'type': 'custom', 'properties': p}],
        'elements': [{'id': 'B', 'nodes': ['A', 'B'], 'material': 'M', 'section': 'S'}],
        'load_cases': [{'id': 'L', 'loads': [{'type': 'nodal', 'node': 'B', component: force}]}]}
    expected = dict.fromkeys(('ux', 'uy', 'uz', 'rx', 'ry', 'rz'), 0.)
    if component == 'fx': expected['ux'] = force*length/(E*p['A'])
    if component == 'mx': expected['rx'] = force*length/(G*p['J'])
    if component == 'fy':
        expected['uy'] = force*length**3/(3*E*p['Iz'])+force*length/(G*p['Asy'])
        expected['rz'] = force*length**2/(2*E*p['Iz'])
    if component == 'fz':
        expected['uz'] = force*length**3/(3*E*p['Iy'])+force*length/(G*p['Asz'])
        expected['ry'] = -force*length**2/(2*E*p['Iy'])
    if component == 'my':
        expected['uz'] = -force*length**2/(2*E*p['Iy'])
        expected['ry'] = force*length/(E*p['Iy'])
    if component == 'mz':
        expected['uy'] = force*length**2/(2*E*p['Iz'])
        expected['rz'] = force*length/(E*p['Iz'])
    actual = solve(model, 'L')['displacements']['B']
    for key, value in expected.items():
        assert math.isclose(actual[key], value, rel_tol=1e-12, abs_tol=1e-15)


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
