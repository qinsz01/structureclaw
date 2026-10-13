"""Test-only capability proxies for planned INT-089 and MM-089.

These explicit rectangular sections are calibration choices, not the still
unwritten benchmark property tables, multimodal attachments or scoring truth.
Geometry, connections, support roles and loads follow the 300-case plan in
all-models-engines-v2.json / all-tasks-engines-v2.json (2026-10-13).
No production converter, solver or postprocessor is imported here.
"""
from __future__ import annotations


def _rectangle(identifier: str, width_mm: int, depth_mm: int) -> dict:
    width, depth = width_mm / 1000, depth_mm / 1000
    longer, shorter = max(width, depth), min(width, depth)
    torsion = longer * shorter**3 * (
        1 / 3 - .21 * shorter / longer * (1 - shorter**4 / (12 * longer**4)))
    return {"id": identifier, "name": identifier, "type": "rectangular",
            "shape": {"kind": "rectangular", "B": width_mm, "H": depth_mm},
            "properties": {"A": width * depth, "Iy": width * depth**3 / 12,
                           "Iz": depth * width**3 / 12, "J": torsion}}


def model(case: str, state: int = 1) -> dict:
    """Return a fresh proxy. INT state 2 is the clarified third-turn state."""
    if case not in {"INT-089", "MM-089"} or type(state) is not int or state not in (
            (1, 2) if case == "INT-089" else (1,)):
        raise ValueError("Only INT-089 states 1/2 and MM-089 state 1 are defined")
    interactive = case == "INT-089"
    xs, ys = ([0., 6., 12.] if interactive else [0., 4., 8., 12.]), [0., 5., 10.]
    levels = [0., 3.6, 7.2]
    nodes, elements, references = [], [], {}
    node_id = lambda i, j, k: f"n{i}-{j}-{k}"
    for k, z in enumerate(levels):
        for i, x in enumerate(xs):
            for j, y in enumerate(ys):
                corner = i in (0, len(xs)-1) and j in (0, len(ys)-1)
                interior = 0 < i < len(xs)-1 and 0 < j < len(ys)-1
                pinned = ((i, j) in {(0, 0), (len(xs)-1, len(ys)-1)}
                          if interactive else interior)
                nodes.append({"id": node_id(i, j, k), "x": x, "y": y, "z": z,
                              "restraints": ([True]*3 + [not pinned]*3) if k == 0 else [False]*6})
                if k == 0:
                    continue
                section = "C1" if corner else "C3" if interior else "C4" if state == 2 else "C2"
                column_id = f"c{i}-{j}-{k}"
                elements.append({"id": column_id, "type": "column", "material": "M1", "section": section,
                                 "nodes": [node_id(i, j, k-1), node_id(i, j, k)]})
                references[column_id] = [1., 0., 0.]
                if i < len(xs)-1:
                    beam_id = f"x{i}-{j}-{k}"
                    x_section = "B1" if interactive else "B3" if j == 1 else "B2"
                    elements.append({"id": beam_id, "type": "beam", "material": "M1", "section": x_section,
                                     "nodes": [node_id(i, j, k), node_id(i+1, j, k)]})
                    references[beam_id] = [0., 0., 1.]
                if j < len(ys)-1:
                    beam_id = f"y{i}-{j}-{k}"
                    elements.append({"id": beam_id, "type": "beam", "material": "M1",
                                     "section": "B2" if interactive else "B1",
                                     "nodes": [node_id(i, j, k), node_id(i, j+1, k)]})
                    references[beam_id] = [0., 0., 1.]
    sizes = {"C1": (500, 500), "C2": (600, 600), "C3": (700, 700),
             "B1": (300, 600), "B2": (300, 700), "B3": (330, 660)}
    if interactive:
        # The property table already declares C4; only assignments change.
        sizes["C4"] = (650, 650)
    loads = [{"id": f"D:{row['id']}", "type": "distributed", "element": row["id"],
              "reference": "global", "distribution": "uniform", "wz": -8.}
             for row in elements if row["type"] == "beam"]
    if not interactive:
        loads.append({"id": "D:far-corner", "type": "nodal", "node": node_id(3, 2, 2),
                      "fx": 20., "fy": 10.})
    return {"schema_version": "2.2.0", "unit_system": "SI",
            "coordinate_system": {"dimension": "3d", "plane": None, "semantics": "global-z-up", "version": 1,
                                  "dof_order": ["ux", "uy", "uz", "rx", "ry", "rz"]},
            "nodes": nodes, "elements": elements,
            "materials": [{"id": "M1", "name": "Q355", "type": "steel", "category": "steel", "grade": "Q355",
                           "E": 206000., "G": 206000./2.6, "nu": .3, "rho": 7850.}],
            "sections": [_rectangle(key, *size) for key, size in sizes.items()],
            "stories": [{"id": f"s{k}", "elevation": levels[k-1], "height": 3.6,
                         "rigid_diaphragm": False} for k in (1, 2)],
            "load_cases": [{"id": "D", "type": "dead", "loads": loads}], "load_combinations": [],
            "analysis_control": dict.fromkeys(("self_weight", "rigid_floor", "p_delta", "rigid_offsets", "construction_stage"), False),
            "metadata": {"elementReferenceVectors": references,
                         "capabilityProxy": {"plannedCase": case, "state": state,
                                             "kind": "test-only-explicit-rectangular-frame",
                                             "notBenchmarkScoringTruth": True,
                                             "notMultimodalInputEvidence": True,
                                             "taskTurn": 3 if state == 2 else 1,
                                             "sectionDimensionsUnit": "mm"}}}
