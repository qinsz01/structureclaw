import importlib.util
import copy
import json
from pathlib import Path
import struct
import unittest

SPEC = importlib.util.spec_from_file_location("yjk_native_settings", Path(__file__).parents[1] / "yjk_native_settings.py")
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
    def rigid_fixture(self):
        return json.loads((Path(__file__).parent / "fixtures/native-rigid-diaphragm.json").read_text("utf8"))

    def test_real_forced_rigid_floor_has_MF_constraints_without_floor_plates(self):
        row = self.rigid_fixture()
        audit = settings.audit_effective_settings(row["model"], row["fe"], row["receipt"], row["report"], row["loadAudit"])
        self.assertTrue(audit["passed"], audit["failures"])
        self.assertEqual(audit["diaphragms"]["groups"]["F1"]["masters"], ["1000005"])
        self.assertEqual(len(audit["diaphragms"]["groups"]["F1"]["nodes"]), 4)

    def test_rigid_floor_rejects_missing_master_wrong_scheme_and_added_slab(self):
        row = self.rigid_fixture()
        for mode in ("master", "scheme", "slab", "report"):
            bad = copy.deepcopy(row)
            if mode == "master":
                bad["fe"]["sectionsRaw"]["NODE"] = [line.replace("FM=1000005", "FM=0", 1) for line in bad["fe"]["sectionsRaw"]["NODE"]]
            elif mode == "scheme":
                bad["fe"]["sectionsRaw"]["ANALYSIS"] = ["scheme=1"]
            elif mode == "slab":
                bad["fe"]["sectionsRaw"]["PLANAR"] = ["unrequested plate"]
            else:
                bad["report"] = bad["report"].replace("对所有楼层强制采用刚性楼板假定", "不强制采用")
            audit = settings.audit_effective_settings(bad["model"], bad["fe"], bad["receipt"], bad["report"], bad["loadAudit"])
            self.assertFalse(audit["passed"], mode)

    def test_rigid_floor_rejects_non_horizontal_nodes(self):
        row = self.rigid_fixture()
        row["model"]["nodes"][-1]["z"] += .1
        with self.assertRaisesRegex(ValueError, "horizontal"):
            settings.compile_settings(row["model"])

    def test_false_controls_disable_both_member_rigid_zones_and_second_order(self):
        model = {"analysis_control": {key: False for key in
                 ("rigid_floor", "rigid_offsets", "self_weight", "p_delta", "construction_stage")}}
        plan = settings.compile_settings(model)
        ints = plan["parameters"]["int"]
        self.assertEqual({key: ints[key] for key in ("606", "609", "650", "608", "697")},
                         {key: 0 for key in ("606", "609", "650", "608", "697")})
        self.assertEqual(ints["601"], 60102)
        self.assertEqual(plan["parameters"]["float"]["801"], 0.)
        self.assertEqual(plan["parameters"]["float"]["803"], 0.)
        self.assertEqual(plan["verification"], "pending-native-readback-and-fe-audit")

    def test_story_and_global_constraints_cannot_disagree(self):
        with self.assertRaisesRegex(ValueError, "conflicting"):
            settings.compile_settings({"analysis_control": {"rigid_floor": False},
                                       "stories": [{"rigid_diaphragm": True}]})

    def test_non_linear_controls_do_not_silently_fall_back(self):
        for key in ("p_delta", "construction_stage"):
            with self.assertRaisesRegex(ValueError, "not calibrated"):
                settings.compile_settings({"analysis_control": {key: True}})

    def test_rigid_column_weight_requires_verified_consistent_load_compilation(self):
        row=self.rigid_fixture()
        row['model']['analysis_control'].update(rigid_offsets=True,self_weight=True)
        audit=settings.audit_effective_settings(row['model'],row['fe'],row['receipt'],row['report'],row['loadAudit'])
        self.assertIn('rigid-axial-selfweight-compilation-unverified',audit['failures'])
        self.assertFalse(audit['passed'])
        for rigid, weight in ((False, True), (True, False)):
            plan = settings.compile_settings({"analysis_control": {"rigid_offsets": rigid, "self_weight": weight}})
            self.assertEqual(plan["controls"]["self_weight"], weight)

    def test_inclined_rigid_ends_require_their_own_mapping(self):
        model = {"analysis_control": {"rigid_offsets": True},
                 "nodes": [{"id": "i", "x": 0, "y": 0, "z": 0}, {"id": "j", "x": 1, "y": 0, "z": 3}],
                 "elements": [{"id": "member", "type": "column", "nodes": ["i", "j"]}]}
        for kind in ("column", "beam"):
            model["elements"][0]["type"] = kind
            with self.assertRaisesRegex(settings.SettingsCapabilityError, "inclined-member"):
                settings.compile_settings(model)

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
