import copy
import json
import importlib.util
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT.parent / "runtime"), str(ROOT.parents[2] / "skill-shared/python")]
from yjk_native_design import compile_design_request, parse_member_design, verify_physical_design_section


class NativeDesignContractTests(unittest.TestCase):
    def request(self):
        return dict(requested=True, mode=None, code="GB/T50010-2010(2024)", adoptedNativeDefaults=True)

    def model(self):
        return dict(analysis_control=dict(self_weight=False), materials=[], elements=[])

    def test_explicit_adoption_and_no_source_mutation(self):
        model = self.model(); original = copy.deepcopy(model)
        compiled = compile_design_request(self.request(), model)
        self.assertEqual(compiled["request"]["mode"], "code-check")
        self.assertEqual(compiled["parameters"]["float"], {"801": 0., "803": 0.})
        self.assertEqual(model, original)
        request = self.request(); request.pop("adoptedNativeDefaults")
        with self.assertRaises(ValueError): compile_design_request(request, model)
        model["analysis_control"]["self_weight"] = True
        with self.assertRaises(ValueError): compile_design_request(self.request(), model)

    def test_source_design_overrides_cannot_be_silently_defaulted(self):
        for extra in ({"f": 305}, {"design": {"f": 305}}, {"extra": {"fy": 400}}):
            model = self.model(); model["materials"] = [{"id": "M", "category": "concrete", **extra}]
            with self.assertRaisesRegex(ValueError, "materials.M"):
                compile_design_request(self.request(), model)

    def test_request_unknown_fields_and_out_of_range_params(self):
        for parameters in ({"beamCoverMm": 0}, {"beamCoverMm": 35.5}, {"guessSteel": True}):
            with self.assertRaises(ValueError):
                compile_design_request({**self.request(), "parameters": parameters}, self.model())

    def test_steel_length_method_flags_are_not_arbitrary_l0_values(self):
        request = {"requested": True, "code": "GB50017-2017", "adoptedNativeDefaults": True,
                   "parameters": {"steelColumnSwayX": True, "steelColumnSwayY": False}}
        compiled = compile_design_request(request, self.model())
        self.assertEqual(compiled["parameters"]["int"]["706"], 1)
        self.assertEqual(compiled["parameters"]["int"]["734"], 0)
        request["parameters"]["steelColumnSwayX"] = 3.0
        with self.assertRaises(ValueError): compile_design_request(request, self.model())

    def test_authored_main_rebar_maps_without_changing_other_fields(self):
        model = json.loads((ROOT / "__tests__/fixtures/native-design-concrete-model.json").read_text("utf-8"))
        for row in model["elements"]:
            row["rebar_grade"] = "HRB500"
        original = copy.deepcopy(model)
        plan = compile_design_request(self.request(), model)
        self.assertEqual(plan["mainRebar"]["floors"], {"F1": {"column": "HRB500", "beam": "HRB500"}})
        self.assertEqual(set(plan["mainRebar"]["members"]), {row["id"] for row in model["elements"]})
        self.assertEqual(model, original)

    def test_member_only_and_conflicting_main_rebar_never_change_neighbours(self):
        model = json.loads((ROOT / "__tests__/fixtures/native-design-concrete-model.json").read_text("utf-8"))
        model["elements"][0]["rebar_grade"] = "HRB500"
        with self.assertRaises(ValueError) as raised:
            compile_design_request(self.request(), model)
        self.assertEqual(raised.exception.error_code, "ENGINE_INPUT_UNSUPPORTED")
        request = {**self.request(), "parameters": {"columnMainRebarGrade": "HRB400"}}
        with self.assertRaises(ValueError): compile_design_request(request, model)

    def test_explicit_role_main_bar_grade_is_distinct_from_hoop_grade(self):
        model = json.loads((ROOT / "__tests__/fixtures/native-design-concrete-model.json").read_text("utf-8"))
        request = {**self.request(), "parameters": {"columnMainRebarGrade": "HRB500", "beamMainRebarGrade": "HRB400"}}
        plan = compile_design_request(request, model)
        self.assertEqual(plan["mainRebar"]["floors"], {"F1": {"column": "HRB500", "beam": "HRB400"}})
        self.assertNotIn("hoop", str(plan["mainRebar"]))

    def test_invalid_main_bar_value_is_a_typed_input_failure(self):
        model = json.loads((ROOT / "__tests__/fixtures/native-design-concrete-model.json").read_text("utf-8"))
        for value in (["HRB500"], None, 500):
            with self.assertRaises(ValueError) as raised:
                compile_design_request({**self.request(), "parameters": {"beamMainRebarGrade": value}}, model)
            self.assertEqual(raised.exception.error_code, "ENGINE_INPUT_UNSUPPORTED")

    def test_required_rebar_consumes_only_active_buffer_and_keeps_native_combo(self):
        raw = {"reinforcement_with_calculation": [1,
            [[540., 321., .003, 4., 520., 302., .003, 0., 30., 20., .001, 7.], [0.]*12], [[1.]*18, [0.]*18]]}
        result = parse_member_design("B", raw, "concrete", "beam")
        self.assertEqual(len(result["records"]), 3)
        self.assertEqual(result["records"][0]["nativeCombination"]["id"], 4)
        self.assertEqual(result["checks"], [])
        self.assertEqual(result["records"][1]["nativeCombination"]["id"], 0)
        with self.assertRaises(ValueError):
            parse_member_design("B", {"reinforcement_with_calculation": [1, [[0.]*12], [[0.]*18]]}, "concrete", "beam")

    def test_steel_actual_exceedance_missing_and_zero_differ(self):
        raw = {"steel_checks": [1, [[330., 305., 2., 0., 305., 0., 15., 305., 3.]], [[0.]*18]]}
        result = parse_member_design("C", raw, "steel", "column")
        self.assertEqual([row["status"] for row in result["checks"]], ["fail", "pass", "pass"])
        self.assertEqual(result["checks"][0]["unit"], "MPa")
        for value in (None, -99999, float("nan")):
            bad = copy.deepcopy(raw); bad["steel_checks"][1][0][0] = value
            with self.assertRaises(ValueError): parse_member_design("C", bad, "steel", "column")
        with self.assertRaises(ValueError): parse_member_design("C", {}, "steel", "column")

    def test_signed_tension_is_preserved_and_compared_by_magnitude(self):
        raw = {"steel_checks": [1, [[-330., 305., 2., 0., 0., 0., 15., 305., 3.]], [[0.]*18]]}
        rows = parse_member_design("C", raw, "steel", "column")["checks"]
        self.assertEqual(rows[0]["signedStress"], -330.)
        self.assertEqual(rows[0]["status"], "fail")
        self.assertGreater(rows[0]["utilization"], 1)
        self.assertEqual(rows[1]["status"], "not_applicable")
        with self.assertRaises(ValueError):
            parse_member_design("C", {"steel_checks": [1, [[0.]*9], [[0.]*18]]}, "steel", "column")

    def test_real_native_signed_beam_record(self):
        raw = json.loads((ROOT / "__tests__/fixtures/native-steel-design-record.json").read_text("utf-8"))["raw"]
        checks = parse_member_design("B", raw, "steel", "beam")["checks"]
        self.assertEqual(len(checks), 5)
        self.assertLess(checks[0]["signedStress"], 0)
        self.assertEqual(checks[2]["status"], "not_applicable")
        self.assertEqual(checks[4]["unit"], "MPa")
        self.assertEqual(checks[4]["nativeCombination"]["id"], 1)

    def test_physical_steel_geometry_uses_native_shear_area_convention(self):
        from yjk_native_materials import section_representation
        cases = [({"kind": "H", "B": 200., "H": 400., "tw": 8., "tf": 13.},
                  "native-physical-I", .008192, .004333333333333333, .0032),
                 ({"kind": "box", "B": 300., "H": 400., "t": 20.},
                  "native-physical-box", .0264, .012, .016)]
        for shape, method, area, asy, asz in cases:
            row = section_representation({"id": "S", "shape": shape})
            self.assertEqual(row["method"], method)
            for key, value in (("A", area), ("Asy", asy), ("Asz", asz)):
                self.assertAlmostEqual(row["baseline"][key], value, places=14)

    def test_standard_concrete_identity_is_not_replaced_with_C30(self):
        from yjk_native_materials import native_baseline
        for grade in range(15, 85, 5):
            result = native_baseline({"id": "M", "category": "concrete", "grade": "C"+str(grade),
                                      "E": 30000., "nu": .2, "G": 12500., "rho": 2500.})
            self.assertEqual(result["grade"], "C"+str(grade))
            self.assertEqual(result["representation"], "native-grade-with-rigidity-transfer")

    def test_design_needs_actual_native_geometry_not_only_equal_stiffness(self):
        section = {"id": "S", "shape": {"kind": "H", "B": 200., "H": 400., "tw": 8., "tf": 13.}}
        native = {"section_info": [2, 8., 400., 200., 13., 200., 13., 0, 5, 0]}
        self.assertTrue(verify_physical_design_section(section, native)["verified"])
        with self.assertRaises(ValueError):
            verify_physical_design_section(section, {"section_info": [1, 400., 600., 0, 0, 0, 0]})
        with self.assertRaises(ValueError):
            verify_physical_design_section(section, None)

    def test_missing_design_geometry_is_input_required_before_native_launch(self):
        spec = importlib.util.spec_from_file_location("yjk_design_runtime_contract", ROOT / "runtime.py")
        runtime = importlib.util.module_from_spec(spec); spec.loader.exec_module(runtime)
        model = json.loads((ROOT / "__tests__/fixtures/native-design-steel-box-model.json").read_text("utf-8"))
        for section in model["sections"]:
            section.pop("shape")
            section["type"] = "custom"
        request = {"requested": True, "code": "GB50017-2017", "adoptedNativeDefaults": True}
        with self.assertRaises(ValueError) as raised:
            runtime.run_analysis(model, {"design": request})
        self.assertEqual(raised.exception.error_code, "ANALYSIS_INPUT_REQUIRED")

    def test_column_axial_ratio_not_applicable_is_not_pass(self):
        raw = {"reinforcement": [1, 201., [[700., 400., 1.]*4], [[0.]*24]],
               "axial_compression_ratio": [0., 99., 0., 0.]}
        result = parse_member_design("C", raw, "concrete", "column")
        self.assertEqual(result["checks"][0]["status"], "not_applicable")


if __name__ == "__main__": unittest.main()
