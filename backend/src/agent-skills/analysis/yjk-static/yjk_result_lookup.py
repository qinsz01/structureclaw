"""YJK result lookup and envelope helpers split from ``yjk_driver.py``.

Id/coordinate lookups, force and reaction envelopes, load-case descriptors.
Pure functions; runs under YJK's bundled Python 3.10 and holds no process,
SDK or module-level state.
"""

from __future__ import annotations

import json
import math
import re


def _safe_float(value: object, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _finite_result_float(value: object, label: str) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError) as error:
        raise RuntimeError(f"YJK result {label} is not numeric") from error
    if not math.isfinite(number):
        raise RuntimeError(f"YJK result {label} is not finite")
    return number


def _signed_max_abs(current: float, candidate: float) -> float:
    return candidate if abs(candidate) > abs(current) else current


def _load_json_file(path: str) -> dict:
    try:
        with open(path, "r", encoding="utf-8") as f:
            payload = json.load(f)
        return payload if isinstance(payload, dict) else {}
    except Exception:
        return {}


def _id_candidates(value: object) -> list[str]:
    if value is None:
        return []
    text = str(value).strip()
    if not text or text.lower() == "none":
        return []
    candidates = [text]
    number = _safe_float(value, None)
    if number is not None and abs(number - round(number)) < 1e-9:
        candidates.append(str(int(round(number))))
    return list(dict.fromkeys(candidates))


def _coord_key(x: object, y: object, z: object, *, scale: float = 1.0) -> tuple[float, float, float]:
    # Keys are millimetres, quantized only for floating-point coordinate noise.
    # Preserve submillimetre geometry instead of rounding it to whole mm.
    return (
        round(_finite_result_float(x, "node coordinate x") * scale, 6),
        round(_finite_result_float(y, "node coordinate y") * scale, 6),
        round(_finite_result_float(z, "node coordinate z") * scale, 6),
    )


def _node_lookup_from_mapping(mapping: dict) -> dict[tuple[float, float, float], str]:
    lookup: dict[tuple[float, float, float], str] = {}
    nodes = mapping.get("nodes", {})
    if not isinstance(nodes, dict):
        return lookup

    for v2_id, item in nodes.items():
        if not isinstance(item, dict):
            continue
        keys = []
        for suffix, scale in (("mm", 1.0), ("m", 1000.0)):
            fields = tuple(f"{axis}_{suffix}" for axis in ("x", "y", "z"))
            if any(field in item for field in fields):
                keys.append(_coord_key(*(item.get(field) for field in fields), scale=scale))
        if not keys or any(key != keys[0] for key in keys):
            raise RuntimeError(f"YJK converter node '{v2_id}' has missing or conflicting coordinates")
        key = keys[0]
        mapped_id = str(item.get("v2_id") or v2_id)
        if key in lookup and lookup[key] != mapped_id:
            raise RuntimeError("YJK coordinate mapping is ambiguous for coincident physical nodes")
        lookup[key] = mapped_id
    return lookup


def _build_result_node_lookup(
    extracted: dict,
    mapping: dict,
    diagnostics: dict | None = None,
) -> dict[str, str]:
    coord_to_v2 = _node_lookup_from_mapping(mapping)
    meta = extracted.get("meta", {})
    # Historical extractor payloads documented XYZ in metres. New payloads
    # state the unit; never try multiple scales based on what happens to match.
    coordinate_unit = meta.get("coordinateUnit", "m") if isinstance(meta, dict) else "m"
    if coordinate_unit not in {"m", "mm"}:
        raise RuntimeError(f"Unsupported YJK result coordinate unit: {coordinate_unit!r}")
    scale = 1000.0 if coordinate_unit == "m" else 1.0
    # The result SDK exports float32 XYZ. Compare against that exact encoding
    # of the authored coordinate, not a model-dependent distance tolerance.
    # Example: 3.6 m reads back as 3.5999999046325684 m.
    import struct
    float32_coordinates = {}
    for coordinates, physical_id in coord_to_v2.items():
        encoded = _coord_key(*(struct.unpack('f', struct.pack('f', value / scale))[0]
                               for value in coordinates), scale=scale)
        if encoded in float32_coordinates and float32_coordinates[encoded] != physical_id:
            raise RuntimeError('YJK float32 coordinates cannot distinguish physical nodes')
        float32_coordinates[encoded] = physical_id
    result_lookup: dict[str, str] = {}
    coord_matches = 0
    unmapped = 0
    for node in extracted.get("nodes", []) if isinstance(extracted.get("nodes"), list) else []:
        if not isinstance(node, dict):
            continue
        result_id = str(node.get("id"))
        key = _coord_key(node.get("x"), node.get("y"), node.get("z"), scale=scale)
        matched = coord_to_v2.get(key) or float32_coordinates.get(key)
        if result_id in result_lookup:
            raise RuntimeError(f"Duplicate YJK result node ID: {result_id}")
        if matched:
            result_lookup[result_id] = matched
            coord_matches += 1
        else:
            result_lookup[result_id] = result_id
            unmapped += 1
    if diagnostics is not None:
        diagnostics["node_id_matches"] = 0
        diagnostics["node_coord_matches"] = coord_matches
        diagnostics["node_unmapped"] = unmapped
        diagnostics["node_id_index_size"] = len(result_lookup)
    return result_lookup


