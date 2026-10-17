"""Lateral stiffness/strength, weak/soft story and vertical lateral-system discontinuity checks.

Split verbatim from ``regularity.py``, which re-exports these names.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Sequence, Tuple
from seismic_contracts import as_record, optional_number

from regularity_common import (
    _is_true,
    _material_elastic_modulus,
    _node_story_key,
    _node_value,
    _records_by_id,
    _section_inertia,
    _stories,
)


def _structured_story_lateral_stiffness_value(story: Dict[str, Any]) -> Tuple[Optional[float], Optional[str]]:
    extra = as_record(story.get("extra"))
    scalar_keys = (
        "lateralStiffnessKNPerM",
        "storyLateralStiffnessKNPerM",
        "storyStiffnessKNPerM",
        "lateralStiffness",
        "storyLateralStiffness",
        "storyStiffness",
        "lateralStiffnessK",
        "storyStiffnessK",
    )
    for source_name, source in (("stories[]", story), ("stories[].extra", extra)):
        for key in scalar_keys:
            value = optional_number(source.get(key))
            if value is not None and value > 0.0:
                return value, f"{source_name}.{key}"

    nested_keys = (
        "lateralStiffness",
        "storyLateralStiffness",
        "storyStiffness",
        "stiffness",
        "directionalLateralStiffness",
    )
    component_keys = (
        "x",
        "y",
        "kx",
        "ky",
        "Kx",
        "Ky",
        "xKNPerM",
        "yKNPerM",
        "KxKNPerM",
        "KyKNPerM",
        "stiffnessXKNPerM",
        "stiffnessYKNPerM",
    )
    for source_name, source in (("stories[]", story), ("stories[].extra", extra)):
        for key in nested_keys:
            nested = as_record(source.get(key))
            values = [
                value
                for value in (optional_number(nested.get(component_key)) for component_key in component_keys)
                if value is not None and value > 0.0
            ]
            if values:
                return min(values), f"{source_name}.{key}"
    return None, None


def _structured_story_lateral_stiffness_checks(stories: Sequence[Dict[str, Any]]) -> Tuple[str, List[Dict[str, Any]], List[str]]:
    stiffnesses: List[Dict[str, Any]] = []
    missing = 0
    for story in stories:
        story_id = str(story.get("id") or f"F{len(stiffnesses) + missing + 1}").strip()
        stiffness, source = _structured_story_lateral_stiffness_value(story)
        if stiffness is None:
            missing += 1
            continue
        stiffnesses.append({
            "story": story_id,
            "stiffnessKNPerM": stiffness,
            "source": source,
        })

    assumptions: List[str] = []
    if missing:
        assumptions.append("Structured story lateral-stiffness regularity skipped stories without structured stiffness data.")
    if len(stiffnesses) < 2:
        assumptions.append("Structured story lateral-stiffness regularity was not assessed because fewer than two structured story stiffnesses are available.")
        return "unknown", [], assumptions

    values = [float(item["stiffnessKNPerM"]) for item in stiffnesses]
    adjacent_ratios = [
        min(values[index], values[index + 1]) / max(values[index], values[index + 1])
        for index in range(len(values) - 1)
    ]
    min_ratio = min(adjacent_ratios, default=1.0)
    if min_ratio < 0.50:
        severity = "particularly_irregular"
    elif min_ratio < 0.70:
        severity = "irregular"
    else:
        severity = "regular"
    max_stiffness = max(values)
    return severity, [{
        "name": "structured_story_lateral_stiffness_variation",
        "severity": severity,
        "value": round(min_ratio, 4),
        "irregularThreshold": 0.70,
        "particularlyIrregularThreshold": 0.50,
        "storyStiffness": [
            {
                **item,
                "stiffnessKNPerM": round(float(item["stiffnessKNPerM"]), 6),
                "relativeStiffness": round(float(item["stiffnessKNPerM"]) / max(max_stiffness, 1e-9), 4),
            }
            for item in stiffnesses
        ],
        "basis": "structured story lateral stiffness adjacent-story ratio heuristic",
    }], assumptions


def _story_lateral_stiffness_checks(payload: Dict[str, Any]) -> Tuple[str, List[Dict[str, Any]], List[str]]:
    nodes = _records_by_id(payload, "nodes")
    sections = _records_by_id(payload, "sections")
    materials = _records_by_id(payload, "materials")
    raw_elements = payload.get("elements")
    elements = [item for item in raw_elements if isinstance(item, dict)] if isinstance(raw_elements, list) else []

    story_stiffness: Dict[str, float] = {}
    story_elevation: Dict[str, float] = {}
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
        if z_i is None or z_j is None:
            continue
        height = abs(z_j - z_i)
        if height <= 0.0:
            continue

        upper_node = j_node if z_j >= z_i else i_node
        upper_z = max(z_i, z_j)
        story_key = (
            str(element.get("story")).strip()
            if str(element.get("story") or "").strip()
            else _node_story_key(upper_node)
        )
        if not story_key:
            story_key = f"z={round(upper_z, 4)}"

        section = sections.get(str(element.get("section")))
        inertia = _section_inertia(section) if section else None
        material = materials.get(str(element.get("material")))
        elastic_modulus = _material_elastic_modulus(material) if material else None
        if inertia is None:
            missing_properties += 1
            continue
        story_stiffness[story_key] = story_stiffness.get(story_key, 0.0) + 12.0 * float(elastic_modulus or 1.0) * inertia / height ** 3
        story_elevation[story_key] = upper_z

    ordered = [
        (story, stiffness)
        for story, stiffness in sorted(story_stiffness.items(), key=lambda item: story_elevation.get(item[0], 0.0))
        if stiffness > 0.0
    ]
    assumptions: List[str] = []
    if missing_properties:
        assumptions.append("Story lateral stiffness check skipped column elements with missing section inertia.")
    if len(ordered) < 2:
        assumptions.append("Story lateral stiffness regularity was not assessed because fewer than two column-supported stories are available.")
        return "unknown", [], assumptions

    adjacent_ratios = [
        min(ordered[index][1], ordered[index + 1][1]) / max(ordered[index][1], ordered[index + 1][1])
        for index in range(len(ordered) - 1)
    ]
    min_ratio = min(adjacent_ratios, default=1.0)
    if min_ratio < 0.50:
        severity = "particularly_irregular"
    elif min_ratio < 0.70:
        severity = "irregular"
    else:
        severity = "regular"
    max_stiffness = max(stiffness for _, stiffness in ordered)
    return severity, [{
        "name": "story_lateral_stiffness_variation",
        "severity": severity,
        "value": round(min_ratio, 4),
        "irregularThreshold": 0.70,
        "particularlyIrregularThreshold": 0.50,
        "storyStiffness": [
            {"story": story, "relativeStiffness": round(stiffness / max_stiffness, 4)}
            for story, stiffness in ordered
        ],
        "basis": "sum(12*E*I/h^3) over structured column elements",
    }], assumptions


def _story_lateral_strength_value(story: Dict[str, Any]) -> Tuple[Optional[float], Optional[str]]:
    extra = as_record(story.get("extra"))
    scalar_keys = (
        "lateralStrengthKN",
        "storyLateralStrengthKN",
        "storyShearCapacityKN",
        "storyLateralCapacityKN",
        "seismicShearCapacityKN",
        "shearCapacityKN",
        "ultimateStoryShearKN",
    )
    for source_name, source in (("stories[]", story), ("stories[].extra", extra)):
        for key in scalar_keys:
            value = optional_number(source.get(key))
            if value is not None and value > 0.0:
                return value, f"{source_name}.{key}"

    nested_keys = (
        "lateralStrength",
        "storyLateralStrength",
        "storyShearCapacity",
        "storyLateralCapacity",
        "seismicShearCapacity",
    )
    component_keys = (
        "x",
        "y",
        "vx",
        "vy",
        "Vx",
        "Vy",
        "xKN",
        "yKN",
        "VxKN",
        "VyKN",
        "capacityXKN",
        "capacityYKN",
    )
    for source_name, source in (("stories[]", story), ("stories[].extra", extra)):
        for key in nested_keys:
            nested = as_record(source.get(key))
            values = [
                value
                for value in (optional_number(nested.get(component_key)) for component_key in component_keys)
                if value is not None and value > 0.0
            ]
            if values:
                return min(values), f"{source_name}.{key}"
    return None, None


def _story_lateral_strength_checks(stories: Sequence[Dict[str, Any]]) -> Tuple[str, List[Dict[str, Any]], List[str]]:
    strengths: List[Dict[str, Any]] = []
    missing = 0
    for story in stories:
        story_id = str(story.get("id") or f"F{len(strengths) + missing + 1}").strip()
        strength, source = _story_lateral_strength_value(story)
        if strength is None:
            missing += 1
            continue
        strengths.append({
            "story": story_id,
            "strengthKN": strength,
            "source": source,
        })

    assumptions: List[str] = []
    if missing:
        assumptions.append("Story lateral-strength regularity skipped stories without structured story strength/capacity data.")
    if len(strengths) < 2:
        assumptions.append("Story lateral-strength regularity was not assessed because fewer than two structured story strengths are available.")
        return "unknown", [], assumptions

    values = [float(item["strengthKN"]) for item in strengths]
    adjacent_ratios = [
        min(values[index], values[index + 1]) / max(values[index], values[index + 1])
        for index in range(len(values) - 1)
    ]
    min_ratio = min(adjacent_ratios, default=1.0)
    if min_ratio < 0.65:
        severity = "particularly_irregular"
    elif min_ratio < 0.80:
        severity = "irregular"
    else:
        severity = "regular"
    max_strength = max(values)
    return severity, [{
        "name": "story_lateral_strength_variation",
        "severity": severity,
        "value": round(min_ratio, 4),
        "irregularThreshold": 0.80,
        "particularlyIrregularThreshold": 0.65,
        "storyStrengths": [
            {
                **item,
                "strengthKN": round(float(item["strengthKN"]), 6),
                "relativeStrength": round(float(item["strengthKN"]) / max(max_strength, 1e-9), 4),
            }
            for item in strengths
        ],
        "basis": "structured story lateral strength/capacity adjacent-story ratio heuristic",
    }], assumptions


def _vertical_lateral_system_discontinuity_checks(payload: Dict[str, Any], workflow: Dict[str, Any]) -> Tuple[str, List[Dict[str, Any]], List[str]]:
    requirement_sources = (
        ("seismicWorkflow.designRequirements", as_record(workflow.get("designRequirements"))),
        ("seismicWorkflow.structure", as_record(workflow.get("structure"))),
        ("seismicWorkflow.structureProfile", as_record(workflow.get("structureProfile"))),
        ("model.metadata", as_record(payload.get("metadata"))),
    )
    trigger_keys = (
        "hasTransferStory",
        "hasTransferLevel",
        "hasFrameSupportedWall",
        "hasDiscontinuousVerticalMember",
        "hasVerticalLateralSystemDiscontinuity",
        "verticalLateralSystemDiscontinuity",
    )
    triggers: List[Dict[str, Any]] = []
    explicit_regular = False
    for source_name, source in requirement_sources:
        for key in trigger_keys:
            if key not in source:
                continue
            if _is_true(source.get(key)):
                triggers.append({
                    "source": f"{source_name}.{key}",
                    "value": True,
                })
            elif source.get(key) is False:
                explicit_regular = True

    story_triggers: List[Dict[str, Any]] = []
    for story in _stories(payload):
        extra = as_record(story.get("extra"))
        story_id = str(story.get("id") or "").strip()
        for key in trigger_keys:
            if _is_true(extra.get(key)) or _is_true(story.get(key)):
                story_triggers.append({
                    "story": story_id or f"story-{len(story_triggers) + 1}",
                    "source": f"stories[].{key}",
                })

    element_type_aliases = {
        "transfer-beam",
        "transfer-column",
        "transfer-girder",
        "frame-supported-wall",
        "frame-supported-column",
        "discontinuous-wall",
        "discontinuous-column",
    }
    raw_elements = payload.get("elements")
    elements = [item for item in raw_elements if isinstance(item, dict)] if isinstance(raw_elements, list) else []
    element_triggers: List[Dict[str, Any]] = []
    for element in elements:
        element_type = str(element.get("type") or "").strip().lower()
        metadata = as_record(element.get("metadata"))
        if element_type in element_type_aliases or any(_is_true(metadata.get(key)) for key in trigger_keys):
            element_triggers.append({
                "elementId": str(element.get("id") or ""),
                "type": element_type,
            })

    if not triggers and not story_triggers and not element_triggers:
        if explicit_regular:
            return "regular", [{
                "name": "vertical_lateral_system_discontinuity",
                "severity": "regular",
                "value": False,
                "basis": "structured transfer-story/discontinuous vertical member flags",
            }], []
        return "unknown", [], ["Vertical lateral-system discontinuity regularity was not assessed because structured transfer/discontinuity flags are unavailable."]

    return "particularly_irregular", [{
        "name": "vertical_lateral_system_discontinuity",
        "severity": "particularly_irregular",
        "value": True,
        "triggers": triggers,
        "storyTriggers": story_triggers,
        "elementTriggers": element_triggers,
        "basis": "structured transfer-story or discontinuous vertical lateral-resisting member flags",
    }], []


def _explicit_weak_soft_story_checks(payload: Dict[str, Any], workflow: Dict[str, Any]) -> Tuple[str, List[Dict[str, Any]], List[str]]:
    requirement_sources = (
        ("seismicWorkflow.designRequirements", as_record(workflow.get("designRequirements"))),
        ("seismicWorkflow.structure", as_record(workflow.get("structure"))),
        ("seismicWorkflow.structureProfile", as_record(workflow.get("structureProfile"))),
        ("model.metadata", as_record(payload.get("metadata"))),
    )
    trigger_keys = (
        "hasWeakStory",
        "hasSoftStory",
        "hasWeakOrSoftStory",
        "isWeakStory",
        "isSoftStory",
        "isWeakOrSoftStory",
        "weakStory",
        "softStory",
        "weakOrSoftStory",
        "storyStrengthDiscontinuity",
        "storyStiffnessDiscontinuity",
    )
    triggers: List[Dict[str, Any]] = []
    explicit_regular = False
    for source_name, source in requirement_sources:
        for key in trigger_keys:
            if key not in source:
                continue
            if _is_true(source.get(key)):
                triggers.append({
                    "source": f"{source_name}.{key}",
                    "value": True,
                })
            elif source.get(key) is False:
                explicit_regular = True

    story_triggers: List[Dict[str, Any]] = []
    for story in _stories(payload):
        extra = as_record(story.get("extra"))
        story_id = str(story.get("id") or "").strip()
        for key in trigger_keys:
            if _is_true(extra.get(key)) or _is_true(story.get(key)):
                story_triggers.append({
                    "story": story_id or f"story-{len(story_triggers) + 1}",
                    "source": f"stories[].{key}",
                })

    if not triggers and not story_triggers:
        if explicit_regular:
            return "regular", [{
                "name": "explicit_weak_soft_story",
                "severity": "regular",
                "value": False,
                "basis": "structured weak/soft story flags",
            }], []
        return "unknown", [], ["Weak/soft story regularity was not assessed because structured flags are unavailable."]

    return "particularly_irregular", [{
        "name": "explicit_weak_soft_story",
        "severity": "particularly_irregular",
        "value": True,
        "triggers": triggers,
        "storyTriggers": story_triggers,
        "basis": "structured weak-story, soft-story, or story strength/stiffness discontinuity flags",
    }], []
