"""Explicit native acceptance; creates a fresh directory, never reuses a project.

Run manually with the configured engineering Python.  This is deliberately not
part of the automatic unit suite: PKPM/SATWE requires an installed license.
YJK defaults to independent SDK model generation and database inspection only;
it does not attach to an existing YJK window or project.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import sys
import time
import traceback
import uuid


def representative_model() -> dict:
    """A two-story setback with different beam sections and incomplete grids."""
    plan = [(0, 0), (4, 0), (8, 0), (0, 4), (4, 4), (0, 8)]
    floors = [list(range(6)), list(range(6)), [0, 1, 3, 4]]
    elevations = [0, 3, 6]
    nodes = [{"id": f"N{floor}_{index}", "x": plan[index][0], "y": plan[index][1],
              "z": elevations[floor], "restraints": [floor == 0] * 6}
             for floor, indices in enumerate(floors) for index in indices]
    elements = []
    for floor in (1, 2):
        for index in floors[floor]:
            elements.append({"id": f"C{floor}_{index}", "type": "column", "nodes": [f"N{floor-1}_{index}", f"N{floor}_{index}"], "section": "C", "material": "M", "story": f"F{floor}"})
        edges = [(0, 1), (1, 2), (0, 3), (3, 4), (4, 1), (3, 5)] if floor == 1 else [(0, 1), (0, 3), (3, 4), (4, 1)]
        for index, (start, end) in enumerate(edges):
            elements.append({"id": f"B{floor}_{index}", "type": "beam", "nodes": [f"N{floor}_{start}", f"N{floor}_{end}"], "section": f"B{floor}", "material": "M", "story": f"F{floor}"})
    return {
        "schema_version": "2.0.0", "unit_system": "SI",
        "coordinate_system": {"semantics": "global-z-up", "version": 1, "dimension": "3d", "plane": None, "dof_order": ["ux", "uy", "uz", "rx", "ry", "rz"]},
        "project": {"name": "native_acceptance_setback"},
        # This is a grade/geometry SDK fixture, deliberately not a formal V2
        # material. Numeric material acceptance is a separate analytic suite.
        "materials": [{"id": "M", "name": "C30", "grade": "C30", "category": "concrete"}],
        "sections": [{"id": name, "name": name, "type": "rectangular", "shape": {"kind": "rectangular", "B": width, "H": height}, "width": width, "height": height}
                     for name, width, height in [("C", 600, 600), ("B1", 300, 500), ("B2", 250, 450)]],
        "nodes": nodes, "elements": elements,
        "stories": [{"id": f"F{floor}", "elevation": (floor-1)*3, "height": 3, "dead_load": 2, "live_load": 0} for floor in (1, 2)],
        "load_cases": [],
    }


def load_runtime(directory: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, directory / "runtime.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("engine", choices=["pkpm", "yjk"])
    parser.add_argument("--work-root", type=Path, required=True)
    parser.add_argument("--run", action="store_true", help="Run PKPM/SATWE after model readback")
    parser.add_argument("--cycle", type=Path)
    parser.add_argument("--yjk-sdk", type=Path)
    parser.add_argument("--timeout", type=int, default=90)
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[2]
    analysis = repo / "backend/src/agent-skills/analysis"
    directory = analysis / f"{args.engine}-static"
    sys.path[:0] = [str(directory), str(analysis / "runtime"), str(repo / "backend/src/skill-shared/python")]
    run_dir = args.work_root.resolve() / f"acceptance-commercial-{args.engine}-{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:8]}"
    run_dir.mkdir(parents=True, exist_ok=False)
    model = representative_model()
    (run_dir / "input.json").write_text(json.dumps(model, ensure_ascii=False, indent=2), encoding="utf-8")
    evidence = {"engine": args.engine, "runDirectory": str(run_dir), "steps": [], "status": "failed",
                "scope": "native-grade-geometry-compilation-and-result-coverage-only",
                "formalV2AnalysisAccepted": False}
    try:
        if args.engine == "pkpm":
            import APIPyInterface
            from pkpm_converter import convert_v2_to_jws, refresh_result_mappings
            jws, mapping = convert_v2_to_jws(model, run_dir, "acceptance", "concrete")
            refreshed = refresh_result_mappings(jws, mapping)
            native = APIPyInterface.Model()
            if native.OpenPMModel(str(jws)) == 0:
                raise RuntimeError("Native model reopen failed")
            counts = []
            readback = {"floors": [], "members": []}
            for floor in (1, 2):
                natural = native.GetFloorAssemTable(floor)
                actual_floor = {"floor": floor, "bottomElevationM": natural.GetBottomElevation(),
                                "heightMm": natural.GetFloorHeight(), "standardFloor": natural.GetStandFloorIndex()}
                if actual_floor != {"floor": floor, "bottomElevationM": (floor-1)*3,
                                     "heightMm": 3000, "standardFloor": floor}:
                    raise RuntimeError(f"Native floor elevations/assembly mismatch: {actual_floor}")
                readback["floors"].append(actual_floor)
                native.SetCurrentStandFloor(floor)
                standard = native.GetCurrentStandFloor()
                counts.append({"floor": floor, "nodes": len(standard.GetNodes()), "columns": len(standard.GetColumns()), "beams": len(standard.GetBeams())})
                for role, members in (("column", standard.GetColumns()), ("beam", standard.GetBeams())):
                    for member in members:
                        section = native.GetColumnSection(member.GetSect()) if role == "column" else native.GetBeamSection(member.GetSect())
                        kind, shape = section.GetUserSect()
                        expected_shape = (600, 600) if role == "column" else (300, 500) if floor == 1 else (250, 450)
                        actual_shape = (shape.Get_B(), shape.Get_H())
                        if actual_shape != expected_shape or member.GetConcreteGrade() != 30:
                            raise RuntimeError(f"Native member {member.GetID()} grade/section mismatch")
                        readback["members"].append({"id": member.GetID(), "floor": floor, "role": role,
                                                   "grade": member.GetConcreteGrade(), "shapeMm": actual_shape,
                                                   "nativeSegment": member.GetSeg()})
            expected = [{"floor": 1, "nodes": 6, "columns": 6, "beams": 6}, {"floor": 2, "nodes": 4, "columns": 4, "beams": 4}]
            if counts != expected:
                raise RuntimeError(f"Native topology mismatch: {counts}; expected {expected}")
            evidence["steps"].append({"name": "native-model-readback", "status": "passed", "counts": counts, "mappedElements": len(refreshed["elem_map"])})
            (run_dir / "native-model-readback.json").write_text(json.dumps(readback, ensure_ascii=False, indent=2), encoding="utf-8")
            evidence["steps"].append({"name": "native-floor-elevation-member-grade-and-section-geometry", "status": "passed"})
            del native, standard
            if args.run:
                if args.cycle is None or not args.cycle.is_file():
                    raise RuntimeError("--run requires an existing --cycle JWSCYCLE.exe")
                os.environ["PKPM_CYCLE_PATH"] = str(args.cycle)
                runtime = load_runtime(directory, "pkpm_native_acceptance_runtime")
                runtime._run_jws_cycle(args.cycle, run_dir, timeout=args.timeout)
                raw = runtime._extract_results(jws, "concrete")
                evidence["steps"].append({"name": "native-solver-results", "status": "passed", "floors": raw["floors_analyzed"], "beams": raw["beam_count"], "columns": raw["column_count"], "cases": sorted(raw["case_member_stations"])})
                station_rows = [{"case": case, "pmid": key[0], "floor": key[1], "stations": rows} for case, members in raw["case_member_stations"].items() for key, rows in members.items()]
                (run_dir / "native-stations.json").write_text(json.dumps(station_rows, ensure_ascii=False, indent=2), encoding="utf-8")
                if raw["floors_analyzed"] != 2 or raw["beam_count"] != 10 or raw["column_count"] != 10 or not station_rows:
                    raise RuntimeError("Native results do not completely cover the representative model")
        else:
            if args.run:
                raise RuntimeError("YJK solver acceptance requires a dedicated isolated GUI/license session; this script never attaches to an existing session")
            if args.yjk_sdk is None:
                raise RuntimeError("YJK build acceptance requires --yjk-sdk site-packages path")
            sys.path.insert(0, str(args.yjk_sdk))
            # SDK uses argv[1] to select NDepend/Depend; do not pass our CLI mode.
            saved_argv = sys.argv
            sys.argv = [sys.argv[0], "NDepend"]
            try:
                from yjk_converter import convert_v2_to_ydb
                ydb = convert_v2_to_ydb(model, str(run_dir), "acceptance.ydb")
            finally:
                sys.argv = saved_argv
            with sqlite3.connect(f"file:{Path(ydb).as_posix()}?mode=ro", uri=True) as db:
                tables = [row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")]
            evidence["steps"].append({"name": "native-sdk-model-generation", "status": "passed", "tables": tables})
            evidence["limitations"] = ["Solver not run; native settings, topology roundtrip and force convention still require acceptance"]
        evidence["status"] = "passed"
    except Exception as error:
        evidence["error"] = f"{type(error).__name__}: {error}"
        (run_dir / "failure.txt").write_text(traceback.format_exc(), encoding="utf-8")
    (run_dir / "acceptance.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(evidence, ensure_ascii=False))
    return 0 if evidence["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
