"""Recover support reactions from calibrated, simultaneous PKPM column forces.

PKPM 2025 R2.5 ColumnDesignData.GetForce has two cuts: 0 is bottom and
1 is top. For a vertical, unrotated column its six values are
[Fz, Fx, Fy, Mz, Mx, My]. The bottom cut's negative is the force applied
by its bottom node to the column; the top cut's positive is the force
applied by its top node. This convention is independently calibrated by
the six-component cantilever fixture, not by component envelopes.

All geometry in this interface is m. Native geometry/constraint evidence
must be read back by the caller, not constructed from requested settings.
This deliberately rejects uncalibrated inclines, rotations, offsets,
releases, and non-column support incidences. It does not fill missing data.
"""
from __future__ import annotations

import math
from collections.abc import Mapping


class NativeReactionUnavailable(ValueError):
    """The result or its native geometric/boundary evidence is incomplete."""


def _vector(value, size, label):
    if not isinstance(value, (list, tuple)) or len(value) != size:
        raise NativeReactionUnavailable(f"{label} must contain {size} values")
    if any(isinstance(item, bool) or not isinstance(item, (int, float)) or not math.isfinite(item) for item in value):
        raise NativeReactionUnavailable(f"{label} contains a non-finite or non-numeric value")
    return tuple(float(item) for item in value)


def _evidence(value, label):
    if not isinstance(value, Mapping) or not value.get("kind"):
        raise NativeReactionUnavailable(f"{label} has no native readback source")


def _same_point(first, second):
    return all(abs(a - b) <= 1e-7 for a, b in zip(first, second))


def column_end_actions(member_id, member, geometry, rows, nodes):
    """Return global node-on-member actions at both explicitly bound endpoints."""
    if member.get("type") != "column" or geometry.get("kind") != "column":
        raise NativeReactionUnavailable(f"{member_id}: only calibrated columns can recover reactions")
    bottom, top = geometry.get("bottomNodeId"), geometry.get("topNodeId")
    if bottom == top or bottom not in nodes or top not in nodes:
        raise NativeReactionUnavailable(f"{member_id}: native endpoints are not bound to physical nodes")
    if {member.get("nodeStart"), member.get("nodeEnd")} != {bottom, top}:
        raise NativeReactionUnavailable(f"{member_id}: native/physical endpoint identities differ")
    bottom_xyz = _vector(geometry.get("bottomCoordinates"), 3, f"{member_id} native bottom")
    top_xyz = _vector(geometry.get("topCoordinates"), 3, f"{member_id} native top")
    if not _same_point(bottom_xyz, _vector(nodes[bottom], 3, f"{bottom} coordinates")) or not _same_point(top_xyz, _vector(nodes[top], 3, f"{top} coordinates")):
        raise NativeReactionUnavailable(f"{member_id}: native/physical endpoint coordinates differ")
    if any(abs(top_xyz[i] - bottom_xyz[i]) > 1e-7 for i in (0, 1)) or top_xyz[2] <= bottom_xyz[2]:
        raise NativeReactionUnavailable(f"{member_id}: inclined/reversed native column axes are not calibrated")
    if _vector([geometry.get("angleDegrees")], 1, f"{member_id} native angle")[0] != 0:
        raise NativeReactionUnavailable(f"{member_id}: rotated native column axes are not calibrated")
    if any(_vector(geometry.get("offsetsM"), 6, f"{member_id} native offsets")):
        raise NativeReactionUnavailable(f"{member_id}: offset endpoint actions are not calibrated")
    releases = geometry.get("releases")
    if not isinstance(releases, (list, tuple)) or len(releases) != 12 or any(value is not False for value in releases):
        raise NativeReactionUnavailable(f"{member_id}: native releases are unknown or not calibrated")
    _evidence(geometry.get("geometrySource"), f"{member_id} geometry")
    if not isinstance(rows, (list, tuple)) or len(rows) != 2:
        raise NativeReactionUnavailable(f"{member_id}: complete simultaneous bottom/top cuts are required")
    cuts = {}
    for row in rows:
        station = row.get("nativeStation")
        if type(station) is not int or station not in (0, 1) or station in cuts:
            raise NativeReactionUnavailable(f"{member_id}: ambiguous native cut indices")
        values = _vector(row.get("nativeComponents"), 6, f"{member_id} cut {station}")
        cuts[station] = (values[1], values[2], values[0], values[4], values[5], values[3])
    return {bottom: tuple(-value for value in cuts[0]), top: cuts[1]}


