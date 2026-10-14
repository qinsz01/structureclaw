"""Independent rigid-arm reference checked against closed-form integration."""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[5] / "tests"))
from native_frame_reference import solve


def model(load):
    return {"nodes": [{"id": "a", "x": 0., "y": 0., "z": 0., "restraints": [True]*6},
                      {"id": "b", "x": 6., "y": 0., "z": 0.}],
            "materials": [{"id": "m", "E": 30000., "G": 12000., "nu": .25}],
            "sections": [{"id": "s", "shape": {"kind": "rectangular", "B": 300., "H": 500.}}],
            "elements": [{"id": "e", "type": "beam", "nodes": ["a", "b"], "material": "m", "section": "s"}],
            "load_cases": [{"id": "D", "loads": [load]}]}


@pytest.mark.parametrize("ri,rj", [(0., 0.), (.4, .2), (1., 0.), (0., 1.)])
def test_cantilever_end_force(ri, rj):
    data = model({"type": "nodal", "node": "b", "fz": -3.})
    result = solve(data, "D", rigid_end_lengths={"e": [ri, rj]})
    length, force, EI, GA = 6., -3., 30000e3*.3*.5**3/12, 12000e3*.3*.5*5/6
    # Virtual work: integrate P*(L-x)^2/EI + P/GA over elastic segment only.
    displacement = force*((length-ri)**3-rj**3)/(3*EI)+force*(length-ri-rj)/GA
    rotation = -force*((length-ri)**2-rj**2)/(2*EI)
    assert result["displacements"]["b"]["uz"] == pytest.approx(displacement, rel=1e-12)
    assert result["displacements"]["b"]["ry"] == pytest.approx(rotation, rel=1e-12)
    assert result["reactions"]["a"]["fz"] == pytest.approx(3.)
    assert result["reactions"]["a"]["my"] == pytest.approx(-18.)


def test_full_physical_uniform_load_including_rigid_segments():
    ri, rj, length, q = .4, .2, 6., -2.
    data = model({"type": "distributed", "element": "e", "wz": q})
    result = solve(data, "D", rigid_end_lengths={"e": [ri, rj]})
    EI, GA = 30000e3*.3*.5**3/12, 12000e3*.3*.5*5/6
    expected = q*((length-ri)**4-rj**4)/(8*EI)+q*((length-ri)**2-rj**2)/(2*GA)
    assert result["displacements"]["b"]["uz"] == pytest.approx(expected, rel=1e-12)
    assert result["reactions"]["a"]["fz"] == pytest.approx(-q*length)
    assert result["reactions"]["a"]["my"] == pytest.approx(q*length**2/2)
    assert result["localEndActions"]["e"][6:] == pytest.approx([0.]*6, abs=1e-12)


def test_zero_rigid_end_option_preserves_original_reference():
    data = model({"type": "distributed", "element": "e", "wz": -2.})
    before, after = solve(data, "D"), solve(data, "D", rigid_end_lengths={})
    for field in ("displacements", "reactions", "localEndActions"):
        assert before[field] == after[field]


def test_executed_net_load_reference_preserves_source_rigid_arm_integrals():
    import copy
    import importlib.util
    path = Path(__file__).resolve().parents[5]/'tests/analysis-pkpm-rigid-offset-native.py'
    spec = importlib.util.spec_from_file_location('rigid_input_reference', path)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    ri, rj, qs, qe = .4, .2, -2., -1.8
    data = model({'type': 'distributed', 'element': 'e', 'wz': qs})
    before = copy.deepcopy(data)
    packet = {'loadCompilation': {'elementLoads': [{'loadCaseId': 'D', 'sourceLoadIndex': 0,
        'elementId': 'e', 'sourceIntensityVectorKnM': [0., 0., qs],
        'effectiveElasticIntensityVectorKnM': [0., 0., qe]}]}}
    changed = module.executed_reference_model(data, {'e': [ri, rj]}, packet)
    original = solve(data, 'D', rigid_end_lengths={'e': [ri, rj]})
    result = solve(changed, 'D', rigid_end_lengths={'e': [ri, rj]})
    assert data == before
    elastic = 6-ri-rj
    EI, GA = 30000e3*.3*.5**3/12, 12000e3*.3*.5*5/6
    delta = (qe-qs)*((elastic**4/8+rj*elastic**3/6)/EI+elastic**2/(2*GA))
    assert result['displacements']['b']['uz']-original['displacements']['b']['uz'] == pytest.approx(delta, rel=1e-12)
    assert result['reactions']['a']['fz'] == pytest.approx(-qs*(ri+rj)-qe*elastic)
    assert result['reactions']['a']['my'] == pytest.approx(qs*(ri**2+6**2-(6-rj)**2)/2+qe*((6-rj)**2-ri**2)/2)
