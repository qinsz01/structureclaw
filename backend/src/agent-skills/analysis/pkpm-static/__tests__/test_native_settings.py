from pathlib import Path
import importlib.util
import os
import sys
import tempfile
import time
import unittest

SKILL = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(SKILL), str(SKILL.parent / "runtime")]
from native_settings import control_parameters, validate_settings, verify_effective_settings


def _load_module(name, path):
    """Load a skill's runtime.py under a unique name; runtime.py exists in several skills."""
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


_load_module("pkpm_static_runtime", SKILL / "runtime.py")
from pkpm_static_runtime import _verify_native_completion


class NativeSettingsTest(unittest.TestCase):
    def test_compact_enums_and_zero_weights_are_distinct_from_option_ids(self):
        ints, doubles = control_parameters(dict.fromkeys(
            ("self_weight", "rigid_floor", "p_delta", "rigid_offsets", "construction_stage"), False))
        self.assertEqual(ints, {601: 1, 606: 0, 608: 0, 609: 0, 641: 0})
        self.assertEqual(doubles, {801: 0.0, 803: 0.0})
        with self.assertRaisesRegex(Exception, "false controls"):
            validate_settings({"analysis_control": {"p_delta": True}})
        with self.assertRaisesRegex(Exception, "no-slab"):
            validate_settings({"analysis_control": {"rigid_floor": False}, "stories": [{"dead_load": 3}]})

    def test_report_must_prove_actual_settings_and_no_implicit_slab(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "WMASS.OUT").write_text("竖向荷载计算信息: 按一次加荷方式计算\n是否对全楼强制采用刚性楼板假定: 否", encoding="gb18030")
            (root / "GOUJIAN.OUT").write_text("板总数=0", encoding="gb18030")
            controls = {"construction_stage": False, "rigid_floor": False}
            self.assertTrue(verify_effective_settings(root, controls)["verified"])
            (root / "GOUJIAN.OUT").write_text("板总数=1", encoding="gb18030")
            with self.assertRaisesRegex(RuntimeError, "introduced slabs"):
                verify_effective_settings(root, controls)
            with self.assertRaisesRegex(RuntimeError, "differs"):
                verify_effective_settings(root, {"p_delta": False})

    def test_fresh_outputs_and_native_completion_are_both_required(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ("WMASS.OUT", "WDISP.OUT", "WPJ1.OUT", "SATWE_calibration_MODEL0_HOLO.PDB"):
                (root / name).write_bytes(b"native")
            (root / "CommonInfoOut.log").write_text("全部完成", encoding="gb18030")
            _verify_native_completion(root, time.time())
            (root / "CommonInfoOut.log").write_text("正在计算", encoding="gb18030")
            with self.assertRaisesRegex(RuntimeError, "does not confirm"):
                _verify_native_completion(root, time.time())
            (root / "CommonInfoOut.log").write_text("全部完成", encoding="gb18030")
            os.utime(root / "WMASS.OUT", (1, 1))
            with self.assertRaisesRegex(RuntimeError, "stale"):
                _verify_native_completion(root, time.time())


if __name__ == "__main__":
    unittest.main()
