"""Independent topology probes for three planned YJK scenarios.

These are capability tests, not authored benchmark questions, multimodal
attachments or same-engine scoring truth. MM-084 dimensions follow its plan;
the other plans' still-unwritten section tables use explicit rectangular
calibration choices. No production modeling or solver helper is used here.
"""
from __future__ import annotations


def numeric_custom_model() -> dict:
    """MM-087 topology with explicit unequal principal/shear properties.

    Deliberately not the final task's property table. This independently tests
    native assembly without supplying a fictitious physical section shape.
    """
    data = model("MM-087")
    data["project"] = {"name": "MM087_numeric_section_capability"}
    for section in data["sections"]:
        p = section["properties"]
        p.update(Iy=p["Iy"]*.87, Iz=p["Iz"]*1.12, J=p["J"]*.78,
                 Asy=p["A"]*.61, Asz=p["A"]*.37)
        section.pop("shape")
        section.update(type="custom", name="Authored numeric " + section["id"])
    for material in data["materials"]:
        material.update(name="M1-authored", grade=None, E=203000., G=76321., nu=.31,
                        rho=7812., category="steel")
    node = next(n["id"] for n in data["nodes"] if (n["x"], n["y"], n["z"]) == (6, 5, 7.2))
    for key in ("fx", "fy", "fz", "mx", "my", "mz"):
        data["load_cases"].append({"id": key.upper(), "name": key.upper(), "type": "other",
            "loads": [{"id": "L-" + key, "type": "nodal", "node": node, key: 7}]})
    data["load_combinations"] = [{"id": "ALL", "name": "ALL", "type": "custom",
                                  "factors": {case["id"]: 1. for case in data["load_cases"]}}]
    return data


def _rectangle(identifier: str, width: int, height: int) -> dict:
    b, h = width / 1000, height / 1000
    a, c = max(b, h), min(b, h)
    return {"id": identifier, "type": "rectangular",
            "shape": {"kind": "rectangular", "B": width, "H": height},
            "properties": {"A": b*h, "Iy": b*h**3/12, "Iz": h*b**3/12,
                           "J": a*c**3*(1/3-.21*c/a*(1-c**4/(12*a**4)))}}


def model(case: str) -> dict:
    if case not in {"INT-081", "MM-084", "MM-087"}:
        raise ValueError("Only the three documented YJK topology probes are defined")
    xs = [0., 6.] if case == "INT-081" else [0., 6., 12.]
    ys = [0., 5.] if case == "MM-084" else [0., 5., 10.]
    levels = [0., 3.3, 6.6, 9.9] if case == "INT-081" else [0., 3.6, 7.2]
    cells = ({(0, 0), (1, 1)} if case == "MM-087" else
             {(i, j) for i in range(len(xs)-1) for j in range(len(ys)-1)})
    top_points = {(i+di, j+dj) for i, j in cells for di, dj in ((0, 0), (0, 1), (1, 0), (1, 1))}
    nodes, elements, references, loads = [], [], {}, []
    key = lambda i, j, k: f"n{i}-{j}-{k}"
    for k, z in enumerate(levels):
        for i, x in enumerate(xs):
            for j, y in enumerate(ys):
                if k == len(levels)-1 and (i, j) not in top_points:
                    continue
                nodes.append({"id": key(i, j, k), "x": x, "y": y, "z": z,
                              "restraints": [k == 0]*6})

    def member(identifier, role, ends, section):
        elements.append({"id": identifier, "type": role, "nodes": ends,
                         "material": "M1", "section": section})
        references[identifier] = [1., 0., 0.] if role == "column" else [0., 0., 1.]

    def line(identifier, value):
        loads.append({"id": f"D:{identifier}", "type": "distributed", "element": identifier,
                      "reference_frame": "global", "wz": -value})

    node_ids = {row["id"] for row in nodes}
    for k in range(1, len(levels)):
        for i in range(len(xs)):
            for j in range(len(ys)):
                if key(i, j, k) not in node_ids:
                    continue
                if not (case == "MM-084" and (i, j, k) == (1, 0, 2)):
                    member(f"c{i}-{j}-{k}", "column", [key(i, j, k-1), key(i, j, k)], "C1")
        edges = {}
        current_cells = cells if k == len(levels)-1 else {(i, j) for i in range(len(xs)-1) for j in range(len(ys)-1)}
        for i, j in current_cells:
            for axis, a, b in (("x", (i, j), (i+1, j)), ("x", (i, j+1), (i+1, j+1)),
                               ("y", (i, j), (i, j+1)), ("y", (i+1, j), (i+1, j+1))):
                edges[(axis, a, b)] = (i, j)
        for (axis, a, b), cell in sorted(edges.items()):
            identifier = f"{axis}{a[0]}-{a[1]}-{k}"
            section = "BT" if case == "MM-084" and k == 2 and axis == "x" and a[1] == 0 else "B1"
            member(identifier, "beam", [key(*a, k), key(*b, k)], section)
            if case == "INT-081" and axis == "x":
                line(identifier, 50. if a[1] == 1 else 25.)
            elif case == "MM-084" and axis == "x":
                line(identifier, 30. if k == 1 else 25.)
            elif case == "MM-087":
                line(identifier, 10. if k == 1 else 8. if cell == (0, 0) else 6.)
    if case == "INT-081":
        for j in (0, 2):
            identifier = f"roof-tip-{j}"
            nodes.append({"id": identifier, "x": 7.2, "y": ys[j], "z": levels[-1], "restraints": [False]*6})
            member(f"cantilever-{j}", "beam", [key(1, j, 3), identifier], "B1")
            loads.append({"id": f"D:{identifier}", "type": "nodal", "node": identifier,
                          "reference_frame": "global", "fz": -5.})
    concrete = case == "MM-084"
    return {"schema_version": "2.2.0", "unit_system": "SI",
            "coordinate_system": {"dimension": "3d", "plane": None, "semantics": "global-z-up", "version": 1,
                                  "dof_order": ["ux", "uy", "uz", "rx", "ry", "rz"]},
            "nodes": nodes, "elements": elements,
            "materials": [{"id": "M1", "name": "C30" if concrete else "Q355",
                           "category": "concrete" if concrete else "steel", "grade": "C30" if concrete else "Q355",
                           "E": 30000. if concrete else 206000., "G": 12500. if concrete else 206000./2.6,
                           "nu": .2 if concrete else .3, "rho": 2500. if concrete else 7850.}],
            "sections": [_rectangle("C1", 500, 500), _rectangle("B1", 300, 600)]
                        + ([_rectangle("BT", 400, 800)] if concrete else []),
            "stories": [{"id": f"s{k}", "elevation": levels[k-1], "height": levels[k]-levels[k-1],
                         "rigid_diaphragm": False} for k in range(1, len(levels))],
            "load_cases": [{"id": "D", "type": "dead", "loads": loads}], "load_combinations": [],
            "analysis_control": dict.fromkeys(("self_weight", "rigid_floor", "p_delta", "rigid_offsets", "construction_stage"), False),
            "metadata": {"elementReferenceVectors": references,
                         "capabilityProxy": {"plannedCase": case, "notBenchmarkScoringTruth": True,
                                             "notMultimodalInputEvidence": True,
                                             "sectionTableStatus": "plan-specified" if concrete else "calibration-choice"}}}
