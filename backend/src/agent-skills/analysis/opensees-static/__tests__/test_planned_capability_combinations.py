"""Capability recipes from the 267 planned OpenSees scenarios, not their answers.

References are closed-form virtual work / bar equilibrium.  They do not import
the production assembler, mesh or recovery to produce expected values.
"""
from copy import deepcopy
from pathlib import Path
import sys

import numpy as np
import pytest

SKILL = Path(__file__).resolve().parents[1]
for path in (SKILL, SKILL.parent / 'runtime', SKILL.parents[2] / 'skill-shared' / 'python'):
    sys.path.insert(0, str(path))
from structure_protocol.structure_model_v2 import StructureModelV2
from opensees_static_analysis import OpenSeesStaticExecutor
from opensees_static_simplified_static_analysis import StaticAnalyzer


def solve(payload, **selection):
    model = StructureModelV2.model_validate(payload)
    return OpenSeesStaticExecutor(StaticAnalyzer(model)).run(selection or {'loadCaseIds': ['D']})


def base(dimension='3d'):
    return {'coordinate_system': {'semantics': 'global-z-up', 'version': 1,
            'dimension': dimension, 'plane': 'xz' if dimension == '2d' else None,
            'dof_order': ['ux', 'uy', 'uz', 'rx', 'ry', 'rz']},
        'nodes': [], 'elements': [],
        'materials': [{'id': 'm', 'name': 'explicit', 'E': 210000, 'G': 70000, 'nu': .25, 'rho': 7850}],
        'sections': [{'id': 's', 'name': 'explicit', 'type': 'beam',
            'properties': {'A': .023, 'Iy': .00031, 'Iz': .00067, 'J': .00009}}],
        'load_cases': [{'id': 'D', 'type': 'dead', 'loads': []}],
        'analysis_control': {'self_weight': False, 'rigid_floor': False}}


