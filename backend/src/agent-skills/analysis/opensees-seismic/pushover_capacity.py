"""Pushover curve helpers: control nodes, lateral load pattern, curve interpolation,
capacity-spectrum iteration and capacity assessment.

Split verbatim from ``pushover.py``, which re-exports these names.
"""

from __future__ import annotations

import math
from typing import Any, Dict, List, Optional, Sequence, Tuple
from design_basis import SeismicDesignBasis
from gb50011_drift_limits import gb50011_advisory_yield_drift_metadata
from modal import G_ACCEL
from seismic_contracts import optional_number
from spectrum import seismic_influence_coefficient

from pushover_hinges import (
    _field,
    _performance_objective,
)


def _node_key(node: Any) -> str:
    return str(_field(node, "id"))


def _base_and_top(nodes: Sequence[Any], node_tags: Dict[str, int]) -> Tuple[List[int], List[int]]:
    elevations = [float(_field(node, "z", 0.0) or 0.0) for node in nodes]
    if not elevations:
        return [], []
    min_z = min(elevations)
    max_z = max(elevations)
    base = [
        node_tags[_node_key(node)]
        for node in nodes
        if _node_key(node) in node_tags and abs(float(_field(node, "z", 0.0) or 0.0) - min_z) <= 1e-6
    ]
    top = [
        node_tags[_node_key(node)]
        for node in nodes
        if _node_key(node) in node_tags and abs(float(_field(node, "z", 0.0) or 0.0) - max_z) <= 1e-6
    ]
    return base, top


def _control_node_tag(
    nodes: Sequence[Any],
    node_tags: Dict[str, int],
    requested_control_node: Any,
) -> int:
    if requested_control_node is not None:
        key = str(requested_control_node)
        if key in node_tags:
            return node_tags[key]
    _base, top = _base_and_top(nodes, node_tags)
    if top:
        return top[0]
    raise RuntimeError("Unable to select a pushover control node.")


def _lateral_load_for_node(node: Any, max_height: float) -> float:
    z = float(_field(node, "z", 0.0) or 0.0)
    if max_height <= 0.0 or z <= 0.0:
        return 0.0
    return z / max_height


def _interpolate_curve_value(curve: Sequence[Dict[str, Any]], displacement: float) -> Dict[str, float]:
    if not curve:
        return {"roofDisplacement": displacement, "baseShear": 0.0}
    ordered = sorted(curve, key=lambda item: float(item.get("roofDisplacement", 0.0) or 0.0))
    first = ordered[0]
    if displacement <= float(first.get("roofDisplacement", 0.0) or 0.0):
        return {
            "roofDisplacement": round(displacement, 8),
            "baseShear": round(float(first.get("baseShear", 0.0) or 0.0), 6),
        }
    for previous, current in zip(ordered, ordered[1:]):
        d0 = float(previous.get("roofDisplacement", 0.0) or 0.0)
        d1 = float(current.get("roofDisplacement", 0.0) or 0.0)
        if d0 <= displacement <= d1 and d1 > d0:
            v0 = float(previous.get("baseShear", 0.0) or 0.0)
            v1 = float(current.get("baseShear", 0.0) or 0.0)
            ratio = (displacement - d0) / (d1 - d0)
            return {
                "roofDisplacement": round(displacement, 8),
                "baseShear": round(v0 + ratio * (v1 - v0), 6),
            }
    last = ordered[-1]
    return {
        "roofDisplacement": round(displacement, 8),
        "baseShear": round(float(last.get("baseShear", 0.0) or 0.0), 6),
    }


