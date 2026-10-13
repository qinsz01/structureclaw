from __future__ import annotations
import copy
from pathlib import Path
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from native_loads import plan_native_loads


class NativeLoadPlanTest(unittest.TestCase):
    def setUp(self):
        self.model = {"nodes": [{"id": "A", "x": 0, "y": 0, "z": 3}, {"id": "B", "x": 4, "y": 0, "z": 3}],
                      "elements": [{"id": "AB", "type": "beam", "nodes": ["A", "B"]}],
                      "load_cases": [{"id": "D", "type": "dead", "loads": [{"id": "q", "type": "distributed", "element": "AB", "wz": -2}]}]}

    def test_udl_retains_physical_extent_and_explicit_unverified_status(self):
        row, = plan_native_loads(self.model)
        self.assertEqual(row["intervalM"], [0, 4])
        self.assertEqual(row["nativeValues"], [1, 2, 0, 0, 0, 0])
        self.assertEqual(row["acceptance"], "native-solver-unverified")
        self.assertEqual(row["sourceLoad"]["wz"], -2)

    def test_partial_load_is_not_smeared_over_span(self):
        self.model["load_cases"][0]["loads"][0].update(start=1, end=3)
        with self.assertRaisesRegex(ValueError, "extent must not change"):
            plan_native_loads(self.model)

    def test_duplicate_cases_local_axes_and_unsupported_loads_fail(self):
        original = copy.deepcopy(self.model)
        self.model["load_cases"].append(copy.deepcopy(self.model["load_cases"][0]))
        with self.assertRaisesRegex(ValueError, "Duplicate load case"):
            plan_native_loads(self.model)
        for patch in ({"reference_frame": "local"}, {"type": "point", "position": 2}, {"wx": 1}):
            model = copy.deepcopy(original); model["load_cases"][0]["loads"][0].update(patch)
            with self.assertRaises(ValueError): plan_native_loads(model)


if __name__ == "__main__": unittest.main()