def recover_support_reactions(*, nodes, members, native_members, supports, station_rows,
                              nodal_loads, source_case, result_source):
    """Return all support six-vectors, or reject the incomplete case atomically.

    ``members`` contains every physical member (not just result members).
    ``supports[id]`` supplies canonical ``restraints`` and read-back
    ``nativeRestraints``, each six booleans, plus ``source`` evidence.
    ``nodal_loads`` must explicitly include a signed six-vector at every
    support, including a zero vector when the model has no load there.
    Forces and moments are kN and kN.m. The input case must be simultaneous
    signed static cuts; native design or component envelopes are rejected.
    """
    if not isinstance(source_case, str) or not source_case:
        raise NativeReactionUnavailable("A source load case is required")
    if not isinstance(result_source, Mapping) or result_source.get("kind") != "simultaneous-signed-stations" or result_source.get("caseId") != source_case:
        raise NativeReactionUnavailable("Reaction recovery requires case-bound simultaneous signed stations")
    if not supports:
        raise NativeReactionUnavailable("No physical supports were supplied")
    incidence = {node_id: [] for node_id in supports}
    for member_id, member in members.items():
        start, end = member.get("nodeStart"), member.get("nodeEnd")
        if start not in nodes or end not in nodes or start == end:
            raise NativeReactionUnavailable(f"{member_id}: incomplete physical endpoint topology")
        for node_id in (start, end):
            if node_id in incidence:
                incidence[node_id].append(member_id)
    actions = {}
    result = {}
    for node_id, support in supports.items():
        if node_id not in nodes or not incidence[node_id]:
            raise NativeReactionUnavailable(f"{node_id}: support has no verified incident member")
        values = support.get("restraints")
        if values not in ([True] * 6, [True] * 3 + [False] * 3) or support.get("nativeRestraints") != values:
            raise NativeReactionUnavailable(f"{node_id}: calibrated native and physical restraints must agree")
        if values[3:] == [False] * 3 and (support.get("source", {}).get("kind") != "calibrated-native-free-base-rotations"
                or support["source"].get("rotationStiffnessKNmPerRad") != [0., 0., 0.]):
            raise NativeReactionUnavailable(f"{node_id}: free native rotations lack exact constraint evidence")
        _evidence(support.get("source"), f"{node_id} restraints")
        external = _vector(nodal_loads.get(node_id), 6, f"{node_id} explicit support nodal load")
        components = [-value for value in external]
        for member_id in incidence[node_id]:
            if member_id not in native_members or member_id not in station_rows:
                raise NativeReactionUnavailable(f"{node_id}: missing incident member {member_id} native end force/geometry")
            if member_id not in actions:
                actions[member_id] = column_end_actions(member_id, members[member_id], native_members[member_id], station_rows[member_id], nodes)
            for index, value in enumerate(actions[member_id][node_id]):
                components[index] += value
        result[node_id] = dict(zip(("fx", "fy", "fz", "mx", "my", "mz"), components))
        if values[3:] == [False] * 3 and any(abs(value) > 1e-5 for value in components[3:]):
            raise NativeReactionUnavailable(f"{node_id}: native released moment exceeds frozen tolerance / 释放方向残余弯矩超过冻结容差")
        result[node_id]["R"] = math.hypot(*components[:3])
        result[node_id]["source"] = {
            "kind": "derived-node-equilibrium", "caseId": source_case,
            "memberIds": list(incidence[node_id]),
            "boundary": dict(support["source"]),
        }
    return {"reactions": result, "source": {
        "kind": "derived-node-equilibrium",
        "schema": "pkpm-2025r2.5-vertical-column-reactions/v1",
        "caseId": source_case, "nativeSource": dict(result_source),
        "nativeComponentOrder": ["Fz", "Fx", "Fy", "Mz", "Mx", "My"],
        "nativeCutOrder": ["bottom", "top"],
        "units": {"force": "kN", "moment": "kN.m"},
    }}
