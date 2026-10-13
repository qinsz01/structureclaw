import importlib.util
from pathlib import Path
import struct
import unittest

SPEC = importlib.util.spec_from_file_location("native_settings", Path(__file__).parents[1] / "native_settings.py")
settings = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(settings)


class NativeAPI:
    """The official getters return strings, including an empty unset value."""
    def __init__(self):
        self.values = {}
        self.saved = False

    def GetSParaInt(self, key):
        return str(self.values[key]) if key in self.values else ""

    def GetSParaFlt(self, key):
        return self.GetSParaInt(key)

    def SetSParInt(self, key, value):
        self.values[key] = value

    def SetSParFloat(self, key, value):
        self.values[key] = struct.unpack("f", struct.pack("f", value))[0]

    def SParaSave(self):
        self.saved = True


class NativeSettingsTests(unittest.TestCase):
    def test_false_controls_disable_both_member_rigid_zones_and_second_order(self):
        model = {"analysis_control": {key: False for key in
                 ("rigid_floor", "rigid_offsets", "self_weight", "p_delta", "construction_stage")}}
        plan = settings.compile_settings(model)
        ints = plan["parameters"]["int"]
        self.assertEqual({key: ints[key] for key in ("606", "609", "650", "608", "697")},
                         {key: 0 for key in ("606", "609", "650", "608", "697")})
        self.assertEqual(ints["601"], 60102)
        self.assertNotIn("801", plan["parameters"]["float"])
        self.assertEqual(plan["verification"], "pending-native-readback-and-fe-audit")

    def test_story_and_global_constraints_cannot_disagree(self):
        with self.assertRaisesRegex(ValueError, "conflicting"):
            settings.compile_settings({"analysis_control": {"rigid_floor": False},
                                       "stories": [{"rigid_diaphragm": True}]})

    def test_non_linear_controls_do_not_silently_fall_back(self):
        for key in ("p_delta", "construction_stage"):
            with self.assertRaisesRegex(ValueError, "not calibrated"):
                settings.compile_settings({"analysis_control": {key: True}})

    def test_string_getters_and_unset_before_are_supported_with_strict_final_readback(self):
        api = NativeAPI()
        result = settings.apply_and_readback({"int": {"601": 1}, "float": {"611": 1.2}}, api)
        self.assertTrue(api.saved)
        self.assertEqual(result["before"]["int"]["601"]["status"], "unset-or-invalid")
        self.assertEqual(result["readback"]["int"]["601"], 1)
        self.assertEqual(result["readback"]["float"]["611"], struct.unpack("f", struct.pack("f", 1.2))[0])

    def test_silent_native_write_rejection_is_failure(self):
        api = NativeAPI()
        api.values[601] = 2
        api.SetSParInt = lambda key, value: None
        with self.assertRaisesRegex(ValueError, "readback mismatch"):
            settings.apply_and_readback({"int": {"601": 1}}, api)

    def test_missing_getter_cannot_partially_write(self):
        api = NativeAPI()
        api.GetSParaFlt = None
        with self.assertRaisesRegex(RuntimeError, "before writing"):
            settings.apply_and_readback({"int": {"601": 1}, "float": {"611": 1}}, api)
        self.assertEqual(api.values, {})

    def test_native_integer_readback_is_not_truncated(self):
        api = NativeAPI()
        api.GetSParaInt = lambda key: "1.5"
        with self.assertRaisesRegex(ValueError, "Invalid native int scalar"):
            settings.apply_and_readback({"int": {"601": 1}}, api)

    def test_invalid_ids_nonfinite_values_and_bool_are_rejected_before_writes(self):
        for params in ({"int": {"0601": 1}}, {"int": {"601": True}},
                       {"float": {"611": float("nan")}}, {"float": {"611": float("inf")}},
                       {"int": {"601": 1}, "float": {"601": 1}}):
            api = NativeAPI()
            with self.assertRaises(ValueError):
                settings.apply_and_readback(params, api)
            self.assertEqual(api.values, {})

    def test_scalar_readback_does_not_validate_wrong_construction_semantics_or_hidden_slab(self):
        model = {"analysis_control": {"rigid_floor": False, "self_weight": False, "rigid_offsets": False}}
        plan = settings.compile_settings(model)
        receipt = {"passed": True, "audit": {"written": plan["parameters"], "readback": plan["parameters"]}}
        fe = {"sha256": "exact-fe", "frames": {"b": {"E": [0.] * 6, "RZL": [0.] * 2}},
              "sectionsRaw": {"NODE": ["1 C=0,0,0 NM=0"], "NONL_CTRL": ["T=1 GeoNL=0"], "ANALYSIS": ["scheme=1"]}}
        report = "恒载计算信息: 一次性加载\n考虑梁端刚域: 否\n考虑柱端刚域: 否\n"
        load = {"passed": True, "feaSha256": "exact-fe", "selfWeight": False}
        self.assertTrue(settings.audit_effective_settings(model, fe, receipt, report, load)["passed"])
        bad = settings.audit_effective_settings(model, fe, receipt, report.replace("一次性加载", "全都生成"), load)
        self.assertIn("construction-report-is-not-once-loaded", bad["failures"])
        fe["sectionsRaw"]["NODE"] = ["1 C=0,0,0 NM=100009"]
        self.assertFalse(settings.audit_effective_settings(model, fe, receipt, report, load)["passed"])

    def test_selected_case_selfweight_audit_cannot_be_reused_for_another_FE_file(self):
        model = {"analysis_control": {"self_weight": False}}
        plan = settings.compile_settings(model)
        receipt = {"passed": True, "audit": {"written": plan["parameters"], "readback": plan["parameters"]}}
        fe = {"sha256": "exact-fe", "frames": {"b": {}}, "sectionsRaw": {"NONL_CTRL": ["GeoNL=0"]}}
        audit = settings.audit_effective_settings(model, fe, receipt, "恒载计算信息: 一次性加载\n",
            {"passed": True, "feaSha256": "old-fe", "selfWeight": False})
        self.assertIn("selected-load-case-selfweight-not-verified", audit["failures"])


if __name__ == "__main__":
    unittest.main()
