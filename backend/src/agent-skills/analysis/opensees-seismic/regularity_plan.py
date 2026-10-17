"""Plan regularity checks: setback, aspect ratio, structured plan irregularity and torsion.

Split verbatim from ``regularity.py``, which re-exports these names.
"""

from __future__ import annotations

import math
from typing import Any, Dict, List, Optional, Sequence, Tuple
from seismic_contracts import as_record, optional_number

from regularity_common import (
    _bbox_area,
    _is_true,
    _material_elastic_modulus,
    _node_story_key,
    _node_value,
    _records_by_id,
    _section_inertia,
    _severity_max,
    _stories,
    _story_nodes_by_key,
)


def _plan_setback_checks(payload: Dict[str, Any]) -> Tuple[str, List[Dict[str, Any]], List[str]]:
    raw_nodes = payload.get("nodes")
    nodes = [node for node in raw_nodes if isinstance(node, dict)] if isinstance(raw_nodes, list) else []
    by_story: Dict[str, List[Dict[str, Any]]] = {}
    for node in nodes:
        key = _node_story_key(node)
        if key:
            by_story.setdefault(key, []).append(node)

    areas = [area for area in (_bbox_area(items) for items in by_story.values()) if area is not None and area > 0.0]
    if len(areas) < 2:
        return "unknown", [], ["Plan setback regularity was not assessed because story-level plan extents are unavailable."]

    min_ratio = min(min(areas[index], areas[index + 1]) / max(areas[index], areas[index + 1]) for index in range(len(areas) - 1))
    if min_ratio < 0.50:
        severity = "particularly_irregular"
    elif min_ratio < 0.75:
        severity = "irregular"
    else:
        severity = "regular"
    return severity, [{
        "name": "plan_setback_variation",
        "severity": severity,
        "value": round(min_ratio, 4),
        "irregularThreshold": 0.75,
        "particularlyIrregularThreshold": 0.50,
        "basis": "story-level node bounding-box area heuristic",
    }], []


def _plan_aspect_check(payload: Dict[str, Any]) -> Tuple[str, List[Dict[str, Any]], List[str]]:
    raw_nodes = payload.get("nodes")
    nodes = [node for node in raw_nodes if isinstance(node, dict)] if isinstance(raw_nodes, list) else []
    xs = [_node_value(node, "x") for node in nodes]
    ys = [_node_value(node, "y") for node in nodes]
    x_values = [value for value in xs if value is not None]
    y_values = [value for value in ys if value is not None]
    if len(x_values) < 2 or len(y_values) < 2:
        return "unknown", [], ["Plan aspect regularity was not assessed because node coordinates are insufficient."]
    width = max(x_values) - min(x_values)
    depth = max(y_values) - min(y_values)
    if width <= 0.0 or depth <= 0.0:
        return "unknown", [], ["Plan aspect regularity was not assessed because the plan extent is degenerate."]
    aspect = max(width, depth) / max(min(width, depth), 1e-9)
    severity = "irregular" if aspect > 6.0 else "regular"
    return severity, [{
        "name": "plan_aspect_ratio",
        "severity": severity,
        "value": round(aspect, 4),
        "irregularThreshold": 6.0,
        "basis": "overall node bounding-box aspect heuristic",
    }], []


def _structured_plan_irregularity_candidates(source: Dict[str, Any], source_name: str) -> Tuple[List[Dict[str, Any]], bool]:
    irregular_keys = (
        "hasPlanIrregularity",
        "planIrregularity",
        "hasReentrantCorner",
        "reentrantCorner",
        "hasReentrantCornerPlan",
        "hasConcavePlan",
        "concavePlan",
        "hasPlanConcavity",
        "planConcavity",
    )
    severe_keys = (
        "hasSeverePlanIrregularity",
        "severePlanIrregularity",
        "hasParticularlyIrregularPlan",
        "particularlyIrregularPlan",
        "planParticularlyIrregular",
        "planSevereIrregularity",
    )
    ratio_keys = (
        "reentrantCornerRatio",
        "planReentrantCornerRatio",
        "planConcavityRatio",
        "concavityRatio",
        "planIndentationRatio",
        "indentationRatio",
    )
    candidates: List[Dict[str, Any]] = []
    explicit_regular = False
    for key in severe_keys:
        if key not in source:
            continue
        if _is_true(source.get(key)):
            candidates.append({
                "source": f"{source_name}.{key}",
                "severity": "particularly_irregular",
                "value": True,
            })
        elif source.get(key) is False:
            explicit_regular = True

    for key in irregular_keys:
        if key not in source:
            continue
        if _is_true(source.get(key)):
            candidates.append({
                "source": f"{source_name}.{key}",
                "severity": "irregular",
                "value": True,
            })
        elif source.get(key) is False:
            explicit_regular = True

    for key in ratio_keys:
        value = optional_number(source.get(key))
        if value is None or value < 0.0:
            continue
        severity = "particularly_irregular" if value > 0.40 else "irregular" if value > 0.30 else "regular"
        candidates.append({
            "source": f"{source_name}.{key}",
            "severity": severity,
            "value": round(value, 6),
        })
    return candidates, explicit_regular


