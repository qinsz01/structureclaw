from __future__ import annotations
import copy
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from contracts import AnalysisCapabilityError
from native_results import combine_linear_native_results


class NativeCombinationTest(unittest.TestCase):
    def setUp(self):
        self.context = {"engine": "pkpm", "engineVersion": "test-only", "physicalModelHash": "same-model",
                        "stiffnessHash": "same-stiffness", "settingsHash": "same-settings", "linearStatic": True,
                        "effectiveSettingsVerified": True, "stationConventionsVerified": True}
        self.case = {"status": "success", "nativeContext": self.context, "forceSemantics": "simultaneous-signed-stations",
                     "units": {"displacement": "m", "rotation": "rad", "force": "kN", "moment": "kN.m"},
                     "displacements": {"N": {"ux": 0, "uz": -0.001}}, "reactions": {"B": {"fz": 10}},
                     "memberStations": {"M": [{"positionM": 0, "referenceFrame": "element-local", "side": "right",
                         "components": {"N": -10, "Vy": -2, "Vz": 1, "T": 0, "My": -6, "Mz": 3}}]},
                     "missingCapabilities": ["nodal-rotations"]}

    def test_signed_combination_preserves_positions_and_missing_rotations(self):
        other = copy.deepcopy(self.case)
        other["memberStations"]["M"][0]["components"]["My"] = 4
        result = combine_linear_native_results({"D": self.case, "W": other}, {"D": 1.2, "W": -1.4}, self.context)
        self.assertAlmostEqual(result["memberStations"]["M"][0]["components"]["My"], -12.8)
        self.assertNotIn("rx", result["displacements"]["N"])
        self.assertEqual(result["capabilityStatus"], "partial")
        self.assertEqual(self.case["memberStations"]["M"][0]["components"]["My"], -6)

    def test_unverified_physics_rejects_even_complete_mock_vectors(self):
        for key in ("linearStatic", "effectiveSettingsVerified", "stationConventionsVerified"):
            context = {**self.context, key: False}
            with self.assertRaises(AnalysisCapabilityError):
                combine_linear_native_results({"D": self.case}, {"D": 1}, context)
            other = copy.deepcopy(self.case)
            other["nativeContext"][key] = False
            with self.assertRaises(AnalysisCapabilityError):
                combine_linear_native_results({"D": other}, {"D": 1}, self.context)

    def test_combination_preserves_calibrated_local_axes_and_each_native_source(self):
        first = copy.deepcopy(self.case)
        first["memberStations"]["M"][0].update(localAxes=[[1,0,0],[0,1,0],[0,0,1]],source={"kind":"native","case":"D"})
        other = copy.deepcopy(first)
        other["memberStations"]["M"][0]["source"]["case"] = "W"
        result = combine_linear_native_results({"D": first, "W": other}, {"D": 1, "W": -1}, self.context)
        row = result["memberStations"]["M"][0]
        self.assertEqual(row["localAxes"], first["memberStations"]["M"][0]["localAxes"])
        self.assertEqual(row["source"]["cases"]["W"]["case"], "W")
        other["memberStations"]["M"][0]["localAxes"] = [[1,0,0],[0,-1,0],[0,0,-1]]
        with self.assertRaisesRegex(ValueError, "local axes differ"):
            combine_linear_native_results({"D": first, "W": other}, {"D": 1, "W": -1}, self.context)

    def test_reaction_resultant_is_recomputed_from_signed_combined_forces(self):
        first, second = copy.deepcopy(self.case), copy.deepcopy(self.case)
        first["reactions"]["B"] = dict(fx=3, fy=0, fz=0, mx=1, my=2, mz=3, R=3)
        second["reactions"]["B"] = dict(fx=0, fy=4, fz=0, mx=-1, my=2, mz=-3, R=4)
        result = combine_linear_native_results({"D": first, "W": second}, {"D": 1, "W": 1}, self.context)
        self.assertEqual(result["reactions"]["B"], dict(fx=3, fy=4, fz=0, mx=0, my=4, mz=0, R=5))
        cancelled = combine_linear_native_results({"D": first, "W": first}, {"D": 1, "W": -1}, self.context)
        self.assertEqual(cancelled["reactions"]["B"]["R"], 0)

    def test_station_coordinates_require_unambiguous_sides(self):
        for mutation in (
            lambda c: c["memberStations"]["M"][0].update(positionM=-1),
            lambda c: c["memberStations"]["M"][0].pop("side"),
            lambda c: c["memberStations"]["M"].append(copy.deepcopy(c["memberStations"]["M"][0])),
            lambda c: c["memberStations"].update(M=[]),
        ):
            other = copy.deepcopy(self.case); mutation(other)
            with self.assertRaises(ValueError):
                combine_linear_native_results({"D": other}, {"D": 1}, self.context)

    def test_envelope_changed_stiffness_units_station_or_side_are_rejected(self):
        for mutation in (
            lambda c: c.update(forceSemantics="signed-component-envelope"),
            lambda c: c["nativeContext"].update(stiffnessHash="changed"),
            lambda c: c["units"].update(force="N"),
            lambda c: c["memberStations"]["M"][0].update(positionM=1),
            lambda c: c["memberStations"]["M"][0].update(side="left"),
            lambda c: c["memberStations"]["M"][0]["components"].pop("T"),
        ):
            other = copy.deepcopy(self.case); mutation(other)
            with self.assertRaises(ValueError):
                combine_linear_native_results({"D": self.case, "L": other}, {"D": 1, "L": 1}, self.context)


if __name__ == "__main__": unittest.main()
