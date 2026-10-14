"""Compile exact source boundaries between native preprocessing and solving."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import struct
import subprocess
import time


def run_native_stages(cycle_path, work_dir, constraints, terminate_tree, timeout=120, section_model=None, include_design=False, design_plan=None, release_model=None):
    executable = cycle_path.parent.parent / "Ribbon" / "PKPMMain.exe"
    if section_model is not None:
        solver = executable.parent / "SAT" / "SAT64" / "WINSAT-A_x64.exe"
        if hashlib.sha256(solver.read_bytes()).hexdigest() != "28adde523fe58491f96727da7250c21e6304e56aef3d0ba0330da9c57e3adaf3":
            raise RuntimeError("Native numeric-section compiler version is not verified / 原生数值截面编译版本尚未验收")
    phases = [
        ["-PMCAD", "-PMCAD", "-AUTORIB", "BACKGROUNDONLY"],
        ["-ANA", "-auto_data", "BACKGROUNDONLY"],
        ["-ANA", "-auto_sata", "BACKGROUNDONLY"],
        # The installed ResultData SDK requires this native finalization stage
        # even for elastic results. It can also generate design data; only an
        # explicit, validated design request may expose those conclusions.
        ["-ANA", "-auto_satf", "BACKGROUNDONLY"],
    ]
    evidence = {"executable": str(executable), "cwd": str(work_dir), "includeDesign": include_design,
                "nativeFinalizationGeneratesDesignData": True,
                "phases": [], "status": "failed", "sharedDirectoryConfigurationModified": False}
    started = time.time()
    try:
        for index, arguments in enumerate(phases):
            phase = {"arguments": arguments, "startedAt": time.time()}
            evidence["phases"].append(phase)
            proc = subprocess.Popen([str(executable), *arguments], cwd=work_dir,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=subprocess.CREATE_NO_WINDOW)
            try:
                stdout, stderr = proc.communicate(timeout=max(1, timeout - (time.time() - started)))
            except subprocess.TimeoutExpired:
                terminate_tree(proc)
                stdout, stderr = proc.communicate()
                (work_dir / f"phase-{index}-stdout.log").write_bytes(stdout)
                (work_dir / f"phase-{index}-stderr.log").write_bytes(stderr)
                phase.update(returncode=proc.returncode, timedOut=True, completedAt=time.time())
                raise RuntimeError(f"Native phase {index} timed out / 原生分阶段运行超时")
            finally:
                if proc.poll() is None:
                    terminate_tree(proc)
            (work_dir / f"phase-{index}-stdout.log").write_bytes(stdout)
            (work_dir / f"phase-{index}-stderr.log").write_bytes(stderr)
            phase.update(returncode=proc.returncode, completedAt=time.time())
            if proc.returncode:
                raise RuntimeError(f"Native phase {index} returned {proc.returncode}")
            if index == 0 and design_plan is not None:
                from pkpm_native_design import reapply_design_parameters
                projects = list(work_dir.glob("*.JWS"))
                if not include_design or len(projects) != 1:
                    raise RuntimeError("Native design parameters require one explicit project / 原生设计参数须绑定唯一明确工程")
                evidence["designParameterReadback"] = reapply_design_parameters(projects[0], design_plan)
            if index == 0 and release_model is not None:
                from native_member_releases import reapply_member_releases
                projects = list(work_dir.glob("*.JWS"))
                if len(projects) != 1:
                    raise RuntimeError("Native releases require one project / 原生端释放须绑定唯一工程")
                evidence["memberReleaseReadback"] = reapply_member_releases(projects[0], release_model)
            if index == 1:
                # Compile only formal input before the solver is launched.
                # The source definition explicitly requests all 3 rotations
                # free; PM3DSAT's minimum-one numerical floor is not a V2
                # spring and must not become a physical boundary condition.
                evidence["boundaryCompilation"] = compile_free_rotations(work_dir, constraints) if constraints else []
                if section_model is not None:
                    from native_numeric_sections import compile_numeric_sections
                    evidence["sectionCompilation"] = compile_numeric_sections(work_dir, section_model)
        for artifact in evidence["boundaryCompilation"]:
            if hashlib.sha256((work_dir / artifact["path"]).read_bytes()).hexdigest() != artifact["afterSha256"]:
                raise RuntimeError("Native solver changed compiled boundary inputs / 原生求解器改变了已编译边界输入")
        for name in ("DISP.SAT", "NODEINDEX.SAT", "MESH.SAT", "WMASS.OUT", "GOUJIAN.OUT"):
            path = work_dir / name
            if not path.is_file() or path.stat().st_size == 0 or path.stat().st_mtime < started - 2:
                raise RuntimeError(f"Fresh native stage artifact is missing: {name} / 缺少本次原生运行产物")
        if "全部完成" not in (work_dir / "CommonInfoOut.log").read_text(encoding="gb18030"):
            raise RuntimeError("Native stage completion evidence is missing / 缺少原生完成证据")
        evidence["status"] = "completed"
    finally:
        (work_dir / "native-stage-evidence.json").write_text(json.dumps(evidence, indent=2), encoding="utf-8")


def compile_free_rotations(work_dir: Path, constraints: list[dict]):
    if not constraints or any(row.get("stiffness") != [100000000376832.] * 3 + [0.] * 3 for row in constraints):
        raise ValueError("Native pin definitions do not match source / 原生铰脚定义与源模型不符")
    output = []
    for name, width, offset, count in (("ConstraintNode.SAT", 120, 72, 6), ("ConstraintNodeSK.SAT", 96, 0, 12)):
        path = work_dir / name
        before = path.read_bytes()
        if len(before) < 16:
            raise ValueError("Missing formal native constraint input")
        header = struct.unpack_from("<4i", before)
        if header != (3, 20200113, 2, width) or len(before) != 16 + 2 * width:
            raise ValueError("Uncalibrated native constraint input schema")
        if name == "ConstraintNode.SAT" and (before[20:52].split(b"\0", 1)[0].rstrip() != b"SCLAW_PIN6" or struct.unpack_from("<i", before, 56)[0] != 1):
            raise ValueError("Native pin definition identity is not verified / 原生铰脚定义身份未核对")
        values = list(struct.unpack_from("<" + "d" * count, before, 16 + offset))
        if name == "ConstraintNode.SAT":
            if values[:3] != [1e14] * 3 or values[3:] != [1.] * 3:
                raise ValueError("Probe native constraint does not match frozen free-rotation request")
            values[3:] = [0.] * 3
        else:
            if values != [1e14, 0., 1e14, 0., 0., 1e14, 1., 0., 1., 0., 0., 1.]:
                raise ValueError("Probe native constraint matrix does not match its definition")
            values[6:] = [0.] * 6
        after = bytearray(before)
        struct.pack_into("<" + "d" * count, after, 16 + offset, *values)
        path.with_suffix(path.suffix + ".precompile").write_bytes(before)
        path.write_bytes(after)
        output.append({"path": name, "beforeSha256": hashlib.sha256(before).hexdigest(),
                       "afterSha256": hashlib.sha256(after).hexdigest(), "values": values,
                       "purpose": "preserve-source-free-rotations-before-native-solve"})
    return output
