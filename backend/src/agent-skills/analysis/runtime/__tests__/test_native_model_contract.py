from __future__ import annotations

import importlib.util
import copy
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

RUNTIME = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RUNTIME))
from contracts import AnalysisCapabilityError
from native_model_contract import pkpm_section_shape, validate_pkpm_material_properties, validate_pkpm_sections, validate_story_load_totals


def load_runtime(engine):
    folder = RUNTIME.parent / f"{engine}-static"
    sys.path.insert(0, str(folder))
    spec = importlib.util.spec_from_file_location(f"contract_{engine}_runtime", folder / "runtime.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class NativeModelContractTest(unittest.TestCase):
    def test_story_area_uses_each_declared_floor_not_global_bounding_box(self):
        model = {
            "nodes": [{"id": "L", "x": 8, "y": 8, "z": 3}, {"id": "S", "x": 4, "y": 4, "z": 6}],
            "stories": [
                {"id": "L", "height": 3, "elevation": 0, "dead_load": 2, "load_area_m2": 48},
                {"id": "S", "height": 3, "elevation": 3, "dead_load": 2, "load_area_m2": 16},
            ],
            "load_cases": [{"id": "D", "loads": [
                {"type": "nodal", "node": "L", "story": "L", "source": "story_floor_loads", "load_kind": "dead", "fz": -96},
                {"type": "nodal", "node": "S", "story": "S", "source": "story_floor_loads", "load_kind": "dead", "fz": -32},
            ]}],
        }
        for engine in ("PKPM", "YJK"):
            validate_story_load_totals(model, engine)
            model["stories"][1]["load_area_m2"] = 64
            with self.assertRaisesRegex(ValueError, "nodal-load total conflicts"):
                validate_story_load_totals(model, engine)
            model["stories"][1]["load_area_m2"] = 16
        del model["stories"][1]["load_area_m2"]
        with self.assertRaisesRegex(ValueError, "load_area_m2 is required"):
            validate_story_load_totals(model, "PKPM")

    def test_floor_load_aliases_conflict_instead_of_overwriting(self):
        model = {"nodes": [{"id": "N", "z": 3}], "stories": [{"id": "F", "elevation": 0, "height": 3,
            "load_area_m2": 4, "dead_load": 2, "floor_loads": [{"type": "dead", "value": 3}]}],
            "load_cases": [{"loads": [{"type": "nodal", "node": "N", "story": "F", "source": "story_floor_loads", "load_kind": "dead", "fz": -8}]}]}
        with self.assertRaisesRegex(ValueError, "Conflicting dead floor load"):
            validate_story_load_totals(model, "YJK")

    def model(self):
        return {"elements": [{"id": "B1", "material": "C", "section": "S"}],
                "materials": [{"id": "C", "name": "C30", "grade": "C30"}],
                "sections": [{"id": "S", "type": "rectangular", "shape": {"kind": "Rectangle", "B": 300, "H": 600}}]}

    def assert_rejected(self, callback, code, field):
        with self.assertRaises(AnalysisCapabilityError) as caught:
            callback()
        self.assertEqual(caught.exception.error_code, code)
        self.assertIn(field, caught.exception.detail["inputFields"])

    def test_isotropic_materials_reach_native_audit_without_losing_authored_values(self):
        validate_pkpm_material_properties(self.model())
        model = self.model()
        model["materials"][0].update(E=30000, nu=.2, G=12500, rho=2500)
        before = copy.deepcopy(model)
        validate_pkpm_material_properties(model)
        self.assertEqual(model, before)
        # Input admissibility does not certify the values actually executed.
        for change, field in (({"G": 12000}, "G"), ({"nu": .5}, "isotropicConstants"),
                              ({"rho": None}, "isotropicConstants")):
            with self.subTest(change=change):
                candidate = copy.deepcopy(model)
                candidate["materials"][0].update(change)
                self.assert_rejected(lambda: validate_pkpm_material_properties(candidate),
                                     "PKPM_NATIVE_MATERIAL_PROPERTIES_UNVERIFIED", f"materials.C.{field}")
        incomplete = self.model()
        incomplete["materials"][0]["G"] = 12500
        self.assert_rejected(lambda: validate_pkpm_material_properties(incomplete),
                             "PKPM_NATIVE_MATERIAL_PROPERTIES_UNVERIFIED", "materials.C.E")

    def test_nested_material_and_reinforcement_overrides_cannot_disappear(self):
        model = self.model()
        model["materials"][0]["extra"] = {"G": 12500}
        self.assert_rejected(lambda: validate_pkpm_material_properties(model),
                             "PKPM_NATIVE_MATERIAL_PROPERTIES_UNVERIFIED", "materials.C.extra.G")
        model = self.model()
        model["elements"][0]["rebar_grade"] = "HRB500"
        model["materials"][0]["design"] = {"f": 305, "fv": 175}
        model["materials"][0]["fy"] = 355
        before = copy.deepcopy(model)
        validate_pkpm_material_properties(model)
        self.assertEqual(model, before)

    def test_section_invariants_are_preserved_for_native_readback_audit(self):
        section = self.model()["sections"][0]
        section["properties"] = {"A": .18, "Iy": .0054, "Iz": .00135, "J": .003}
        before = copy.deepcopy(section)
        self.assertEqual(pkpm_section_shape(section), {"kind": "Rectangle", "B": 300, "H": 600})
        self.assertEqual(section, before)
        section["properties"]["Asy"] = .15
        self.assert_rejected(lambda: pkpm_section_shape(section),
                             "PKPM_NATIVE_SECTION_PROPERTIES_UNVERIFIED", "sections.S.properties.Asy")

    def test_explicit_dimension_contract_never_guesses_by_magnitude(self):
        self.assertEqual(pkpm_section_shape({"id": "S", "type": "rectangular", "width": 10, "height": 20}),
                         {"kind": "Rectangle", "B": 10, "H": 20})
        legacy = {"id": "S", "type": "rectangular", "properties": {"width": .3, "height": .6}}
        self.assertEqual(pkpm_section_shape(legacy)["B"], 300)
        self.assert_rejected(lambda: pkpm_section_shape(legacy, "2.1.0"),
                             "PKPM_NATIVE_SECTION_INPUT_UNSUPPORTED", "sections.S.properties")

    def test_unwritten_shape_fields_fractional_dimensions_and_conflicts_fail(self):
        examples = [
            ({"kind": "H", "H": 300, "B": 150, "tw": 6, "tf": 9, "B2": 100}, "shape.B2"),
            ({"kind": "Rectangle", "B": 300.4, "H": 600}, "shape.B"),
            ({"kind": "Rectangle", "B": 300, "b": 250, "H": 600}, "shape.B"),
            ({"kind": "unknown", "B": 300, "H": 600}, "shape.kind"),
        ]
        for shape, field in examples:
            with self.subTest(shape=shape):
                self.assert_rejected(lambda: pkpm_section_shape({"id": "S", "shape": shape}),
                                     "PKPM_NATIVE_SECTION_INPUT_UNSUPPORTED", f"sections.S.{field}")
        section = self.model()["sections"][0]
        section["standard_steel_name"] = "HN300x150"
        self.assert_rejected(lambda: pkpm_section_shape(section),
                             "PKPM_NATIVE_SECTION_INPUT_UNSUPPORTED", "sections.S.shape")
        section = self.model()["sections"][0]
        section["width"] = 250
        self.assert_rejected(lambda: pkpm_section_shape(section),
                             "PKPM_NATIVE_SECTION_INPUT_UNSUPPORTED", "sections.S.width")

    def test_pkpm_inconsistent_physics_rejected_before_environment_or_native_work(self):
        runtime = load_runtime("pkpm")
        model = self.model()
        model["materials"][0].update(E=30000, nu=.2, G=12000, rho=2500)
        with (patch.object(runtime, "validate_coordinate_contract"),
              patch("native_member_mesh.compile_member_mesh") as mesh,
              patch.object(runtime, "_check_pkpm_available") as available):
            self.assert_rejected(lambda: runtime.run_analysis(model, {}),
                                 "PKPM_NATIVE_MATERIAL_PROPERTIES_UNVERIFIED", "materials.C.G")
        mesh.assert_not_called()
        available.assert_not_called()

    def test_unmapped_node_springs_and_member_modifiers_are_not_ignored(self):
        model = self.model()
        model["nodes"] = [{"id": "N1", "extra": {"springs": {"ux": 1000}}}]
        self.assert_rejected(lambda: validate_pkpm_sections(model),
                             "PKPM_NATIVE_MEMBER_NODE_PROPERTIES_UNSUPPORTED", "nodes.N1.extra.springs")
        model = self.model()
        model["elements"][0]["extra"] = {"stiffness_factor": .5}
        self.assert_rejected(lambda: validate_pkpm_sections(model),
                             "PKPM_NATIVE_MEMBER_NODE_PROPERTIES_UNSUPPORTED", "elements.B1.extra.stiffness_factor")

    def test_yjk_explicit_material_conflict_rejected_before_environment_or_workdir(self):
        runtime = load_runtime("yjk")
        model = self.model()
        model["materials"][0].update(category="steel", E=30000, nu=.2, G=12500, rho=2500)
        with (patch.object(runtime, "_ensure_v2_model", side_effect=lambda value: value),
              patch.object(runtime, "validate_coordinate_contract"),
              patch.object(runtime, "resolve_model_dimension", return_value="3d"),
              patch.object(runtime, "_validate_yjk_grid_conversion_scope"),
              patch.object(runtime, "_resolve_yjk_python") as available,
              patch.object(runtime, "_resolve_work_dir") as workdir):
            with self.assertRaisesRegex(AnalysisCapabilityError, "category/grade conflict"):
                runtime.run_analysis(model, {})
        available.assert_not_called()
        workdir.assert_not_called()


if __name__ == "__main__":
    unittest.main()