def _structured_plan_irregularity_checks(payload: Dict[str, Any], workflow: Dict[str, Any]) -> Tuple[str, List[Dict[str, Any]], List[str]]:
    sources = (
        ("seismicWorkflow.designRequirements", as_record(workflow.get("designRequirements"))),
        ("seismicWorkflow.structure", as_record(workflow.get("structure"))),
        ("seismicWorkflow.structureProfile", as_record(workflow.get("structureProfile"))),
        ("seismicWorkflow.regularityAssessment", as_record(workflow.get("regularityAssessment"))),
        ("model.metadata", as_record(payload.get("metadata"))),
        ("model.metadata.regularityAssessment", as_record(as_record(payload.get("metadata")).get("regularityAssessment"))),
    )
    candidates: List[Dict[str, Any]] = []
    explicit_regular = False
    for source_name, source in sources:
        source_candidates, source_regular = _structured_plan_irregularity_candidates(source, source_name)
        candidates.extend(source_candidates)
        explicit_regular = explicit_regular or source_regular

    story_candidates: List[Dict[str, Any]] = []
    for story in _stories(payload):
        story_id = str(story.get("id") or "").strip()
        extra = as_record(story.get("extra"))
        for source_name, source in (("stories[]", story), ("stories[].extra", extra)):
            source_candidates, source_regular = _structured_plan_irregularity_candidates(source, source_name)
            explicit_regular = explicit_regular or source_regular
            for item in source_candidates:
                story_candidates.append({
                    **item,
                    "story": story_id or f"story-{len(story_candidates) + 1}",
                })

    all_candidates = candidates + story_candidates
    if not all_candidates:
        if explicit_regular:
            return "regular", [{
                "name": "structured_plan_irregularity_flags",
                "severity": "regular",
                "value": False,
                "basis": "structured plan-irregularity flags or ratios",
            }], []
        return "unknown", [], ["Structured plan-irregularity flags were not assessed because comparable structured flags or ratios are unavailable."]

    severity = "regular"
    for item in all_candidates:
        severity = _severity_max(severity, str(item.get("severity") or "regular"))
    return severity, [{
        "name": "structured_plan_irregularity_flags",
        "severity": severity,
        "value": severity,
        "irregularThreshold": 0.30,
        "particularlyIrregularThreshold": 0.40,
        "triggers": all_candidates,
        "basis": "structured plan irregularity, reentrant-corner, or plan-concavity flags/ratios heuristic",
    }], []


def _plan_dimension(nodes: Sequence[Dict[str, Any]]) -> Optional[float]:
    xs = [_node_value(node, "x") for node in nodes]
    ys = [_node_value(node, "y") for node in nodes]
    x_values = [value for value in xs if value is not None]
    y_values = [value for value in ys if value is not None]
    if len(x_values) < 2 or len(y_values) < 2:
        return None
    width = max(x_values) - min(x_values)
    depth = max(y_values) - min(y_values)
    if width <= 0.0 or depth <= 0.0:
        return None
    return max(width, depth)