def _interpolate_curve_displacement_for_base_shear(
    curve: Sequence[Dict[str, Any]],
    base_shear: float,
) -> Dict[str, float]:
    if not curve:
        return {"roofDisplacement": 0.0, "baseShear": round(base_shear, 6)}
    points = [
        {"roofDisplacement": 0.0, "baseShear": 0.0},
        *[
            {
                "roofDisplacement": abs(float(point.get("roofDisplacement", 0.0) or 0.0)),
                "baseShear": abs(float(point.get("baseShear", 0.0) or 0.0)),
            }
            for point in curve
            if abs(float(point.get("roofDisplacement", 0.0) or 0.0)) > 1e-12
        ],
    ]
    ordered = sorted(points, key=lambda item: float(item.get("baseShear", 0.0) or 0.0))
    demand = max(float(base_shear), 0.0)
    first = ordered[0]
    if demand <= float(first.get("baseShear", 0.0) or 0.0):
        return {
            "roofDisplacement": round(float(first.get("roofDisplacement", 0.0) or 0.0), 8),
            "baseShear": round(demand, 6),
        }
    for previous, current in zip(ordered, ordered[1:]):
        v0 = float(previous.get("baseShear", 0.0) or 0.0)
        v1 = float(current.get("baseShear", 0.0) or 0.0)
        if v0 <= demand <= v1 and v1 > v0:
            d0 = float(previous.get("roofDisplacement", 0.0) or 0.0)
            d1 = float(current.get("roofDisplacement", 0.0) or 0.0)
            ratio = (demand - v0) / (v1 - v0)
            return {
                "roofDisplacement": round(d0 + ratio * (d1 - d0), 8),
                "baseShear": round(demand, 6),
            }
    last = ordered[-1]
    return {
        "roofDisplacement": round(float(last.get("roofDisplacement", 0.0) or 0.0), 8),
        "baseShear": round(float(last.get("baseShear", 0.0) or 0.0), 6),
    }


def _total_mass_and_weight(floor_masses: Optional[Sequence[Dict[str, Any]]]) -> Tuple[float, float]:
    if not floor_masses:
        return 0.0, 0.0
    total_mass = 0.0
    total_weight = 0.0
    for floor in floor_masses:
        if not isinstance(floor, dict):
            continue
        mass = optional_number(floor.get("mass"))
        weight = optional_number(floor.get("weightKN"))
        if mass is not None:
            total_mass += max(float(mass), 0.0)
        if weight is not None:
            total_weight += max(float(weight), 0.0)
    if total_weight <= 0.0 and total_mass > 0.0:
        total_weight = total_mass * G_ACCEL
    if total_mass <= 0.0 and total_weight > 0.0:
        total_mass = total_weight / G_ACCEL
    return total_mass, total_weight


def _capacity_spectrum_iteration(
    curve: Sequence[Dict[str, Any]],
    *,
    basis: Optional[SeismicDesignBasis],
    floor_masses: Optional[Sequence[Dict[str, Any]]],
    initial_displacement: float,
) -> Optional[Dict[str, Any]]:
    if basis is None:
        return None
    total_mass, total_weight = _total_mass_and_weight(floor_masses)
    if total_mass <= 0.0 or total_weight <= 0.0:
        return None
    positive_points = [
        point for point in curve
        if abs(float(point.get("roofDisplacement", 0.0) or 0.0)) > 1e-12
        and abs(float(point.get("baseShear", 0.0) or 0.0)) > 1e-12
    ]
    if not positive_points:
        return None
    max_displacement = max(abs(float(point.get("roofDisplacement", 0.0) or 0.0)) for point in positive_points)
    if max_displacement <= 0.0:
        return None

    displacement = min(max(abs(float(initial_displacement or 0.0)), max_displacement * 0.10), max_displacement)
    tolerance = 1.0e-4
    history: List[Dict[str, Any]] = []
    converged = False
    current_alpha = 0.0
    current_period = 0.0
    demand_base_shear = 0.0
    for iteration in range(1, 21):
        capacity = _interpolate_curve_value(positive_points, displacement)
        capacity_base_shear = abs(float(capacity.get("baseShear", 0.0) or 0.0))
        secant_stiffness = capacity_base_shear / max(displacement, 1.0e-9)
        if secant_stiffness <= 0.0:
            break
        current_period = 2.0 * math.pi * math.sqrt(total_mass / secant_stiffness)
        current_alpha = seismic_influence_coefficient(current_period, basis)
        demand_base_shear = current_alpha * total_weight
        demand_point = _interpolate_curve_displacement_for_base_shear(positive_points, demand_base_shear)
        next_displacement = min(
            max(abs(float(demand_point.get("roofDisplacement", 0.0) or 0.0)), 1.0e-9),
            max_displacement,
        )
        residual = next_displacement - displacement
        history.append({
            "iteration": iteration,
            "roofDisplacementM": round(displacement, 8),
            "capacityBaseShearKN": round(capacity_base_shear, 6),
            "demandBaseShearKN": round(demand_base_shear, 6),
            "secantPeriodSec": round(current_period, 6),
            "alpha": round(current_alpha, 6),
            "nextRoofDisplacementM": round(next_displacement, 8),
            "residualM": round(residual, 8),
        })
        if abs(residual) <= max(tolerance * max_displacement, 1.0e-6):
            displacement = next_displacement
            converged = True
            break
        displacement = 0.5 * displacement + 0.5 * next_displacement

    performance = _interpolate_curve_value(positive_points, displacement)
    return {
        "status": "estimated",
        "method": "secant_capacity_spectrum_iteration",
        "converged": converged,
        "iterationCount": len(history),
        "roofDisplacementM": round(abs(float(performance.get("roofDisplacement", 0.0) or 0.0)), 8),
        "baseShearKN": round(abs(float(performance.get("baseShear", 0.0) or 0.0)), 6),
        "demandBaseShearKN": round(demand_base_shear, 6),
        "secantPeriodSec": round(current_period, 6),
        "alpha": round(current_alpha, 6),
        "totalWeightKN": round(total_weight, 6),
        "totalMass": round(total_mass, 6),
        "history": history,
        "limitations": [
            "Secant capacity-spectrum iteration on the computed pushover curve; not a full nonlinear performance-based design procedure.",
        ],
    }