def _element_category(elem_type: object) -> str:
    normalized = str(elem_type or "").lower()
    if normalized == "column":
        return "columns"
    if normalized in ("brace", "braces", "truss"):
        return "braces"
    return "beams"


def _endpoint_key(nodes: object) -> tuple[str, str] | None:
    if not isinstance(nodes, list) or len(nodes) < 2:
        return None
    endpoints = [str(nodes[0]), str(nodes[-1])]
    endpoints.sort()
    return (endpoints[0], endpoints[1])


def _build_element_lookups(mapping: dict) -> dict[str, dict]:
    by_yjk_id: dict[tuple[str, int, str], str] = {}
    by_endpoint: dict[tuple[str, int, tuple[str, str]], str] = {}
    by_sequence: dict[tuple[str, int, int], str] = {}
    elements = mapping.get("elements", {})
    if not isinstance(elements, dict):
        return {
            "by_yjk_id": by_yjk_id,
            "by_endpoint": by_endpoint,
            "by_sequence": by_sequence,
        }

    for v2_id, item in elements.items():
        if not isinstance(item, dict):
            continue
        elem_id = str(item.get("v2_id") or v2_id)
        category = ('braces' if item.get('native_geometry_route') == 'ordinary-inclined-column'
                    else _element_category(item.get("type")))
        floor_index = int(round(_safe_float(item.get("floor_index"), 0.0)))
        for field in (
            "yjk_model_id",
            "yjk_member_id",
            "yjk_id",
            "tot_id",
            "original_no",
            "id",
        ):
            for candidate in _id_candidates(item.get(field)):
                by_yjk_id[(category, floor_index, candidate)] = elem_id

        endpoints = _endpoint_key(item.get("nodes"))
        if endpoints is not None and floor_index > 0:
            by_endpoint[(category, floor_index, endpoints)] = elem_id

        fallback = item.get("fallback_match", {})
        if isinstance(fallback, dict):
            sequence = int(round(_safe_float(fallback.get("sequence_in_floor_type"), 0.0)))
            if floor_index > 0 and sequence > 0:
                by_sequence[(category, floor_index, sequence)] = elem_id
    return {
        "by_yjk_id": by_yjk_id,
        "by_endpoint": by_endpoint,
        "by_sequence": by_sequence,
    }


