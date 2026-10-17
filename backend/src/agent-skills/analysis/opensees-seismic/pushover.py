from __future__ import annotations

import math
from typing import Any, Dict, List, Optional, Sequence, Tuple

from coordinate_semantics import resolve_model_dimension
from design_basis import SeismicDesignBasis, model_payload
from gb50011_drift_limits import gb50011_advisory_yield_drift_metadata
from modal import (
    G_ACCEL,
    _build_opensees_model,
    _effective_section_properties,
    _element_nodes,
    _element_type,
    _is_opensees_line_element_type,
    _material_e,
    _material_map,
    _restraints_for_node,
    _section_map,
)
from seismic_contracts import optional_number
from spectrum import seismic_influence_coefficient

from pushover_hinges import (  # noqa: F401
    _as_record,
    _backbone_yield_point,
    _convergence_settings,
    _field,
    _first_number,
    _first_string,
    _hinge_ends,
    _looks_like_hinge_record,
    _member_plastic_hinge_definitions,
    _performance_objective,
    _records,
    _structured_entries,
)
from pushover_capacity import (  # noqa: F401
    _base_and_top,
    _capacity_assessment,
    _capacity_spectrum_iteration,
    _control_node_tag,
    _interpolate_curve_displacement_for_base_shear,
    _interpolate_curve_value,
    _lateral_load_for_node,
    _node_key,
    _pushover_bilinear_parameters,
    _total_mass_and_weight,
)
from pushover_estimates import (  # noqa: F401
    PUSHOVER_BILINEAR_SDOF_CAPABILITY,
    PUSHOVER_BILINEAR_STORY_SHEAR_CAPABILITY,
    PUSHOVER_MEMBER_HINGE_2D_CAPABILITY,
    _run_bilinear_sdof_pushover_estimate,
    _run_bilinear_story_shear_pushover_estimate,
    _run_member_hinge_2d_pushover_estimate,
    _story_shear_definition,
)


def _final_compliance_assessment(
    *,
    capacity_assessment: Dict[str, Any],
    nonlinear_estimate: Dict[str, Any],
) -> Dict[str, Any]:
    nonlinear_acceptance = (
        nonlinear_estimate.get("acceptanceCheck")
        if isinstance(nonlinear_estimate.get("acceptanceCheck"), dict)
        else {}
    )
    nonlinear_performance = (
        nonlinear_estimate.get("performancePoint")
        if isinstance(nonlinear_estimate.get("performancePoint"), dict)
        else {}
    )
    if nonlinear_acceptance:
        utilization = optional_number(nonlinear_acceptance.get("utilization"))
        drift = optional_number(nonlinear_performance.get("driftRatio"))
        limit = optional_number(nonlinear_acceptance.get("limitDriftRatio"))
        status = str(nonlinear_acceptance.get("status") or "").strip().lower()
        model_scope = str(nonlinear_estimate.get("modelScope") or nonlinear_estimate.get("engineMode") or "").strip()
        performance_objective = _performance_objective(nonlinear_acceptance)
        if model_scope == "member_end_rotational_plastic_hinges_2d":
            scope = "OpenSees 2D member-end rotational plastic-hinge nonlinear pushover estimate"
        elif model_scope == "bilinear_story_shear_building":
            scope = "OpenSees bilinear story-shear building nonlinear pushover estimate"
        else:
            scope = "OpenSees bilinear SDOF nonlinear estimate calibrated from the elastic pushover curve"
        return {
            "status": "pass" if status == "pass" and (utilization is None or utilization <= 1.0) else "fail",
            "method": "nonlinear_pushover_drift_acceptance",
            "source": "pushover.nonlinearEstimate.acceptanceCheck",
            "scope": scope,
            "driftRatio": round(float(drift), 8) if drift is not None else None,
            "limitDriftRatio": round(float(limit), 8) if limit is not None else None,
            "utilization": round(float(utilization), 6) if utilization is not None else None,
            **({"performanceObjective": performance_objective} if performance_objective else {}),
            "clauseBasis": "GB 55002-2021 + GB/T 50011-2010(2024) rare-earthquake elastic-plastic deformation acceptance concept",
        }

    capacity_acceptance = (
        capacity_assessment.get("acceptanceCheck")
        if isinstance(capacity_assessment.get("acceptanceCheck"), dict)
        else {}
    )
    performance = (
        capacity_assessment.get("performancePoint")
        if isinstance(capacity_assessment.get("performancePoint"), dict)
        else {}
    )
    if capacity_acceptance:
        utilization = optional_number(capacity_acceptance.get("utilization"))
        drift = optional_number(performance.get("driftRatio"))
        limit = optional_number(capacity_acceptance.get("limitDriftRatio"))
        status = str(capacity_acceptance.get("status") or "").strip().lower()
        performance_objective = _performance_objective(capacity_acceptance)
        return {
            "status": "pass" if status == "pass" and (utilization is None or utilization <= 1.0) else "fail",
            "method": "pushover_capacity_curve_drift_acceptance",
            "source": "pushover.capacityAssessment.acceptanceCheck",
            "scope": "capacity-curve performance point from OpenSees static pushover",
            "driftRatio": round(float(drift), 8) if drift is not None else None,
            "limitDriftRatio": round(float(limit), 8) if limit is not None else None,
            "utilization": round(float(utilization), 6) if utilization is not None else None,
            **({"performanceObjective": performance_objective} if performance_objective else {}),
            "clauseBasis": "GB 55002-2021 + GB/T 50011-2010(2024) rare-earthquake elastic-plastic deformation acceptance concept",
        }

    return {
        "status": "not_applicable",
        "method": "pushover_final_compliance",
        "source": "pushover",
        "scope": "No pushover drift acceptance result was available.",
    }


