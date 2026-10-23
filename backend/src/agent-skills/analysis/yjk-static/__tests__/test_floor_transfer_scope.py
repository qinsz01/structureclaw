import copy
import sys
import unittest
from pathlib import Path

ADAPTER = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ADAPTER), str(ADAPTER.parent / 'runtime')]
from model_contract import validate_floor_transfer
from contracts import AnalysisCapabilityError


class FloorTransferScopeTests(unittest.TestCase):
    def model(self):
        return {"nodes": [{"id": "N", "z": 3}],
                "stories": [{"id": "F1", "elevation": 0, "height": 3, "load_area_m2": 20,
                             "floor_loads": [{"type": "dead", "value": 5}, {"type": "live", "value": 2.5}]}],
                "load_cases": [{"id": "DL", "loads": []}, {"id": "LL", "loads": []}]}

    def test_unrepresented_floor_totals_fail_as_input_capability_before_native_execution(self):
        data = self.model()
        original = copy.deepcopy(data)
        with self.assertRaises(AnalysisCapabilityError) as caught:
            validate_floor_transfer(data)
        self.assertEqual(caught.exception.error_code, "ENGINE_INPUT_UNSUPPORTED")
        self.assertEqual(caught.exception.capability, "native-floor-load-transfer")
        self.assertEqual(caught.exception.detail["inputFields"],
                         ["stories.F1.floor_loads.dead", "stories.F1.floor_loads.live"])
        self.assertEqual(data, original)

    def test_explicit_verified_nodal_equivalents_are_preserved(self):
        data = self.model()
        for case, kind, force in zip(data["load_cases"], ("dead", "live"), (-100, -50)):
            case["loads"] = [{"type": "nodal", "node": "N", "story": "F1", "source": "story_floor_loads",
                              "load_kind": kind, "fz": force}]
        original = copy.deepcopy(data)
        validate_floor_transfer(data)
        self.assertEqual(data, original)

    def test_a_marker_cannot_bypass_missing_live_load_or_inconsistent_totals(self):
        data = self.model()
        data["load_cases"][0]["loads"] = [{"type": "nodal", "node": "N", "story": "F1",
            "source": "story_floor_loads", "load_kind": "dead", "fz": -100}]
        with self.assertRaises(ValueError):
            validate_floor_transfer(data)
        data["load_cases"][0]["loads"][0]["fz"] = -200
        with self.assertRaises(ValueError):
            validate_floor_transfer(data)

    def test_zero_floor_declarations_do_not_require_substitute_loads(self):
        data = self.model()
        data["stories"][0]["floor_loads"] = [{"type": "dead", "value": 0}]
        validate_floor_transfer(data)


if __name__ == '__main__':
    unittest.main()