def _torsional_eccentricity_checks(payload: Dict[str, Any]) -> Tuple[str, List[Dict[str, Any]], List[str]]:
    nodes = _records_by_id(payload, "nodes")
    sections = _records_by_id(payload, "sections")
    materials = _records_by_id(payload, "materials")
    raw_elements = payload.get("elements")
    elements = [item for item in raw_elements if isinstance(item, dict)] if isinstance(raw_elements, list) else []
    story_nodes = _story_nodes_by_key(payload)
    story_column_stiffness: Dict[str, List[Dict[str, float]]] = {}
    missing_properties = 0

    for element in elements:
        if str(element.get("type") or "").strip().lower() != "column":
            continue
        element_nodes = element.get("nodes")
        if not isinstance(element_nodes, list) or len(element_nodes) < 2:
            continue
        i_node = nodes.get(str(element_nodes[0]))
        j_node = nodes.get(str(element_nodes[1]))
        if not i_node or not j_node:
            continue
        z_i = _node_value(i_node, "z")
        z_j = _node_value(j_node, "z")
        x_i = _node_value(i_node, "x")
        x_j = _node_value(j_node, "x")
        y_i = _node_value(i_node, "y")
        y_j = _node_value(j_node, "y")
        if None in {z_i, z_j, x_i, x_j, y_i, y_j}:
            continue
        height = abs(float(z_j) - float(z_i))
        if height <= 0.0:
            continue
        upper_node = j_node if float(z_j) >= float(z_i) else i_node
        story_key = (
            str(element.get("story")).strip()
            if str(element.get("story") or "").strip()
            else _node_story_key(upper_node)
        )
        if not story_key:
            continue
        section = sections.get(str(element.get("section")))
        inertia = _section_inertia(section) if section else None
        material = materials.get(str(element.get("material")))
        elastic_modulus = _material_elastic_modulus(material) if material else None
        if inertia is None:
            missing_properties += 1
            continue
        stiffness = 12.0 * float(elastic_modulus or 1.0) * inertia / height ** 3
        story_column_stiffness.setdefault(story_key, []).append({
            "x": float(x_i + x_j) / 2.0,
            "y": float(y_i + y_j) / 2.0,
            "stiffness": stiffness,
        })

    story_results: List[Dict[str, Any]] = []
    assumptions: List[str] = []
    for story, nodes_at_story in story_nodes.items():
        plan_dimension = _plan_dimension(nodes_at_story)
        columns = story_column_stiffness.get(story, [])
        if plan_dimension is None or len(columns) < 2:
            continue
        x_values = [_node_value(node, "x") for node in nodes_at_story]
        y_values = [_node_value(node, "y") for node in nodes_at_story]
        xs = [float(value) for value in x_values if value is not None]
        ys = [float(value) for value in y_values if value is not None]
        mass_x = sum(xs) / len(xs)
        mass_y = sum(ys) / len(ys)
        total_stiffness = sum(item["stiffness"] for item in columns)
        if total_stiffness <= 0.0:
            continue
        stiffness_x = sum(item["x"] * item["stiffness"] for item in columns) / total_stiffness
        stiffness_y = sum(item["y"] * item["stiffness"] for item in columns) / total_stiffness
        eccentricity = math.hypot(mass_x - stiffness_x, mass_y - stiffness_y)
        eccentricity_ratio = eccentricity / max(plan_dimension, 1e-9)
        story_results.append({
            "story": story,
            "eccentricityRatio": round(eccentricity_ratio, 4),
            "eccentricityM": round(eccentricity, 4),
            "massCenter": {"x": round(mass_x, 4), "y": round(mass_y, 4)},
            "stiffnessCenter": {"x": round(stiffness_x, 4), "y": round(stiffness_y, 4)},
        })

    if missing_properties:
        assumptions.append("Plan torsional eccentricity check skipped column elements with missing section inertia.")
    if not story_results:
        assumptions.append("Plan torsional eccentricity regularity was not assessed because story plan coordinates or column stiffness data are insufficient.")
        return "unknown", [], assumptions

    max_ratio = max(float(item["eccentricityRatio"]) for item in story_results)
    if max_ratio > 0.30:
        severity = "particularly_irregular"
    elif max_ratio > 0.15:
        severity = "irregular"
    else:
        severity = "regular"
    return severity, [{
        "name": "plan_torsional_eccentricity",
        "severity": severity,
        "value": round(max_ratio, 4),
        "irregularThreshold": 0.15,
        "particularlyIrregularThreshold": 0.30,
        "storyEccentricities": story_results,
        "basis": "distance between story node centroid as mass-center proxy and column-stiffness center divided by max plan dimension",
    }], assumptions


