"""PKPM static analysis skill — runtime.

Converts a V2 StructureModelV2 JSON payload into a PKPM JWS project file
via APIPyInterface, then invokes JWSCYCLE.exe for SATWE structural analysis,
and extracts results via APIPyInterface.ResultData.

Environment variables
---------------------
PKPM_CYCLE_PATH : str
    Full path to JWSCYCLE.exe on the local machine.
PKPM_WORK_DIR : str, optional
    Directory where PKPM project files are written.
    Defaults to a 'pkpm_projects' subfolder in the system temp directory.
"""
from __future__ import annotations

import logging
import csv
import math
import os
import re
import subprocess
import tempfile
import uuid
import time
from contextlib import contextmanager
from pathlib import Path
from threading import Lock
from typing import Any, Dict

from coordinate_semantics import coordinate_contract_metadata, validate_coordinate_contract
from contracts import AnalysisCapabilityError, EngineNotAvailableError
from pkpm_diagnostics import (
    find_pdb_version_mismatch,
    format_pdb_version_mismatch_error,
    format_pdb_version_mismatch_warning,
)
from native_settings import verify_effective_settings

logger = logging.getLogger(__name__)

_UNAVAILABLE_OUTPUTS = [
    "nodal-rotations", "nodal-reactions", "physical-member-station-positions",
    "verified-local-axis-and-endpoint-conventions",
]

# The native launcher has one shared directory selector per installation.
_jws_cycle_lock = Lock()


def _check_pkpm_available() -> Path:
    """Return Path to JWSCYCLE.exe or raise EngineNotAvailableError."""
    cycle_path = os.getenv("PKPM_CYCLE_PATH", "").strip()
    if not cycle_path:
        raise EngineNotAvailableError(
            engine="pkpm",
            reason=(
                "PKPM_CYCLE_PATH environment variable is not set. "
                "Set it to the full path of JWSCYCLE.exe."
            ),
        )
    p = Path(cycle_path)
    if not p.is_file():
        raise EngineNotAvailableError(
            engine="pkpm",
            reason=f"JWSCYCLE.exe not found at: {cycle_path}",
        )
    return p


def _import_apipyinterface() -> None:
    """Ensure APIPyInterface can be imported; raise EngineNotAvailableError if not."""
    try:
        import APIPyInterface  # noqa: F401
    except ImportError as exc:
        raise EngineNotAvailableError(
            engine="pkpm",
            reason=f"APIPyInterface Python extension not found: {exc}",
        ) from exc


def _read_project_para_int(para: Any, key: int) -> int | None:
    try:
        value = para.GetPara_Int(key)
    except Exception:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _open_pm_model(model: Any, jws_path: Path) -> Any:
    open_result = model.OpenPMModel(str(jws_path))
    if open_result == 0 or open_result is False:
        raise RuntimeError(f"Failed to open PKPM model: {jws_path}")
    return open_result


def _get_project_para(model: Any, jws_path: Path) -> Any:
    para = model.GetProjectPara()
    if para is None:
        raise RuntimeError(f"Failed to read PKPM project parameters: {jws_path}")
    return para


def _verify_project_material_params(jws_path: Path, material_family: str) -> dict[str, Any]:
    """Read the solved model; never rewrite inputs or native report labels."""
    import APIPyInterface

    target_material = 2 if material_family == "steel" else 0
    target_values = {
        101: 0,  # Native compact enum: frame
        103: target_material,  # 结构材料信息
    }

    model = APIPyInterface.Model()
    open_result = _open_pm_model(model, jws_path)
    para = _get_project_para(model, jws_path)
    actual = {str(key): _read_project_para_int(para, key) for key in target_values}

    mismatches = {
        str(key): {"expected": value, "actual": actual.get(str(key))}
        for key, value in target_values.items()
        if actual.get(str(key)) != value
    }
    if mismatches:
        raise RuntimeError(f"PKPM project material parameters were not persisted: {mismatches}")

    return {
        "material_family": material_family,
        "open_result": open_result,
        "target": {str(key): value for key, value in target_values.items()},
        "actual": actual,
        "verified": True,
    }


@contextmanager
def _cycle_file_lock(path: Path, timeout: float):
    """Serialize independent runtime processes before changing native state."""
    with path.open("a+b") as handle:
        if handle.tell() == 0:
            handle.write(b"\0")
            handle.flush()
        deadline = time.monotonic() + timeout
        while True:
            try:
                handle.seek(0)
                if os.name == "nt":
                    import msvcrt
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError as error:
                if time.monotonic() >= deadline:
                    raise RuntimeError("PKPM installation is already running another analysis / PKPM 安装目录已有计算占用") from error
                time.sleep(0.1)
        try:
            yield
        finally:
            handle.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def _terminate_cycle_tree(proc: subprocess.Popen) -> None:
    # Kill descendants before their launcher; killing only JWSCYCLE leaves
    # PKPMMain/WINSAT using the shared configuration after it is restored.
    if proc.poll() is not None:
        return
    if os.name == "nt":
        completed = subprocess.run(
            ["taskkill.exe", "/PID", str(proc.pid), "/T", "/F"],
            capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW,
        )
        if completed.returncode and proc.poll() is None:
            raise RuntimeError(f"Failed to terminate owned PKPM process tree {proc.pid}")
    else:
        import signal
        os.killpg(proc.pid, signal.SIGKILL)
    proc.wait(timeout=10)


def _assert_no_external_cycle(cycle_path: Path) -> None:
    if os.name != "nt":
        return
    snapshot = subprocess.run(
        ["tasklist.exe", "/FI", f"IMAGENAME eq {cycle_path.name}", "/FO", "CSV", "/NH"],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        creationflags=subprocess.CREATE_NO_WINDOW, check=True,
    )
    if any(row and row[0].casefold() == cycle_path.name.casefold()
           for row in csv.reader(snapshot.stdout.splitlines())):
        raise RuntimeError("Another native PKPM batch is active; its configuration was not changed / 已有 PKPM 原生批处理运行，未修改其目录配置")


