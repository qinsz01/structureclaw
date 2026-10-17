"""Mapping of raw YJK result JSON to the app's analysis result shape.

Split from ``yjk_driver.py``; runs under YJK's bundled Python 3.10 and holds
no process, SDK or module-level state.
"""

from __future__ import annotations

import json
import os
import sys

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)
from yjk_result_lookup import (  # noqa: E402
    _accumulate_element_envelope,
    _accumulate_node_envelope,
    _accumulate_reaction_envelope,
    _build_element_lookups,
    _build_result_node_lookup,
    _case_block,
    _case_descriptors,
    _category_element_type,
    _finite_result_float,
    _force_from_sections,
    _member_id_for,
    _merge_max_force,
    _merge_max_reaction,
    _merge_member_definition,
    _raw_member_definition_lookup,
    _reaction_from_raw,
    _safe_float,
)


def _build_yjk_design_results(
    *,
    extracted: dict,
    member_definition_lookup: dict[str, dict[tuple[int, str], dict]],
    element_lookups: dict[str, dict],
    result_node_lookup: dict[str, str],
    diagnostics: dict,
) -> dict:
    """Preserve mapped native design records without inventing check meanings.

    SDK tuples can include return codes, limits, areas and placeholders (e.g.
    [0, 99, 0, 0]). Their largest number is not a utilization ratio. Neither
    dimensions nor percent encoding can be inferred from numeric magnitude.
    Design schemas and software-generated combinations remain uncalibrated.
    """
    raw_design = extracted.get("member_design", {})
    if not isinstance(raw_design, dict):
        raw_design = {}

    elements: dict[str, dict] = {}
    raw_count = 0
    mapped_count = 0

    for category in ("columns", "beams", "braces"):
        raw_items = raw_design.get(category, [])
        if not isinstance(raw_items, list):
            continue
        category_lookup = member_definition_lookup.get(category, {})
        for sequence, raw_item in enumerate(raw_items, start=1):
            if not isinstance(raw_item, dict):
                continue
            raw_count += 1
            raw_member = _merge_member_definition(category_lookup, raw_item)
            elem_id, match_method = _member_id_for(
                category=category,
                raw_member=raw_member,
                sequence=sequence,
                lookups=element_lookups,
                result_node_lookup=result_node_lookup,
                diagnostics=diagnostics,
            )
            if match_method not in {"direct", "endpoint"}:
                raise RuntimeError(
                    f"YJK design result for {category} member '{raw_item.get('id')}' lacks an exact id or endpoint mapping"
                )
            mapped_count += 1

            if elem_id in elements:
                raise RuntimeError(f"YJK design result repeats mapped physical member '{elem_id}'")
            elements[elem_id] = {
                "elementId": elem_id,
                "elementType": _category_element_type(category),
                "floor": raw_item.get("floor"),
                "nativeGeometry": raw_item.get("native_geometry"),
                "yjk": {
                    "category": category,
                    "id": raw_item.get("id"),
                    "totId": raw_item.get("tot_id"),
                    "originalNo": raw_item.get("original_no"),
                    "originalFloor": raw_item.get("original_floor"),
                    "matchMethod": match_method,
                },
                "interpretation": "unverified-native-design-schema",
                "raw": raw_item.get("raw", {}),
            }

    diagnostics["design_raw_members"] = raw_count
    diagnostics["design_mapped_members"] = mapped_count
    diagnostics["design_unmapped_members"] = max(raw_count - mapped_count, 0)

    return {
        "source": "YJKSDsnDataPy",
        "scope": "software-automatic-design",
        "verificationStatus": "unverified",
        "summary": {
            "elementCount": len(elements),
            "rawMemberCount": raw_count,
            "mappedMemberCount": mapped_count,
        },
        "elements": elements,
    }


