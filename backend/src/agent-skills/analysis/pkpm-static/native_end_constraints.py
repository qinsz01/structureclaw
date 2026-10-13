"""Version-bound native six-DOF member-end constraint API bridge."""
from __future__ import annotations

import ctypes as c
import hashlib
from pathlib import Path


def add_bottom_pin(api, member_id: int) -> dict:
    """Preserve the exact pin intent; native_stages compiles it for SATWE."""
    path = Path(api.__file__).parent / "PmsrwData_x64.dll"
    if hashlib.sha256(path.read_bytes()).hexdigest() != "ca7a47b9006eb4b4f5f88c37014b0da5c090029de518a1d6ab69dbea0d2f6560":
        raise RuntimeError("Unverified native constraint ABI / 原生约束接口尚未验收")
    dll = c.CDLL(str(path))
    ctor = getattr(dll, "??0CPMJDConstraintDef@@QEAA@XZ")
    ctor.argtypes = [c.c_void_p]; ctor.restype = c.c_void_p
    dtor = getattr(dll, "??1CPMJDConstraintDef@@QEAA@XZ")
    dtor.argtypes = [c.c_void_p]; dtor.restype = None
    add = dll.ghfAddOnePMJDConstraintDefByCheck
    add.argtypes = [c.c_void_p, c.c_void_p, c.POINTER(c.c_float), c.POINTER(c.c_int)]; add.restype = None
    read = dll.ghfGetOneJDConstraintDefByID
    read.argtypes = [c.POINTER(c.c_int), c.c_void_p, c.POINTER(c.c_int)]; read.restype = None
    bind = dll.ghfAddOneJDConstraintToGJ3d
    bind.argtypes = [c.POINTER(c.c_int), c.c_void_p]; bind.restype = None
    record = c.create_string_buffer(96); actual = c.create_string_buffer(96)
    ctor(record); ctor(actual)
    try:
        c.memmove(c.addressof(record) + 8, b"SCLAW_PIN6\0", 11)
        stiffness = (c.c_float * 6).from_buffer(record, 52)
        stiffness[:] = [1e14] * 3 + [0.] * 3
        identity, tolerance = c.c_int(), c.c_float(1e-8)
        add(None, record, c.byref(tolerance), c.byref(identity))
        identity.value = abs(identity.value)
        status = c.c_int(); read(c.byref(identity), actual, c.byref(status))
        if identity.value <= 1000 or status.value != 1 or actual.raw[4:76] != record.raw[4:76]:
            raise RuntimeError("Native end constraint readback differs / 原生杆端约束回读不符")
        binding = (c.c_int * 3)(0, identity.value, 1)
        source = c.c_int(member_id)
        bind(c.byref(source), binding)
        return {"memberId": member_id, "definitionId": identity.value, "binding": list(binding),
                "stiffness": list(stiffness), "acceptance": "sdk-readback; solver-input-compilation-required"}
    finally:
        dtor(actual); dtor(record)
