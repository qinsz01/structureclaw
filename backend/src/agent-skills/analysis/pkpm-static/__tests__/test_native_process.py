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

    def test_preserves_original_configuration_bytes_and_transcripts(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            work = folder / "work"
            work.mkdir()
            config = folder / "DirectorySet.conf"
            original = "G:\\工程\\既有目录\r\n".encode("gbk")
            config.write_bytes(original)
            process = Mock(returncode=0)
            process.communicate.return_value = ("native stdout", "native stderr")
            with patch.object(runtime.subprocess, "Popen", return_value=process):
                runtime._run_jws_cycle(folder / "JWSCYCLE.exe", work)
            self.assertEqual(config.read_bytes(), original)
            self.assertEqual((work / "cycle-stdout.log").read_text(), "native stdout")
            self.assertEqual((work / "cycle-stderr.log").read_text(), "native stderr")

    def test_timeout_terminates_owned_tree_before_restoring_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            work = folder / "work"
            work.mkdir()
            config = folder / "DirectorySet.conf"
            config.write_bytes(b"original")
            process = Mock()
            process.communicate.side_effect = [subprocess.TimeoutExpired("JWSCYCLE", 1), ("partial", "")]

            def terminate(owned):
                self.assertIs(owned, process)
                self.assertEqual(config.read_text(), str(work))

            with patch.object(runtime.subprocess, "Popen", return_value=process), patch.object(runtime, "_terminate_cycle_tree", side_effect=terminate) as stop:
                with self.assertRaisesRegex(RuntimeError, "timed out"):
                    runtime._run_jws_cycle(folder / "JWSCYCLE.exe", work, 1)
            stop.assert_called_once_with(process)
            self.assertEqual(config.read_bytes(), b"original")
            self.assertEqual((work / "cycle-stdout.log").read_text(), "partial")

    def test_does_not_replace_new_external_directory_selection(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            process = Mock(returncode=0)

            def communicate(**_kwargs):
                (folder / "DirectorySet.conf").write_bytes(b"external user's choice")
                return "", ""

            process.communicate.side_effect = communicate
            with patch.object(runtime.subprocess, "Popen", return_value=process):
                runtime._run_jws_cycle(folder / "JWSCYCLE.exe", folder)
            self.assertEqual((folder / "DirectorySet.conf").read_bytes(), b"external user's choice")

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