def _run_jws_cycle(cycle_path: Path, work_dir: Path, timeout: int = 600, constraints=None, section_model=None) -> None:
    """Launch JWSCYCLE.exe using the official DirectorySet.conf mechanism.

    Per PKPM official API documentation (gitee.com/pkpmgh/pkpm-official---api-release):
    1. Write work_dir path into DirectorySet.conf in the PkpmCycle directory.
    2. Set cwd to the PkpmCycle directory.
    3. Launch JWSCYCLE.exe (no CLI arguments needed).

    Serializes processes, preserves configuration bytes, retains the launcher
    transcript, and terminates only this launcher's process tree on timeout.
    """
    cycle_dir = cycle_path.parent
    if constraints or section_model is not None:
        from native_stages import run_native_stages
        with _jws_cycle_lock, _cycle_file_lock(cycle_dir / ".structureclaw-cycle.lock", timeout):
            _assert_no_external_cycle(cycle_path)
            run_native_stages(cycle_path, work_dir, constraints, _terminate_cycle_tree, timeout, section_model=section_model)
        return
    conf_path = cycle_dir / "DirectorySet.conf"
    started_at = time.time()

    with _jws_cycle_lock, _cycle_file_lock(cycle_dir / ".structureclaw-cycle.lock", timeout):
        _assert_no_external_cycle(cycle_path)
        had_previous_conf = conf_path.exists()
        previous_conf = conf_path.read_bytes() if had_previous_conf else None
        selected_conf = str(work_dir).encode("utf-8")
        conf_path.write_bytes(selected_conf)
        proc = None
        try:
            try:
                proc = subprocess.Popen(
                    [str(cycle_path)],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    cwd=str(cycle_dir),
                    creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
                    start_new_session=os.name != "nt",
                )
                try:
                    stdout, stderr = proc.communicate(timeout=timeout)
                except subprocess.TimeoutExpired:
                    _terminate_cycle_tree(proc)
                    stdout, stderr = proc.communicate()
                    (work_dir / "cycle-stdout.log").write_text(stdout or "", encoding="utf-8")
                    (work_dir / "cycle-stderr.log").write_text(stderr or "", encoding="utf-8")
                    raise RuntimeError(f"PKPM analysis timed out after {timeout}s; its process tree was stopped / PKPM 计算超时，已终止本次进程树")
                (work_dir / "cycle-stdout.log").write_text(stdout or "", encoding="utf-8")
                (work_dir / "cycle-stderr.log").write_text(stderr or "", encoding="utf-8")
            except (FileNotFoundError, OSError) as exc:
                raise RuntimeError(
                    f"Failed to launch JWSCYCLE.exe at '{cycle_path}': {exc}"
                ) from exc
        except BaseException:
            if proc is not None and proc.poll() is None:
                _terminate_cycle_tree(proc)
            raise
        finally:
            # An external native client may have selected another directory.
            # Do not overwrite that newer choice while releasing our lock.
            if conf_path.exists() and conf_path.read_bytes() == selected_conf:
                if had_previous_conf:
                    conf_path.write_bytes(previous_conf)
                else:
                    conf_path.unlink()

    if proc.returncode != 0:
        stderr_snippet = (stderr or "")[:500]
        raise RuntimeError(
            f"JWSCYCLE.exe exited with code {proc.returncode}. "
            f"stderr: {stderr_snippet}"
        )
    _verify_native_completion(work_dir, started_at)


def _verify_native_completion(work_dir: Path, started_at: float) -> None:
    """Launcher exit zero alone also occurs when native stages fail."""
    required = [work_dir / name for name in ("CommonInfoOut.log", "WMASS.OUT", "WDISP.OUT", "WPJ1.OUT")]
    databases = list(work_dir.glob("SATWE_*_MODEL0_HOLO.PDB"))
    if len(databases) != 1:
        raise RuntimeError("PKPM did not produce one native result database / 原生结果数据库缺失或不唯一")
    required.extend(databases)
    for path in required:
        if not path.is_file() or path.stat().st_size == 0 or path.stat().st_mtime < started_at - 1:
            raise RuntimeError(f"PKPM native output is missing, empty or stale: {path.name} / 原生输出缺失、为空或过期")
    log = (work_dir / "CommonInfoOut.log").read_text(encoding="gb18030")
    if "全部完成" not in log:
        raise RuntimeError("PKPM native log does not confirm all stages completed / 原生日志未确认全部完成")


def _safe_float(val: Any, default: float = 0.0) -> float:
    try:
        return float(val)
    except (TypeError, ValueError):
        return default


def _max_from_list(values: list[float]) -> float:
    return max(values) if values else 0.0


def _finite_result_float(value: Any, label: str) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError) as error:
        raise RuntimeError(f"PKPM result {label} is not numeric") from error
    if not math.isfinite(number):
        raise RuntimeError(f"PKPM result {label} is not finite")
    return number


def _signed_max_abs(current: float, candidate: float) -> float:
    return candidate if abs(candidate) > abs(current) else current


def _has_core_pkpm_results(extracted: Dict[str, Any]) -> bool:
    if not extracted:
        return False
    has_node_results = bool(extracted.get("case_node_disps"))
    has_member_results = bool(extracted.get("case_beam_forces")) or bool(extracted.get("case_col_forces"))
    return has_node_results and has_member_results


def _read_satwe_params(result: Any) -> Dict[str, Any]:
    """Read SATWE design parameters from SysInfoDetail for verification."""
    satwe_params: Dict[str, Any] = {}
    try:
        sys_info = result.GetSysInfoDetail()
        satwe_params["damping_ratio"] = _safe_float(sys_info.GetDamp_whole())
        satwe_params["structure_type"] = _safe_float(sys_info.GetKind_tb())
        satwe_params["seismic_intensity"] = _safe_float(sys_info.GetLiedu())
        satwe_params["site_category"] = _safe_float(sys_info.GetIgrdtype())
        satwe_params["steel_structure_flag"] = _safe_float(sys_info.GetIe_sts())
        satwe_params["solver_type"] = _safe_float(sys_info.GetIsolver())
        satwe_params["mode_count"] = _safe_float(sys_info.GetVb_nmode())
        satwe_params["basement_count"] = _safe_float(sys_info.GetNbasement0())
    except Exception:
        pass
    return satwe_params


def _read_wmass_design_params(project_dir: Path) -> Dict[str, Any]:
    """Read actual SATWE design parameters printed in WMASS.OUT."""
    path = project_dir / "WMASS.OUT"
    if not path.is_file():
        return {}
    try:
        text = path.read_bytes().decode("gb18030", errors="ignore")
    except OSError:
        return {}

    def _match_float(pattern: str) -> float | None:
        m = re.search(pattern, text)
        return _safe_float(m.group(1), None) if m else None

    def _match_text(pattern: str) -> str | None:
        m = re.search(pattern, text)
        return m.group(1).strip() if m else None

    params: Dict[str, Any] = {}
    for key, value in [
        ("basic_wind_pressure", _match_float(r"WO\s*=\s*([\d.]+)")),
        ("seismic_intensity", _match_float(r"NAF\s*=\s*([\d.]+)")),
        ("mode_count", _match_float(r"NMODE\s*=\s*([\d.]+)")),
        ("characteristic_period", _match_float(r"TG\s*=\s*([\d.]+)")),
        ("max_influence_coefficient", _match_float(r"Rmax1\s*=\s*([\d.]+)")),
        ("period_reduction_factor", _match_float(r"TC\s*=\s*([\d.]+)")),
    ]:
        if value is not None:
            params[key] = value
    damping = _match_float(r"DAMP\s*=\s*([\d.]+)")
    if damping is not None:
        params["damping_ratio"] = damping / 100.0 if damping > 1.0 else damping
        params["damping_ratio_percent"] = damping if damping > 1.0 else damping * 100.0

    terrain = _match_text(r"地面粗糙程度:\s*([ABCD])\s*类")
    if terrain:
        params["terrain_roughness"] = terrain
    site_category = _match_text(r"场地类别:\s*KD\s*=\s*([A-Z0-9]+)")
    if site_category:
        params["site_category"] = site_category
    design_group = _match_text(r"设计地震分组:\s*([一二三]组)")
    if design_group:
        params["design_group"] = design_group
    return params


