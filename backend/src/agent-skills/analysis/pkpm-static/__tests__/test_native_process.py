from __future__ import annotations

import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

SKILL = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(SKILL), str(SKILL.parent / "runtime")]
spec = importlib.util.spec_from_file_location("pkpm_native_process_test", SKILL / "runtime.py")
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


class NativeProcessTest(unittest.TestCase):
    def setUp(self):
        external_cycle = patch.object(runtime, "_assert_no_external_cycle")
        self.external_cycle = external_cycle.start()
        self.addCleanup(external_cycle.stop)
        completion = patch.object(runtime, "_verify_native_completion")
        completion.start()
        self.addCleanup(completion.stop)

    def test_existing_native_batch_does_not_change_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            config = folder / "DirectorySet.conf"
            config.write_bytes(b"existing native batch")
            self.external_cycle.side_effect = RuntimeError("native batch is active")
            with patch.object(runtime.subprocess, "Popen") as launch:
                with self.assertRaisesRegex(RuntimeError, "native batch is active"):
                    runtime._run_jws_cycle(folder / "JWSCYCLE.exe", folder)
            launch.assert_not_called()
            self.assertEqual(config.read_bytes(), b"existing native batch")

    def test_native_stages_never_modify_installation_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            work = folder / "work"
            work.mkdir()
            config = folder / "DirectorySet.conf"
            original = "G:\\工程\\既有目录\r\n".encode("gbk")
            config.write_bytes(original)
            def stages(cycle, project, constraints, terminate, timeout, **kwargs):
                self.assertEqual(config.read_bytes(), original)
                self.assertEqual(project, work)
                self.assertFalse(kwargs["include_design"])
                self.assertEqual(terminate, runtime._terminate_cycle_tree)
            with patch("native_stages.run_native_stages", side_effect=stages) as launch:
                runtime._run_jws_cycle(folder / "JWSCYCLE.exe", work)
            launch.assert_called_once()
            self.assertEqual(config.read_bytes(), original)
            self.assertFalse((folder / ".structureclaw-cycle.lock").exists())

    def test_abrupt_worker_failure_does_not_need_configuration_restoration(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            config = folder / "DirectorySet.conf"
            config.write_bytes(b"user-owned configuration")
            with patch("native_stages.run_native_stages", side_effect=SystemExit("worker stopped")):
                with self.assertRaisesRegex(SystemExit, "worker stopped"):
                    runtime._run_jws_cycle(folder / "JWSCYCLE.exe", folder)
            self.assertEqual(config.read_bytes(), b"user-owned configuration")

    def test_compiled_constraints_and_design_interpretation_are_explicit(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            constraints, model = [{"id": "pin"}], {"sections": []}
            with patch("native_stages.run_native_stages") as launch:
                runtime._run_jws_cycle(folder / "JWSCYCLE.exe", folder, 17,
                                      constraints=constraints, section_model=model, include_design=True)
            self.assertEqual(launch.call_args.args[2], constraints)
            self.assertEqual(launch.call_args.kwargs, {"section_model": model, "include_design": True})
            self.assertFalse((folder / "DirectorySet.conf").exists())

    def test_stage_timeout_stops_only_owned_process_and_keeps_failure_evidence(self):
        from native_stages import run_native_stages
        import json
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            process = Mock(returncode=-9)
            process.poll.return_value = None
            process.communicate.side_effect = [subprocess.TimeoutExpired("owned", 1), (b"partial", b"")]
            def stop(owned):
                self.assertIs(owned, process)
                process.poll.return_value = -9
            with patch("native_stages.subprocess.Popen", return_value=process), patch.object(runtime, "_terminate_cycle_tree", side_effect=stop) as terminate:
                with self.assertRaisesRegex(RuntimeError, "timed out"):
                    run_native_stages(folder / "JWSCYCLE.exe", folder, None, terminate, timeout=1)
            terminate.assert_called_once_with(process)
            receipt = json.loads((folder / "native-stage-evidence.json").read_text())
            self.assertEqual(receipt["status"], "failed")
            self.assertFalse(receipt["sharedDirectoryConfigurationModified"])
            self.assertTrue(receipt["phases"][0]["timedOut"])

    def test_design_parameters_reapplied_after_pmcad_before_solver_preprocessing(self):
        from native_stages import run_native_stages
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            (folder / "owned.JWS").write_bytes(b"owned")
            process = Mock(returncode=0)
            process.communicate.return_value = (b"", b"")
            process.poll.return_value = 0
            plan = {"parameters": {"beamMainRebarGrade": {"requested": "HRB500"}}}
            def stop_after_readback(path, requested):
                self.assertEqual(path, folder / "owned.JWS")
                self.assertEqual(requested, plan)
                self.assertEqual(launch.call_count, 1)
                self.assertIn("-AUTORIB", launch.call_args.args[0])
                raise RuntimeError("readback checkpoint")
            with patch("native_stages.subprocess.Popen", return_value=process) as launch, \
                    patch("pkpm_native_design.reapply_design_parameters", side_effect=stop_after_readback):
                with self.assertRaisesRegex(RuntimeError, "readback checkpoint"):
                    run_native_stages(folder / "JWSCYCLE.exe", folder, None, Mock(), include_design=True, design_plan=plan)

    def test_independent_process_cannot_acquire_owned_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            lock = Path(directory) / "cycle.lock"
            script = (
                "import sys,importlib.util; "
                f"sys.path[:0]={repr([str(SKILL), str(SKILL.parent / 'runtime')])}; "
                f"s=importlib.util.spec_from_file_location('probe',{str(SKILL / 'runtime.py')!r}); "
                "m=importlib.util.module_from_spec(s);s.loader.exec_module(m); "
                f"m._cycle_file_lock(m.Path({str(lock)!r}),0.1).__enter__()"
            )
            with runtime._cycle_file_lock(lock, 1):
                result = subprocess.run([sys.executable, "-c", script], capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(b"already running another analysis", result.stderr)
            with runtime._cycle_file_lock(lock, 0.1):
                pass


if __name__ == "__main__":
    unittest.main()
