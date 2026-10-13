"""Exercise the real Windows pipe/event ordering without loading YJK."""

import ctypes
import os
import json
import subprocess
import tempfile
import threading
import time
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from ctypes import wintypes as w
from unittest.mock import patch

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src/agent-skills/analysis/yjk-static"))

from sdk_ipc import SdkPipe, encode_command, kernel_api
from windows_job import InstallationLease, ProcessJob, run_contained_driver


class Encoding(unittest.TestCase):
    def test_native_byte_boundary_and_delimiters(self):
        self.assertEqual(
            encode_command("yjks_pyload", ("model.py", "run_host")),
            b"cmd=yjks_pyload,para=model.py+run_host\r\n",
        )
        for name, args in [
            ("bad\nname", ()),
            ("save", ("a\nb",)),
            ("save", ("a+b",)),
            ("save", ("\0",)),
            ("save", ("x", "y", "z")),
            ("save", ("墙" * 100,)),
        ]:
            with self.subTest(name=name, args=args), self.assertRaises(ValueError):
                encode_command(name, args)
        overhead = len(encode_command("save", ()))
        self.assertEqual(len(encode_command("save", ("x" * (255 - overhead),))), 255)
        with self.assertRaises(ValueError):
            encode_command("save", ("x" * (256 - overhead),))