def _extract_results(jws_path: Path, material_family: str = "steel") -> Dict[str, Any]:
    """Extract design results from a completed SATWE analysis via APIPyInterface."""
    import APIPyInterface

    result = APIPyInterface.ResultData()
    ret = result.InitialResult(str(jws_path))
    if ret == 0:
        raise RuntimeError(f"InitialResult returned FALSE (0) — failed to load results from {jws_path}")

    try:
        # ---- Mode periods ----
        mode_periods: list[dict[str, Any]] = []
        for p in result.GetModePeriods():
            mode_periods.append({
                "index": p.GetIndex(),
                "period_s": round(_finite_result_float(p.GetCycle(), "mode period"), 4),
                "angle": round(_finite_result_float(p.GetAngle(), "mode angle"), 2),
                "torsion_ratio": round(_finite_result_float(p.GetTorsi(), "mode torsion ratio"), 4),
            })

        # ---- Beam & column design data per floor ----
        beam_results: list[dict[str, Any]] = []
        column_results: list[dict[str, Any]] = []
        max_shear_force = 0.0
        max_posi_moment = 0.0
        max_nega_moment = 0.0
        all_node_disp_x: list[float] = []
        all_node_disp_y: list[float] = []
        all_node_disp_z: list[float] = []
        all_node_disp_magnitudes: list[float] = []
        # Per-load-case force accumulation: {case_name: {(pmid,floor): {N,Vy,Vz,T,My,Mz}}}
        case_beam_forces: Dict[str, Dict[tuple[int, int], Dict[str, float]]] = {}
        case_col_forces: Dict[str, Dict[tuple[int, int], Dict[str, float]]] = {}
        case_member_stations: dict[str, dict[tuple[int, int], list[dict[str, Any]]]] = {}
        native_result_members = []

        floor_idx = 1
        max_floors = 500
        while floor_idx <= max_floors:
            beams = result.GetDesignBeams(floor_idx)
            columns = result.GetDesignColumns(floor_idx)
            if not beams and not columns:
                break

            for b in beams:
                pmid = b.GetPmid()

                # Primary: use GetForce() for per-load-case forces
                # GetForce() returns dict[case, dict[pos, [N, Vy, Vz, T, My, Mz]]]
                force_data = b.GetForce()
                beam_max_v = 0.0
                beam_max_m = 0.0
                if force_data:
                    for case_name, inner in force_data.items():
                        for _pos, vals in inner.items():
                            if len(vals) < 6:
                                raise RuntimeError(
                                    f"PKPM beam {pmid} case '{case_name}' returned fewer than six local-force components"
                                )
                            components = [
                                _finite_result_float(value, f"beam {pmid} force[{index}]")
                                for index, value in enumerate(vals[:6])
                            ]
                            case_member_stations.setdefault(case_name, {}).setdefault((pmid, floor_idx), []).append({
                                "nativeStation": int(_pos),
                                "nativeComponents": components,
                                "referenceFrame": "element-local",
                                "source": "APIPyInterface.BeamDesignData.GetForce",
                                "endpointConvention": "unverified",
                            })
                            station_v = math.hypot(components[1], components[2])
                            station_m = math.hypot(components[4], components[5])
                            beam_max_v = max(beam_max_v, station_v)
                            beam_max_m = max(beam_max_m, station_m)
                            # Accumulate per-case forces (keyed by (pmid, floor) to avoid cross-floor overwrite)
                            beam_key = (pmid, floor_idx)
                            case_beam_forces.setdefault(case_name, {}).setdefault(
                                beam_key, {"N": 0.0, "Vy": 0.0, "Vz": 0.0, "T": 0.0, "My": 0.0, "Mz": 0.0, "V": 0.0, "M": 0.0}
                            )
                            entry = case_beam_forces[case_name][beam_key]
                            for component, value in zip(
                                ("N", "Vy", "Vz", "T", "My", "Mz"), components
                            ):
                                entry[component] = _signed_max_abs(entry[component], value)
                            entry["V"] = max(entry["V"], station_v)
                            entry["M"] = max(entry["M"], station_m)

                # Fallback: use design summary methods
                shear = _finite_result_float(b.GetShearingforce(), f"beam {pmid} design shear")
                posi = [
                    _finite_result_float(value, f"beam {pmid} positive moment")
                    for value in b.GetPosiMoment()
                ]
                nega = [
                    _finite_result_float(value, f"beam {pmid} negative moment")
                    for value in b.GetNegaMoment()
                ]

                # Prefer GetForce() values if design methods return 0
                if beam_max_v > 0 and abs(shear) < 0.001:
                    shear = beam_max_v
                if beam_max_m > 0:
                    if _max_from_list([abs(v) for v in posi]) < 0.001:
                        posi = [beam_max_m]
                    if _max_from_list([abs(v) for v in nega]) < 0.001:
                        nega = [beam_max_m]

                max_shear_force = max(max_shear_force, abs(shear))
                max_posi_moment = max(max_posi_moment, _max_from_list([abs(v) for v in posi]))
                max_nega_moment = max(max_nega_moment, _max_from_list([abs(v) for v in nega]))
                beam_results.append({
                    "floor": floor_idx,
                    "pmid": pmid,
                    "max_shear_force_kn": round(shear, 2),
                    "positive_moments_kNm": [round(v, 2) for v in posi],
                    "negative_moments_kNm": [round(v, 2) for v in nega],
                })

            for c in columns:
                pmid = c.GetPmid()
                if hasattr(c, "GetElementid"):
                    native_result_members.append({"kind": "column", "pmid": pmid, "floor": floor_idx,
                        "nativeElementId": c.GetElementid(), "nativeJoints": [c.GetJoint_1(), c.GetJoint_2()]})

                # Primary: use GetForce() for per-load-case forces
                # GetForce() returns dict[case, dict[pos, [N, Vy, Vz, T, My, Mz]]]
                force_data = c.GetForce()
                col_max_n = 0.0
                col_max_v = 0.0
                col_max_m = 0.0
                if force_data:
                    for case_name, inner in force_data.items():
                        for _pos, vals in inner.items():
                            if len(vals) < 6:
                                raise RuntimeError(
                                    f"PKPM column {pmid} case '{case_name}' returned fewer than six local-force components"
                                )
                            components = [
                                _finite_result_float(value, f"column {pmid} force[{index}]")
                                for index, value in enumerate(vals[:6])
                            ]
                            case_member_stations.setdefault(case_name, {}).setdefault((pmid, floor_idx), []).append({
                                "nativeStation": int(_pos),
                                "nativeComponents": components,
                                "referenceFrame": "element-local",
                                "source": "APIPyInterface.ColumnDesignData.GetForce",
                                "endpointConvention": "unverified",
                            })
                            col_max_n = max(col_max_n, abs(components[0]))  # N
                            col_max_v = max(
                                col_max_v, (components[1] ** 2 + components[2] ** 2) ** 0.5
                            )
                            col_max_m = max(
                                col_max_m, (components[4] ** 2 + components[5] ** 2) ** 0.5
                            )
                            # Accumulate per-case forces (keyed by (pmid, floor) to avoid cross-floor overwrite)
                            col_key = (pmid, floor_idx)
                            case_col_forces.setdefault(case_name, {}).setdefault(
                                col_key, {"N": 0.0, "Vy": 0.0, "Vz": 0.0, "T": 0.0, "My": 0.0, "Mz": 0.0, "V": 0.0, "M": 0.0}
                            )
                            entry = case_col_forces[case_name][col_key]
                            for component, value in zip(
                                ("N", "Vy", "Vz", "T", "My", "Mz"), components
                            ):
                                entry[component] = _signed_max_abs(entry[component], value)
                            entry["V"] = max(entry["V"], math.hypot(components[1], components[2]))
                            entry["M"] = max(entry["M"], math.hypot(components[4], components[5]))

                max_shear_force = max(max_shear_force, col_max_v)
                max_posi_moment = max(max_posi_moment, col_max_m)

                column_results.append({
                    "floor": floor_idx,
                    "pmid": pmid,
                    "max_axial_force_kn": round(col_max_n, 2),
                    "max_shear_force_kn": round(col_max_v, 2),
                    "max_moment_kNm": round(col_max_m, 2),
                })

            floor_idx += 1

        # ---- Node displacements (per-load-case, filter sentinel) ----
        _SENTINEL = 99990.0
        node_displacements: list[dict[str, Any]] = []
        # {case_name: {(pmid,floor): {ux, uy, uz, rx, ry, rz}}}
        case_node_disps: Dict[str, Dict[tuple[int, int], Dict[str, float]]] = {}
        native_nodes = []
        has_native_dofs = (jws_path.parent / "DISP.SAT").is_file()
        try:
            for node in result.GetPyNodeInResult():
                pmid = int(node.GetPmID())
                if pmid <= 0:
                    continue
                floor_no = int(node.GetFloorNo())
                if has_native_dofs:
                    native_nodes.append({"pmid": pmid, "floor": floor_no, "coordinates": [
                        node.GetCoordinateX(), node.GetCoordinateY(), node.GetCoordinateZ()]})
                disp_dict = node.GetNodeDisp()
                best_mag = 0.0
                best_dx = best_dy = best_dz = 0.0
                for case_name, nd in disp_dict.items():
                    # PKPM ResultData translations are returned in metres.
                    vx = _finite_result_float(nd.GetDispX(), "node displacement X")
                    vy = _finite_result_float(nd.GetDispY(), "node displacement Y")
                    vz = _finite_result_float(nd.GetDispZ(), "node displacement Z")
                    if abs(vx) >= _SENTINEL or abs(vy) >= _SENTINEL or abs(vz) >= _SENTINEL:
                        continue
                    node_key = (pmid, floor_no)
                    case_node_disps.setdefault(case_name, {})[node_key] = {
                        "ux": vx, "uy": vy, "uz": vz,
                    }
                    mag = (vx ** 2 + vy ** 2 + vz ** 2) ** 0.5
                    if mag > best_mag:
                        best_mag = mag
                        best_dx, best_dy, best_dz = abs(vx), abs(vy), abs(vz)
                dx, dy, dz = best_dx, best_dy, best_dz
                if dx > 0:
                    all_node_disp_x.append(dx)
                if dy > 0:
                    all_node_disp_y.append(dy)
                if dz > 0:
                    all_node_disp_z.append(dz)
                if best_mag > 0:
                    all_node_disp_magnitudes.append(best_mag)
                if dx > 0 or dy > 0 or dz > 0:
                    node_displacements.append({
                        "pmid": pmid,
                        "floor": floor_no,
                        "max_disp_x_mm": round(dx * 1000.0, 4),
                        "max_disp_y_mm": round(dy * 1000.0, 4),
                        "max_disp_z_mm": round(dz * 1000.0, 4),
                    })
        except Exception as error:
            raise RuntimeError(f"Failed to extract PKPM nodal translations: {error}") from error

        displacement_source = None
        constraint_displacements = {}
        if has_native_dofs:
            from native_displacements import read_native_displacements
            native_dofs = read_native_displacements(jws_path.parent, native_nodes, case_node_disps)
            for case, values in native_dofs["caseDisplacements"].items():
                case_node_disps[case].update(values)
            displacement_source = {"source": native_dofs["source"],
                                   "missingNodeRotations": native_dofs["missingNodeRotations"]}
            constraint_displacements = native_dofs["constraintDisplacements"]

        max_displacement = max(all_node_disp_magnitudes, default=0.0)

        # ---- Story drift ratios ----
        story_drift: list[dict[str, Any]] = []
        for label, drift_data in result.GetStoryDrift_Earthquake().items():
            for d in drift_data:
                story_drift.append({
                    "direction": label,
                    "floor": d.Getifloor(),
                    "max_displacement_mm": round(_finite_result_float(d.GetmaxD(), "earthquake story displacement"), 4),
                    "drift_ratio": round(_finite_result_float(d.GetratioD(), "earthquake story drift ratio"), 6),
                })
        for label, drift_data in result.GetStoryDrift_Wind().items():
            for d in drift_data:
                story_drift.append({
                    "direction": label,
                    "floor": d.Getifloor(),
                    "max_displacement_mm": round(_finite_result_float(d.GetmaxD(), "wind story displacement"), 4),
                    "drift_ratio": round(_finite_result_float(d.GetratioD(), "wind story drift ratio"), 6),
                })

        # ---- Story stiffness ----
        storey_stiffness: list[dict[str, Any]] = []
        for s in result.GetStoreyStifs():
            storey_stiffness.append({
                "floor": s.Getfloorindex(),
                "tower": s.GetTowerIndex(),
                "stiffness_x_kn_m": round(_finite_result_float(s.GetRJX(), "storey stiffness X"), 2),
                "stiffness_y_kn_m": round(_finite_result_float(s.GetRJY(), "storey stiffness Y"), 2),
                "ratio_x": round(_finite_result_float(s.GetRatx(), "storey stiffness ratio X"), 4),
                "ratio_y": round(_finite_result_float(s.GetRaty(), "storey stiffness ratio Y"), 4),
            })

        # ---- Bearing shear ----
        bearing_shear: list[dict[str, Any]] = []
        for bs in result.GetBearingShear():
            bearing_shear.append({
                "floor": bs.GetFloorNum(),
                "tower": bs.GetTowerNum(),
                "ratio_x": round(_finite_result_float(bs.GetRatx(), "bearing shear ratio X"), 4),
                "ratio_y": round(_finite_result_float(bs.GetRaty(), "bearing shear ratio Y"), 4),
                "limit_value": round(_finite_result_float(bs.GetLimitVal(), "bearing shear limit"), 4),
            })

        satwe_params = _read_satwe_params(result)
        satwe_params.update(_read_wmass_design_params(jws_path.parent))

        return {
            "mode_periods": mode_periods,
            "beam_count": len(beam_results),
            "column_count": len(column_results),
            "floors_analyzed": floor_idx - 1,
            "summary": {
                "max_displacement_mm": round(max_displacement * 1000.0, 4),
                "max_shear_force_kn": round(max_shear_force, 2),
                "max_bending_moment_kNm": round(max(max_posi_moment, max_nega_moment), 2),
            },
            "beams": beam_results,
            "columns": column_results,
            "node_displacements": node_displacements,
            "story_drift": story_drift,
            "storey_stiffness": storey_stiffness,
            "bearing_shear": bearing_shear,
            "case_node_disps": case_node_disps,
            "native_displacement_source": displacement_source,
            "native_constraint_displacements": constraint_displacements,
            "native_result_members": native_result_members,
            "native_result_nodes": native_nodes,
            "case_beam_forces": case_beam_forces,
            "case_col_forces": case_col_forces,
            "native_case_names": result.GetAllChineseLoadCaseName() if has_native_dofs else {},
            "case_member_stations": case_member_stations,
            "satwe_params": satwe_params,
        }
    finally:
        result.ClearResult()