def _build_analysis_result(
    *,
    extracted: dict,
    mapping: dict,
    ydb_path: str,
    yjk_project: str,
    work_dir: str,
    results_path: str,
    steps: list[dict],
    source_model: dict | None = None,
) -> dict:
    """Normalize raw YJK result JSON into the app's analysis result shape."""
    meta = extracted.get("meta", {}) if isinstance(extracted.get("meta"), dict) else {}
    native_fe_model = None
    source_elements = {}
    source_load_cases = {}
    native_context = {}
    station_errors = {}
    fe_path = os.path.join(work_dir, "fea.dat")
    input_path = os.path.join(work_dir, "input.json")
    if os.path.isfile(fe_path) and (source_model is not None or os.path.isfile(input_path)):
        from native_fe import parse_fe
        from yjk_native_stations import member_geometry, map_stations, station_envelope, StationConventionUnavailable
        import hashlib
        native_fe_model = parse_fe(fe_path)
        if source_model is None:
            with open(input_path, encoding="utf-8-sig") as stream:
                source_model = json.load(stream)
        source_elements = {str(row["id"]): row for row in source_model.get("elements", [])}
        source_load_cases = {str(row["id"]): row for row in source_model.get("load_cases", [])}
        native_context = {"engine": "yjk", "stationConventionsVerified": False,
                          "artifacts": [{"path": "fea.dat", "sha256": native_fe_model["sha256"]}]}
        context_path = os.path.join(work_dir, "native-physics-context.json")
        if os.path.isfile(context_path):
            with open(context_path, encoding="utf-8-sig") as stream:
                native_context = json.load(stream)
            model_hash = hashlib.sha256(json.dumps(source_model, sort_keys=True, separators=(",", ":"),
                                                   ensure_ascii=False, allow_nan=False).encode("utf-8")).hexdigest()
            if (native_context.get("physicalModelHash") != model_hash
                    or {"path": "fea.dat", "sha256": native_fe_model["sha256"]} not in native_context.get("artifacts", [])):
                raise RuntimeError("YJK native physics context is not bound to the executed model and FE artifact")
    diagnostics: dict[str, int] = {}
    result_node_lookup = _build_result_node_lookup(extracted, mapping, diagnostics)
    element_lookups = _build_element_lookups(mapping)
    member_definition_lookup = _raw_member_definition_lookup(extracted)
    design_results = _build_yjk_design_results(
        extracted=extracted,
        member_definition_lookup=member_definition_lookup,
        element_lookups=element_lookups,
        result_node_lookup=result_node_lookup,
        diagnostics=diagnostics,
    )
    expected_nodes = {
        str(item.get("v2_id") or node_id)
        for node_id, item in mapping.get("nodes", {}).items()
        if isinstance(item, dict)
    } if isinstance(mapping.get("nodes"), dict) else set()
    expected_elements = {
        str(item.get("v2_id") or element_id)
        for element_id, item in mapping.get("elements", {}).items()
        if isinstance(item, dict)
    } if isinstance(mapping.get("elements"), dict) else set()
    if not mapping or not expected_nodes or not expected_elements:
        raise RuntimeError("YJK result normalization requires a complete converter mapping")

    displacements: dict[str, dict[str, float]] = {}
    forces: dict[str, dict[str, float]] = {}
    reactions: dict[str, dict[str, float]] = {}
    case_results: dict[str, dict] = {}
    node_displacement_envelope: dict[str, dict] = {}
    element_force_envelope: dict[str, dict] = {}
    node_reaction_envelope: dict[str, dict] = {}

    node_disp_cases = extracted.get("node_disp", {})
    if not isinstance(node_disp_cases, dict):
        node_disp_cases = {}
    node_reaction_cases = extracted.get("node_reactions", {})
    if not isinstance(node_reaction_cases, dict):
        node_reaction_cases = {}
    member_force_blocks = extracted.get("member_forces", {})
    if not isinstance(member_force_blocks, dict):
        member_force_blocks = {}

    raw_case_keys = set(node_disp_cases.keys())
    raw_case_keys.update(node_reaction_cases.keys())
    for block in member_force_blocks.values():
        if isinstance(block, dict):
            raw_case_keys.update(block.keys())

    case_descriptors = _case_descriptors(extracted, raw_case_keys)
    source_case_mappings = mapping.get("load_cases") or []
    if source_case_mappings:
        bound_cases = []
        for source_case in source_case_mappings:
            native_name = str(source_case["nativeName"])
            matches = [case for case in case_descriptors
                       if native_name in {str(case.get("nativeCode")), str(case.get("name"))}]
            if len(matches) != 1:
                raise RuntimeError(f"YJK source case '{source_case['sourceCaseId']}' does not map uniquely to '{native_name}'")
            native = matches[0]
            bound_cases.append({**native, "native_result_key": native["result_key"],
                                "result_key": str(source_case["sourceCaseId"]), "nativeCase": dict(native),
                                "sourceCaseId": str(source_case["sourceCaseId"]), "label": str(source_case["sourceCaseId"])})
        if len({case["result_key"] for case in bound_cases}) != len(bound_cases):
            raise RuntimeError("YJK source case mapping contains duplicate identities")
        case_descriptors = bound_cases
    selection_text = os.environ.get("SC_YJK_SELECTED_CASE")
    if selection_text:
        selection = json.loads(selection_text)
        labels = set(selection["labels"])
        selected = [case for case in case_descriptors if labels & {str(case.get(field)) for field in ("result_key", "name", "expName", "label", "nativeCode")}]
        if len(selected) != 1:
            raise RuntimeError(f"YJK requested case '{selection['id']}' does not map uniquely to a native case by label")
        case_descriptors = [{**selected[0], "native_result_key": selected[0].get("native_result_key", selected[0]["result_key"]), "result_key": str(selection["id"])}]
    displacement_rows_seen = 0
    nonzero_displacement_rows = 0
    force_rows_seen = 0
    reaction_rows_seen = 0

    for descriptor in case_descriptors:
        case_name = str(descriptor["result_key"])
        case_disps: dict[str, dict[str, float]] = {}
        raw_disps = _case_block(node_disp_cases, descriptor)
        if isinstance(raw_disps, list):
            for raw_disp in raw_disps:
                if not isinstance(raw_disp, dict):
                    continue
                displacement_rows_seen += 1
                raw_node_id = str(raw_disp.get("id"))
                node_id = result_node_lookup.get(raw_node_id, raw_node_id)
                if node_id in case_disps:
                    raise RuntimeError(f"YJK case '{case_name}' repeats displacement node '{node_id}'")
                # YJK extracted translations are already expressed in metres.
                disp = {
                    axis: _finite_result_float(raw_disp.get(axis), f"node {raw_node_id} displacement {axis}")
                    for axis in ("ux", "uy", "uz", "rx", "ry", "rz")
                }
                case_disps[node_id] = disp
                _accumulate_node_envelope(node_displacement_envelope, node_id, case_name, disp)

                mag = (
                    disp["ux"] ** 2
                    + disp["uy"] ** 2
                    + disp["uz"] ** 2
                ) ** 0.5
                if mag > 0:
                    nonzero_displacement_rows += 1
                previous = displacements.get(node_id)
                previous_mag = -1.0
                if previous:
                    previous_mag = (
                        previous["ux"] ** 2 + previous["uy"] ** 2 + previous["uz"] ** 2
                    ) ** 0.5
                if previous is None or mag > previous_mag:
                    displacements[node_id] = disp

        case_forces: dict[str, dict[str, float]] = {}
        case_stations: dict[str, list[dict]] = {}
        calibrated_elements = set()
        for category in ("columns", "beams", "braces"):
            block = member_force_blocks.get(category, {})
            raw_forces = _case_block(block, descriptor) if isinstance(block, dict) else []
            if not isinstance(raw_forces, list):
                continue
            sequence_by_floor: dict[int, int] = {}
            for raw_force in sorted(
                (item for item in raw_forces if isinstance(item, dict)),
                key=lambda item: (
                    int(round(_safe_float(item.get("floor"), 0.0))),
                    _safe_float(item.get("id"), 0.0),
                ),
            ):
                sections = raw_force.get("sections")
                if not isinstance(sections, list) or not sections:
                    continue
                force_rows_seen += 1
                category_member_lookup = member_definition_lookup.get(category, {})
                raw_force = _merge_member_definition(category_member_lookup, raw_force)
                floor = int(round(_safe_float(raw_force.get("floor"), 0.0)))
                sequence_by_floor[floor] = sequence_by_floor.get(floor, 0) + 1
                elem_id, match_method = _member_id_for(
                    category=category,
                    raw_member=raw_force,
                    sequence=sequence_by_floor[floor],
                    lookups=element_lookups,
                    result_node_lookup=result_node_lookup,
                    diagnostics=diagnostics,
                )
                if match_method not in {"direct", "endpoint"}:
                    raise RuntimeError(
                        f"YJK force result for {category} member '{raw_force.get('id')}' lacks an exact id or endpoint mapping"
                    )
                force = _force_from_sections(sections)
                rows = sections if any(isinstance(row, (list, tuple)) for row in sections) else [sections]
                case_stations[elem_id] = [
                    {
                        "nativeStationIndex": index,
                        "nativeComponents": [_finite_result_float(value, "native section force") for value in row],
                        "nativeComponentOrder": ["Mx", "My", "Qx", "Qy", "N", "T"],
                        "referenceFrame": "element-local",
                        "source": "YJKSDsnDataPy",
                        "endpointConvention": "unverified",
                        "nativeEndpoints": [
                            result_node_lookup.get(str(raw_force.get(field)), str(raw_force.get(field)))
                            for field in ("node_i", "node_j")
                        ],
                    }
                    for index, row in enumerate(rows)
                    if isinstance(row, (list, tuple))
                ]
                if native_fe_model is not None and elem_id in source_elements:
                    try:
                        if raw_force.get("option") != 1:
                            raise StationConventionUnavailable("Adjusted native forces are not simultaneous solver output")
                        source_element = {**mapping["elements"][elem_id],
                                          "releases": source_elements[elem_id].get("releases"),
                                          "rotation_angle": source_elements[elem_id].get("rotation_angle", 0)}
                        geometry = member_geometry(native_fe_model, raw_force, source_element,
                                                   result_node_lookup, mapping["nodes"],
                                                   metadata=source_model.get("metadata") or {},
                                                   rigid_offsets=native_context.get('effectiveRigidOffsets'))
                        authored_case = source_load_cases.get(str(descriptor.get("sourceCaseId", case_name)), {})
                        geometry["discontinuities"] = [float(load["position"]) for load in authored_case.get("loads", [])
                                                       if load.get("element") == elem_id and load.get("position") is not None]
                        canonical_stations = map_stations(rows, geometry)
                        compiled_weight = ((native_context.get('effectiveLoads') or {}).get('selfWeight') or {}).get('consistentLoadCompilation')
                        compiled_members = {item['sourceSegmentId']:item for item in (compiled_weight or {}).get('members', [])}
                        if elem_id in compiled_members and descriptor.get('sourceCaseId',case_name) == compiled_members[elem_id]['loadCaseId']:
                            if len(canonical_stations) != 2:
                                raise StationConventionUnavailable('Compiled axial gravity may expose only physical elastic-end native cuts / 编译轴向自重仅可提供物理弹性端面的原生截面')
                            for station in canonical_stations:
                                station['source']['loadFieldCompilation'] = 'axial-uniform-load-exact-virtual-work'
                                station['source']['nativeInteriorFieldSemantics'] = 'computational-load-vector; not-physical-uniform-load'
                        case_stations[elem_id] = canonical_stations
                        force = station_envelope(canonical_stations)
                        calibrated_elements.add(elem_id)
                    except StationConventionUnavailable as exc:
                        station_errors[elem_id] = str(exc)
                if elem_id in case_forces:
                    raise RuntimeError(f"YJK case '{case_name}' repeats member '{elem_id}'")
                case_forces[elem_id] = force
                forces[elem_id] = _merge_max_force(forces.get(elem_id, {}), force)
                _accumulate_element_envelope(element_force_envelope, elem_id, case_name, force)

        case_reactions: dict[str, dict[str, float]] = {}
        raw_reactions = _case_block(node_reaction_cases, descriptor)
        if isinstance(raw_reactions, list):
            for raw_reaction in raw_reactions:
                if not isinstance(raw_reaction, dict):
                    continue
                reaction_rows_seen += 1
                raw_node_id = str(raw_reaction.get("id", raw_reaction.get("node_id")))
                node_id = result_node_lookup.get(raw_node_id, raw_node_id)
                reaction = _reaction_from_raw(raw_reaction)
                if node_id in case_reactions:
                    raise RuntimeError(f"YJK case '{case_name}' repeats reaction node '{node_id}'")
                case_reactions[node_id] = reaction

        for label, actual, expected in (
            ("displacement nodes", set(case_disps), expected_nodes),
            ("reaction nodes", set(case_reactions), expected_nodes),
            ("force elements", set(case_forces), expected_elements),
        ):
            if actual != expected:
                raise RuntimeError(
                    f"YJK case '{case_name}' {label} do not exactly cover the converted model"
                )

        case_flags = []
        # Native EXA/EYA readback can return six zero reaction values despite
        # nonzero prescribed-force member response. Retain those rows only in
        # raw_results; they are not verified zero support reactions.
        if (
            descriptor.get("nativeCode") in {"EXA", "EYA"}
            and any(value != 0 for force in case_forces.values() for value in force.values())
            and not any(value != 0 for reaction in case_reactions.values() for value in reaction.values())
        ):
            case_flags.append("YJK_PRESCRIBED_FORCE_REACTIONS_UNVERIFIED")
            case_reactions = {}
        for node_id, reaction in case_reactions.items():
            reactions[node_id] = _merge_max_reaction(reactions.get(node_id, {}), reaction)
            _accumulate_reaction_envelope(node_reaction_envelope, node_id, case_name, reaction)

        stations_verified = calibrated_elements == expected_elements
        # Modal SRSS/CQC component maxima are not simultaneous signed static
        # vectors even when they have the same station/component array shape.
        static_vectors = descriptor.get("nativeCode") not in {"EX", "EY"}
        case_context = {**native_context, "stationConventionsVerified": stations_verified}
        case_results[case_name] = {
            "status": "partial" if case_flags else "success",
            "flags": case_flags,
            "completeness": {
                "nodeDisplacements": "available",
                "nodeReactions": "unverified" if case_flags else "available",
                "memberStationValues": "available",
                "memberStationCoordinates": "available" if stations_verified else "unverified",
                "memberLocalAxes": "available" if stations_verified else "unverified",
            },
            "key": case_name,
            "label": descriptor.get("label"),
            "name": descriptor.get("name"),
            "expName": descriptor.get("expName"),
            "kind": descriptor.get("kind"),
            "id": descriptor.get("id"),
            "oldId": descriptor.get("oldId"),
            "nativeResultKey": descriptor.get("native_result_key", case_name),
            "nativeCode": descriptor.get("nativeCode"),
            "nativeCase": descriptor.get("nativeCase"),
            "displacements": case_disps,
            "forces": {
                element_id: {**force, "referenceFrame": "element-local"}
                for element_id, force in case_forces.items()
            },
            "reactions": case_reactions,
            "envelope": {},
            "memberStations": case_stations,
            "nativeContext": case_context,
            "units": {"displacement": "m", "rotation": "rad", "force": "kN", "moment": "kN.m"},
            "forceSemantics": ("simultaneous-signed-stations" if stations_verified and static_vectors
                               else "native-response-spectrum-components" if not static_vectors
                               else "signed-component-envelope; memberStations retain native station vectors"),
            "forceSummarySemantics": "signed-component-envelope",
        }

    max_disp = 0.0
    max_disp_node: str | None = None
    for node_id, item in node_displacement_envelope.items():
        value = _safe_float(item.get("maxAbsDisplacement"))
        if value > max_disp:
            max_disp = value
            max_disp_node = node_id

    max_axial = max_shear = max_moment = 0.0
    control_axial = control_shear = control_moment = ""
    for elem_id, item in element_force_envelope.items():
        axial = _safe_float(item.get("maxAbsAxialForce"))
        shear = _safe_float(item.get("maxAbsShearForce"))
        moment = _safe_float(item.get("maxAbsMoment"))
        if axial > max_axial:
            max_axial = axial
            control_axial = elem_id
        if shear > max_shear:
            max_shear = shear
            control_shear = elem_id
        if moment > max_moment:
            max_moment = moment
            control_moment = elem_id

    max_reaction = 0.0
    control_reaction = ""
    for node_id, item in node_reaction_envelope.items():
        reaction = _safe_float(item.get("maxAbsReaction"))
        if reaction > max_reaction:
            max_reaction = reaction
            control_reaction = node_id

    envelope = {
        "maxAbsDisplacement": max_disp,
        "controlNodeDisplacement": max_disp_node,
        "maxAbsAxialForce": max_axial,
        "maxAbsShearForce": max_shear,
        "maxAbsMoment": max_moment,
        "maxAbsReaction": max_reaction,
        "controlElementAxialForce": control_axial or None,
        "controlElementShearForce": control_shear or None,
        "controlElementMoment": control_moment or None,
        "controlNodeReaction": control_reaction or None,
    }
    if max_disp_node:
        envelope[f"node:{max_disp_node}:maxAbsDisplacement"] = max_disp
    if not reactions:
        # No validated reaction rows is different from a computed zero maximum.
        envelope.pop("maxAbsReaction", None)
        envelope.pop("controlNodeReaction", None)

    if force_rows_seen == 0 or displacement_rows_seen == 0 or reaction_rows_seen == 0:
        raise RuntimeError("YJK result extraction did not return complete force, displacement, and reaction rows")
    if diagnostics.get("node_unmapped", 0) > 0 or diagnostics.get("element_unmapped", 0) > 0:
        raise RuntimeError("YJK result extraction contains node or member rows that cannot be mapped exactly")
    for label, actual, expected in (
        ("displacement nodes", set(displacements), expected_nodes),
        ("reaction nodes", set(reactions), expected_nodes if any(case["reactions"] for case in case_results.values()) else set()),
        ("force elements", set(forces), expected_elements),
    ):
        if actual != expected:
            missing = sorted(expected - actual)
            unexpected = sorted(actual - expected)
            raise RuntimeError(
                f"YJK {label} do not exactly cover the converted model "
                f"(missing={missing[:5]}, unexpected={unexpected[:5]})"
            )

    warnings: list[str] = []
    for case_name, case in case_results.items():
        if case["flags"]:
            warnings.append(
                f"YJK case '{case_name}' prescribed-force reactions are unverified; "
                "zero native rows were preserved only in raw results."
            )
    members = extracted.get("members", {})
    if not isinstance(members, dict) or all(not members.get(category) for category in ("columns", "beams", "braces")):
        warnings.append("YJK raw members were empty; element result mapping used force rows and fallbacks.")
    if force_rows_seen == 0:
        warnings.append("YJK raw member_forces were empty; top-level forces and element envelopes are empty.")
    if displacement_rows_seen == 0:
        warnings.append("YJK raw node_disp was empty; displacement envelopes are empty.")
    elif nonzero_displacement_rows == 0:
        warnings.append("YJK raw node_disp values were all zero; check whether the extractor returned solved displacements.")
    if reaction_rows_seen == 0:
        warnings.append("YJK raw node_reactions were empty; reaction envelopes are empty.")
    if diagnostics.get("node_coord_matches", 0) > 0:
        warnings.append(
            f"YJK node mapping matched declared-unit coordinates for {diagnostics.get('node_coord_matches', 0)} result nodes."
        )
    if diagnostics.get("node_unmapped", 0) > 0:
        warnings.append(
            f"YJK node mapping left {diagnostics.get('node_unmapped', 0)} result nodes on raw ids."
        )
    if diagnostics.get("element_endpoint_matches", 0) > 0:
        warnings.append(
            f"YJK element mapping used endpoint fallback for {diagnostics.get('element_endpoint_matches', 0)} force rows."
        )
    if diagnostics.get("element_sequence_matches", 0) > 0:
        warnings.append(
            f"YJK element mapping used sequence fallback for {diagnostics.get('element_sequence_matches', 0)} force rows."
        )
    if diagnostics.get("element_unmapped", 0) > 0:
        warnings.append(
            f"YJK element mapping left {diagnostics.get('element_unmapped', 0)} force rows on raw ids."
        )

    return {
        "status": "success",
        "analysisMode": "yjk-static",
        "resultCompleteness": {
            "nodeScope": "physical-member-endpoints",
            "caseFlags": {key: case["flags"] for key, case in case_results.items() if case["flags"]},
            "memberStationCoordinates": "available" if all(case["nativeContext"]["stationConventionsVerified"] for case in case_results.values()) else "unverified",
            "memberLocalAxes": "available" if all(case["nativeContext"]["stationConventionsVerified"] for case in case_results.values()) else "unverified",
            "stationMappingIssues": station_errors,
        },
        "displacements": displacements,
        "forces": {
            key: {**value, "referenceFrame": "element-local"}
            for key, value in forces.items()
        },
        "reactions": reactions,
        "envelope": envelope,
        "summary": {
            "engine": "yjk-static",
            "mode": "sync",
            "ydb_path": ydb_path,
            "yjk_project": yjk_project,
            "work_dir": work_dir,
            "results_path": results_path,
            "nodeCount": len(displacements),
            "elementCount": len(forces),
            "reactionNodeCount": len(reactions),
            "designElementCount": design_results["summary"]["elementCount"],
            "maxDisplacement": max_disp,
            "maxDisplacementNode": max_disp_node,
            "floors_analyzed": meta.get("n_floors"),
            "n_floors": meta.get("n_floors"),
            "n_nodes": meta.get("n_nodes"),
            "load_cases": extracted.get("load_cases", meta.get("load_cases")),
        },
        "data": extracted,
        "detailed": {
            "message": "YJK static analysis completed and results were extracted.",
            "yjk_project": yjk_project,
            "results_path": results_path,
            "extraction": extracted,
            "mapping": mapping,
            "normalization": diagnostics,
        },
        "yjk_detailed": {
            "raw_results": extracted,
            "mapping": mapping,
            "floor_stats": extracted.get("floor_stats", []),
            "members": extracted.get("members", {}),
            "member_design": extracted.get("member_design", {}),
        },
        "caseResults": case_results,
        "designResults": design_results,
        "envelopeTables": {
            "nodeDisplacement": node_displacement_envelope,
            "elementForce": element_force_envelope,
            "nodeReaction": node_reaction_envelope,
        },
        "warnings": warnings,
        "steps": steps,
    }
