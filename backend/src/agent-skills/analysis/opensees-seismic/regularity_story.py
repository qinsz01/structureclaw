"""Vertical regularity checks from story data: height, load, mass and floor-diaphragm openings.

Split verbatim from ``regularity.py``, which re-exports these names.
"""

from __future__ import annotations

import math
from typing import Any, Dict, List, Optional, Sequence, Tuple
from seismic_contracts import as_record, optional_number

from regularity_common import (
    G_ACCEL,
    _bbox_area,
    _stories,
    _story_nodes_by_key,
)


def _story_height_checks(stories: Sequence[Dict[str, Any]]) -> Tuple[str, List[Dict[str, Any]], List[str]]:
    heights = [optional_number(story.get("height")) for story in stories]
    values = [height for height in heights if height is not None and height > 0.0]
    if len(values) < 2:
        return "unknown", [], ["Story-height regularity was not assessed because fewer than two story heights are available."]

    sorted_values = sorted(values)
    median = sorted_values[len(sorted_values) // 2]
    max_to_median = max(values) / median if median > 0.0 else 1.0
    adjacent_ratios = [
        max(values[index], values[index + 1]) / max(min(values[index], values[index + 1]), 1e-9)
        for index in range(len(values) - 1)
    ]
    max_adjacent = max(adjacent_ratios, default=1.0)
    ratio = max(max_to_median, max_adjacent)
    if ratio > 1.50:
        severity = "particularly_irregular"
    elif ratio > 1.20:
        severity = "irregular"
    else:
        severity = "regular"
    return severity, [{
        "name": "story_height_variation",
        "severity": severity,
        "value": round(ratio, 4),
        "irregularThreshold": 1.20,
        "particularlyIrregularThreshold": 1.50,
        "basis": "model.stories[].height heuristic",
    }], []


def _story_load_value(story: Dict[str, Any]) -> Optional[float]:
    dead = optional_number(story.get("dead_load"))
    live = optional_number(story.get("live_load"))
    if dead is not None or live is not None:
        return float(dead or 0.0) + 0.5 * float(live or 0.0)
    floor_loads = story.get("floor_loads")
    if not isinstance(floor_loads, list):
        return None
    total = 0.0
    found = False
    for load in floor_loads:
        if not isinstance(load, dict):
            continue
        value = optional_number(load.get("value"))
        if value is None:
            continue
        load_type = str(load.get("type") or "other").strip().lower()
        factor = 0.5 if load_type == "live" else 1.0
        total += factor * value
        found = True
    return total if found else None


def _story_load_checks(stories: Sequence[Dict[str, Any]]) -> Tuple[str, List[Dict[str, Any]], List[str]]:
    values = [_story_load_value(story) for story in stories]
    loads = [value for value in values if value is not None and value > 0.0]
    if len(loads) < 2:
        return "unknown", [], ["Story mass/load regularity was not assessed because floor load data is insufficient."]

    adjacent_ratios = [
        max(loads[index], loads[index + 1]) / max(min(loads[index], loads[index + 1]), 1e-9)
        for index in range(len(loads) - 1)
    ]
    ratio = max(adjacent_ratios, default=1.0)
    if ratio > 2.00:
        severity = "particularly_irregular"
    elif ratio > 1.50:
        severity = "irregular"
    else:
        severity = "regular"
    return severity, [{
        "name": "story_load_variation",
        "severity": severity,
        "value": round(ratio, 4),
        "irregularThreshold": 1.50,
        "particularlyIrregularThreshold": 2.00,
        "basis": "model.stories floor loads heuristic using dead + 0.5 live",
    }], []


def _explicit_story_weight(story: Dict[str, Any]) -> Tuple[Optional[float], Optional[str]]:
    extra = as_record(story.get("extra"))
    for key in ("seismicWeightKN", "representativeWeightKN", "gravityWeightKN", "weightKN"):
        value = optional_number(extra.get(key))
        if value is not None and value > 0.0:
            return value, f"stories[].extra.{key}"

    for key in ("massT", "massTon", "massTonne"):
        mass_t = optional_number(extra.get(key))
        if mass_t is not None and mass_t > 0.0:
            return mass_t * G_ACCEL, f"stories[].extra.{key}"

    mass_kg = optional_number(extra.get("massKg"))
    if mass_kg is not None and mass_kg > 0.0:
        return mass_kg / 1000.0 * G_ACCEL, "stories[].extra.massKg"

    return None, None


def _story_nodes(story: Dict[str, Any], by_story: Dict[str, List[Dict[str, Any]]]) -> List[Dict[str, Any]]:
    story_id = str(story.get("id") or "").strip()
    if story_id and story_id in by_story:
        return by_story[story_id]

    keys: List[str] = []
    elevation = optional_number(story.get("elevation"))
    height = optional_number(story.get("height"))
    if elevation is not None and height is not None:
        keys.append(f"z={round(elevation + height, 4)}")
    if elevation is not None:
        keys.append(f"z={round(elevation, 4)}")
    for key in keys:
        if key in by_story:
            return by_story[key]
    return []


def _story_plan_area(story: Dict[str, Any], nodes: Sequence[Dict[str, Any]]) -> Tuple[Optional[float], Optional[str]]:
    extra = as_record(story.get("extra"))
    for key in ("planAreaM2", "floorAreaM2", "tributaryAreaM2"):
        area = optional_number(extra.get(key))
        if area is not None and area > 0.0:
            return area, f"stories[].extra.{key}"

    area = _bbox_area(nodes)
    if area is not None and area > 0.0:
        return area, "story node bounding-box area"
    return None, None


def _story_mass_checks(payload: Dict[str, Any]) -> Tuple[str, List[Dict[str, Any]], List[str]]:
    stories = _stories(payload)
    if len(stories) < 2:
        return "unknown", [], ["Story-mass regularity was not assessed because fewer than two stories are available."]

    by_story = _story_nodes_by_key(payload)
    weights: List[Dict[str, Any]] = []
    missing = 0
    for story in stories:
        story_id = str(story.get("id") or f"F{len(weights) + missing + 1}").strip()
        explicit_weight, explicit_source = _explicit_story_weight(story)
        if explicit_weight is not None:
            weights.append({
                "story": story_id,
                "weightKN": explicit_weight,
                "source": explicit_source,
            })
            continue

        load = _story_load_value(story)
        nodes = _story_nodes(story, by_story)
        area, area_source = _story_plan_area(story, nodes)
        if load is None or load <= 0.0 or area is None or area <= 0.0:
            missing += 1
            continue
        weights.append({
            "story": story_id,
            "weightKN": load * area,
            "source": f"floor load * {area_source}",
            "planAreaM2": area,
        })

    assumptions: List[str] = []
    if missing:
        assumptions.append("Story-mass regularity skipped stories without explicit weight/mass or enough floor-load and plan-area data.")
    if len(weights) < 2:
        assumptions.append("Story-mass regularity was not assessed because fewer than two structured story weights could be inferred.")
        return "unknown", [], assumptions

    weight_values = [float(item["weightKN"]) for item in weights]
    adjacent_ratios = [
        max(weight_values[index], weight_values[index + 1]) / max(min(weight_values[index], weight_values[index + 1]), 1e-9)
        for index in range(len(weight_values) - 1)
    ]
    ratio = max(adjacent_ratios, default=1.0)
    if ratio > 2.00:
        severity = "particularly_irregular"
    elif ratio > 1.50:
        severity = "irregular"
    else:
        severity = "regular"
    return severity, [{
        "name": "story_mass_variation",
        "severity": severity,
        "value": round(ratio, 4),
        "irregularThreshold": 1.50,
        "particularlyIrregularThreshold": 2.00,
        "storyWeights": [
            {
                **item,
                "weightKN": round(float(item["weightKN"]), 6),
                **({"planAreaM2": round(float(item["planAreaM2"]), 6)} if "planAreaM2" in item else {}),
            }
            for item in weights
        ],
        "basis": "structured story weight/mass or floor load multiplied by story plan area heuristic",
    }], assumptions


def _slab_opening_area(opening: Dict[str, Any]) -> Optional[float]:
    width = optional_number(opening.get("width"))
    depth = optional_number(opening.get("depth"))
    if width is None or depth is None or width <= 0.0 or depth <= 0.0:
        return None
    shape = str(opening.get("shape") or "rectangular").strip().lower()
    if shape == "circular":
        return math.pi * (width / 2.0) * (depth / 2.0)
    return width * depth


def _story_opening_records(story: Dict[str, Any]) -> List[Dict[str, Any]]:
    extra = as_record(story.get("extra"))
    records: List[Dict[str, Any]] = []
    for source in (story, extra):
        for key in ("slab_openings", "slabOpenings", "floorOpenings", "diaphragmOpenings", "openings"):
            raw = source.get(key)
            if isinstance(raw, list):
                records.extend(item for item in raw if isinstance(item, dict))
    return records


def _story_opening_area(story: Dict[str, Any]) -> Tuple[Optional[float], Optional[str]]:
    extra = as_record(story.get("extra"))
    for source_name, source in (("stories[]", story), ("stories[].extra", extra)):
        for key in ("slabOpeningAreaM2", "openingAreaM2", "floorOpeningAreaM2", "diaphragmOpeningAreaM2"):
            value = optional_number(source.get(key))
            if value is not None and value >= 0.0:
                return value, f"{source_name}.{key}"
    return None, None


def _story_opening_ratio(story: Dict[str, Any]) -> Tuple[Optional[float], Optional[str]]:
    extra = as_record(story.get("extra"))
    for source_name, source in (("stories[]", story), ("stories[].extra", extra)):
        for key in ("slabOpeningRatio", "openingRatio", "floorOpeningRatio", "diaphragmOpeningRatio"):
            value = optional_number(source.get(key))
            if value is not None and value >= 0.0:
                return value, f"{source_name}.{key}"
    return None, None


def _floor_diaphragm_discontinuity_checks(payload: Dict[str, Any]) -> Tuple[str, List[Dict[str, Any]], List[str]]:
    stories = _stories(payload)
    raw_openings = payload.get("slab_openings")
    openings = [item for item in raw_openings if isinstance(item, dict)] if isinstance(raw_openings, list) else []
    if not stories and not openings:
        return "unknown", [], ["Floor-diaphragm discontinuity was not assessed because story and slab-opening data are unavailable."]

    openings_by_story: Dict[str, List[Dict[str, Any]]] = {}
    for opening in openings:
        story_id = str(opening.get("story_id") or opening.get("storyId") or "").strip()
        if story_id:
            openings_by_story.setdefault(story_id, []).append(opening)

    by_story_nodes = _story_nodes_by_key(payload)
    story_results: List[Dict[str, Any]] = []
    missing_area = 0
    for story in stories:
        story_id = str(story.get("id") or "").strip()
        if not story_id:
            continue
        story_openings = openings_by_story.get(story_id, []) + _story_opening_records(story)
        record_opening_area = sum(
            area
            for area in (_slab_opening_area(opening) for opening in story_openings)
            if area is not None and area > 0.0
        )
        direct_opening_area, direct_area_source = _story_opening_area(story)
        opening_area = record_opening_area + float(direct_opening_area or 0.0)
        direct_opening_ratio, direct_ratio_source = _story_opening_ratio(story)
        nodes = _story_nodes(story, by_story_nodes)
        plan_area, area_source = _story_plan_area(story, nodes)
        rigid_diaphragm = story.get("rigid_diaphragm")
        if opening_area <= 0.0 and direct_opening_ratio is None and rigid_diaphragm is not False:
            continue
        if direct_opening_ratio is None and (plan_area is None or plan_area <= 0.0):
            missing_area += 1
            continue
        opening_ratio = (
            float(direct_opening_ratio)
            if direct_opening_ratio is not None
            else opening_area / float(plan_area or 1.0)
        )
        rigid_value = rigid_diaphragm if isinstance(rigid_diaphragm, bool) else None
        story_results.append({
            "story": story_id,
            "openingAreaM2": round(opening_area, 6),
            **({"openingAreaSource": direct_area_source} if direct_area_source else {}),
            **({"openingRatioSource": direct_ratio_source} if direct_ratio_source else {}),
            **({"planAreaM2": round(float(plan_area), 6)} if plan_area is not None and plan_area > 0.0 else {}),
            "openingRatio": round(opening_ratio, 4),
            "openingCount": len(story_openings),
            "rigidDiaphragm": rigid_value,
            "planAreaSource": area_source,
        })

    assumptions: List[str] = []
    if missing_area:
        assumptions.append("Floor-diaphragm discontinuity skipped stories with openings or non-rigid diaphragm flags but no plan area.")
    if not story_results:
        if openings:
            assumptions.append("Floor-diaphragm discontinuity was not assessed because slab openings could not be matched to story plan areas.")
        return "unknown", [], assumptions

    max_opening_ratio = max(float(item["openingRatio"]) for item in story_results)
    has_non_rigid = any(item["rigidDiaphragm"] is False for item in story_results)
    if max_opening_ratio > 0.50:
        severity = "particularly_irregular"
    elif max_opening_ratio > 0.30 or has_non_rigid:
        severity = "irregular"
    else:
        severity = "regular"
    return severity, [{
        "name": "floor_diaphragm_discontinuity",
        "severity": severity,
        "value": round(max_opening_ratio, 4),
        "irregularThreshold": 0.30,
        "particularlyIrregularThreshold": 0.50,
        "storyDiaphragms": story_results,
        "basis": "structured slab opening area/ratio divided by story plan area plus rigid_diaphragm flag heuristic",
    }], assumptions