def run_analysis(model: Dict[str, Any], parameters: Dict[str, Any]) -> Dict[str, Any]:
    """Convert V2 model to PKPM JWS and run SATWE static analysis.

    Parameters
    ----------
    model : dict
        Deserialized StructureModelV2 payload (raw dict, not Pydantic instance).
    parameters : dict
        Analysis parameters forwarded from the API request.

    Returns
    -------
    dict
        AnalysisResult-shaped dict with status / summary / detailed / warnings.

    Raises
    ------
    EngineNotAvailableError
        When PKPM is not installed or APIPyInterface is unavailable.
    RuntimeError
        When JWS generation or SATWE analysis fails.
    """
    parameters = parameters or {}
    requested_cases = parameters.get("loadCaseIds") or []
    if not isinstance(requested_cases, list) or len(set(map(str, requested_cases))) != len(requested_cases):
        raise AnalysisCapabilityError(engine="pkpm", capability="selected-load-cases", reason="loadCaseIds must contain unique case IDs / 工况编号必须唯一")
    validate_coordinate_contract(model)
    from native_model_contract import validate_pkpm_material_properties, validate_pkpm_sections
    model_dict = model.model_dump(mode="json", exclude_unset=True) if hasattr(model, "model_dump") else dict(model)
    from commercial_context import project_commercial_model, attach_native_design_context
    source_model = model_dict
    projection = project_commercial_model(source_model, "pkpm")
    model_dict = projection["analysisModel"]
    combination_id = parameters.get("loadCombinationId")
    if combination_id:
        definitions = [row for row in model_dict.get("load_combinations", []) if row.get("id") == combination_id]
        if requested_cases or len(definitions) != 1 or not definitions[0].get("factors"):
            raise ValueError("Select existing source cases or one explicit combination / 请指定源工况或唯一显式组合")
        requested_cases = list(definitions[0]["factors"])
    available_cases = {str(case["id"]) for case in model_dict.get("load_cases", [])}
    if set(requested_cases) - available_cases:
        raise ValueError("Requested source case does not exist / 请求的源工况不存在")
    validate_pkpm_material_properties(model_dict)
    validate_pkpm_sections(model_dict)
    cycle_path = _check_pkpm_available()
    _import_apipyinterface()

    from pkpm_converter import convert_v2_to_jws  # local import after availability check

    # ---- Determine working directory ----
    base_work_dir = Path(
        os.getenv("PKPM_WORK_DIR", "").strip()
        or Path.home() / ".structureclaw" / "analysis" / "pkpm"
    )
    project_name = f"sc_{uuid.uuid4().hex[:8]}"
    work_dir = base_work_dir / project_name

    warnings: list[str] = []

    # ---- Phase 1: Generate JWS ----
    try:
        # Detect material family before converter (converter needs it for grade setting)
        from pkpm_converter import _detect_material_family as _conv_detect_mat
        material_family = _conv_detect_mat(model_dict)
        jws_path, converter_mappings = convert_v2_to_jws(
            model_dict, work_dir, project_name, material_family=material_family
        )
        import json
        (work_dir / "source-model.json").write_text(json.dumps(source_model, ensure_ascii=False), encoding="utf-8")
        (work_dir / "model-projection.json").write_text(json.dumps(
            {key: value for key, value in projection.items() if key != "analysisModel"}, ensure_ascii=False), encoding="utf-8")
    except AnalysisCapabilityError:
        raise
    except Exception as exc:
        raise RuntimeError(f"PKPM JWS generation failed: {exc}") from exc

    # ---- Phase 2: Run SATWE via JWSCYCLE.exe ----
    timeout = int(parameters.get("timeout", 600))
    from native_numeric_sections import has_numeric_sections, verify_numeric_sections
    numeric_sections = has_numeric_sections(model_dict)
    if numeric_sections:
        _run_jws_cycle(cycle_path, work_dir, timeout=timeout,
                       constraints=converter_mappings.get("native_end_constraints"), section_model=model_dict)
    elif converter_mappings.get("native_end_constraints"):
        _run_jws_cycle(cycle_path, work_dir, timeout=timeout, constraints=converter_mappings["native_end_constraints"])
    else:
        _run_jws_cycle(cycle_path, work_dir, timeout=timeout)

    # Verify the settings used; changing the solved project cannot fix a run.
    project_parameter_verification = _verify_project_material_params(jws_path, material_family)
    native_controls = converter_mappings.get("design_conditions", {}).get("analysis_control", {})
    effective_settings = verify_effective_settings(work_dir, native_controls)
    from native_materials import verify_solver_materials
    material_verification = verify_solver_materials(work_dir, converter_mappings.get("native_materials", {}))
    section_verification = verify_numeric_sections(work_dir, model_dict) if numeric_sections else None

    # ---- Phase 3: Extract results via APIPyInterface ----
    # material_family was already detected in Phase 1 and passed to converter

    try:
        extracted = _extract_results(jws_path, material_family=material_family)
    except Exception as exc:
        pdb_mismatch = find_pdb_version_mismatch(work_dir)
        if pdb_mismatch:
            raise RuntimeError(
                f"{format_pdb_version_mismatch_error(work_dir, cycle_path, pdb_mismatch)} "
                f"Result extraction failed: {exc}"
            ) from exc
        raise RuntimeError(f"PKPM result extraction failed: {exc}") from exc
    pdb_mismatch = find_pdb_version_mismatch(work_dir)
    if pdb_mismatch:
        if not _has_core_pkpm_results(extracted):
            raise RuntimeError(format_pdb_version_mismatch_error(work_dir, cycle_path, pdb_mismatch))
        warnings.append(format_pdb_version_mismatch_warning(work_dir, cycle_path, pdb_mismatch))

    if not requested_cases and extracted.get("native_displacement_source"):
        requested_cases = [str(case["id"]) for case in model_dict.get("load_cases", [])]
    if requested_cases:
        names = {}
        for requested_id in map(str, requested_cases):
            source_case = next((case for case in model_dict.get("load_cases", []) if str(case.get("id")) == requested_id), {})
            if not source_case:
                raise AnalysisCapabilityError(engine="pkpm", capability="selected-load-case", reason=f"Unknown requested case '{requested_id}' / 请求工况不存在")
            native_name = converter_mappings.get("native_load_mapping", {}).get("cases", {}).get(requested_id, {}).get("nativeLabel")
            native_name = native_name or {"dead": "DL", "live": "LL"}.get(source_case.get("type"), requested_id)
            if native_name not in extracted.get("case_node_disps", {}):
                labels = [key for key, name in extracted.get("native_case_names", {}).items() if name == native_name]
                if len(labels) != 1:
                    raise ValueError(f"Native source case label '{native_name}' is ambiguous or missing / 原生源工况标签缺失或不唯一")
                native_name = labels[0]
            required_fields = ["case_node_disps"]
            for role, field in (("beam", "case_beam_forces"), ("column", "case_col_forces")):
                if any(element.get("type") == role for element in model_dict.get("elements", [])):
                    required_fields.append(field)
            for field in required_fields:
                if native_name not in extracted.get(field, {}):
                    raise AnalysisCapabilityError(engine="pkpm", capability="selected-load-case", reason=f"Native {field} has no verified mapping for requested case '{requested_id}'")
            names[requested_id] = native_name
        for field in ("case_node_disps", "case_beam_forces", "case_col_forces", "case_member_stations", "native_constraint_displacements"):
            block = extracted.get(field, {})
            extracted[field] = {requested_id: block[native_name] for requested_id, native_name in names.items() if native_name in block}

    # ---- Phase 4: Map to frontend-compatible analysis result format ----
    pkpm_summary = extracted.get("summary", {})
    node_disps = extracted.get("node_displacements", [])
    beams = extracted.get("beams", [])
    columns = extracted.get("columns", [])
    design_conditions = converter_mappings.get("design_conditions", {})
    floor_load_mapping = converter_mappings.get("floor_load_mapping", [])

    # ---- Build V2 node → PKPM (floor, pmid) mapping ----
    v2_to_pm: Dict[str, int] = converter_mappings.get("v2_to_pm", {})
    v2_node_z: Dict[str, float] = converter_mappings.get("v2_node_z", {})
    elem_map_raw: Dict[str, Any] = converter_mappings.get("elem_map", {})

    # Build story top elevations for floor mapping
    stories_source = converter_mappings.get("stories") or model_dict.get("stories")
    story_items = stories_source if isinstance(stories_source, list) else []
    sorted_stories = sorted(
        story_items,
        key=lambda s: _safe_float(s.get("elevation", 0)) if isinstance(s, dict) else 0.0,
    )
    story_tops: list[float] = []
    for st in sorted_stories:
        if not isinstance(st, dict):
            continue
        elev = _safe_float(st.get("elevation", 0))
        h = _safe_float(st.get("height", 0))
        story_tops.append(elev + h)

    # Map each V2 node to one exact PKPM natural floor number (1-indexed).
    coordinate_tolerance = 1e-6
    v2_node_floor: Dict[str, int] = {}
    for v2_id, z in v2_node_z.items():
        z_value = _finite_result_float(z, f"input node '{v2_id}' global Z")
        if abs(z_value) <= coordinate_tolerance:
            v2_node_floor[v2_id] = 0  # base
            continue
        matches = [
            i + 1 for i, top_z in enumerate(story_tops)
            if abs(z_value - top_z) <= coordinate_tolerance
        ]
        if len(matches) != 1:
            raise RuntimeError(
                f"V2 node '{v2_id}' at global Z={z_value} does not map uniquely to a PKPM floor"
            )
        v2_node_floor[v2_id] = matches[0]

    # JWSCYCLE assigns new entity IDs to copied standard floors.  Refresh the
    # converter mapping only when the extracted result IDs show that renumbering
    # actually occurred; reused standard floors retain the original IDs.
    floor_load_mapping = converter_mappings.get("floor_load_mapping", [])
    copied_natural_floors = {
        index + 1
        for index, item in enumerate(floor_load_mapping)
        if int(item.get("stand_floor_index", 1)) > 1
    }
    extracted_node_keys = {
        key
        for case_values in extracted.get("case_node_disps", {}).values()
        for key in case_values
    }
    needs_result_mapping_refresh = any(
        {pmid for pmid, result_floor in extracted_node_keys if result_floor == floor}
        != {
            int(v2_to_pm[v2_id])
            for v2_id, node_floor in v2_node_floor.items()
            if node_floor == floor
        }
        for floor in copied_natural_floors
    )
    if needs_result_mapping_refresh:
        from pkpm_converter import refresh_result_mappings

        converter_mappings = refresh_result_mappings(jws_path, converter_mappings)
        v2_to_pm = converter_mappings.get("v2_to_pm", {})
        elem_map_raw = converter_mappings.get("elem_map", {})

    # Build reverse: (pkpm_pmid, floor) → v2_node_id
    pm_floor_to_v2: Dict[tuple[int, int], str] = {}
    for v2_id, pm_id in v2_to_pm.items():
        floor = v2_node_floor.get(v2_id, -1)
        if floor > 0 or (pm_id, floor) in extracted_node_keys:
            key = (pm_id, floor)
            if key in pm_floor_to_v2:
                raise RuntimeError(
                    f"PKPM node mapping collision for plan node {pm_id} on floor {floor}"
                )
            pm_floor_to_v2[key] = v2_id

    # Populated from signed per-case translations below.  Aggregate PKPM
    # displacement summaries contain absolute values and are not vectors.
    displacements: Dict[str, Dict[str, float]] = {}

    # Build (pmid, floor) → V2 element ID mapping
    # PKPM same pmid repeats on every floor; tuple key disambiguates.
    v2_elem_by_id: Dict[str, dict] = {
        e.get("id", ""): e for e in model_dict.get("elements", [])
    }
    pm_floor_elem_to_v2: Dict[tuple[int, int], str] = {}
    for v2_eid, info in elem_map_raw.items():
        pmid = info["pmid"]
        elem_data = v2_elem_by_id.get(v2_eid)
        if not elem_data:
            continue
        node_ids = elem_data.get("nodes", [])
        start_floor = v2_node_floor.get(node_ids[0], 0) if node_ids else 0
        end_floor = v2_node_floor.get(node_ids[-1], 0) if node_ids else 0
        pkpm_floor = max(start_floor, end_floor)
        if pkpm_floor > 0:
            key = (pmid, pkpm_floor)
            if key in pm_floor_elem_to_v2:
                raise RuntimeError(
                    f"PKPM element mapping collision for member {pmid} on floor {pkpm_floor}"
                )
            pm_floor_elem_to_v2[key] = v2_eid
    if len(pm_floor_elem_to_v2) != len(elem_map_raw):
        raise RuntimeError("PKPM converter did not produce an exact result mapping for every V2 element")

    case_node_disps = extracted.get("case_node_disps", {})
    case_beam_forces = extracted.get("case_beam_forces", {})
    case_col_forces = extracted.get("case_col_forces", {})
    result_node_keys = {
        key for case_values in case_node_disps.values() for key in case_values
    }
    result_element_keys = {
        key
        for case_blocks in (case_beam_forces, case_col_forces)
        for case_values in case_blocks.values()
        for key in case_values
    }
    for label, actual, expected in (
        ("displacement nodes", result_node_keys, set(pm_floor_to_v2)),
        ("force elements", result_element_keys, set(pm_floor_elem_to_v2)),
    ):
        if actual != expected:
            missing = sorted(expected - actual)
            unexpected = sorted(actual - expected)
            raise RuntimeError(
                f"PKPM {label} do not exactly cover the converted model "
                f"(missing={missing[:5]}, unexpected={unexpected[:5]})"
            )
    result_case_names = set(case_node_disps) | set(case_beam_forces) | set(case_col_forces)
    for case_name in result_case_names:
        case_nodes = set(case_node_disps.get(case_name, {}))
        case_elements = set(case_beam_forces.get(case_name, {})) | set(case_col_forces.get(case_name, {}))
        for label, actual, expected in (
            ("displacement nodes", case_nodes, set(pm_floor_to_v2)),
            ("force elements", case_elements, set(pm_floor_elem_to_v2)),
        ):
            if actual != expected:
                raise RuntimeError(
                    f"PKPM case '{case_name}' {label} do not exactly cover the converted model"
                )

    for displacement in node_disps:
        key = (displacement.get("pmid"), displacement.get("floor"))
        if key not in pm_floor_to_v2:
            raise RuntimeError(f"PKPM displacement summary {key} cannot be mapped to a V2 node")
    for member in beams + columns:
        key = (member.get("pmid"), member.get("floor"))
        if key not in pm_floor_elem_to_v2:
            raise RuntimeError(f"PKPM design result {key} cannot be mapped to a V2 element")

    # forces: { elementId: { N, V, M, Vy, Vz, My, Mz, T } }
    forces: Dict[str, Dict[str, float]] = {}
    # Collect per-element max forces from per-case data for full 6-DOF
    # Build a merged {(pmid, floor): {N,Vy,Vz,T,My,Mz}} taking max across all cases
    elem_max_forces: Dict[tuple[int, int], Dict[str, float]] = {}
    for case_forces_dict in [extracted.get("case_beam_forces", {}), extracted.get("case_col_forces", {})]:
        for _case_name, key_map in case_forces_dict.items():
            for key, f in key_map.items():
                if key not in elem_max_forces:
                    elem_max_forces[key] = {"N": 0.0, "Vy": 0.0, "Vz": 0.0, "T": 0.0, "My": 0.0, "Mz": 0.0, "V": 0.0, "M": 0.0}
                entry = elem_max_forces[key]
                for comp in ("N", "Vy", "Vz", "T", "My", "Mz"):
                    value = _finite_result_float(f.get(comp), f"{key} {comp}")
                    entry[comp] = _signed_max_abs(entry[comp], value)
                entry["V"] = max(entry["V"], _finite_result_float(f.get("V"), f"{key} V"))
                entry["M"] = max(entry["M"], _finite_result_float(f.get("M"), f"{key} M"))

    for key, f in elem_max_forces.items():
        v2_eid = pm_floor_elem_to_v2.get(key)
        if v2_eid is None:
            raise RuntimeError(f"PKPM force result {key} cannot be mapped to a V2 element")
        elem_id = v2_eid
        forces[elem_id] = {
            "N": f["N"],
            "V": f["V"],
            "M": f["M"],
            "Vy": f["Vy"],
            "Vz": f["Vz"],
            "My": f["My"],
            "Mz": f["Mz"],
            "T": f["T"],
            "referenceFrame": "element-local",
        }

    logger.debug(
        "Phase 4 mapping: %d/%d nodes mapped to floor, "
        "%d/%d elem mappings, %d forces, %d displacements",
        sum(1 for f in v2_node_floor.values() if f >= 0),
        len(v2_node_z),
        len(pm_floor_elem_to_v2),
        len(elem_map_raw),
        len(forces),
        len(displacements),
    )

    # ---- Build caseResults + envelopeTables (Phase 3) ----
    floors_analyzed = extracted.get("floors_analyzed", 0)

    all_case_names: set[str] = set()
    all_case_names.update(case_node_disps.keys())
    all_case_names.update(case_beam_forces.keys())
    all_case_names.update(case_col_forces.keys())

    case_results: Dict[str, Dict[str, Any]] = {}
    node_displacement_envelope: Dict[str, Dict[str, Any]] = {}
    element_force_envelope: Dict[str, Dict[str, Any]] = {}

    for case_name in sorted(all_case_names):
        # Per-case displacements — remap (pmid, floor) → V2 node ID
        case_disps: Dict[str, Dict[str, float]] = {}
        for key, disp in case_node_disps.get(case_name, {}).items():
            v2_id = pm_floor_to_v2.get(key)
            if v2_id is None:
                raise RuntimeError(f"PKPM case displacement {key} cannot be mapped to a V2 node")
            normalized_disp = {
                "ux": _finite_result_float(disp.get("ux"), f"{key} ux"),
                "uy": _finite_result_float(disp.get("uy"), f"{key} uy"),
                "uz": _finite_result_float(disp.get("uz"), f"{key} uz"),
            }
            for rotation in ("rx", "ry", "rz"):
                if rotation in disp:
                    normalized_disp[rotation] = _finite_result_float(disp[rotation], f"{key} {rotation}")
            case_disps[v2_id] = normalized_disp
            previous = displacements.get(v2_id)
            previous_magnitude = (
                sum(float(previous[axis]) ** 2 for axis in ("ux", "uy", "uz")) ** 0.5
                if previous else -1.0
            )
            magnitude = sum(normalized_disp[axis] ** 2 for axis in ("ux", "uy", "uz")) ** 0.5
            if magnitude > previous_magnitude:
                displacements[v2_id] = normalized_disp

        # Per-case forces — remap (pmid, floor) → V2 element ID
        case_forces_out: Dict[str, Dict[str, float]] = {}
        for key, force in case_beam_forces.get(case_name, {}).items():
            v2_eid = pm_floor_elem_to_v2.get(key)
            if v2_eid is None:
                raise RuntimeError(f"PKPM beam force {key} cannot be mapped to a V2 element")
            elem_id = v2_eid
            case_forces_out[elem_id] = {
                "N": force["N"],
                "V": force["V"],
                "M": force["M"],
                "Vy": force["Vy"], "Vz": force["Vz"],
                "My": force["My"], "Mz": force["Mz"], "T": force["T"],
                "referenceFrame": "element-local",
            }
        for key, force in case_col_forces.get(case_name, {}).items():
            v2_eid = pm_floor_elem_to_v2.get(key)
            if v2_eid is None:
                raise RuntimeError(f"PKPM column force {key} cannot be mapped to a V2 element")
            elem_id = v2_eid
            if elem_id in case_forces_out:
                raise RuntimeError(f"PKPM element '{elem_id}' was returned as both beam and column")
            existing = case_forces_out.get(elem_id, {})
            case_forces_out[elem_id] = {
                **existing,
                "N": force["N"],
                "V": force["V"],
                "M": force["M"],
                "Vy": force["Vy"], "Vz": force["Vz"],
                "My": force["My"], "Mz": force["Mz"], "T": force["T"],
                "referenceFrame": "element-local",
            }

        case_results[case_name] = {
            "status": "success",
            "capabilityStatus": "partial",
            "missingCapabilities": [name for name in _UNAVAILABLE_OUTPUTS if name != "nodal-rotations" or
                not case_disps or any(any(key not in row for key in ("rx", "ry", "rz")) for row in case_disps.values())],
            "displacementSource": extracted.get("native_displacement_source"),
            "displacements": case_disps,
            "forces": case_forces_out,
            "reactions": {},
            "nativeConstraintDisplacements": {pm_floor_to_v2[key]: values for key, values in extracted.get("native_constraint_displacements", {}).get(case_name, {}).items()},
            "envelope": {},
            "memberStations": {
                pm_floor_elem_to_v2[key]: stations
                for key, stations in extracted.get("case_member_stations", {}).get(case_name, {}).items()
            },
            "forceSemantics": "signed-component-envelope; memberStations retain native station vectors",
        }

        # Accumulate envelope tables
        for node_id, disp in case_disps.items():
            mag = (disp["ux"]**2 + disp["uy"]**2 + disp["uz"]**2)**0.5
            item = node_displacement_envelope.setdefault(
                str(node_id), {"maxAbsDisplacement": 0.0, "controlCase": ""}
            )
            if mag > item["maxAbsDisplacement"]:
                item["maxAbsDisplacement"] = round(mag, 8)
                item["controlCase"] = case_name

        for elem_id, force in case_forces_out.items():
            item = element_force_envelope.setdefault(
                str(elem_id), {
                    "maxAbsAxialForce": 0.0, "maxAbsShearForce": 0.0, "maxAbsMoment": 0.0,
                    "controlCaseAxial": "", "controlCaseShear": "", "controlCaseMoment": "",
                }
            )
            axial = abs(force.get("N", 0.0))
            shear = abs(force.get("V", 0.0))
            moment = abs(force.get("M", 0.0))
            if axial > item["maxAbsAxialForce"]:
                item["maxAbsAxialForce"] = round(axial, 2)
                item["controlCaseAxial"] = case_name
            if shear > item["maxAbsShearForce"]:
                item["maxAbsShearForce"] = round(shear, 2)
                item["controlCaseShear"] = case_name
            if moment > item["maxAbsMoment"]:
                item["maxAbsMoment"] = round(moment, 2)
                item["controlCaseMoment"] = case_name

    # envelope for max displacement
    max_disp = 0.0
    max_disp_node = ""
    for nid, d in displacements.items():
        mag = (d["ux"] ** 2 + d["uy"] ** 2 + d["uz"] ** 2) ** 0.5
        if mag > max_disp:
            max_disp = mag
            max_disp_node = nid

    envelope: Dict[str, Any] = {}
    if max_disp_node:
        envelope[f"node:{max_disp_node}:maxAbsDisplacement"] = max_disp

    # Standard envelope keys for TS compatibility (extractKeyMetrics / extractControllingCases)
    envelope["maxAbsDisplacement"] = max_disp
    envelope["controlNodeDisplacement"] = max_disp_node or None

    # Global max forces from envelopeTables
    g_max_axial = 0.0
    g_max_shear = 0.0
    g_max_moment = 0.0
    control_elem_axial = ""
    control_elem_shear = ""
    control_elem_moment = ""
    for eid, ef in element_force_envelope.items():
        a = ef.get("maxAbsAxialForce", 0.0)
        s = ef.get("maxAbsShearForce", 0.0)
        m = ef.get("maxAbsMoment", 0.0)
        if a > g_max_axial:
            g_max_axial = a
            control_elem_axial = eid
        if s > g_max_shear:
            g_max_shear = s
            control_elem_shear = eid
        if m > g_max_moment:
            g_max_moment = m
            control_elem_moment = eid
    envelope["maxAbsAxialForce"] = g_max_axial
    envelope["maxAbsShearForce"] = g_max_shear
    envelope["maxAbsMoment"] = g_max_moment
    envelope["controlElementAxialForce"] = control_elem_axial
    envelope["controlElementShearForce"] = control_elem_shear
    envelope["controlElementMoment"] = control_elem_moment
    warnings.append(
        "PKPM ResultData API does not expose nodal reactions; reactions are unavailable. / "
        "PKPM ResultData API 当前不提供节点反力，反力结果不可用。"
    )

    # Build result dict
    result_dict: Dict[str, Any] = {
        "status": "success",
        "capabilityStatus": "partial",
        "missingCapabilities": list(_UNAVAILABLE_OUTPUTS),
        "analysisMode": "pkpm-satwe",
        "displacements": displacements,
        "forces": forces,
        "reactions": {},
        "envelope": envelope,
        "summary": {
            "maxDisplacement": max_disp,
            "maxDisplacementNode": max_disp_node,
            "nodeCount": len(displacements),
            "elementCount": len(forces),
            "reactionResultAvailable": False,
            "rotationResultAvailable": False,
            "engine": "pkpm-static",
            "requestedLoadCaseIds": requested_cases,
            "nativeDefaultsUsed": not bool(model_dict.get("analysis_control")),
            "materialFamily": material_family,
            "jws_path": str(jws_path),
            "work_dir": str(work_dir),
            "floors_analyzed": floors_analyzed,
            "beam_count": extracted.get("beam_count", 0),
            "column_count": extracted.get("column_count", 0),
            "designConditions": design_conditions,
            "floorLoadMapping": floor_load_mapping,
            "projectParameterVerification": project_parameter_verification,
            "effectiveNativeSettings": effective_settings,
            "nativeMaterialVerification": material_verification,
            "nativeSectionVerification": section_verification,
            "nativeLoadMapping": converter_mappings.get("native_load_mapping", {}),
            "nativeResultMembers": extracted.get("native_result_members", []),
            **pkpm_summary,
        },
        "pkpm_detailed": {
            "mode_periods": extracted.get("mode_periods", []),
            "beams": beams,
            "columns": columns,
            "node_displacements": node_disps,
            "story_drift": extracted.get("story_drift", []),
            "storey_stiffness": extracted.get("storey_stiffness", []),
            "bearing_shear": extracted.get("bearing_shear", []),
            "satwe_params": extracted.get("satwe_params", {}),
            "input_design_conditions": design_conditions,
            "input_floor_load_mapping": floor_load_mapping,
            "project_parameter_verification": project_parameter_verification,
        },
        "caseResults": case_results,
        "envelopeTables": {
            "nodeDisplacement": node_displacement_envelope,
            "elementForce": element_force_envelope,
            "nodeReaction": {},
        },
        "warnings": warnings,
        "meta": {
            **coordinate_contract_metadata(model),
            "lengthUnit": "m",
            "displacementUnit": "m",
            "forceUnit": "kN",
            "momentUnit": "kN.m",
        },
    }

    if extracted.get("native_displacement_source"):
        from native_result_adapter import complete_frame_results
        result_dict = complete_frame_results(model_dict, result_dict, jws_path)
    if requested_cases:
        from native_result_adapter import select_result
        result_dict = select_result(model_dict, result_dict, requested_cases, combination_id)
    return attach_native_design_context(result_dict, source_model, projection,
        native_project=str(jws_path), parameters=parameters,
        representation={"analysisOnly": numeric_sections,
                        "method": "native-reference-carrier" if numeric_sections else "native-physical-section"})