def tree_recipe():
    """Two orthogonal finite arms, a sloping branch, independent E/G/A/I/J."""
    model = base()
    xyz = {'O': [0, 0, 0], 'A': [0, 0, 3], 'B': [0, 0, 6],
           'C': [2, 0, 6], 'D': [0, -1.5, 3], 'E': [1.5, 0, 8]}
    edges = [('O', 'A'), ('A', 'B'), ('B', 'C'), ('A', 'D'), ('B', 'E')]
    # Explicit orthonormal principal axes; these are the independently stated
    # geometry, not a call to the production default-axis implementation.
    axes = [np.array(a, float) for a in (
        [[0, 0, 1], [0, 1, 0], [-1, 0, 0]],
        [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
        [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
        [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
        [[.6, 0, .8], [0, 1, 0], [-.8, 0, .6]])]
    model['nodes'] = [dict(id=k, x=v[0], y=v[1], z=v[2],
                            restraints=[True] * 6 if k == 'O' else None) for k, v in xyz.items()]
    model['materials'] = []
    model['sections'] = []
    for i, (a, b) in enumerate(edges):
        model['materials'].append({'id': f'm{i}', 'name': f'explicit-{i}', 'E': 190000 + i * 5000,
                                  'G': 65000 + i * 7000, 'nu': .28, 'rho': 7850})
        model['sections'].append({'id': f's{i}', 'type': 'beam', 'name': f'property-only-{i}',
            'properties': {'A': .02 + .001 * i, 'Iy': .0003 + .00007 * i,
                           'Iz': .0007 - .00003 * i, 'J': .0001 + .00001 * i}})
        model['elements'].append({'id': f'e{i}', 'nodes': [a, b], 'type': 'column' if i < 2 else 'beam',
                                  'material': f'm{i}', 'section': f's{i}'})
    model['metadata'] = {'elementReferenceVectors': {f'e{i}': a[2].tolist() for i, a in enumerate(axes)}}
    loads = {'A': [7, 0, -4, 0, 3, 0], 'C': [5, 11, -45, 2, -3, 4],
             'D': [13, -6, -22, 1, 2, -5], 'E': [-8, 10, -17, 3, 1, 2]}
    model['load_cases'][0]['loads'] = [dict(node=n, **dict(zip(('fx', 'fy', 'fz', 'mx', 'my', 'mz'), v)))
                                        for n, v in loads.items()]
    return model, xyz, edges, axes, loads


def tree_virtual_work(model, xyz, edges, axes, loads):
    """Exact Euler-Bernoulli energy integration of a statically determinate tree."""
    xyz = {k: np.array(v, float) for k, v in xyz.items()}
    children = {k: [] for k in xyz}
    for a, b in edges:
        children[a].append(b)
    def descendants(node):
        return {node}.union(*(descendants(n) for n in children[node]))
    expected = {}
    gauss, weights = np.polynomial.legendre.leggauss(3)
    for observed in xyz:
        values = np.zeros(6)
        for index in range(6):
            virtual = np.eye(6)[index]
            for i, (a, b) in enumerate(edges):
                below = descendants(b)
                if observed not in below:
                    continue
                length = np.linalg.norm(xyz[b] - xyz[a])
                p = model['sections'][i]['properties']
                mat = model['materials'][i]
                compliance = np.array([1 / (mat['E'] * 1000 * p['A']),
                    1 / (mat['G'] * 1000 * p['J']), 1 / (mat['E'] * 1000 * p['Iy']),
                    1 / (mat['E'] * 1000 * p['Iz'])])
                for g, weight in zip(gauss, weights):
                    x = xyz[a] + (xyz[b] - xyz[a]) * (g + 1) / 2
                    f, moment = np.zeros(3), np.zeros(3)
                    for node, vector in loads.items():
                        if node in below:
                            f += vector[:3]
                            moment += np.cross(xyz[node] - x, vector[:3]) + vector[3:]
                    vm = np.cross(xyz[observed] - x, virtual[:3]) + virtual[3:]
                    actual = np.r_[axes[i][0] @ f, axes[i] @ moment]
                    unit = np.r_[axes[i][0] @ virtual[:3], axes[i] @ vm]
                    values[index] += float(actual @ (compliance * unit)) * weight * length / 2
        expected[observed] = values
    return expected


@pytest.mark.parametrize('reverse', [False, True])
@pytest.mark.parametrize('rotate_basis', [False, True])
def test_spatial_elastic_branches_piecewise_properties_and_all_six_dofs(reverse, rotate_basis):
    model, xyz, edges, axes, loads = tree_recipe()
    expected = tree_virtual_work(model, xyz, edges, axes, loads)
    # Proper source-coordinate change (X,Y,Z)=(u,-w,v), including moments.
    rotation = np.array([[1, 0, 0], [0, 0, -1], [0, 1, 0]]) if rotate_basis else np.eye(3)
    for node in model['nodes']:
        node['x'], node['y'], node['z'] = (rotation @ xyz[node['id']]).tolist()
    for i, element in enumerate(model['elements']):
        if reverse:
            element['nodes'].reverse()
        model['metadata']['elementReferenceVectors'][element['id']] = (rotation @ axes[i][2]).tolist()
    for load in model['load_cases'][0]['loads']:
        vector = loads[load['node']]
        transformed = np.r_[rotation @ vector[:3], rotation @ vector[3:]]
        load.update(dict(zip(('fx', 'fy', 'fz', 'mx', 'my', 'mz'), transformed.tolist())))
    before = deepcopy(model)
    result = solve(model)
    assert model == before
    assert len(result['forces']) == 5
    for node, value in expected.items():
        expected6 = np.r_[rotation @ value[:3], rotation @ value[3:]]
        for key, number in zip(('ux', 'uy', 'uz', 'rx', 'ry', 'rz'), expected6):
            assert result['displacements'][node][key] == pytest.approx(number, rel=2e-10, abs=1e-12)
    total_f = sum((np.array(v[:3]) for v in loads.values()), start=np.zeros(3))
    total_m = sum((np.cross(xyz[n], v[:3]) + v[3:] for n, v in loads.items()), start=np.zeros(3))
    for key, value in zip(('fx', 'fy', 'fz', 'mx', 'my', 'mz'), np.r_[-rotation @ total_f, -rotation @ total_m]):
        assert result['reactions']['O'][key] == pytest.approx(value, abs=1e-8)


@pytest.mark.parametrize('dimension', ['2d', '3d'])
def test_guided_column_preserves_axial_freedom_and_pin_rotations(dimension):
    model = base(dimension)
    model['nodes'] = [{'id': 'A', 'x': 0, 'y': 0, 'z': 0,
                       'restraints': [True, True, True, True, False, True]},
                      {'id': 'B', 'x': 0, 'y': 0, 'z': 6,
                       'restraints': [True, True, False, True, False, True]}]
    model['elements'] = [{'id': 'column', 'type': 'column', 'nodes': ['A', 'B'], 'material': 'm', 'section': 's'}]
    model['metadata'] = {'elementReferenceVectors': {'column': [-1, 0, 0]}} if dimension == '3d' else {}
    model['load_cases'][0]['loads'] = [{'node': 'B', 'fz': -90},
        {'type': 'point', 'element': 'column', 'position': 3, 'fx': 20}]
    result = solve(model)
    middle = result['solverMesh']['physicalElements']['column'][0]['nodes'][1]
    assert result['segmentResults']['displacements'][middle]['ux'] == pytest.approx(20 * 6**3 / (48 * 210e6 * .00031), rel=1e-10)
    assert result['displacements']['B']['uz'] == pytest.approx(-90 * 6 / (210e6 * .023), rel=1e-10)
    for node in ('A', 'B'):
        assert result['reactions'][node]['fx'] == pytest.approx(-10)
        assert result['reactions'][node]['my'] == pytest.approx(0, abs=1e-10)
    assert abs(result['displacements']['A']['ry']) > 0


def test_internal_lateral_roller_is_neither_vertical_nor_rotational_restraint():
    model = base('2d')
    model['nodes'] = [{'id': 'A', 'x': 0, 'y': 0, 'z': 0, 'restraints': [True]*6},
        {'id': 'C', 'x': 0, 'y': 0, 'z': 2, 'restraints': [True, True, False, True, False, True]},
        {'id': 'B', 'x': 0, 'y': 0, 'z': 6}]
    model['elements'] = [{'id': f'c{i}', 'type': 'column', 'nodes': pair, 'material': 'm', 'section': 's'}
        for i, pair in enumerate([['A', 'C'], ['C', 'B']])]
    model['load_cases'][0]['loads'] = [{'node': 'B', 'fx': 20, 'fz': -90}]
    result = solve(model)
    reaction = -20 * (3 * 6 - 2) / (2 * 2)
    expected = (20 * 6**3 / 3 + reaction * 2**2 * (3 * 6 - 2) / 6) / (210e6 * .00031)
    assert result['displacements']['B']['ux'] == pytest.approx(expected, rel=1e-10)
    assert result['reactions']['C']['fx'] == pytest.approx(reaction)
    assert result['reactions']['C']['fz'] == pytest.approx(0, abs=1e-10)
    assert result['reactions']['C']['my'] == pytest.approx(0, abs=1e-10)
    assert result['displacements']['C']['uz'] == pytest.approx(-90 * 2 / (210e6 * .023))


def test_spatial_truss_star_with_different_bar_properties():
    model = base()
    tip = np.array([1., 2., 4.])
    anchors = [np.array(v, float) for v in ([0,0,0], [5,0,0], [5,6,0], [0,6,0])]
    model['nodes'] = [dict(id=f'A{i}', x=p[0], y=p[1], z=p[2], restraints=[True,True,True,False,False,False]) for i,p in enumerate(anchors)]
    model['nodes'].append(dict(id='T', x=tip[0], y=tip[1], z=tip[2]))
    model['sections'] = []
    stiffness = np.zeros((3,3))
    directions = []
    for i, p in enumerate(anchors):
        area = .004 + .001 * i
        direction = (tip-p) / np.linalg.norm(tip-p)
        k = 210e6 * area / np.linalg.norm(tip-p)
        stiffness += k * np.outer(direction, direction)
        directions.append((direction, k))
        model['sections'].append({'id':f's{i}', 'name':f's{i}', 'type':'truss', 'properties':{'A':area}})
        model['elements'].append({'id':f'b{i}', 'type':'truss', 'nodes':[f'A{i}','T'], 'material':'m','section':f's{i}'})
    force = np.array([12., -9., -100.])
    model['load_cases'][0]['loads'] = [{'node':'T', 'fx':force[0], 'fy':force[1], 'fz':force[2]}]
    expected = np.linalg.solve(stiffness, force)
    result = solve(model)
    for key,value in zip(('ux','uy','uz'),expected):
        assert result['displacements']['T'][key] == pytest.approx(value, rel=1e-10)
    for i, (direction,k) in enumerate(directions):
        assert result['forces'][f'b{i}']['axial'] == pytest.approx(k * direction @ expected, rel=1e-10)
    assert len(result['solverMesh']['nodes']) == 5


def test_spatial_mixed_brace_and_frame_six_dof_coupling():
    model, xyz, edges, axes, _ = tree_recipe()
    model['nodes'] = model['nodes'][:2]
    model['elements'] = model['elements'][:1]
    model['materials'] = model['materials'][:1]
    model['sections'] = model['sections'][:1]
    model['metadata']['elementReferenceVectors'] = {'e0': axes[0][2].tolist()}
    xyz = {k: xyz[k] for k in ('O', 'A')}
    compliance = np.column_stack([tree_virtual_work(model, xyz, edges[:1], axes[:1],
        {'A': np.eye(6)[i]})['A'] for i in range(6)])
    anchor = np.array([4., -3., 0.])
    delta = np.array(xyz['A']) - anchor
    length = np.linalg.norm(delta)
    direction = np.r_[delta / length, [0,0,0]]
    axial_stiffness = model['materials'][0]['E'] * 1000 * model['sections'][0]['properties']['A'] / length
    stiffness = np.linalg.inv(compliance) + axial_stiffness * np.outer(direction, direction)
    applied = np.array([12., -9., -100., 4., 7., -3.])
    expected = np.linalg.solve(stiffness, applied)
    model['nodes'].append({'id':'anchor', 'x':anchor[0], 'y':anchor[1], 'z':anchor[2],
        'restraints':[True,True,True,False,False,False]})
    model['elements'].append({'id':'diagonal', 'type':'brace', 'nodes':['anchor','A'], 'material':'m0','section':'s0'})
    model['load_cases'][0]['loads'] = [dict(node='A', **dict(zip(('fx','fy','fz','mx','my','mz'),applied.tolist())))]
    result = solve(model)
    for key,value in zip(('ux','uy','uz','rx','ry','rz'),expected):
        assert result['displacements']['A'][key] == pytest.approx(value, rel=1e-10, abs=1e-12)
    assert result['forces']['diagonal']['axial'] == pytest.approx(axial_stiffness * direction @ expected, rel=1e-10)


def continuous_recipe():
    model = base('2d')
    breaks = [0., 2., 4., 6., 8., 10., 12.]
    model['nodes'] = [dict(id=f'n{i}', x=x, y=0, z=0, restraints=[True]*6 if i==0
        else [False,True,True,True,False,True] if x in (4,10) else None) for i,x in enumerate(breaks)]
    model['sections'] = []
    model['materials'] = []
    for i, (a,b) in enumerate(zip(breaks,breaks[1:])):
        model['materials'].append({'id':f'm{i}', 'name':f'explicit-{i}', 'E':200000+i*5000, 'nu':.27, 'rho':7850})
        model['sections'].append({'id':f's{i}','name':f'explicit-{i}','type':'beam',
            'properties':{'A':.02+i*.001,'Iy':.0002+i*.00003,'Iz':.0005,'J':.00007}})
        model['elements'].append({'id':f'e{i}','type':'beam','nodes':[f'n{i}',f'n{i+1}'],'material':f'm{i}','section':f's{i}'})
    # Force signs use global Z; moments use global +Y.  Actual load boundaries
    # and section boundaries intentionally do not coincide.
    cases = {'D':{'q':[(1.,9.,-8.)], 'points':[(3.,-17.,0.),(7.,0.,11.)]},
             'L':{'q':[(0.,2.,-5.),(8.,12.,-6.)], 'points':[(4.,-13.,0.)]},
             'W':{'q':[(6.,11.,9.)], 'points':[(12.,6.,-4.)]}}
    model['load_cases'] = []
    for name, loads in cases.items():
        converted = []
        for a,b,q in loads['q']:
            for i,(s,t) in enumerate(zip(breaks,breaks[1:])):
                if max(s,a)<min(t,b):
                    converted.append({'type':'distributed','element':f'e{i}','start':max(s,a)-s,'end':min(t,b)-s,'wz':q})
        for x,f,m in loads['points']:
            if x in breaks:
                converted.append({'node':f'n{breaks.index(x)}','fz':f,'my':m})
            else:
                i=next(i for i,(a,b) in enumerate(zip(breaks,breaks[1:])) if a<x<b)
                converted.append({'type':'point','element':f'e{i}','position':x-breaks[i],'fz':f,'my':m})
        model['load_cases'].append({'id':name,'type':{'D':'dead','L':'live','W':'wind'}[name],'loads':converted})
    model['load_combinations']=[{'id':'MIX','factors':{'D':1.2,'L':1.4,'W':-.7}}]
    return model,breaks,cases


def continuous_reference(model, breaks, loads, observation):
    """Force method: cantilever primary, two vertical redundant reactions."""
    gauss,weights=np.polynomial.legendre.leggauss(4)
    def moment(x, actions):
        result=sum(m-(p-x)*f for p,f,m in actions['points'] if p>x)
        for a,b,q in actions['q']:
            lower=max(a,x)
            if lower<b:
                result-=q*((b-x)**2-(lower-x)**2)/2
        return result
    def work(first,second):
        cuts=sorted(set(breaks+[x for l in (first,second) for x,_,_ in l['points']]
            +[x for l in (first,second) for a,b,_ in l['q'] for x in (a,b)]))
        total=0.
        for a,b in zip(cuts,cuts[1:]):
            i=next(i for i,(s,t) in enumerate(zip(breaks,breaks[1:])) if s<=(a+b)/2<t)
            ei=model['materials'][i]['E']*1000*model['sections'][i]['properties']['Iy']
            for g,w in zip(gauss,weights):
                x=(a+b)/2+g*(b-a)/2
                total+=moment(x,first)*moment(x,second)/ei*w*(b-a)/2
        return total
    virtual=[{'q':[],'points':[(x,1.,0.)]} for x in (4.,10.)]
    flexibility=np.array([[work(a,b) for b in virtual] for a in virtual])
    reaction=np.linalg.solve(flexibility,-np.array([work(loads,v) for v in virtual]))
    corrected={'q':loads['q'], 'points':loads['points']+[(x,r,0.) for x,r in zip((4.,10.),reaction)]}
    values=[work(corrected,{'q':[],'points':[(observation,f,m)]}) for f,m in ((1.,0.),(0.,1.))]
    return values,reaction


def test_continuous_piecewise_beam_partial_loads_point_moment_and_separate_case_combinations():
    model,breaks,cases=continuous_recipe()
    batch=[{'id':case,'loadCaseIds':[case]} for case in cases]+[{'id':'MIX','loadCombinationId':'MIX'}]
    result=solve(model,batchCases=batch)
    assert set(result['caseResults'])=={'D','L','W','MIX'}
    for selection,row in result['caseResults'].items():
        factors={'D':1.2,'L':1.4,'W':-.7} if selection=='MIX' else {selection:1.}
        loads={'q':[(a,b,q*f) for c,f in factors.items() for a,b,q in cases[c]['q']],
               'points':[(x,p*f,m*f) for c,f in factors.items() for x,p,m in cases[c]['points']]}
        assert row['execution']['executed'] is True
        for i,x in enumerate(breaks):
            expected,reactions=continuous_reference(model,breaks,loads,x)
            assert row['displacements'][f'n{i}']['uz']==pytest.approx(expected[0],rel=2e-9,abs=1e-11)
            assert row['displacements'][f'n{i}']['ry']==pytest.approx(expected[1],rel=2e-9,abs=1e-11)
        assert row['reactions']['n2']['fz']==pytest.approx(reactions[0],rel=2e-9)
        assert row['reactions']['n5']['fz']==pytest.approx(reactions[1],rel=2e-9)


@pytest.mark.parametrize('connected', [False, True])
def test_crossed_axial_members_follow_endpoint_table_and_independent_bar_energy(connected):
    model=base('2d')
    coords=[(0,0),(4,0),(0,3),(4,3)] + ([(2,1.5)] if connected else [])
    pairs=[(0,1),(0,2),(1,3),(2,3)] + ([(0,4),(4,3),(1,4),(4,2)] if connected else [(0,3),(1,2)])
    model['nodes']=[{'id':f'n{i}','x':x,'y':0,'z':z,'restraints':[True,True,True,False,False,False] if i<2 else None}
                    for i,(x,z) in enumerate(coords)]
    stiffness=np.zeros((2*len(coords),2*len(coords)))
    model['sections']=[]
    for i,(a,b) in enumerate(pairs):
        area=.004+i*.0001
        vector=np.array(coords[b])-coords[a]
        length=np.linalg.norm(vector)
        gradient=np.r_[-vector/length,vector/length]
        dofs=[2*a,2*a+1,2*b,2*b+1]
        stiffness[np.ix_(dofs,dofs)]+=210e6*area/length*np.outer(gradient,gradient)
        model['sections'].append({'id':f's{i}','type':'truss','name':f's{i}','properties':{'A':area}})
        model['elements'].append({'id':f'e{i}','type':'truss','nodes':[f'n{a}',f'n{b}'],'material':'m','section':f's{i}'})
    applied=np.zeros(2*len(coords))
    applied[4:8]=[3,-7,11,-19]
    if connected:
        applied[8:]=[-2,-13]
    model['load_cases'][0]['loads']=[{'node':f'n{i}','fx':applied[2*i],'fz':applied[2*i+1]} for i in range(2,len(coords))]
    free=np.arange(4,len(applied))
    displacement=np.zeros(len(applied))
    displacement[free]=np.linalg.solve(stiffness[np.ix_(free,free)],applied[free])
    reactions=stiffness@displacement-applied
    result=solve(model)
    assert len(result['solverMesh']['nodes'])==len(coords)
    assert len(result['solverMesh']['elements'])==len(pairs)
    for i in range(len(coords)):
        for j,key in enumerate(('ux','uz')):
            assert result['displacements'][f'n{i}'][key]==pytest.approx(displacement[2*i+j],rel=1e-10,abs=1e-12)
        if i<2:
            for j,key in enumerate(('fx','fz')):
                assert result['reactions'][f'n{i}'][key]==pytest.approx(reactions[2*i+j],rel=1e-10,abs=1e-10)
