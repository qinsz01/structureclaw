import copy
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from native_loads import compile_load_definitions


class NativeLoadCompilerTest(unittest.TestCase):
    def model(self):
        return {"nodes": [{"id": "A", "x": 0, "y": 0, "z": 3},
                          {"id": "B", "x": 6, "y": 0, "z": 3}],
                "elements": [{"id": "AB", "type": "beam", "nodes": ["A", "B"]}],
                "load_cases": [{"id": "D", "type": "dead", "loads": [
                    {"id": "P", "type": "nodal", "node": "A", "fx": 2, "fy": -3,
                     "fz": -0.5, "mx": 4, "my": -5, "mz": 6},
                    {"id": "Q", "type": "distributed", "element": "AB", "wz": -8}]}]}

    def test_explicit_500n_and_all_six_signed_components_preserved(self):
        model = self.model()
        before = copy.deepcopy(model)
        case = compile_load_definitions(model)[0]
        self.assertEqual(case["loads"][0]["components"], [0.5, 4, -5, 2, -3, 6])
        self.assertEqual(case["loads"][0]["shapeVal"], "0.5,4,-5,2,-3,6,0")
        self.assertEqual(case["loads"][1]["shapeVal"], "1,8,0,0,0,0,0")
        self.assertEqual(case["loads"][1]["endPositionM"], 6)
        self.assertEqual(case["nativeName"], "SC001_D")
        self.assertEqual(model, before)

    def test_distinct_source_cases_do_not_merge_into_native_dead(self):
        model = self.model()
        model["load_cases"].append({"id": "D_eq", "type": "dead", "loads": []})
        rows = compile_load_definitions(model)
        self.assertEqual([row["nativeName"] for row in rows], ["SC001_D", "SC002_D_eq"])

    def test_partial_range_and_point_loads_preserve_metres_from_source_start(self):
        model = self.model()
        model["load_cases"][0]["loads"][1].update(start=1, end=2)
        model["load_cases"][0]["loads"].append({"type":"point", "element":"AB", "position":1.5, "fz":-2})
        rows = compile_load_definitions(model)[0]["loads"]
        self.assertEqual(rows[1]["shapeVal"], "11,8,8,1,1,0,0")
        self.assertEqual(rows[2]["shapeVal"], "4,2,1.5,0,0,0,0")

    def test_invalid_range_or_unsupported_component_cannot_be_ignored(self):
        for extra in ({"start": -1}, {"end": 7}, {"wx": 1}, {"wy": 1},
                      {"reference_frame": "local"}, {"distribution": "piecewise_linear"}):
            with self.subTest(extra=extra):
                model = self.model()
                model["load_cases"][0]["loads"][1].update(extra)
                with self.assertRaises(ValueError):
                    compile_load_definitions(model)

    def test_missing_target_and_nonfinite_or_unrepresentable_loads_reject(self):
        for extra in ({"element": "missing"}, {"wz": float("nan")}, {"wz": 0.0005}):
            with self.subTest(extra=extra):
                model = self.model()
                model["load_cases"][0]["loads"][1].update(extra)
                with self.assertRaises(ValueError):
                    compile_load_definitions(model)


if __name__ == "__main__":
    unittest.main()