def _member_id_for(
    *,
    category: str,
    raw_member: dict,
    sequence: int,
    lookups: dict[str, dict],
    result_node_lookup: dict[str, str],
    diagnostics: dict | None = None,
) -> tuple[str, str]:
    floor = int(round(_safe_float(raw_member.get("floor"), 0.0)))
    original_floor = int(round(_safe_float(raw_member.get("original_floor"), 0.0)))
    floors = [item for item in (floor, original_floor) if item > 0]
    if category == "beams":
        floors.extend(item + 1 for item in (floor, original_floor) if item > 0)
    if not floors:
        floors = [0]
    floors = list(dict.fromkeys(floors))

    by_yjk_id = lookups.get("by_yjk_id", {})
    for candidate_field in ("tot_id", "id", "original_no"):
        for candidate in _id_candidates(raw_member.get(candidate_field)):
            for floor_key in floors:
                direct = by_yjk_id.get((category, floor_key, candidate))
                if direct:
                    if diagnostics is not None:
                        diagnostics["element_direct_matches"] = diagnostics.get("element_direct_matches", 0) + 1
                    return direct, "direct"

    node_i = raw_member.get("node_i")
    node_j = raw_member.get("node_j")
    endpoint = _endpoint_key([
        result_node_lookup.get(str(node_i), str(node_i)),
        result_node_lookup.get(str(node_j), str(node_j)),
    ])
    if endpoint is not None:
        by_endpoint = lookups.get("by_endpoint", {})
        for floor_key in floors:
            direct = by_endpoint.get((category, floor_key, endpoint))
            if direct:
                if diagnostics is not None:
                    diagnostics["element_endpoint_matches"] = diagnostics.get("element_endpoint_matches", 0) + 1
                return direct, "endpoint"

    raw_sequence = int(round(_safe_float(raw_member.get("sequence"), 0.0))) or sequence
    by_sequence = lookups.get("by_sequence", {})
    for floor_key in floors:
        fallback = by_sequence.get((category, floor_key, raw_sequence))
        if fallback:
            if diagnostics is not None:
                diagnostics["element_sequence_matches"] = diagnostics.get("element_sequence_matches", 0) + 1
            return fallback, "sequence"

    if diagnostics is not None:
        diagnostics["element_unmapped"] = diagnostics.get("element_unmapped", 0) + 1
    member_key = next(
        (str(raw_member.get(field)) for field in ("tot_id", "id", "original_no") if raw_member.get(field) is not None),
        str(raw_sequence),
    )
    return f"{category}:{floors[0]}:{member_key}", "raw"


def _force_from_sections(sections: object) -> dict[str, float]:
    """Map YJK section force rows [Mx, My, Qx, Qy, N, T] to common fields."""
    force = {"N": 0.0, "Vy": 0.0, "Vz": 0.0, "T": 0.0, "My": 0.0, "Mz": 0.0}
    if not isinstance(sections, list):
        force["V"] = 0.0
        force["M"] = 0.0
        return force

    rows = sections
    if sections and all(not isinstance(item, (list, tuple)) for item in sections):
        rows = [sections]

    for row in rows:
        if not isinstance(row, (list, tuple)):
            continue
        if len(row) < 6:
            raise RuntimeError("YJK member-force section returned fewer than six local-force components")
        values = [
            _finite_result_float(item, f"member force[{index}]")
            for index, item in enumerate(row[:6])
        ]
        mx, my, qx, qy, axial, torsion = values[:6]
        force["N"] = _signed_max_abs(force["N"], axial)
        force["Vy"] = _signed_max_abs(force["Vy"], qx)
        force["Vz"] = _signed_max_abs(force["Vz"], qy)
        force["T"] = _signed_max_abs(force["T"], torsion)
        force["My"] = _signed_max_abs(force["My"], my)
        force["Mz"] = _signed_max_abs(force["Mz"], mx)
        force["V"] = max(force.get("V", 0.0), math.hypot(qx, qy))
        force["M"] = max(force.get("M", 0.0), math.hypot(my, mx))

    force.setdefault("V", 0.0)
    force.setdefault("M", 0.0)
    return force


def _reaction_from_raw(raw: dict) -> dict[str, float]:
    reaction = {
        "fx": _finite_result_float(raw.get("Fx", raw.get("fx", raw.get("RX", raw.get("rx")))), "reaction fx"),
        "fy": _finite_result_float(raw.get("Fy", raw.get("fy", raw.get("RY", raw.get("ry")))), "reaction fy"),
        "fz": _finite_result_float(raw.get("Fz", raw.get("fz", raw.get("RZ", raw.get("rz")))), "reaction fz"),
        "mx": _finite_result_float(raw.get("Mx", raw.get("mx")), "reaction mx"),
        "my": _finite_result_float(raw.get("My", raw.get("my")), "reaction my"),
        "mz": _finite_result_float(raw.get("Mz", raw.get("mz")), "reaction mz"),
    }
    reaction["R"] = _safe_float(
        raw.get("R"),
        (reaction["fx"] ** 2 + reaction["fy"] ** 2 + reaction["fz"] ** 2) ** 0.5,
    )
    return reaction


