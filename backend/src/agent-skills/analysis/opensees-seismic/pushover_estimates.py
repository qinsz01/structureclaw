"""Pushover estimate runners: bilinear SDOF, bilinear story-shear and 2D member-hinge models.

Split verbatim from ``pushover.py``, which re-exports these names.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Sequence
from coordinate_semantics import resolve_model_dimension
from design_basis import SeismicDesignBasis, model_payload
from modal import _effective_section_properties, _element_nodes, _element_type, _is_opensees_line_element_type, _material_e, _material_map, _restraints_for_node, _section_map
from seismic_contracts import optional_number

from pushover_capacity import (
    _base_and_top,
    _control_node_tag,
    _interpolate_curve_value,
    _lateral_load_for_node,
    _node_key,
    _pushover_bilinear_parameters,
)
from pushover_hinges import (
    _as_record,
    _convergence_settings,
    _field,
    _member_plastic_hinge_definitions,
    _performance_objective,
    _records,
)


PUSHOVER_MEMBER_HINGE_2D_CAPABILITY = "pushoverMemberPlasticHinge2dEstimate"
PUSHOVER_BILINEAR_SDOF_CAPABILITY = "pushoverBilinearSdofEstimate"
PUSHOVER_BILINEAR_STORY_SHEAR_CAPABILITY = "pushoverBilinearStoryShearBuildingEstimate"


def _run_bilinear_sdof_pushover_estimate(
    ops: Any,
    *,
    capacity_assessment: Dict[str, Any],
    target_displacement: float,
    max_height: float,
    steps: int,
    parameters: Dict[str, Any],
    basis: SeismicDesignBasis,
) -> Dict[str, Any]:
    params = _pushover_bilinear_parameters(
        capacity_assessment=capacity_assessment,
        target_displacement=target_displacement,
        max_height=max_height,
        parameters=parameters,
        basis=basis,
    )
    increment = target_displacement / max(steps, 1)
    curve: List[Dict[str, Any]] = []
    converged = True
    try:
        ops.wipe()
        ops.model("basic", "-ndm", 1, "-ndf", 1)
        ops.node(1, 0.0)
        ops.node(2, 0.0)
        ops.fix(1, 1)
        ops.uniaxialMaterial(
            "Steel01",
            1,
            params["yieldBaseShearKN"],
            params["initialStiffnessKNPerM"],
            params["postYieldStiffnessRatio"],
        )
        ops.element("zeroLength", 1, 1, 2, "-mat", 1, "-dir", 1)
        ops.timeSeries("Linear", 1)
        ops.pattern("Plain", 1, 1)
        ops.load(2, 1.0)
        ops.constraints("Plain")
        ops.numberer("Plain")
        ops.system("BandGeneral")
        ops.test("NormDispIncr", 1.0e-8, 20)
        ops.algorithm("Newton")
        ops.integrator("DisplacementControl", 2, 1, increment)
        ops.analysis("Static")
        for step in range(steps):
            if ops.analyze(1) != 0:
                converged = False
                break
            displacement = float(ops.nodeDisp(2, 1))
            try:
                forces = ops.eleForce(1)
                base_shear = max(abs(float(value)) for value in forces)
            except Exception:
                elastic = params["initialStiffnessKNPerM"] * min(abs(displacement), params["yieldDisplacementM"])
                plastic = params["initialStiffnessKNPerM"] * params["postYieldStiffnessRatio"] * max(abs(displacement) - params["yieldDisplacementM"], 0.0)
                base_shear = elastic + plastic
            curve.append({
                "step": step + 1,
                "roofDisplacement": round(displacement, 8),
                "baseShear": round(base_shear, 6),
                "ductility": round(abs(displacement) / max(params["yieldDisplacementM"], 1e-12), 6),
            })
    except Exception as error:
        return {
            "status": "estimate_failed",
            "engineMode": "opensees_bilinear_sdof_pushover_estimate",
            "warnings": [f"OpenSees bilinear SDOF pushover estimate failed: {error}"],
            "implementedCapabilities": [],
        }
    finally:
        try:
            ops.wipe()
        except Exception:
            pass

    performance = _interpolate_curve_value(curve, target_displacement)
    drift_ratio = abs(performance["roofDisplacement"]) / max(max_height, 1e-9)
    acceptance_drift = float(params["acceptanceDriftRatio"])
    return {
        "status": "estimated",
        "engineMode": "opensees_bilinear_sdof_pushover_estimate",
        "curve": curve,
        "parameters": {
            "initialStiffnessKNPerM": round(params["initialStiffnessKNPerM"], 6),
            "yieldDisplacementM": round(params["yieldDisplacementM"], 8),
            "yieldBaseShearKN": round(params["yieldBaseShearKN"], 6),
            **({"yieldDriftRatio": round(float(params["yieldDriftRatio"]), 8)} if params.get("yieldDriftRatio") is not None else {}),
            **({"yieldDriftSource": params["yieldDriftSource"]} if params.get("yieldDriftSource") else {}),
            **({"yieldDriftLimitFamily": params["yieldDriftLimitFamily"]} if params.get("yieldDriftLimitFamily") else {}),
            **({"yieldDriftLimitRatioText": params["yieldDriftLimitRatioText"]} if params.get("yieldDriftLimitRatioText") else {}),
            **({"yieldDriftIsFallback": bool(params["yieldDriftIsFallback"])} if params.get("yieldDriftIsFallback") is not None else {}),
            "postYieldStiffnessRatio": round(params["postYieldStiffnessRatio"], 6),
            **({"performanceObjective": params["performanceObjective"]} if isinstance(params.get("performanceObjective"), dict) and params["performanceObjective"] else {}),
        },
        "performancePoint": {
            "roofDisplacementM": performance["roofDisplacement"],
            "baseShearKN": performance["baseShear"],
            "driftRatio": round(drift_ratio, 8),
        },
        "acceptanceCheck": {
            "limitDriftRatio": round(acceptance_drift, 8),
            "status": "pass" if drift_ratio <= acceptance_drift else "fail",
            "utilization": round(drift_ratio / max(acceptance_drift, 1e-12), 6),
            **({"performanceObjective": params["performanceObjective"]} if isinstance(params.get("performanceObjective"), dict) and params["performanceObjective"] else {}),
        },
        "converged": converged,
        "completedSteps": len(curve),
        "requestedSteps": steps,
        "implementedCapabilities": [PUSHOVER_BILINEAR_SDOF_CAPABILITY],
        "missingInputs": [
            "nonlinearModel.fullMemberConstitutiveModels",
            "nonlinearModel.memberPlasticHingeBackboneCalibration",
        ],
        "assumptions": params["assumptions"],
    }


def _story_shear_definition(
    floor_masses: Sequence[Dict[str, Any]],
    *,
    capacity_assessment: Dict[str, Any],
    target_displacement: float,
    max_height: float,
    parameters: Dict[str, Any],
    basis: SeismicDesignBasis,
) -> Optional[Dict[str, Any]]:
    floors = [
        floor for floor in sorted(
            floor_masses,
            key=lambda item: float(item.get("elevation", 0.0) or 0.0),
        )
        if isinstance(floor, dict)
        and float(floor.get("elevation", 0.0) or 0.0) > 0.0
    ]
    if len(floors) < 2:
        return None

    params = _pushover_bilinear_parameters(
        capacity_assessment=capacity_assessment,
        target_displacement=target_displacement,
        max_height=max_height,
        parameters=parameters,
        basis=basis,
    )
    story_heights: List[float] = []
    lower_elevation = 0.0
    for floor in floors:
        elevation = float(floor.get("elevation", 0.0) or 0.0)
        height = elevation - lower_elevation
        if height <= 1e-9:
            height = max_height / len(floors)
        story_heights.append(height)
        lower_elevation = elevation

    story_count = len(floors)
    story_stiffness = float(params["initialStiffnessKNPerM"]) * story_count
    yield_drift = float(params["yieldDisplacementM"]) / max(sum(story_heights), 1e-9)
    return {
        "floors": floors,
        "storyHeights": story_heights,
        "storyStiffnesses": [story_stiffness] * story_count,
        "yieldDeformations": [max(yield_drift * height, 1e-9) for height in story_heights],
        "postYieldStiffnessRatio": float(params["postYieldStiffnessRatio"]),
        "targetDisplacementM": target_displacement,
        "acceptanceDriftRatio": float(params["acceptanceDriftRatio"]),
        "parameters": params,
    }


def _run_bilinear_story_shear_pushover_estimate(
    ops: Any,
    *,
    floor_masses: Sequence[Dict[str, Any]],
    capacity_assessment: Dict[str, Any],
    target_displacement: float,
    max_height: float,
    steps: int,
    parameters: Dict[str, Any],
    basis: SeismicDesignBasis,
) -> Optional[Dict[str, Any]]:
    definition = _story_shear_definition(
        floor_masses,
        capacity_assessment=capacity_assessment,
        target_displacement=target_displacement,
        max_height=max_height,
        parameters=parameters,
        basis=basis,
    )
    if definition is None:
        return None

    floors = definition["floors"]
    story_heights = definition["storyHeights"]
    stiffnesses = definition["storyStiffnesses"]
    yield_deformations = definition["yieldDeformations"]
    post_yield_ratio = float(definition["postYieldStiffnessRatio"])
    increment = target_displacement / max(steps, 1)
    curve: List[Dict[str, Any]] = []
    converged = True
    try:
        ops.wipe()
        ops.model("basic", "-ndm", 1, "-ndf", 1)
        node_tags = [index + 1 for index in range(len(floors) + 1)]
        for tag in node_tags:
            ops.node(tag, 0.0)
        ops.fix(node_tags[0], 1)
        for index, stiffness in enumerate(stiffnesses):
            mat_tag = index + 1
            element_tag = index + 1
            yield_force = max(float(stiffness) * float(yield_deformations[index]), 1e-9)
            ops.uniaxialMaterial("Steel01", mat_tag, yield_force, float(stiffness), post_yield_ratio)
            ops.element("zeroLength", element_tag, node_tags[index], node_tags[index + 1], "-mat", mat_tag, "-dir", 1)
        ops.timeSeries("Linear", 1)
        ops.pattern("Plain", 1, 1)
        for index, floor in enumerate(floors):
            load = float(floor.get("elevation", 0.0) or 0.0) / max(max_height, 1e-9)
            ops.load(node_tags[index + 1], load)
        ops.constraints("Plain")
        ops.numberer("Plain")
        ops.system("BandGeneral")
        ops.test("NormDispIncr", 1.0e-8, 25)
        ops.algorithm("Newton")
        ops.integrator("DisplacementControl", node_tags[-1], 1, increment)
        ops.analysis("Static")
        for step in range(steps):
            if ops.analyze(1) != 0:
                converged = False
                break
            floor_displacements = [float(ops.nodeDisp(tag, 1)) for tag in node_tags[1:]]
            lower_displacement = 0.0
            story_responses: List[Dict[str, Any]] = []
            for index, displacement in enumerate(floor_displacements):
                interstory = displacement - lower_displacement
                story_responses.append({
                    "story": floors[index].get("story") or f"F{index + 1}",
                    "elevation": round(float(floors[index].get("elevation", 0.0) or 0.0), 6),
                    "storyHeightM": round(float(story_heights[index]), 6),
                    "interstoryDisplacementM": round(interstory, 8),
                    "driftRatio": round(abs(interstory) / max(float(story_heights[index]), 1e-9), 8),
                    "ductility": round(abs(interstory) / max(float(yield_deformations[index]), 1e-12), 6),
                })
                lower_displacement = displacement
            try:
                forces = ops.eleForce(1)
                base_shear = max(abs(float(value)) for value in forces)
            except Exception:
                base_shear = abs(floor_displacements[0]) * float(stiffnesses[0])
            curve.append({
                "step": step + 1,
                "roofDisplacement": round(floor_displacements[-1], 8),
                "baseShear": round(base_shear, 6),
                "maxStoryDriftRatio": round(max((float(item["driftRatio"]) for item in story_responses), default=0.0), 8),
                "storyResponses": story_responses,
            })
    except Exception as error:
        return {
            "status": "estimate_failed",
            "engineMode": "opensees_bilinear_story_shear_pushover_estimate",
            "warnings": [f"OpenSees bilinear story-shear pushover estimate failed: {error}"],
            "implementedCapabilities": [],
        }
    finally:
        try:
            ops.wipe()
        except Exception:
            pass

    performance = _interpolate_curve_value(curve, target_displacement)
    controlling_story: Dict[str, Any] = {}
    for point in curve:
        for story in point.get("storyResponses", []):
            if not isinstance(story, dict):
                continue
            current = float(story.get("driftRatio", 0.0) or 0.0)
            previous = float(controlling_story.get("driftRatio", -1.0) or -1.0) if controlling_story else -1.0
            if current > previous:
                controlling_story = {**story, "step": point.get("step")}
    max_drift = float(controlling_story.get("driftRatio", 0.0) or 0.0)
    acceptance_drift = float(definition["acceptanceDriftRatio"])
    params = definition["parameters"]
    return {
        "status": "estimated",
        "engineMode": "opensees_bilinear_story_shear_pushover_estimate",
        "modelScope": "bilinear_story_shear_building",
        "curve": curve,
        "parameters": {
            "initialStiffnessKNPerM": round(float(params["initialStiffnessKNPerM"]), 6),
            "yieldDisplacementM": round(float(params["yieldDisplacementM"]), 8),
            "yieldBaseShearKN": round(float(params["yieldBaseShearKN"]), 6),
            **({"yieldDriftRatio": round(float(params["yieldDriftRatio"]), 8)} if params.get("yieldDriftRatio") is not None else {}),
            **({"yieldDriftSource": params["yieldDriftSource"]} if params.get("yieldDriftSource") else {}),
            **({"yieldDriftLimitFamily": params["yieldDriftLimitFamily"]} if params.get("yieldDriftLimitFamily") else {}),
            **({"yieldDriftLimitRatioText": params["yieldDriftLimitRatioText"]} if params.get("yieldDriftLimitRatioText") else {}),
            **({"yieldDriftIsFallback": bool(params["yieldDriftIsFallback"])} if params.get("yieldDriftIsFallback") is not None else {}),
            "postYieldStiffnessRatio": round(float(params["postYieldStiffnessRatio"]), 6),
            "storyCount": len(floors),
            "storyStiffnessKNPerM": round(float(stiffnesses[0]), 6),
            **({"performanceObjective": params["performanceObjective"]} if isinstance(params.get("performanceObjective"), dict) and params["performanceObjective"] else {}),
        },
        "performancePoint": {
            "roofDisplacementM": performance["roofDisplacement"],
            "baseShearKN": performance["baseShear"],
            "driftRatio": round(max_drift, 8),
        },
        "controllingStory": controlling_story,
        "acceptanceCheck": {
            "limitDriftRatio": round(acceptance_drift, 8),
            "status": "pass" if max_drift <= acceptance_drift else "fail",
            "utilization": round(max_drift / max(acceptance_drift, 1e-12), 6),
            **({"performanceObjective": params["performanceObjective"]} if isinstance(params.get("performanceObjective"), dict) and params["performanceObjective"] else {}),
        },
        "converged": converged,
        "completedSteps": len(curve),
        "requestedSteps": steps,
        "implementedCapabilities": [
            PUSHOVER_BILINEAR_SDOF_CAPABILITY,
            PUSHOVER_BILINEAR_STORY_SHEAR_CAPABILITY,
        ],
        "missingInputs": [
            "nonlinearModel.fullMemberConstitutiveModels",
            "nonlinearModel.memberPlasticHingeBackboneCalibration",
        ],
        "assumptions": params["assumptions"],
    }


def _run_member_hinge_2d_pushover_estimate(
    ops: Any,
    *,
    model: Any,
    basis: SeismicDesignBasis,
    parameters: Dict[str, Any],
    direction: str,
    target_displacement: float,
    max_height: float,
    steps: int,
) -> Optional[Dict[str, Any]]:
    payload = model_payload(model)
    nodes = _records(payload, model, "nodes")
    elements = _records(payload, model, "elements")
    if resolve_model_dimension(model) != "2d" or direction.lower() != "x":
        return None

    nonlinear_model = _as_record(parameters.get("nonlinearModel"))
    hinges, missing_inputs = _member_plastic_hinge_definitions(parameters, elements)
    if not hinges:
        if not nonlinear_model:
            return None
        return {
            "status": "estimate_failed",
            "engineMode": "opensees_member_end_plastic_hinge_2d_pushover_estimate",
            "modelScope": "member_end_rotational_plastic_hinges_2d",
            "warnings": ["Structured nonlinearModel was provided, but no complete 2D member plastic hinge definitions were available."],
            "implementedCapabilities": [],
            "missingInputs": missing_inputs,
        }

    sections = _section_map(_records(payload, model, "sections"))
    materials = _material_map(_records(payload, model, "materials"))
    node_lookup = {_node_key(node): node for node in nodes}
    node_tags = {_node_key(node): index + 1 for index, node in enumerate(nodes)}
    hinge_by_element_end = {
        (str(hinge["elementId"]), str(hinge["end"])): hinge
        for hinge in hinges
    }
    convergence = _convergence_settings(parameters)
    performance_objective = _performance_objective(parameters)
    acceptance_drift = (
        optional_number(parameters.get("acceptanceDriftRatio"))
        or optional_number(performance_objective.get("acceptanceDriftRatio"))
        or 0.02
    )
    increment = target_displacement / max(steps, 1)
    control_tag = _control_node_tag(nodes, node_tags, parameters.get("controlNode"))
    base_tags, _top_tags = _base_and_top(nodes, node_tags)
    if not base_tags:
        return {
            "status": "estimate_failed",
            "engineMode": "opensees_member_end_plastic_hinge_2d_pushover_estimate",
            "modelScope": "member_end_rotational_plastic_hinges_2d",
            "warnings": ["Unable to identify base nodes for member-end plastic-hinge pushover estimate."],
            "implementedCapabilities": [],
            "missingInputs": missing_inputs,
        }

    curve: List[Dict[str, Any]] = []
    hinge_runtime: List[Dict[str, Any]] = []
    hinge_peaks: Dict[str, Dict[str, Any]] = {}
    converged = True
    try:
        ops.wipe()
        ops.model("basic", "-ndm", 2, "-ndf", 3)
        for node in nodes:
            key = _node_key(node)
            tag = node_tags[key]
            ops.node(tag, float(_field(node, "x", 0.0) or 0.0), float(_field(node, "z", 0.0) or 0.0))
            restraints = _restraints_for_node(node, "2d")
            if any(restraints):
                ops.fix(tag, *restraints)

        next_node_tag = len(node_tags) + 1
        next_element_tag = 1
        next_material_tag = 100_001
        for element in elements:
            element_type = _element_type(element)
            if not _is_opensees_line_element_type(element_type):
                continue
            element_nodes = _element_nodes(element)
            if len(element_nodes) < 2 or element_nodes[0] not in node_lookup or element_nodes[1] not in node_lookup:
                continue
            section = sections.get(str(_field(element, "section", "")))
            if section is None:
                continue
            material = materials.get(str(_field(element, "material", "")))
            area, iy, iz, _torsion = _effective_section_properties(element_type, section)
            inertia = max(iy, 1.0e-8)
            e_modulus = _material_e(material, section)
            element_id = str(_field(element, "id"))
            member_node_tags: List[int] = []
            for end, node_id in (("i", element_nodes[0]), ("j", element_nodes[1])):
                hinge = hinge_by_element_end.get((element_id, end))
                if not hinge:
                    member_node_tags.append(node_tags[node_id])
                    continue
                source_node = node_lookup[node_id]
                physical_tag = node_tags[node_id]
                duplicate_tag = next_node_tag
                next_node_tag += 1
                ops.node(
                    duplicate_tag,
                    float(_field(source_node, "x", 0.0) or 0.0),
                    float(_field(source_node, "z", 0.0) or 0.0),
                )
                ops.equalDOF(physical_tag, duplicate_tag, 1, 2)
                yield_moment = max(float(hinge["yieldMomentKNm"]), 1.0e-9)
                yield_rotation = max(float(hinge["yieldRotationRad"]), 1.0e-9)
                elastic_rotational_stiffness = yield_moment / yield_rotation
                material_tag = next_material_tag
                next_material_tag += 1
                hinge_element_tag = 200_000 + len(hinge_runtime) + 1
                ops.uniaxialMaterial(
                    "Steel01",
                    material_tag,
                    yield_moment,
                    elastic_rotational_stiffness,
                    float(hinge["postYieldStiffnessRatio"]),
                )
                ops.element("zeroLength", hinge_element_tag, physical_tag, duplicate_tag, "-mat", material_tag, "-dir", 3)
                member_node_tags.append(duplicate_tag)
                hinge_runtime.append({
                    "id": f"{element_id}:{end}",
                    "elementId": element_id,
                    "end": end,
                    "physicalTag": physical_tag,
                    "duplicateTag": duplicate_tag,
                    "zeroLengthElementTag": hinge_element_tag,
                    "yieldMomentKNm": yield_moment,
                    "yieldRotationRad": yield_rotation,
                    "postYieldStiffnessRatio": float(hinge["postYieldStiffnessRatio"]),
                })
            if len(member_node_tags) < 2 or member_node_tags[0] == member_node_tags[1]:
                continue
            element_tag = next_element_tag
            next_element_tag += 1
            ops.geomTransf("Linear", element_tag)
            ops.element(
                "elasticBeamColumn",
                element_tag,
                member_node_tags[0],
                member_node_tags[1],
                area,
                e_modulus,
                inertia,
                element_tag,
            )

        if not hinge_runtime:
            return {
                "status": "estimate_failed",
                "engineMode": "opensees_member_end_plastic_hinge_2d_pushover_estimate",
                "modelScope": "member_end_rotational_plastic_hinges_2d",
                "warnings": ["Structured plastic hinges did not map to any OpenSees 2D line element ends."],
                "implementedCapabilities": [],
                "missingInputs": list(dict.fromkeys([*missing_inputs, "nonlinearModel.memberPlasticHinges.elementId"])),
            }

        ops.timeSeries("Linear", 30_001)
        ops.pattern("Plain", 30_001, 30_001)
        for node in nodes:
            key = _node_key(node)
            load = _lateral_load_for_node(node, max_height)
            if load > 0.0:
                ops.load(node_tags[key], load, 0.0, 0.0)

        ops.wipeAnalysis()
        ops.constraints("Transformation")
        ops.numberer("RCM")
        ops.system("BandGeneral")
        ops.test(convergence["test"], convergence["tolerance"], convergence["maxIterations"])
        ops.algorithm("Newton")
        ops.integrator("DisplacementControl", control_tag, 1, increment)
        ops.analysis("Static")
        for step in range(steps):
            if ops.analyze(1) != 0:
                converged = False
                break
            roof_displacement = float(ops.nodeDisp(control_tag, 1))
            try:
                ops.reactions()
                base_shear = abs(sum(float(ops.nodeReaction(tag, 1)) for tag in base_tags))
            except Exception:
                base_shear = 0.0
            step_hinge_responses: List[Dict[str, Any]] = []
            for hinge in hinge_runtime:
                rotation = abs(
                    float(ops.nodeDisp(int(hinge["duplicateTag"]), 3))
                    - float(ops.nodeDisp(int(hinge["physicalTag"]), 3))
                )
                ductility = rotation / max(float(hinge["yieldRotationRad"]), 1.0e-12)
                response = {
                    "id": hinge["id"],
                    "elementId": hinge["elementId"],
                    "end": hinge["end"],
                    "rotationRad": round(rotation, 8),
                    "yieldRotationRad": round(float(hinge["yieldRotationRad"]), 8),
                    "ductility": round(ductility, 6),
                    "yieldMomentKNm": round(float(hinge["yieldMomentKNm"]), 6),
                    "step": step + 1,
                }
                step_hinge_responses.append(response)
                previous = hinge_peaks.get(str(hinge["id"]))
                if previous is None or ductility > float(previous.get("ductility", 0.0) or 0.0):
                    hinge_peaks[str(hinge["id"])] = response
            curve.append({
                "step": step + 1,
                "roofDisplacement": round(roof_displacement, 8),
                "baseShear": round(base_shear, 6),
                "driftRatio": round(abs(roof_displacement) / max(max_height, 1.0e-9), 8),
                "maxHingeDuctility": round(max((float(item["ductility"]) for item in step_hinge_responses), default=0.0), 6),
            })
    except Exception as error:
        return {
            "status": "estimate_failed",
            "engineMode": "opensees_member_end_plastic_hinge_2d_pushover_estimate",
            "modelScope": "member_end_rotational_plastic_hinges_2d",
            "warnings": [f"OpenSees member-end plastic-hinge pushover estimate failed: {error}"],
            "implementedCapabilities": [],
            "missingInputs": missing_inputs,
        }
    finally:
        try:
            ops.wipe()
        except Exception:
            pass

    if not curve:
        return {
            "status": "estimate_failed",
            "engineMode": "opensees_member_end_plastic_hinge_2d_pushover_estimate",
            "modelScope": "member_end_rotational_plastic_hinges_2d",
            "warnings": ["Member-end plastic-hinge pushover estimate did not complete any displacement step."],
            "implementedCapabilities": [],
            "missingInputs": missing_inputs,
        }

    performance = _interpolate_curve_value(curve, target_displacement)
    drift_ratio = abs(float(performance["roofDisplacement"])) / max(max_height, 1.0e-9)
    controlling_hinge = max(
        hinge_peaks.values(),
        key=lambda item: float(item.get("ductility", 0.0) or 0.0),
        default={},
    )
    return {
        "status": "estimated",
        "engineMode": "opensees_member_end_plastic_hinge_2d_pushover_estimate",
        "modelScope": "member_end_rotational_plastic_hinges_2d",
        "curve": curve,
        "parameters": {
            "hingeCount": len(hinge_runtime),
            "targetDisplacementM": round(float(target_displacement), 8),
            "acceptanceDriftRatio": round(float(acceptance_drift), 8),
            "convergenceCriteria": convergence,
            **({"performanceObjective": performance_objective} if performance_objective else {}),
        },
        "performancePoint": {
            "roofDisplacementM": performance["roofDisplacement"],
            "baseShearKN": performance["baseShear"],
            "driftRatio": round(drift_ratio, 8),
            "maxHingeDuctility": controlling_hinge.get("ductility") if controlling_hinge else None,
        },
        "hingeResponses": list(hinge_peaks.values()),
        "controllingHinge": controlling_hinge,
        "acceptanceCheck": {
            "limitDriftRatio": round(float(acceptance_drift), 8),
            "status": "pass" if drift_ratio <= float(acceptance_drift) else "fail",
            "utilization": round(drift_ratio / max(float(acceptance_drift), 1.0e-12), 6),
            **({"performanceObjective": performance_objective} if performance_objective else {}),
        },
        "converged": converged,
        "completedSteps": len(curve),
        "requestedSteps": steps,
        "implementedCapabilities": [PUSHOVER_MEMBER_HINGE_2D_CAPABILITY],
        "missingInputs": list(dict.fromkeys([*missing_inputs, "nonlinearModel.fullMemberConstitutiveModels"])),
        "warnings": [
            "Restricted OpenSees 2D member-end rotational plastic-hinge pushover estimate; full distributed inelastic member modeling is still outside this solver path.",
        ],
    }
