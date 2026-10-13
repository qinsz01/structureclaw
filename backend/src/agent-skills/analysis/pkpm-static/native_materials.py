"""Version-checked bridge to native user-material records absent in Python API.

The exported native API owns persistence. No DLL or user installation is
modified. The record layout is tied to an audited native binary, rather than
assuming that a C++ ABI remains compatible across software releases.
"""
from __future__ import annotations

import ctypes
import hashlib
import math
import struct
from pathlib import Path


class _UserMaterial(ctypes.Structure):
    _fields_ = [("vtable", ctypes.c_void_p), ("id", ctypes.c_int), ("kind", ctypes.c_int),
                ("name", ctypes.c_char * 32), ("data", ctypes.c_double * 20)]


def add_user_material(api, *, name: str, E: float, nu: float, unit_weight: float) -> dict:
    """Write and immediately read the native record; solver validation is separate."""
    if ctypes.sizeof(ctypes.c_void_p) != 8 or ctypes.sizeof(_UserMaterial) != 208:
        raise RuntimeError("Unsupported native material ABI / 不支持的原生材料接口布局")
    if not all(math.isfinite(v) for v in (E, nu, unit_weight)) or E <= 0 or not (-1 < nu < .5) or unit_weight < 0:
        raise ValueError("Invalid native material constants / 原生材料常数无效")
    encoded = name.encode("ascii")
    if not encoded or len(encoded) > 31:
        raise ValueError("Native material name must contain 1–31 ASCII bytes / 原生材料名称须为1至31个ASCII字节")
    path = Path(api.__file__).parent / "PmsrwData_x64.dll"
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    # Assigned after isolated native save/readback and solver validation.
    if digest != "ca7a47b9006eb4b4f5f88c37014b0da5c090029de518a1d6ab69dbea0d2f6560":
        raise RuntimeError("Native material DLL has not passed this ABI audit / 此原生材料库尚未通过接口验收")
    library = ctypes.CDLL(str(path))
    library.AddOneUserMaterial.argtypes = [ctypes.POINTER(_UserMaterial)]
    library.AddOneUserMaterial.restype = None
    library.GetUserMaterialByID.argtypes = [ctypes.c_int, ctypes.POINTER(_UserMaterial), ctypes.POINTER(ctypes.c_int)]
    library.GetUserMaterialByID.restype = None
    copy_type = ctypes.WINFUNCTYPE(ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p)

    @copy_type
    def copy_record(target, source):
        ctypes.memmove(target + 8, source + 8, ctypes.sizeof(_UserMaterial) - 8)
        return target

    vtable = (ctypes.c_void_p * 1)(ctypes.cast(copy_record, ctypes.c_void_p).value)
    requested = _UserMaterial(); requested.vtable = ctypes.addressof(vtable)
    requested.kind = 15; requested.name = encoded
    requested.data[:5] = [unit_weight, E, nu, 0, 0]
    library.AddOneUserMaterial(ctypes.byref(requested))
    actual = _UserMaterial(); actual.vtable = ctypes.addressof(vtable)
    status = ctypes.c_int()
    library.GetUserMaterialByID(requested.id, ctypes.byref(actual), ctypes.byref(status))
    if status.value or actual.id != requested.id or actual.name != encoded or list(actual.data) != list(requested.data):
        raise RuntimeError("Native user-material readback differs / 原生自定义材料回读不符")
    return {"nativeMaterialId": actual.id, "nativeName": actual.name.decode(),
            "nativeValues": list(actual.data), "dllSha256": digest, "recordBytes": ctypes.sizeof(_UserMaterial),
            "requested": {"E": E, "nu": nu, "unitWeight": unit_weight},
            "source": "PmsrwData_x64.AddOneUserMaterial/GetUserMaterialByID",
            "acceptance": "native-elastic-analysis-calibrated", "nativeCodeDesignSupported": False}


def verify_solver_materials(work_dir: Path, materials: dict[str, dict]) -> dict:
    """Verify the material constants consumed by SATWE, not only PMCAD input."""
    if not materials:
        return {}
    path = Path(work_dir) / "UserMaterial.SAT"
    payload = path.read_bytes()
    if len(payload) < 16:
        raise RuntimeError("Truncated native material file / 原生材料文件不完整")
    version, native_version, count, width = struct.unpack_from("<4i", payload)
    if version != 3 or native_version != 20190824 or width != 96 or len(payload) != 16 + count * width:
        raise RuntimeError("Unknown native material file schema / 未验收的原生材料文件格式")
    records = {}
    for index in range(count):
        offset = 16 + index * width
        identity, kind = struct.unpack_from("<2i", payload, offset + 36)
        name = payload[offset + 4:offset + 36].split(b"\0", 1)[0].decode("ascii")
        values = struct.unpack_from("<6d", payload, offset + 48)
        if identity in records or kind != 15:
            raise RuntimeError("Ambiguous native material identity / 原生材料编号不唯一")
        records[identity] = {"name": name, "values": values}
    for source_id, material in materials.items():
        actual = records.get(material["nativeMaterialId"])
        wanted = material["requested"]
        # Native PMCAD materializes unit weight with six significant digits.
        # Only the no-self-weight static path is enabled; density is retained
        # in the source and this exact transport rounding is recorded.
        expected = (float(format(wanted["unitWeight"], ".6g")), wanted["E"] * 1000, wanted["nu"], 0., 0., 0.)
        if actual is None or actual["name"] != material["nativeName"] or actual["values"] != expected:
            raise RuntimeError(f"Native solver material differs for {source_id} / 求解器材料常数不符")
    return {"source": "UserMaterial.SAT", "sha256": hashlib.sha256(payload).hexdigest(),
            "materials": materials, "units": {"E": "kN/m2", "unitWeight": "kN/m3"},
            "nativeUnitWeightEncoding": "six-significant-decimal-digits; static self-weight disabled",
            "nativeCodeDesignSupported": False}