@unittest.skipUnless(os.name == "nt", "Windows named pipe protocol")
class WindowsPipe(unittest.TestCase):
    def setUp(self):
        self.pid = 2_000_000_000 + uuid.uuid4().int % 100_000_000
        self.stop = threading.Event()
        self.errors = []
        self.commands = []
        self.empty_notifications = []
        self.threads = []

    def tearDown(self):
        self.stop.set()
        for thread in self.threads:
            thread.join(4)
            self.assertFalse(thread.is_alive(), "test client did not exit")
        self.assertEqual(self.errors, [])

    def native_client(self, *, pid=None, count=1, response=b"Success\r\n", respond=True, fragments=False):
        pid = pid or self.pid

        def run():
            k = kernel_api()
            k.CreateFileW.argtypes = [
                w.LPCWSTR,
                w.DWORD,
                w.DWORD,
                ctypes.c_void_p,
                w.DWORD,
                w.DWORD,
                w.HANDLE,
            ]
            k.CreateFileW.restype = w.HANDLE
            k.OpenEventW.argtypes = [w.DWORD, w.BOOL, w.LPCWSTR]
            k.OpenEventW.restype = w.HANDLE
            k.PeekNamedPipe.argtypes = [
                w.HANDLE,
                ctypes.c_void_p,
                w.DWORD,
                ctypes.c_void_p,
                ctypes.POINTER(w.DWORD),
                ctypes.c_void_p,
            ]
            k.PeekNamedPipe.restype = w.BOOL
            handles = []
            try:
                end = time.monotonic() + 3
                while not self.stop.is_set():
                    pipe = k.CreateFileW(rf"\\.\pipe\mypipe_{pid}", 0xC0000000, 0, None, 3, 0, None)
                    if pipe != ctypes.c_void_p(-1).value:
                        break
                    if time.monotonic() > end:
                        raise TimeoutError("test client could not connect")
                    time.sleep(0.002)
                else:
                    return
                handles.append(pipe)
                request = k.OpenEventW(0x100002, False, rf"Global\yjk_readyRead_Cpp_{pid}")
                response_event = k.OpenEventW(0x100002, False, rf"Global\yjk_readyRead_Cs_{pid}")
                assert request and response_event
                handles.extend([request, response_event])
                received = 0
                while not self.stop.is_set() and received < count:
                    if k.WaitForSingleObject(request, 25) != 0:
                        continue
                    available = w.DWORD()
                    if not k.PeekNamedPipe(pipe, None, 0, None, ctypes.byref(available), None):
                        return  # Server deadline closes its owned pipe.
                    if not available.value:
                        self.empty_notifications.append(pid)
                        continue  # Inspected native reader returns to waiting here.
                    buffer = ctypes.create_string_buffer(255)
                    n = w.DWORD()
                    assert k.ReadFile(pipe, buffer, 255, ctypes.byref(n), None)
                    payload = buffer.raw[: n.value]
                    assert payload.endswith(b"\r\n")
                    self.commands.append((pid, payload))
                    received += 1
                    if not respond:
                        self.stop.wait(3)
                        return
                    k.SetEvent(response_event)  # Native response event precedes its write.
                    parts = (response[:3], response[3:]) if fragments else (response,)
                    for part in parts:
                        if not part:
                            continue
                        buf = ctypes.create_string_buffer(part)
                        if not k.WriteFile(pipe, buf, len(part), ctypes.byref(n), None):
                            return
                        if fragments:
                            time.sleep(0.01)
            except BaseException as exc:
                self.errors.append(repr(exc))
            finally:
                for handle in reversed(handles):
                    k.CloseHandle(handle)

        thread = threading.Thread(target=run, daemon=True)
        self.threads.append(thread)
        thread.start()

    def test_complete_write_precedes_even_delayed_notification(self):
        self.native_client(fragments=True)
        with SdkPipe(self.pid, command_timeout_s=1) as channel:
            signal = channel._signal_request

            def delayed():
                time.sleep(0.1)
                signal()

            with patch.object(channel, "_signal_request", delayed):
                self.assertEqual(channel.command("yjk_formslab_alllayer"), "Success")
        self.assertEqual(self.empty_notifications, [])
        self.assertEqual(len(self.commands), 1)

    def test_old_notify_before_write_reproduces_lost_wakeup(self):
        self.native_client()
        with SdkPipe(self.pid, command_timeout_s=0.2) as channel:
            channel._signal_request()
            end = time.monotonic() + 1
            while not self.empty_notifications and time.monotonic() < end:
                time.sleep(0.002)
            self.assertEqual(self.empty_notifications, [self.pid])
            channel._io("write", encode_command("yjk_save", ()), time.monotonic() + 1)
            with self.assertRaises(TimeoutError):
                channel._wait(channel.response_event, time.monotonic() + 0.1, "old protocol response")
        self.assertEqual(self.commands, [])

    def test_failed_response_is_not_silently_accepted_or_retried(self):
        self.native_client(response=b"Failure\r\n")
        with SdkPipe(self.pid, command_timeout_s=1) as channel:
            with self.assertRaisesRegex(RuntimeError, "Failure"):
                channel.command("yjk_save")
            self.assertIsNone(channel.pipe)
            with self.assertRaisesRegex(RuntimeError, "closed"):
                channel.command("yjk_save")
        self.assertEqual(len(self.commands), 1)

    def test_response_timeout_invalidates_channel(self):
        self.native_client(respond=False)
        with SdkPipe(self.pid, command_timeout_s=0.1) as channel:
            with self.assertRaisesRegex(TimeoutError, "response notification"):
                channel.command("yjk_save")
            self.assertIsNone(channel.pipe)

    def test_unconnected_deadline_cancels_io_and_releases_pipe_name(self):
        with self.assertRaisesRegex(TimeoutError, "connect"):
            SdkPipe(self.pid, connect_timeout_s=0.05)
        self.native_client()
        with SdkPipe(self.pid, command_timeout_s=1) as channel:
            self.assertEqual(channel.command("yjk_save"), "Success")

    def test_six_independent_hosts_preserve_complete_command_sequences(self):
        pids = [self.pid + i for i in range(6)]
        for pid in pids:
            self.native_client(pid=pid, count=12)

        def sequence(pid):
            with SdkPipe(pid, command_timeout_s=2) as channel:
                for i in range(12):
                    channel.command("SetCurrentLabel", f"{pid}-{i}")

        with ThreadPoolExecutor(6) as pool:
            list(pool.map(sequence, pids))
        for pid in pids:
            self.assertEqual(
                [v for p, v in self.commands if p == pid],
                [encode_command("SetCurrentLabel", (f"{pid}-{i}",)) for i in range(12)],
            )
        self.assertEqual(self.empty_notifications, [])


