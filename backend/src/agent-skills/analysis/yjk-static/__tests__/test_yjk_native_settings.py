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
        self.assertEqual(ints["601"], 1)
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


if __name__ == "__main__":
    unittest.main()
