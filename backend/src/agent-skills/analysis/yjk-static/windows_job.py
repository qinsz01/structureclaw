# Adapted from the independently maintained YJK Flow API (2026-10-12).
# This local copy never imports, edits, or controls its source deployment.
"""Windows process containment; this module never drives application UI."""

import ctypes
import hashlib
import json
import os
import subprocess
from ctypes import wintypes as w
from pathlib import Path


class InstallationLease:
    """Respect the YJK Flow API's installation ownership mutex."""

    def __init__(self, installation):
        if not installation:
            raise ValueError("An explicit private YJK installation is required")
        self.k = ctypes.WinDLL("kernel32", use_last_error=True)
        self.k.CreateMutexW.argtypes = [ctypes.c_void_p, w.BOOL, w.LPCWSTR]
        self.k.CreateMutexW.restype = w.HANDLE
        self.k.CloseHandle.argtypes = [w.HANDLE]
        self.k.CloseHandle.restype = w.BOOL
        root = str(Path(installation).resolve()).lower()
        suffix = hashlib.sha256(root.encode()).hexdigest()[:24]
        self.handle = self.k.CreateMutexW(None, False, "Local\\YjkFlow_" + suffix)
        if not self.handle:
            raise ctypes.WinError(ctypes.get_last_error())
        if ctypes.get_last_error() == 183:
            self.close()
            raise RuntimeError("Another YJK runner owns this installation; use an independent runtime")

    def close(self):
        if self.handle:
            self.k.CloseHandle(self.handle)
            self.handle = None


class BasicLimits(ctypes.Structure):
    _fields_ = [
        ("ProcessTime", ctypes.c_int64),
        ("JobTime", ctypes.c_int64),
        ("Flags", w.DWORD),
        ("MinWorkingSet", ctypes.c_size_t),
        ("MaxWorkingSet", ctypes.c_size_t),
        ("ActiveProcessLimit", w.DWORD),
        ("Affinity", ctypes.c_size_t),
        ("PriorityClass", w.DWORD),
        ("SchedulingClass", w.DWORD),
    ]


class IOCounters(ctypes.Structure):
    _fields_ = [
        (name, ctypes.c_uint64)
        for name in ("ReadOps", "WriteOps", "OtherOps", "ReadBytes", "WriteBytes", "OtherBytes")
    ]


class ExtendedLimits(ctypes.Structure):
    _fields_ = [
        ("Basic", BasicLimits),
        ("IO", IOCounters),
        ("ProcessMemory", ctypes.c_size_t),
        ("JobMemory", ctypes.c_size_t),
        ("PeakProcessMemory", ctypes.c_size_t),
        ("PeakJobMemory", ctypes.c_size_t),
    ]


class ProcessJob:
    def __init__(self, process_handle):
        self.k = ctypes.WinDLL("kernel32", use_last_error=True)
        self.k.CreateJobObjectW.argtypes = [ctypes.c_void_p, w.LPCWSTR]
        self.k.CreateJobObjectW.restype = w.HANDLE
        self.k.SetInformationJobObject.argtypes = [w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD]
        self.k.SetInformationJobObject.restype = w.BOOL
        self.k.AssignProcessToJobObject.argtypes = [w.HANDLE, w.HANDLE]
        self.k.AssignProcessToJobObject.restype = w.BOOL
        self.k.CloseHandle.argtypes = [w.HANDLE]
        self.k.CloseHandle.restype = w.BOOL
        self.handle = self.k.CreateJobObjectW(None, None)
        if not self.handle:
            raise ctypes.WinError(ctypes.get_last_error())
        info = ExtendedLimits()
        info.Basic.Flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        try:
            if not self.k.SetInformationJobObject(self.handle, 9, ctypes.byref(info), ctypes.sizeof(info)):
                raise ctypes.WinError(ctypes.get_last_error())
            if not self.k.AssignProcessToJobObject(self.handle, int(process_handle)):
                raise ctypes.WinError(ctypes.get_last_error())
        except BaseException:
            self.close()
            raise

    def close(self):
        if self.handle:
            self.k.CloseHandle(self.handle)
            self.handle = None

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


def run_contained_driver(command, *, work_dir, env, stdout, stderr, timeout):
    """Contain before releasing the driver gate; close only this process tree.

    All vendor imports and native launches happen after start.gate is written.
    A failure to assign the job kills the waiting worker without launching YJK.
    The UUID run directory must be new: an existing gate cannot prove ownership.
    """
    if os.name != "nt":
        raise RuntimeError("Native YJK process containment requires Windows")
    work_dir = Path(work_dir).resolve()
    gate = work_dir / "start.gate"
    if gate.exists():
        raise ValueError("YJK run directory already has a start gate; use a fresh run")
    worker_env = dict(env, SC_YJK_START_GATE=str(gate))
    lease = InstallationLease(env.get("YJK_PATH") or env.get("YJKS_ROOT"))
    worker = None
    job = None
    contained = False
    try:
        worker = subprocess.Popen(command, cwd=str(work_dir), env=worker_env,
                                  stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr,
                                  close_fds=True, creationflags=subprocess.CREATE_NO_WINDOW)
        job = ProcessJob(worker._handle)
        contained = True
        with gate.open("x", encoding="utf-8") as stream:
            stream.write(str(worker.pid))
        return worker.wait(timeout=timeout)
    finally:
        if job is not None:
            job.close()
        elif worker is not None and worker.poll() is None:
            worker.kill()  # Only the unreleased worker; no vendor child exists yet.
        try:
            if worker is not None:
                try:
                    worker.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    pass
                (work_dir / "yjk-cleanup.json").write_text(json.dumps({
                    "workerPid": worker.pid, "contained": contained,
                    "method": "windows-job-object", "jobClosed": job is not None,
                    "returncode": worker.returncode,
                }, ensure_ascii=False, indent=2), encoding="utf-8")
        finally:
            lease.close()