def _torsional_ratio_candidates(source: Dict[str, Any], source_name: str) -> List[Dict[str, Any]]:
    scalar_keys = (
        "torsionalDisplacementRatio",
        "torsionalIrregularityRatio",
        "maxDisplacementAverageRatio",
        "maxDisplacementToAverageRatio",
        "maxToAverageDisplacementRatio",
        "maxStoryDisplacementToAverageRatio",
        "maxFloorDisplacementToAverageRatio",
    )
    candidates: List[Dict[str, Any]] = []
    for key in scalar_keys:
        value = optional_number(source.get(key))
        if value is not None and value > 0.0:
            candidates.append({
                "source": f"{source_name}.{key}",
                "ratio": value,
            })

    nested_keys = (
        "torsionalDisplacementRatios",
        "torsionalDisplacementRatioByDirection",
        "torsionalIrregularityRatios",
        "maxDisplacementToAverageRatios",
    )
    component_keys = ("x", "y", "X", "Y", "ratioX", "ratioY", "xRatio", "yRatio")
    for key in nested_keys:
        nested = source.get(key)
        if isinstance(nested, dict):
            for component_key in component_keys:
                value = optional_number(nested.get(component_key))
                if value is not None and value > 0.0:
                    candidates.append({
                        "source": f"{source_name}.{key}.{component_key}",
                        "ratio": value,
                        "direction": str(component_key).replace("Ratio", "").replace("ratio", "").lower() or None,
                    })
        elif isinstance(nested, list):
            for index, item in enumerate(nested):
                if not isinstance(item, dict):
                    continue
                value = optional_number(item.get("ratio")) or optional_number(item.get("value"))
                if value is not None and value > 0.0:
                    candidates.append({
                        "source": f"{source_name}.{key}[{index}]",
                        "ratio": value,
                        **({"direction": str(item.get("direction"))} if item.get("direction") else {}),
                    })
    return candidates


def _structured_torsional_displacement_ratio_checks(payload: Dict[str, Any], workflow: Dict[str, Any]) -> Tuple[str, List[Dict[str, Any]], List[str]]:
    sources = (
        ("seismicWorkflow.designRequirements", as_record(workflow.get("designRequirements"))),
        ("seismicWorkflow.structure", as_record(workflow.get("structure"))),
        ("seismicWorkflow.structureProfile", as_record(workflow.get("structureProfile"))),
        ("seismicWorkflow.regularityAssessment", as_record(workflow.get("regularityAssessment"))),
        ("model.metadata", as_record(payload.get("metadata"))),
        ("model.metadata.regularityAssessment", as_record(as_record(payload.get("metadata")).get("regularityAssessment"))),
    )
    candidates: List[Dict[str, Any]] = []
    for source_name, source in sources:
        candidates.extend(_torsional_ratio_candidates(source, source_name))

    story_ratios: List[Dict[str, Any]] = []
    for story in _stories(payload):
        story_id = str(story.get("id") or "").strip()
        extra = as_record(story.get("extra"))
        for source_name, source in (("stories[]", story), ("stories[].extra", extra)):
            for candidate in _torsional_ratio_candidates(source, source_name):
                story_ratios.append({
                    **candidate,
                    "story": story_id or f"story-{len(story_ratios) + 1}",
                })

    all_candidates = candidates + story_ratios
    if not all_candidates:
        return "unknown", [], ["Structured torsional displacement-ratio regularity was not assessed because comparable ratio data is unavailable."]

    max_ratio = max(float(item["ratio"]) for item in all_candidates)
    if max_ratio > 1.40:
        severity = "particularly_irregular"
    elif max_ratio > 1.20:
        severity = "irregular"
    else:
        severity = "regular"
    return severity, [{
        "name": "structured_torsional_displacement_ratio",
        "severity": severity,
        "value": round(max_ratio, 4),
        "irregularThreshold": 1.20,
        "particularlyIrregularThreshold": 1.40,
        "ratios": [
            {
                **item,
                "ratio": round(float(item["ratio"]), 6),
            }
            for item in all_candidates
        ],
        "basis": "structured max story displacement to average displacement ratio heuristic",
    }], []
