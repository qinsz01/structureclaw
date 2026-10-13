# Adapted from the independently maintained YJK Flow API (2026-10-12).
# This local copy never imports, edits, or controls its source deployment.
"""Bounded IPC for the inspected YJK 8.0 host; does not load or patch vendor code.

The native receiver consumes an auto-reset notification, peeks its pipe, and
returns to waiting if no bytes are available. The vendor managed sender signals
before writing to a zero-buffer pipe. A scheduling gap can strand both sides.
Buffer and finish each complete request before signaling; never resend commands.
"""

import ctypes
import math
import re
import time
from ctypes import wintypes as w

import hashlib
from pathlib import Path


def sha(path):
    with Path(path).open("rb") as stream:
        digest = hashlib.sha256()
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
        return digest.hexdigest()

HOST_SHA256 = "63077b4678c454231189b2686d97d263f4320f29b93b25a78f9db18c5fd335bf"
MAX_REQUEST_BYTES = 255  # Inspected host reader reserves one byte in a 256-byte buffer.


class Overlapped(ctypes.Structure):
    _fields_ = [
        ("Internal", ctypes.c_size_t),
        ("InternalHigh", ctypes.c_size_t),
        ("Offset", w.DWORD),
        ("OffsetHigh", w.DWORD),
        ("hEvent", w.HANDLE),
    ]


def verify_host(path):
    if sha(path) != HOST_SHA256:
        raise ValueError("SDK IPC protocol has not been verified for this host executable")


def encode_command(name, args):
    if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z_0-9]*", name):
        raise ValueError("Invalid SDK command name")
    if len(args) > 2 or any(not isinstance(arg, str) or any(c in arg for c in "\r\n\0+") for arg in args):
        raise ValueError("SDK command parameters contain an unsupported protocol delimiter")
    payload = ("cmd=" + name + ",para=" + "+".join(args or ("",)) + "\r\n").encode("utf-8")
    if len(payload) > MAX_REQUEST_BYTES:
        raise ValueError("SDK command exceeds the native 255-byte request boundary")
    return payload


def kernel_api():
    k = ctypes.WinDLL("kernel32", use_last_error=True)
    declarations = {
        "CreateEventW": ([ctypes.c_void_p, w.BOOL, w.BOOL, w.LPCWSTR], w.HANDLE),
        "CreateNamedPipeW": (
            [w.LPCWSTR, w.DWORD, w.DWORD, w.DWORD, w.DWORD, w.DWORD, w.DWORD, ctypes.c_void_p],
            w.HANDLE,
        ),
        "ConnectNamedPipe": ([w.HANDLE, ctypes.POINTER(Overlapped)], w.BOOL),
        "ReadFile": (
            [w.HANDLE, ctypes.c_void_p, w.DWORD, ctypes.POINTER(w.DWORD), ctypes.POINTER(Overlapped)],
            w.BOOL,
        ),
        "WriteFile": (
            [w.HANDLE, ctypes.c_void_p, w.DWORD, ctypes.POINTER(w.DWORD), ctypes.POINTER(Overlapped)],
            w.BOOL,
        ),
        "GetOverlappedResult": (
            [w.HANDLE, ctypes.POINTER(Overlapped), ctypes.POINTER(w.DWORD), w.BOOL],
            w.BOOL,
        ),
        "CancelIoEx": ([w.HANDLE, ctypes.POINTER(Overlapped)], w.BOOL),
        "WaitForSingleObject": ([w.HANDLE, w.DWORD], w.DWORD),
        "SetEvent": ([w.HANDLE], w.BOOL),
        "CloseHandle": ([w.HANDLE], w.BOOL),
    }
    for name, (args, result) in declarations.items():
        function = getattr(k, name)
        function.argtypes, function.restype = args, result
    return k