def run_linear_pushover(
    model: Any,
    basis: SeismicDesignBasis,
    parameters: Dict[str, Any],
    direction: str = "x",
) -> Dict[str, Any]:
    import openseespy.opensees as ops

    payload = model_payload(model)
    dimension, node_tags, floor_masses = _build_opensees_model(ops, payload, model, basis, direction)
    if dimension == "2d" and direction == "y":
        raise RuntimeError("Y-direction pushover requires a 3D model.")

    nodes = _records(payload, model, "nodes")
    base_tags, _top_tags = _base_and_top(nodes, node_tags)
    if not base_tags:
        raise RuntimeError("Unable to identify base nodes for pushover reactions.")

    target = optional_number(parameters.get("targetDisplacement")) or 0.05
    steps = int(optional_number(parameters.get("steps")) or 50)
    steps = max(1, min(steps, 500))
    increment = float(target) / steps
    dof = 2 if dimension == "3d" and direction == "y" else 1
    control_tag = _control_node_tag(nodes, node_tags, parameters.get("controlNode"))
    max_height = max((float(_field(node, "z", 0.0) or 0.0) for node in nodes), default=1.0)

    ops.timeSeries("Linear", 20_001)
    ops.pattern("Plain", 20_001, 20_001)
    for node in nodes:
        key = _node_key(node)
        if key not in node_tags:
            continue
        load = _lateral_load_for_node(node, max_height)
        if load <= 0.0:
            continue
        if dimension == "2d":
            ops.load(node_tags[key], load, 0.0, 0.0)
        else:
            if dof == 1:
                ops.load(node_tags[key], load, 0.0, 0.0, 0.0, 0.0, 0.0)
            else:
                ops.load(node_tags[key], 0.0, load, 0.0, 0.0, 0.0, 0.0)

    ops.wipeAnalysis()
    ops.constraints("Transformation")
    ops.numberer("RCM")
    ops.system("BandGeneral")
    ops.test("NormDispIncr", 1.0e-8, 16)
    ops.algorithm("Newton")
    ops.integrator("DisplacementControl", control_tag, dof, increment)
    ops.analysis("Static")

    curve: List[Dict[str, Any]] = []
    converged = True
    for step in range(steps):
        ok = ops.analyze(1)
        if ok != 0:
            converged = False
            break
        roof_disp = float(ops.nodeDisp(control_tag, dof))
        try:
            ops.reactions()
            base_shear = abs(sum(float(ops.nodeReaction(tag, dof)) for tag in base_tags))
        except Exception:
            base_shear = 0.0
        curve.append({
            "step": step + 1,
            "baseShear": round(base_shear, 6),
            "roofDisplacement": round(roof_disp, 8),
        })

    ops.wipe()
    capacity_assessment = _capacity_assessment(
        curve,
        target_displacement=float(target),
        max_height=max_height,
        parameters=parameters,
        basis=basis,
        floor_masses=floor_masses,
    )
    nonlinear_estimate = _run_member_hinge_2d_pushover_estimate(
        ops,
        model=model,
        basis=basis,
        parameters=parameters,
        direction=direction,
        target_displacement=float(target),
        max_height=max_height,
        steps=steps,
    )
    member_hinge_warnings = (
        nonlinear_estimate.get("warnings")
        if isinstance(nonlinear_estimate, dict) and isinstance(nonlinear_estimate.get("warnings"), list)
        else []
    )
    if nonlinear_estimate is None or nonlinear_estimate.get("status") == "estimate_failed":
        nonlinear_estimate = _run_bilinear_story_shear_pushover_estimate(
            ops,
            floor_masses=floor_masses,
            capacity_assessment=capacity_assessment,
            target_displacement=float(target),
            max_height=max_height,
            steps=steps,
            parameters=parameters,
            basis=basis,
        )
        if member_hinge_warnings and nonlinear_estimate is not None:
            nonlinear_estimate["warnings"] = [
                *member_hinge_warnings,
                "Member-end plastic-hinge pushover estimate was unavailable; used bilinear story-shear fallback.",
                *(nonlinear_estimate.get("warnings") if isinstance(nonlinear_estimate.get("warnings"), list) else []),
            ]
    if nonlinear_estimate is None or nonlinear_estimate.get("status") == "estimate_failed":
        fallback = _run_bilinear_sdof_pushover_estimate(
            ops,
            capacity_assessment=capacity_assessment,
            target_displacement=float(target),
            max_height=max_height,
            steps=steps,
            parameters=parameters,
            basis=basis,
        )
        if nonlinear_estimate is not None:
            fallback["warnings"] = [
                *(member_hinge_warnings if member_hinge_warnings else []),
                *(nonlinear_estimate.get("warnings") if isinstance(nonlinear_estimate.get("warnings"), list) else []),
                "Bilinear story-shear pushover estimate was unavailable; used SDOF fallback.",
            ]
        nonlinear_estimate = fallback
    final_compliance = _final_compliance_assessment(
        capacity_assessment=capacity_assessment,
        nonlinear_estimate=nonlinear_estimate,
    )
    return {
        "status": "success" if curve else "partial",
        "engineMode": "opensees_linear_static_pushover",
        "pushoverCurve": curve,
        "capacityAssessment": capacity_assessment,
        "nonlinearEstimate": nonlinear_estimate,
        "finalCompliance": final_compliance,
        "targetDisplacement": target,
        "controlNode": str(parameters.get("controlNode") or control_tag),
        "converged": converged,
        "completedSteps": len(curve),
        "requestedSteps": steps,
    }
