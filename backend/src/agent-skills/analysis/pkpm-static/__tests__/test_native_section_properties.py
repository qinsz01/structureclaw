import importlib.util
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

SKILL = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(SKILL), str(SKILL.parent / "runtime")]
from native_model_contract import pkpm_section_shape
from contracts import AnalysisCapabilityError

properties = SimpleNamespace(GetArea=lambda: .15, GetRjx=lambda: .003125,
                             GetRjy=lambda: .001125, GetRjz=lambda: .002817371)
fake_api = SimpleNamespace(Bardata=lambda: SimpleNamespace(GetSectProperty_beam=lambda *_: properties),
                           MaterialData=lambda: object())
spec = importlib.util.spec_from_file_location("pkpm_section_check_test", SKILL / "pkpm_converter.py")
converter = importlib.util.module_from_spec(spec)
with patch.dict(sys.modules, {"APIPyInterface": fake_api}):
    spec.loader.exec_module(converter)


class NativeSectionPropertiesTest(unittest.TestCase):
    def test_missing_stories_is_an_input_capability_boundary_not_a_solver_crash(self):
        with self.assertRaises(AnalysisCapabilityError) as caught:
            converter._normalize_generic_frame_for_pkpm({"nodes": [], "elements": []})
        self.assertEqual(caught.exception.error_code, "ENGINE_INPUT_UNSUPPORTED")
        self.assertEqual(caught.exception.meta["capability"], "native-model-contract")

    def test_unsupported_grade_keeps_its_identity_and_capability_cause(self):
        with patch.object(converter.APIPyInterface, "SteelGrade", SimpleNamespace(), create=True):
            with self.assertRaises(AnalysisCapabilityError) as caught:
                converter._resolve_steel_grade("Q235B")
        self.assertEqual(caught.exception.error_code, "ENGINE_INPUT_UNSUPPORTED")
        self.assertIn("Q235B", str(caught.exception))

    def setUp(self):
        self.section = {"id": "S", "shape": {"kind": "rectangular", "B": 300, "H": 500},
                        "properties": {"A": .15, "Iy": .003125, "Iz": .001125, "J": .002817371}}

    def test_geometry_and_declared_stiffness_reach_native_check(self):
        self.assertEqual(pkpm_section_shape(self.section, "2.2.0"), {"kind": "Rectangle", "B": 300, "H": 500})
        self.assertEqual(converter._verify_section_properties(self.section, object(), "beam")["native"]["J"], .002817371)

    def test_torsion_mismatch_cannot_be_discarded(self):
        self.section["properties"]["J"] *= 2
        with self.assertRaisesRegex(Exception, "requested.*native"):
            converter._verify_section_properties(self.section, object(), "beam")

    def test_conflicting_duplicate_value_or_nan_fails(self):
        self.section["A"] = .015
        with self.assertRaisesRegex(ValueError, "conflicting/invalid"):
            converter._verify_section_properties(self.section, object(), "beam")
        del self.section["A"]
        self.section["properties"]["A"] = float("nan")
        with self.assertRaisesRegex(ValueError, "conflicting/invalid"):
            converter._verify_section_properties(self.section, object(), "beam")


if __name__ == "__main__":
    unittest.main()