class SdkPipe:
    """One request at a time to the caller's already-identified owned SDK PID."""

    def __init__(self, pid, *, connect_timeout_s=90, command_timeout_s=90):
        if type(pid) is not int or pid <= 0:
            raise ValueError("An owned native PID is required")
        for value in (connect_timeout_s, command_timeout_s):
            if not math.isfinite(value) or not 0 < value <= 86400:
                raise ValueError("SDK IPC deadlines must be finite and bounded")
        self.k = kernel_api()
        self.pipe = self.request_event = self.response_event = None
        self.command_timeout_s = command_timeout_s
        try:
            # The host opens these events immediately after connecting the pipe.
            # Create them first; PID-specific names preserve independent hosts.
            self.request_event = self._event(False, rf"Global\yjk_readyRead_Cpp_{pid}")
            self.response_event = self._event(False, rf"Global\yjk_readyRead_Cs_{pid}")
            self.pipe = self.k.CreateNamedPipeW(
                rf"\\.\pipe\mypipe_{pid}", 0x40080003, 0, 1, 4096, 4096, 0, None
            )
            # Duplex, overlapped, first-instance ownership, byte mode. Nonzero
            # output quota lets a whole command be written before notification.
            if self.pipe == ctypes.c_void_p(-1).value:
                self.pipe = None
                raise ctypes.WinError(ctypes.get_last_error())
            self._io("connect", None, time.monotonic() + connect_timeout_s)
        except BaseException:
            self.close()
            raise

    def _event(self, manual, name=None):
        handle = self.k.CreateEventW(None, manual, False, name)
        if not handle:
            raise ctypes.WinError(ctypes.get_last_error())
        return handle

    def _wait(self, handle, deadline, operation):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("SDK IPC " + operation + " timed out")
        result = self.k.WaitForSingleObject(handle, max(1, math.ceil(remaining * 1000)))
        if result == 258:
            raise TimeoutError("SDK IPC " + operation + " timed out")
        if result != 0:
            raise ctypes.WinError(ctypes.get_last_error())

    def _io(self, operation, data, deadline):
        event = self._event(True)
        ov = Overlapped(hEvent=event)
        count = w.DWORD()
        buffer = (
            ctypes.create_string_buffer(data)
            if operation == "write"
            else ctypes.create_string_buffer(1024)
            if operation == "read"
            else None
        )
        pending = False
        try:
            if operation == "connect":
                ok = self.k.ConnectNamedPipe(self.pipe, ctypes.byref(ov))
            else:
                function = self.k.WriteFile if operation == "write" else self.k.ReadFile
                size = len(data) if operation == "write" else len(buffer)
                ok = function(self.pipe, buffer, size, ctypes.byref(count), ctypes.byref(ov))
            if not ok:
                error = ctypes.get_last_error()
                if operation == "connect" and error == 535:  # Client connected before ConnectNamedPipe.
                    return None
                if error != 997:
                    raise ctypes.WinError(error)
                pending = True
                self._wait(event, deadline, operation)
            if not self.k.GetOverlappedResult(self.pipe, ctypes.byref(ov), ctypes.byref(count), False):
                raise ctypes.WinError(ctypes.get_last_error())
            pending = False
            if operation == "write" and count.value != len(data):
                raise OSError("SDK IPC request was not written completely")
            return buffer.raw[: count.value] if operation == "read" else None
        finally:
            if pending:
                # Retain OVERLAPPED and its buffer until cancellation completes.
                # The parent job deadline remains an independent process bound.
                self.k.CancelIoEx(self.pipe, ctypes.byref(ov))
                self.k.GetOverlappedResult(self.pipe, ctypes.byref(ov), ctypes.byref(count), True)
            self.k.CloseHandle(event)

    def _signal_request(self):
        if not self.k.SetEvent(self.request_event):
            raise ctypes.WinError(ctypes.get_last_error())

    def command(self, name, *args):
        payload = encode_command(name, args)
        if self.pipe is None:
            raise RuntimeError("SDK IPC connection is closed")
        deadline = time.monotonic() + self.command_timeout_s
        try:
            self._io("write", payload, deadline)
            self._signal_request()
            self._wait(self.response_event, deadline, "response notification for " + name)
            received = b""
            while b"\n" not in received:
                chunk = self._io("read", None, deadline)
                if not chunk:
                    raise OSError("SDK host closed without a complete response to " + name)
                received += chunk
                if len(received) > 1024:
                    raise ValueError("SDK response exceeds the bounded protocol")
            line, extra = received.split(b"\n", 1)
            response = line.rstrip(b"\r").decode("utf-8", errors="strict")
            if extra or response != "Success":
                raise RuntimeError("SDK command " + name + " failed: " + repr(response))
            return response
        except BaseException:
            self.close()  # Never resend an uncertain command or reuse its reply.
            raise

    def close(self):
        for name in ("pipe", "request_event", "response_event"):
            handle = getattr(self, name, None)
            if handle is not None:
                self.k.CloseHandle(handle)
                setattr(self, name, None)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
