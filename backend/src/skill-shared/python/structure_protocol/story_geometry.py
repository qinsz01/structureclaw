"""Natural storeys and physical elevations for the native building compiler.

One declared storey stays one native standard floor. Roof node heights are
offsets from that floor; distinct physical Z values never create new floors.
"""
from __future__ import annotations

import math


def exact_mm(value, label: str) -> int:
    if isinstance(value, bool):
        raise ValueError(f"{label} must be a finite coordinate in metres")
    try:
        number = float(value) * 1000
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{label} must be a finite coordinate in metres") from exc
    if not math.isfinite(number) or abs(number - round(number)) > 1e-6:
        raise ValueError(f"{label} is not exactly representable by the native integer-millimetre grid")
    return int(round(number))


def compile_story_geometry(model: dict) -> dict:
    raw_stories = model.get("stories") or []
    if not raw_stories or any(not isinstance(row, dict) or not row.get("id") for row in raw_stories):
        raise ValueError("Native requires explicit natural stories")
    stories, by_id = [], {}
    previous_top = 0
    for index, row in enumerate(sorted(raw_stories, key=lambda item: exact_mm(item.get("elevation"), "Story elevation")), 1):
        identifier = str(row["id"])
        base, height = exact_mm(row.get("elevation"), f"Story {identifier} elevation"), exact_mm(row.get("height"), f"Story {identifier} height")
        if identifier in by_id or base != previous_top or height <= 0:
            raise ValueError("Native natural stories require unique IDs and contiguous positive heights from Z=0")
        top = base + height
        info = {"id": identifier, "index": index, "height_m": height/1000, "elevation_m": base/1000,
                "top_elevation_m": top/1000, "height_mm": height, "elevation_mm": base, "top_elevation_mm": top}
        stories.append(info)
        by_id[identifier] = info
        previous_top = top
    nodes, planar_slots = {}, set()
    for row in model.get("nodes", []):
        identifier = str(row["id"])
        x, y, z = [exact_mm(row.get(key), f"Node {identifier} {key}") for key in ("x", "y", "z")]
        if identifier in nodes or z < 0:
            raise ValueError("Native node IDs must be unique and elevations cannot be below the declared base")
        declared = row.get("story")
        if z == 0:
            if declared is not None:
                raise ValueError(f"Base node {identifier} cannot belong to an elevated storey")
            floor, offset, story_id = 0, 0, None
        else:
            if declared is not None:
                story = by_id.get(str(declared))
                if story is None or z <= story["elevation_mm"]:
                    raise ValueError(f"Node {identifier} has an invalid natural story assignment")
            elif len(stories) == 1:
                story = stories[0]
            else:
                candidates = [item for item in stories if item["elevation_mm"] < z <= item["top_elevation_mm"]]
                if len(candidates) != 1:
                    raise ValueError(f"Node {identifier} needs an explicit natural story for its roof elevation")
                story = candidates[0]
            floor, offset, story_id = story["index"], z-story["top_elevation_mm"], story["id"]
        slot = (floor, x, y)
        if slot in planar_slots:
            raise ValueError(f"Native cannot preserve multiple independent heights at one plan node on floor {floor}")
        planar_slots.add(slot)
        nodes[identifier] = {"floor_index": floor, "floor": story_id, "height_offset_mm": offset,
                             "x_mm": x, "y_mm": y, "z_mm": z}
    members = {}
    for row in model.get("elements", []):
        identifier = str(row["id"])
        refs = row.get("nodes", [])
        if len(refs) != 2 or any(str(key) not in nodes for key in refs):
            raise ValueError(f"Native member {identifier} requires two existing physical endpoints")
        start, end = [nodes[str(key)] for key in refs]
        if row.get("type") == "column":
            floor = end["floor_index"]
            if floor <= 0 or start["floor_index"] != floor-1 or start["z_mm"] >= end["z_mm"]:
                raise ValueError(f"Native column {identifier} must connect adjacent declared natural floors from bottom to top")
        elif row.get("type") == "beam":
            floor = start["floor_index"]
            if floor <= 0 or end["floor_index"] != floor:
                raise ValueError(f"Native beam {identifier} must have both nodes assigned to the same natural floor")
        else:
            raise ValueError(f"Native native floor compilation does not preserve {row.get('type')}")
        story = stories[floor-1]
        if row.get("story") is not None and str(row["story"]) != story["id"]:
            raise ValueError(f"Member {identifier} natural story conflicts with its physical endpoints")
        members[identifier] = {"floor_index": floor, "floor": story["id"],
                              "start_height_mm": start["z_mm"]-story["elevation_mm"],
                              "end_height_mm": end["z_mm"]-story["elevation_mm"]}
    return {"stories": stories, "nodes": nodes, "members": members}