@unittest.skipUnless(os.name == "nt", "Windows process containment")
class WindowsContainment(unittest.TestCase):
    def _run_tree(self, *, timed_out):
        with tempfile.TemporaryDirectory(prefix="sclaw-yjk-owned-") as temporary:
            root = Path(temporary)
            worker = root / "worker.py"
            worker.write_text('''import json, os, subprocess, sys, time
from pathlib import Path
gate = Path(os.environ["SC_YJK_START_GATE"])
while not gate.exists(): time.sleep(.01)
child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"],
                         creationflags=subprocess.CREATE_NO_WINDOW)
Path("child.json").write_text(json.dumps({"pid":child.pid}))
if sys.argv[1] == "timeout": time.sleep(60)
''', encoding="utf-8")
            unrelated = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"],
                                         creationflags=subprocess.CREATE_NO_WINDOW)
            try:
                kwargs = dict(work_dir=root, env=dict(os.environ, YJK_PATH=str(root / "private-sdk")),
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=1)
                command = [sys.executable, str(worker), "timeout" if timed_out else "done"]
                if timed_out:
                    with self.assertRaises(subprocess.TimeoutExpired):
                        run_contained_driver(command, **kwargs)
                else:
                    self.assertEqual(run_contained_driver(command, **kwargs), 0)
                evidence = json.loads((root / "yjk-cleanup.json").read_text(encoding="utf-8"))
                self.assertTrue(evidence["contained"])
                self.assertTrue(evidence["jobClosed"])
                child_pid = json.loads((root / "child.json").read_text())["pid"]
                kernel = ctypes.WinDLL("kernel32", use_last_error=True)
                kernel.OpenProcess.argtypes = [w.DWORD, w.BOOL, w.DWORD]
                kernel.OpenProcess.restype = w.HANDLE
                kernel.WaitForSingleObject.argtypes = [w.HANDLE, w.DWORD]
                kernel.CloseHandle.argtypes = [w.HANDLE]
                handle = kernel.OpenProcess(0x100000, False, child_pid)
                if handle:
                    try:
                        self.assertEqual(kernel.WaitForSingleObject(handle, 3000), 0)
                    finally:
                        kernel.CloseHandle(handle)
                self.assertIsNone(unrelated.poll(), "Unrelated process must remain untouched")
            finally:
                unrelated.kill()
                unrelated.wait(timeout=5)

    def test_completion_closes_owned_child_only(self):
        self._run_tree(timed_out=False)

    def test_timeout_closes_owned_child_only(self):
        self._run_tree(timed_out=True)

    def test_existing_api_installation_ownership_is_respected(self):
        with tempfile.TemporaryDirectory(prefix="sclaw-yjk-lease-") as root:
            first = InstallationLease(root)
            try:
                with self.assertRaisesRegex(RuntimeError, "Another YJK runner"):
                    InstallationLease(root)
            finally:
                first.close()
            InstallationLease(root).close()

    def test_assignment_failure_never_releases_worker_gate(self):
        with tempfile.TemporaryDirectory(prefix="sclaw-yjk-failed-job-") as temporary:
            root = Path(temporary)
            code = ('import os,time; from pathlib import Path; '
                    'p=Path(os.environ["SC_YJK_START_GATE"]); '
                    'exec("while not p.exists(): time.sleep(.01)"); '
                    'Path("vendor-started").touch()')
            with patch("windows_job.ProcessJob", side_effect=OSError("assignment rejected")):
                with self.assertRaisesRegex(OSError, "assignment rejected"):
                    run_contained_driver([sys.executable, "-c", code], work_dir=root,
                        env=dict(os.environ, YJK_PATH=str(root / "private-sdk")),
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=2)
            self.assertFalse((root / "start.gate").exists())
            self.assertFalse((root / "vendor-started").exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
