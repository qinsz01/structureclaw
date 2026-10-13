"""Freeze independent six-DOF cantilevers, then ask native PKPM to solve.

This identifies output/load conventions using the native standard-material
profile; it does not certify the different explicit V2 shear modulus.
"""
from pathlib import Path
import hashlib
import importlib.util
import json
import sys
import time
import uuid

REPO = Path(__file__).resolve().parents[2]
SKILL = REPO / "backend/src/agent-skills/analysis/pkpm-static"
sys.path[:0] = [str(SKILL), str(SKILL.parent / "runtime"), str(REPO / "backend/src/skill-shared/python")]


def save(path, obj):
    path.write_text(json.dumps(obj, indent=2, ensure_ascii=False), encoding="utf-8")


def main():
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work-root", type=Path, required=True)
    parser.add_argument("--cycle", type=Path, required=True)
    parser.add_argument("--width-mm", type=int, default=600)
    parser.add_argument("--depth-mm", type=int, default=600)
    parser.add_argument("--native-angle", type=float, default=0)
    args = parser.parse_args()
    folder = args.work_root / f"pkpm-dof-{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:8]}"
    folder.mkdir(parents=True, exist_ok=False)
    b, h = args.width_mm/1000, args.depth_mm/1000
    E, G, A, Iy, Iz, L = 206000000.0, 79000000.0, b*h, b*h**3/12, h*b**3/12, 3.0
    wide, narrow = max(b, h), min(b, h)
    J = wide*narrow**3*(1/3-.21*narrow/wide*(1-narrow**4/(12*wide**4)))
    load_vectors = [[1, 0, -.5, 0, .125, .2], [2, 0, -.75, .25, 0, .3],
                    [0, 3, -1, 0, 0, -.1], [0, -1, -1.25, 0, 0, 0]]
    references = []
    for node, (fx, fy, fz, mx, my, mz) in enumerate(load_vectors):
        references.append({"nodeId": f"N{node}", "ux": fx*(L**3/(3*E*Iy)+L/((5/6)*G*A))+my*L**2/(2*E*Iy),
            "uy": fy*(L**3/(3*E*Iz)+L/((5/6)*G*A))-mx*L**2/(2*E*Iz), "uz": fz*L/(E*A),
            "rx": mx*L/(E*Iz)-fy*L**2/(2*E*Iz), "ry": my*L/(E*Iy)+fx*L**2/(2*E*Iy), "rz": mz*L/(G*J)})
    reference = {"E_kN_m2": E, "G_kN_m2": G, "A_m2": A, "Iy_m4": Iy, "Iz_m4": Iz, "J_m4": J,
        "sourceReferenceVector": [1, 0, 0], "sourceRotationDegrees": 0, "nativeAngleDegrees": args.native_angle,
        "length_m": L, "loadVectors": load_vectors, "references": references,
        "relativeTolerance": 1e-5, "absoluteTranslationTolerance_m": 1e-11,
        "absoluteRotationTolerance_rad": 1e-11,
        "scope": "Native standard-material diagnostic, not explicit V2 G=79230.769 equivalence"}
    save(folder / "reference.json", reference)
    evidence = {"directory": str(folder), "status": "failed", "formalV2Accepted": False,
        "referenceSha256": hashlib.sha256((folder / "reference.json").read_bytes()).hexdigest()}
    try:
        import APIPyInterface as api
        from native_loads import plan_native_loads, write_native_loads
        from native_settings import clear_floor_slab, verify_effective_settings
        spec = importlib.util.spec_from_file_location("pkpm_dof_runtime", SKILL / "runtime.py")
        runtime = importlib.util.module_from_spec(spec); spec.loader.exec_module(runtime)
        model = api.Model(); model.CreatNewModel(str(folder), "dofcal")
        jws = folder / "dofcal.JWS"; model.OpenPMModel(str(jws))
        shape = api.SectionShape(); shape.Set_B(args.width_mm); shape.Set_H(args.depth_mm); shape.Set_M(5)
        section = api.ColumnSection(); section.SetUserSect(api.SectionKind.IDSec_Rectangle, shape)
        secid = model.AddColumnSection(section)
        floor = model.GetCurrentStandFloor(); clear_floor_slab(floor); floor.SetDeadLive(0, 0)
        targets, source_nodes = {}, []
        for index, (x, y) in enumerate(((0, 0), (4000, 0), (4000, 4000), (0, 4000))):
            node = floor.AddNode(x, y); column = floor.AddColumnEx(secid, node.GetID(), 0, 0, 0, args.native_angle)
            column.SetSteelGrade(api.SteelGrade.Q355)
            targets[("node", f"N{index}")] = node
            source_nodes.append({"id": f"N{index}", "x": x/1000, "y": y/1000, "z": 3})
        loads = [{"id": f"P{i}", "type": "nodal", "node": f"N{i}",
                  **dict(zip(("fx", "fy", "fz", "mx", "my", "mz"), vector))} for i, vector in enumerate(load_vectors)]
        source = {"nodes": source_nodes, "load_cases": [{"id": "L", "type": "live", "loads": loads}]}
        save(folder / "load-mapping.json", write_native_loads(api, model, plan_native_loads(source), targets))
        real = api.RealFloor(); real.SetFloorHeight(3000); real.SetBottomElevation(0); real.SetStandFloorIndex(1)
        model.AddNaturalFloor(real)
        for _ in range(2):
            para = model.GetProjectPara()
            for key, value in {101: 0, 103: 2, 601: 1, 603: 0, 604: 0, 606: 0, 608: 0, 609: 0, 624: 1, 626: 0, 641: 0}.items():
                para.SetParaInt(key, value)
            for key in (801, 803): para.SetParaDouble(key, 0)
            clear_floor_slab(model.GetCurrentStandFloor())
            model.SaveProjectPara(); model.SavePMModel(); model.OpenPMModel(str(jws))
        save(folder / "node-mapping-before.json", {f"N{i}": {"pmid": targets[("node", f"N{i}")].GetID(), "xy_mm": targets[("node", f"N{i}")].Get()} for i in range(4)})
        del para, floor, targets, model
        runtime._run_jws_cycle(args.cycle, folder, timeout=90)
        native = runtime._extract_results(jws, "steel")
        save(folder / "native-node-coordinates.json", native["native_result_nodes"])
        save(folder / "observed.json", {"cases": {name: [{"node": list(key), **value} for key,value in rows.items()] for name,rows in native["case_node_disps"].items()},
            "stations": [{"case": case, "member": list(key), "stations": rows} for case,members in native["case_member_stations"].items() for key,rows in members.items()]})
        evidence["settings"] = verify_effective_settings(folder, dict.fromkeys(("construction_stage", "p_delta", "rigid_offsets", "rigid_floor", "self_weight"), False))
        evidence["status"] = "native-completed-awaiting-independent-DOF-identification"
    except Exception as error:
        evidence["error"] = f"{type(error).__name__}: {error}"
    save(folder / "acceptance.json", evidence); print(json.dumps(evidence, ensure_ascii=False))
    return 0 if evidence["status"].startswith("native-completed") else 1


if __name__ == "__main__":
    raise SystemExit(main())