def _merge_max_reaction(target: dict[str, float], candidate: dict[str, float]) -> dict[str, float]:
    merged = dict(target)
    for key in ("fx", "fy", "fz", "mx", "my", "mz"):
        merged[key] = _signed_max_abs(_safe_float(merged.get(key)), _safe_float(candidate.get(key)))
    merged["R"] = max(abs(_safe_float(merged.get("R"))), abs(_safe_float(candidate.get("R"))))
    return merged


def _merge_max_force(target: dict[str, float], candidate: dict[str, float]) -> dict[str, float]:
    merged = dict(target)
    for key in ("N", "Vy", "Vz", "T", "My", "Mz"):
        merged[key] = _signed_max_abs(_safe_float(merged.get(key)), _safe_float(candidate.get(key)))
    for key in ("V", "M"):
        merged[key] = max(abs(_safe_float(merged.get(key))), abs(_safe_float(candidate.get(key))))
    return merged


def _accumulate_node_envelope(
    table: dict[str, dict],
    node_id: str,
    case_name: str,
    disp: dict[str, float],
) -> None:
    mag = (
        _safe_float(disp.get("ux")) ** 2
        + _safe_float(disp.get("uy")) ** 2
        + _safe_float(disp.get("uz")) ** 2
    ) ** 0.5
    item = table.setdefault(str(node_id), {"maxAbsDisplacement": 0.0, "controlCase": ""})
    if mag > _safe_float(item.get("maxAbsDisplacement")):
        item["maxAbsDisplacement"] = mag
        item["controlCase"] = case_name


def _accumulate_element_envelope(
    table: dict[str, dict],
    elem_id: str,
    case_name: str,
    force: dict[str, float],
) -> None:
    item = table.setdefault(
        str(elem_id),
        {
            "maxAbsAxialForce": 0.0,
            "maxAbsShearForce": 0.0,
            "maxAbsMoment": 0.0,
            "controlCaseAxial": "",
            "controlCaseShear": "",
            "controlCaseMoment": "",
        },
    )
    axial = abs(_safe_float(force.get("N")))
    shear = abs(_safe_float(force.get("V")))
    moment = abs(_safe_float(force.get("M")))
    if axial > _safe_float(item.get("maxAbsAxialForce")):
        item["maxAbsAxialForce"] = axial
        item["controlCaseAxial"] = case_name
    if shear > _safe_float(item.get("maxAbsShearForce")):
        item["maxAbsShearForce"] = shear
        item["controlCaseShear"] = case_name
    if moment > _safe_float(item.get("maxAbsMoment")):
        item["maxAbsMoment"] = moment
        item["controlCaseMoment"] = case_name


def _accumulate_reaction_envelope(
    table: dict[str, dict],
    node_id: str,
    case_name: str,
    reaction: dict[str, float],
) -> None:
    item = table.setdefault(
        str(node_id),
        {
            "maxAbsReaction": 0.0,
            "controlCase": "",
            "fx": 0.0,
            "fy": 0.0,
            "fz": 0.0,
            "mx": 0.0,
            "my": 0.0,
            "mz": 0.0,
            "R": 0.0,
        },
    )
    resultant = abs(_safe_float(reaction.get("R")))
    if resultant > _safe_float(item.get("maxAbsReaction")):
        item.update(reaction)
        item["maxAbsReaction"] = resultant
        item["controlCase"] = case_name