def _capacity_assessment(
    curve: Sequence[Dict[str, Any]],
    *,
    target_displacement: float,
    max_height: float,
    parameters: Dict[str, Any],
    basis: Optional[SeismicDesignBasis] = None,
    floor_masses: Optional[Sequence[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    positive_points = [
        point for point in curve
        if abs(float(point.get("roofDisplacement", 0.0) or 0.0)) > 1e-12
    ]
    if not positive_points:
        return {
            "status": "unavailable",
            "warnings": ["Pushover curve has no positive displacement points for capacity assessment."],
        }
    first = positive_points[0]
    initial_stiffness = float(first.get("baseShear", 0.0) or 0.0) / max(abs(float(first.get("roofDisplacement", 0.0) or 0.0)), 1e-12)
    yield_point = None
    previous = positive_points[0]
    for point in positive_points[1:]:
        d0 = float(previous.get("roofDisplacement", 0.0) or 0.0)
        d1 = float(point.get("roofDisplacement", 0.0) or 0.0)
        if abs(d1 - d0) <= 1e-12:
            previous = point
            continue
        tangent = (float(point.get("baseShear", 0.0) or 0.0) - float(previous.get("baseShear", 0.0) or 0.0)) / (d1 - d0)
        if tangent < 0.80 * initial_stiffness:
            yield_point = {
                "roofDisplacement": round(abs(d1), 8),
                "baseShear": round(float(point.get("baseShear", 0.0) or 0.0), 6),
                "tangentStiffness": round(tangent, 6),
            }
            break
        previous = point
    max_displacement = max(abs(float(point.get("roofDisplacement", 0.0) or 0.0)) for point in curve)
    max_base_shear = max(abs(float(point.get("baseShear", 0.0) or 0.0)) for point in curve)
    capacity_spectrum_iteration = _capacity_spectrum_iteration(
        curve,
        basis=basis,
        floor_masses=floor_masses,
        initial_displacement=target_displacement,
    )
    explicit_performance_displacement = optional_number(
        parameters.get("performanceTargetDisplacement")
        or parameters.get("performancePointDisplacement")
    )
    performance_displacement = (
        explicit_performance_displacement
        or (
            optional_number(capacity_spectrum_iteration.get("roofDisplacementM"))
            if isinstance(capacity_spectrum_iteration, dict)
            else None
        )
        or target_displacement
    )
    performance = _interpolate_curve_value(curve, float(performance_displacement))
    drift_ratio = abs(performance["roofDisplacement"]) / max(max_height, 1e-9)
    performance_objective = _performance_objective(parameters)
    acceptance_drift = (
        optional_number(parameters.get("acceptanceDriftRatio"))
        or optional_number(performance_objective.get("acceptanceDriftRatio"))
        or 0.02
    )
    warnings: List[str] = []
    if yield_point is None:
        warnings.append("No post-yield stiffness degradation was detected; performance point is based on elastic pushover curve only.")
    return {
        "status": "estimated",
        "method": "capacity_spectrum_from_pushover_curve",
        "initialStiffnessKNPerM": round(initial_stiffness, 6),
        "yieldDetected": yield_point is not None,
        "yieldPoint": yield_point,
        "maxBaseShearKN": round(max_base_shear, 6),
        "maxRoofDisplacementM": round(max_displacement, 8),
        "capacitySpectrumIteration": capacity_spectrum_iteration,
        "performancePoint": {
            "roofDisplacementM": performance["roofDisplacement"],
            "baseShearKN": performance["baseShear"],
            "driftRatio": round(drift_ratio, 8),
            "source": (
                "structuredPerformanceTarget"
                if explicit_performance_displacement is not None
                else "secantCapacitySpectrumIteration"
                if capacity_spectrum_iteration
                else "targetDisplacement"
            ),
        },
        "acceptanceCheck": {
            "limitDriftRatio": round(float(acceptance_drift), 8),
            "status": "pass" if drift_ratio <= float(acceptance_drift) else "fail",
            "utilization": round(drift_ratio / max(float(acceptance_drift), 1e-12), 6),
            "basis": "structured performance objective or pushover.acceptanceDriftRatio; performance point from structured target or secant capacity-spectrum iteration",
            **({"performanceObjective": performance_objective} if performance_objective else {}),
        },
        "warnings": warnings,
    }


def _pushover_bilinear_parameters(
    *,
    capacity_assessment: Dict[str, Any],
    target_displacement: float,
    max_height: float,
    parameters: Dict[str, Any],
    basis: SeismicDesignBasis,
) -> Dict[str, Any]:
    initial_stiffness = optional_number(capacity_assessment.get("initialStiffnessKNPerM")) or 1.0
    yield_displacement = optional_number(
        parameters.get("yieldDisplacementM")
        or parameters.get("yieldDisplacement")
        or parameters.get("yieldRoofDisplacementM")
    )
    assumptions: List[str] = []
    yield_drift = optional_number(parameters.get("yieldDriftRatio") or parameters.get("yieldStoryDriftRatio"))
    yield_drift_metadata: Optional[Dict[str, Any]] = None
    if yield_displacement is None:
        if yield_drift is None:
            yield_drift_metadata = gb50011_advisory_yield_drift_metadata(getattr(basis, "structural_family", ""))
            yield_drift = float(yield_drift_metadata["limit"])
        yield_displacement = yield_drift * max(max_height, 1.0)
        if yield_drift_metadata is not None:
            assumptions.append(
                "No pushover yield drift was provided; used "
                f"{yield_drift_metadata['familyLabel']} elastic drift limit "
                f"1/{yield_drift_metadata['denominator']} as an advisory yield displacement."
            )
    post_yield_ratio = optional_number(
        parameters.get("postYieldStiffnessRatio")
        or parameters.get("hardeningRatio")
        or parameters.get("b")
    )
    if post_yield_ratio is None:
        post_yield_ratio = 0.03
        assumptions.append("No pushover post-yield stiffness ratio was provided; used 0.03 for the bilinear estimate.")
    performance_objective = _performance_objective(parameters)
    acceptance_drift = (
        optional_number(parameters.get("acceptanceDriftRatio"))
        or optional_number(performance_objective.get("acceptanceDriftRatio"))
        or 0.02
    )
    return {
        "initialStiffnessKNPerM": max(float(initial_stiffness), 1e-9),
        "yieldDisplacementM": max(float(yield_displacement or 0.0), 1e-9),
        "yieldBaseShearKN": max(float(initial_stiffness), 1e-9) * max(float(yield_displacement or 0.0), 1e-9),
        **({"yieldDriftRatio": float(yield_drift)} if yield_drift is not None else {}),
        **({
            "yieldDriftSource": yield_drift_metadata["source"],
            "yieldDriftLimitFamily": yield_drift_metadata["familyLabel"],
            "yieldDriftLimitRatioText": f"1/{yield_drift_metadata['denominator']}",
            "yieldDriftIsFallback": bool(yield_drift_metadata.get("isFallback")),
        } if yield_drift_metadata is not None else {}),
        "postYieldStiffnessRatio": max(float(post_yield_ratio or 0.0), 0.0),
        "targetDisplacementM": target_displacement,
        "acceptanceDriftRatio": float(acceptance_drift),
        "performanceObjective": performance_objective,
        "assumptions": assumptions,
    }
