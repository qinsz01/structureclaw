"""Isolated SDK calibration, not a production capability bypass.

References are frozen before creating the native model. The four identical
columns carry identical roof point loads, so the live-load axial response is
P*L/(E*A), independently of the horizontal connecting beams. No existing user
project or GUI is attached. Run manually with the licensed engineering Python.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import sys
import time
import uuid


def save(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False), encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work-root", type=Path, required=True)
    parser.add_argument("--cycle", type=Path)
    parser.add_argument("--timeout", type=int, default=120)
    parser.add_argument("--build-only", action="store_true", help="Verify SDK write/readback without launching SATWE; never accepts numerical capability")
    parser.add_argument("--stories", type=int, choices=(1, 2), default=1,
                        help="One-story frozen reference or independent two-story diagnostic; neither substitutes for the other")
    parser.add_argument("--native-defaults", action="store_true", help="Diagnostic: retain native settings and record them; does not certify explicit controls")
    parser.add_argument("--omit-setting", type=int, action="append", default=[], help="Diagnostic: omit one explicit native parameter to isolate solver failures")
    parser.add_argument("--load-pattern", choices=("nodal", "beam-uniform", "cantilever-y"), default="nodal")
    parser.add_argument("--load-kn", type=float, default=1.0, help="Signed downward nodal kN or beam kN/m; reference is frozen before execution")
    parser.add_argument("--material", choices=("C30", "Q355"), default="C30")
    parser.add_argument("--bare-frame", action="store_true", help="Native diagnostic: no self-weight, slab or automatic wind/seismic action")
    args = parser.parse_args()
    if not args.build_only and args.cycle is None:
        parser.error("--cycle is required unless --build-only is selected")
    root = args.work_root.resolve() / f"pkpm-axial-{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:8]}"
    root.mkdir(parents=True, exist_ok=False)
    if not math.isfinite(args.load_kn) or args.load_kn == 0:
        parser.error("--load-kn must be finite and nonzero")
    column_load = args.load_kn * (4 if args.load_pattern == "beam-uniform" else 1)
    modulus = 206000 if args.material == "Q355" else 30000
    reference = {
        "method": "four equal prismatic columns under equal live nodal compression; u=-PL/EA",
        "E_MPa": modulus, "length_m": 3, "section_m": [0.6, 0.6], "P_kN": column_load,
        "displacement_m": -column_load * 3 / (modulus * 1000 * 0.6 * 0.6),
        "axial_magnitude_kN": abs(column_load), "relative_tolerance": 1e-5, "absolute_tolerance_m": 1e-11,
        "absolute_tolerance_kN": 1e-7, "lateral_displacement_m": 0,
        "scope": "axial elastic modulus, positive vertical load convention and LL membership only; not G, nu, density or arbitrary frame equivalence",
    }
    if args.load_pattern == "beam-uniform":
        reference["method"] = "square frame with four 4m beams under equal vertical UDL q; symmetry gives column P=4q and u=-PL/EA"
    if args.load_pattern == "cantilever-y":
        if args.stories != 1 or not args.bare_frame:
            parser.error("cantilever-y requires --bare-frame and one story")
        inertia = 0.6**4 / 12
        nu = 0.3 if args.material == "Q355" else 0.2
        reference.update(method="four identical cantilevers tied only in global X; equal global Y forces; ties do not deform",
            scope="independent transverse sign, E*I and rectangular shear-flexibility hypotheses; candidate diagnostic",
            euler_bernoulli_uy_m=args.load_kn * 3**3 / (3 * modulus * 1000 * inertia),
            shear_correction_uy_m=args.load_kn * 3 / ((5/6) * modulus * 1000 / (2*(1+nu)) * 0.36),
            base_moment_kNm=args.load_kn * 3, nu=nu)
    if args.stories == 2:
        reference["method"] = "two stories of four identical columns; equal P on every floor; u1=-2PL/EA and u2=-3PL/EA"
        reference["displacement_by_floor_m"] = {"1": 2 * reference["displacement_m"], "2": 3 * reference["displacement_m"]}
        reference["axial_by_floor_kN"] = {"1": 2 * column_load, "2": column_load}
    save(root / "reference.json", reference)
    evidence = {"status": "failed", "directory": str(root), "referenceSha256": hashlib.sha256((root / "reference.json").read_bytes()).hexdigest(), "numericalCapabilityAccepted": False, "steps": [],
                "variant": {"stories": args.stories, "nativeDefaults": args.native_defaults, "omittedSettings": args.omit_setting, "loadPattern": args.load_pattern, "loadKn": args.load_kn, "material": args.material, "bareFrame": args.bare_frame},
                "explicitControlsAccepted": False}
    repo = Path(__file__).resolve().parents[2]
    analysis = repo / "backend/src/agent-skills/analysis"
    sys.path[:0] = [str(analysis / "runtime"), str(analysis / "pkpm-static"), str(repo / "backend/src/skill-shared/python")]
    try:
        import APIPyInterface as api
        from native_loads import plan_native_loads, read_native_load_assignments, write_native_loads
        spec = importlib.util.spec_from_file_location("pkpm_calibration_runtime", analysis / "pkpm-static/runtime.py")
        runtime = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(runtime)
        model = api.Model()
        model.CreatNewModel(str(root), "calibration")
        jws = root / "calibration.JWS"
        model.OpenPMModel(str(jws))
        sections = []
        for cls, b, h in ((api.ColumnSection, 600, 600), (api.BeamSection, 300, 500)):
            shape = api.SectionShape()
            shape.Set_B(b); shape.Set_H(h); shape.Set_M(5 if args.material == "Q355" else 6)
            section = cls(); section.SetUserSect(api.SectionKind.IDSec_Rectangle, shape)
            sections.append(model.AddColumnSection(section) if cls == api.ColumnSection else model.AddBeamSection(section))
        floor = model.GetCurrentStandFloor()
        if args.bare_frame: floor.SetInfoValue(0, 0)
        nodes = [floor.AddNode(x, y) for x, y in ((0, 0), (4000, 0), (4000, 4000), (0, 4000))]
        node_ids = [node.GetID() for node in nodes]
        for node in nodes:
            column = floor.AddColumn(sections[0], node.GetID())
            if args.material == "Q355": column.SetSteelGrade(api.SteelGrade.Q355)
            else: column.SetConcreteGrade(30)
        source_nodes = [{"id": f"N{i}", "x": x, "y": y, "z": 3} for i, (x, y) in enumerate(((0, 0), (4, 0), (4, 4), (0, 4)))]
        targets = {("node", f"N{i}"): node for i, node in enumerate(nodes)}
        source_elements = []
        beam_pairs = ((0, 1), (2, 3)) if args.load_pattern == "cantilever-y" else ((0, 1), (1, 2), (2, 3), (3, 0))
        for index, (start, end) in enumerate(beam_pairs):
            net = floor.AddLineNet(nodes[start].GetID(), nodes[end].GetID())
            beam = floor.AddBeamEx(sections[1], net.GetID(), 0, 0, 0, 0.0)
            if args.material == "Q355": beam.SetSteelGrade(api.SteelGrade.Q355)
            else: beam.SetConcreteGrade(30)
            targets[("beam", f"B{index}")] = beam
            source_elements.append({"id": f"B{index}", "type": "beam", "nodes": [f"N{start}", f"N{end}"]})
        source_loads = ([{"id": f"P{i}", "type": "nodal", "node": f"N{i}", "fz": -args.load_kn} for i in range(4)]
                       if args.load_pattern in {"nodal", "cantilever-y"} else
                       [{"id": f"q{i}", "type": "uniform", "element": f"B{i}", "wz": -args.load_kn} for i in range(4)])
        if args.load_pattern == "cantilever-y":
            source_loads = [{"id": f"P{i}", "type": "nodal", "node": f"N{i}", "fy": args.load_kn} for i in range(4)]
        source_load_model = {"nodes": source_nodes, "elements": source_elements, "load_cases": [{"id": "L", "type": "live", "loads": source_loads}]}
        load_mapping = write_native_loads(api, model, plan_native_loads(source_load_model), targets)
        save(root / "load-mapping.json", load_mapping)
        floor.SetDeadLive(0.0, 0.0)
        for index in range(args.stories):
            real = api.RealFloor(); real.SetFloorHeight(3000); real.SetBottomElevation(index * 3); real.SetStandFloorIndex(1)
            model.AddNaturalFloor(real)
        para = model.GetProjectPara()
        # The schema documentation's 60102/10301 are option identifiers, not
        # the compact values stored by the installed native parameter map.
        settings = {103: 2 if args.material == "Q355" else 0, 101: 0, 601: 1, 606: 0, 608: 0, 609: 0, 624: 1, 626: 0, 630: 0, 641: 0}
        if args.bare_frame: settings.update({603: 0, 604: 0})
        if args.native_defaults:
            settings = {103: 2 if args.material == "Q355" else 0, 101: 0}
        settings = {key: value for key, value in settings.items() if key not in args.omit_setting}
        for key, value in settings.items(): para.SetParaInt(key, value)
        if args.bare_frame:
            para.SetParaDouble(801, 0); para.SetParaDouble(803, 0)
        if not args.native_defaults: para.SetParaDouble(611, 1.0)
        model.SaveProjectPara(); model.SavePMModel()
        # Model materialization can reset fields: reopen, set, save, then read.
        model.OpenPMModel(str(jws)); floor = model.GetCurrentStandFloor(); floor.SetDeadLive(0.0, 0.0)
        if args.bare_frame:
            floor.SetInfoValue(0, 0)
            for slab in floor.GetSlabs(): floor.DeleteSlab(slab.GetID())
        para = model.GetProjectPara()
        for key, value in settings.items(): para.SetParaInt(key, value)
        if args.bare_frame:
            para.SetParaDouble(801, 0); para.SetParaDouble(803, 0)
        if not args.native_defaults: para.SetParaDouble(611, 1.0)
        model.SaveProjectPara(); model.SavePMModel()
        model.OpenPMModel(str(jws)); floor = model.GetCurrentStandFloor(); para = model.GetProjectPara()
        readback = {"settings": {str(key): para.GetPara_Int(key) for key in settings}, "nodes": [{"id": n.GetID(), "xy_mm": n.Get(), "load": read_native_load_assignments(n, "node")} for n in floor.GetNodes()], "beams": [{"id": b.GetID(), "load": read_native_load_assignments(b, "beam")} for b in floor.GetBeams()], "loads": [model.GetLoadDefine(row["nativeLoadId"]).Get() for row in load_mapping["loads"]], "grades": [int(c.GetSteelGrade()) if args.material == "Q355" else c.GetConcreteGrade() for c in floor.GetColumns()], "floorHeightMm": model.GetFloorAssemTable(1).GetFloorHeight()}
        save(root / "readback-before.json", readback)
        if any(readback["settings"][str(key)] != value for key, value in settings.items()): raise RuntimeError("Native effective settings did not survive save/reopen")
        expected_grade = int(api.SteelGrade.Q355) if args.material == "Q355" else 30
        if readback["grades"] != [expected_grade] * 4 or readback["floorHeightMm"] != 3000:
            raise RuntimeError("Native grades or column height did not survive save/reopen")
        native_nodes = {node["id"]: node for node in readback["nodes"]}
        if set(native_nodes) != set(node_ids):
            raise RuntimeError("Native node IDs did not survive save/reopen")
        for index, row in enumerate(load_mapping["loads"]):
            target_id = targets[(row["targetType"], row["targetId"])].GetID()
            candidates = readback["nodes"] if row["targetType"] == "node" else readback["beams"]
            actual = next(item["load"] for item in candidates if item["id"] == target_id)
            if list(actual[-2]) != [row["nativeCaseId"]] or list(actual[-1]) != [row["nativeLoadId"]]:
                raise RuntimeError("Native live nodal load assignment did not survive save/reopen")
            kind, values = readback["loads"][index]
            if kind != row["elementKind"] or list(values) != row["nativeValues"]:
                raise RuntimeError("Native nodal load magnitude/direction did not survive save/reopen")
        evidence["steps"].append({"name": "native-settings-load-readback", "status": "passed"})
        del model, floor, para
        if args.build_only:
            evidence["status"] = "partial"
            evidence["remaining"] = ["native-solver-response-and-independent-numerical-comparison"]
            save(root / "acceptance.json", evidence)
            print(json.dumps(evidence, ensure_ascii=False))
            return 0
        runtime._run_jws_cycle(args.cycle.resolve(), root, timeout=args.timeout)
        results = runtime._extract_results(jws, "steel" if args.material == "Q355" else "concrete")
        native_control_labels = ("竖向荷载计算信息", "刚性楼板假定", "P-DELTA", "简化", "刚度放大系数")
        native_controls = [line.strip() for line in (root / "WMASS.OUT").read_text(encoding="gb18030").splitlines()
                           if any(label in line for label in native_control_labels)]
        save(root / "effective-native-controls.json", {"source": "WMASS.OUT", "lines": native_controls,
             "sha256": hashlib.sha256((root / "WMASS.OUT").read_bytes()).hexdigest()})
        if not args.native_defaults and 601 not in args.omit_setting:
            if not any("按一次加荷方式计算" in line for line in native_controls):
                raise RuntimeError("SATWE did not execute the requested one-time loading method")
            evidence["steps"].append({"name": "native-one-time-loading-effective-report", "status": "passed"})
        observed = {"LL": [{"node": list(key), **value} for key, value in results["case_node_disps"].get("LL", {}).items()], "stations": [{"case": case, "member": list(key), "stations": rows} for case, members in results["case_member_stations"].items() for key, rows in members.items()]}
        save(root / "observed.json", observed)
        if args.bare_frame:
            dead_stations = [row for row in observed["stations"] if row["case"] == "DL"]
            if not dead_stations or any(abs(value) > reference["absolute_tolerance_kN"]
                    for member in dead_stations for row in member["stations"] for value in row["nativeComponents"]):
                raise RuntimeError("No-self-weight model generated nonzero dead-load forces")
            native_geometry = (root / "GOUJIAN.OUT").read_text(encoding="gb18030")
            import re
            if not re.search(r"板总数\s*=\s*0", native_geometry):
                raise RuntimeError("Native solver materialized a slab in the bare frame")
            evidence["steps"].append({"name": "no-native-slab-and-zero-self-weight-force", "status": "passed"})
        if len(observed["LL"]) != 4 * args.stories: raise RuntimeError("LL must contain four native node translations per story")
        if args.load_pattern == "cantilever-y":
            expected = reference["euler_bernoulli_uy_m"] + reference["shear_correction_uy_m"]
            for row in observed["LL"]:
                if not math.isclose(row["uy"], expected, rel_tol=reference["relative_tolerance"], abs_tol=reference["absolute_tolerance_m"]):
                    raise RuntimeError(f"Native transverse displacement {row['uy']} differs from frozen Timoshenko {expected}; EB={reference['euler_bernoulli_uy_m']}")
            evidence["steps"].append({"name": "independent-cantilever-timoshenko-displacement", "status": "passed"})
            evidence["status"] = "passed"
            evidence["numericalCapabilityAccepted"] = True
            save(root / "acceptance.json", evidence); print(json.dumps(evidence, ensure_ascii=False))
            return 0
        for row in observed["LL"]:
            expected = reference.get("displacement_by_floor_m", {}).get(str(row["node"][1]), reference["displacement_m"])
            if not math.isclose(row["uz"], expected, rel_tol=reference["relative_tolerance"], abs_tol=reference["absolute_tolerance_m"]):
                raise RuntimeError(f"Native axial displacement {row['uz']} differs from frozen {expected}")
            if any(abs(row[axis]) > reference["absolute_tolerance_m"] for axis in ("ux", "uy")):
                raise RuntimeError("Symmetric vertical calibration must not introduce lateral translation")
        calibrated_columns = 0
        for case, members in results["case_member_stations"].items():
            if case != "LL": continue
            for (_, floor_index), rows in members.items():
                if not rows or rows[0]["source"] != "APIPyInterface.ColumnDesignData.GetForce": continue
                calibrated_columns += 1
                expected = -reference.get("axial_by_floor_kN", {}).get(str(floor_index), column_load)
                if any(not math.isclose(row["nativeComponents"][0], expected, rel_tol=reference["relative_tolerance"], abs_tol=reference["absolute_tolerance_kN"]) for row in rows):
                    raise RuntimeError(f"Native column axial force differs from frozen equilibrium value {expected}")
        if calibrated_columns != 4 * args.stories:
            raise RuntimeError("LL must contain signed axial forces for every native column")
        evidence["steps"].append({"name": "independent-axial-displacement", "status": "passed", "count": 4 * args.stories})
        evidence["steps"].append({"name": "signed-column-force-equilibrium-and-zero-lateral-displacement", "status": "passed"})
        evidence["status"] = "passed"
        evidence["numericalCapabilityAccepted"] = True
    except Exception as error:
        evidence["error"] = f"{type(error).__name__}: {error}"
    save(root / "acceptance.json", evidence)
    print(json.dumps(evidence, ensure_ascii=False))
    return 0 if evidence["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