def _case_descriptors(extracted: dict, raw_case_keys: set[str]) -> list[dict]:
    meta = extracted.get("meta", {}) if isinstance(extracted.get("meta"), dict) else {}
    raw_cases = extracted.get("load_cases")
    if raw_cases is None:
        raw_cases = meta.get("load_cases")
    descriptors: list[dict] = []
    used_result_keys: set[str] = set()
    claimed_source_keys: set[str] = set()

    if isinstance(raw_cases, list):
        for index, item in enumerate(raw_cases, start=1):
            if isinstance(item, dict):
                case_id = item.get("id")
                old_id = item.get("oldId")
                key = str(item.get("key") or f"lc_{case_id}") if case_id is not None else str(item.get("key") or f"case_{index}")
                label = str(item.get("name") or item.get("expName") or key)
                source_keys = [
                    key,
                    *(f"lc_{value}" for value in _id_candidates(case_id)),
                    *(f"lc_{value}" for value in _id_candidates(old_id)),
                    *_id_candidates(case_id),
                    *_id_candidates(old_id),
                ]
                descriptor = {
                    "result_key": key,
                    "source_keys": list(dict.fromkeys(source_keys)),
                    "label": label,
                    "name": item.get("name"),
                    "expName": item.get("expName"),
                    "kind": item.get("kind"),
                    "id": case_id,
                    "oldId": old_id,
                    "nativeCode": _native_case_code(item),
                }
            else:
                key = f"lc_{item}"
                descriptor = {
                    "result_key": key,
                    "source_keys": [key, str(item)],
                    "label": key,
                    "name": key,
                    "kind": None,
                    "id": item,
                    "oldId": None,
                    "expName": None,
                }

            result_key = str(descriptor["result_key"])
            if result_key in used_result_keys:
                result_key = f"{result_key}_{index}"
                descriptor["result_key"] = result_key
            used_result_keys.add(result_key)
            claimed_source_keys.update(str(value) for value in descriptor["source_keys"])
            descriptors.append(descriptor)

    for raw_key in sorted(raw_case_keys - claimed_source_keys):
        descriptors.append({
            "result_key": raw_key,
            "source_keys": [raw_key],
            "label": raw_key,
            "name": raw_key,
            "kind": None,
            "id": None,
            "oldId": None,
            "expName": None,
        })
    return descriptors


def _native_case_code(case: dict) -> str | None:
    # dsnGetLDCaseExpName preserves the ASCII code even when its legacy
    # Chinese text is decoded incorrectly by the native SDK.
    match = re.match(r"^\s*([+-]?[A-Z][A-Z0-9_]*)\s+--", str(case.get("expName") or ""))
    return match.group(1) if match else None


def _case_block(block: dict, descriptor: dict) -> object:
    for key in descriptor.get("source_keys", []):
        if key in block:
            return block.get(key)
    return []


def _raw_member_definition_lookup(extracted: dict) -> dict[str, dict[tuple[int, str], dict]]:
    lookup: dict[str, dict[tuple[int, str], dict]] = {}
    members = extracted.get("members", {})
    if not isinstance(members, dict):
        return lookup
    for category in ("columns", "beams", "braces"):
        category_lookup: dict[tuple[int, str], dict] = {}
        raw_members = members.get(category, [])
        if not isinstance(raw_members, list):
            continue
        for raw in raw_members:
            if not isinstance(raw, dict):
                continue
            floor = int(round(_safe_float(raw.get("floor"), 0.0)))
            original_floor = int(round(_safe_float(raw.get("original_floor"), 0.0)))
            floors = [item for item in (floor, original_floor) if item > 0] or [0]
            for field in ("tot_id", "id", "original_no", "sequence"):
                for candidate in _id_candidates(raw.get(field)):
                    for floor_key in floors:
                        category_lookup[(floor_key, candidate)] = raw
        lookup[category] = category_lookup
    return lookup


def _merge_member_definition(category_lookup: dict[tuple[int, str], dict], raw_force: dict) -> dict:
    floor = int(round(_safe_float(raw_force.get("floor"), 0.0)))
    original_floor = int(round(_safe_float(raw_force.get("original_floor"), 0.0)))
    floors = [item for item in (floor, original_floor) if item > 0] or [0]
    for field in ("tot_id", "id", "original_no", "sequence"):
        for candidate in _id_candidates(raw_force.get(field)):
            for floor_key in floors:
                raw_member = category_lookup.get((floor_key, candidate))
                if raw_member:
                    merged = dict(raw_member)
                    merged.update(raw_force)
                    return merged
    return raw_force


def _category_element_type(category: str) -> str:
    if category == "columns":
        return "column"
    if category == "braces":
        return "brace"
    return "beam"
