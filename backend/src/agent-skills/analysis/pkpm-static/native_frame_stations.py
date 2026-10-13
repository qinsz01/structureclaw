"""Calibrated signed PKPM frame cuts in the canonical physical local axes.

Beam GetForce has nine equally spaced sections (WNL native report layout),
with [N,Vy,Vz,T,My,Mz] in its horizontal axis system. Columns have bottom/top
cuts with [Fz,Fx,Fy,Mz,Mx,My] in global coordinates. Raw rows are positive-cut
actions; canonical diagram shear uses the opposite cut sign. Calibration
compares all endpoints and beam stations to an independently frozen 3-D
Timoshenko frame, including both plan directions and nonzero torsion.
"""
from __future__ import annotations

import math
from pathlib import Path
import sys

_runtime = str(Path(__file__).resolve().parents[1] / "runtime")
if _runtime not in sys.path:
    sys.path.insert(0, _runtime)
from coordinate_semantics import build_element_local_axes, get_reference_vector


class NativeStationUnavailable(ValueError):
    pass


def _dot(first, second):
    return math.fsum(a * b for a, b in zip(first, second))


def map_frame_stations(model, geometry, station_rows, *, active_loads=None):
    """Map complete simultaneous cuts atomically; never invent a displacement."""
    elements = {str(row["id"]): row for row in model["elements"]}
    if set(elements) != set(geometry["native_members"]) or set(elements) != set(station_rows):
        raise NativeStationUnavailable("Physical/native station member coverage differs")
    loads = active_loads if active_loads is not None else [load for case in model.get("load_cases", []) for load in case.get("loads", [])]
    mapped = {}
    for member_id, element in elements.items():
        native = geometry["native_members"][member_id]
        rows = station_rows[member_id]
        column = native["kind"] == "column"
        if native["kind"] not in ("column", "beam") or native["angleDegrees"] != 0 or any(native["offsetsM"]) or any(native["releases"]):
            raise NativeStationUnavailable("Native geometry is outside calibrated frame axes")
        if not native.get("geometrySource", {}).get("kind"):
            raise NativeStationUnavailable("Native geometry has no readback evidence")
        native_ids = [native["bottomNodeId"], native["topNodeId"]] if column else [native["startNodeId"], native["endNodeId"]]
        native_points = [geometry["nodes"][node_id] for node_id in native_ids]
        physical_ids = list(map(str, element["nodes"]))
        if set(native_ids) != set(physical_ids):
            raise NativeStationUnavailable("Native cut endpoints do not match physical member")
        count = 2 if column else 9
        if len(rows) != count or {row.get("nativeStation") for row in rows} != set(range(count)):
            raise NativeStationUnavailable("Native cut indices do not cover documented section layout")
        if any(type(row["nativeStation"]) is not int for row in rows):
            raise NativeStationUnavailable("Native cut indices must be exact integers")
        start, end = [geometry["nodes"][node_id] for node_id in physical_ids]
        length = math.dist(start, end)
        if length <= 0 or not math.isfinite(length):
            raise NativeStationUnavailable("Invalid physical member length")
        axes = build_element_local_axes(start, end, get_reference_vector(model.get("metadata", {}), member_id),
                                        float(element.get("rotation_angle") or 0)).tolist()
        same_order = physical_ids == native_ids
        orientation = 1 if same_order else -1
        native_x = [(b - a) / length for a, b in zip(*native_points)]
        if column and native_x != [0., 0., 1.]:
            raise NativeStationUnavailable("Inclined column forces are not calibrated")
        if not column and native_x[2] != 0:
            raise NativeStationUnavailable("Inclined beam forces are not calibrated")
        native_axes = [native_x, [-native_x[1], native_x[0], 0.], [0., 0., 1.]]
        jumps = [load["position"] for load in loads if load.get("element") == member_id and load.get("type") == "point"]
        out = []
        for row in sorted(rows, key=lambda row: row["nativeStation"]):
            values = row.get("nativeComponents")
            if not isinstance(values, (list, tuple)) or len(values) != 6 or any(type(v) not in (int, float) or not math.isfinite(v) for v in values):
                raise NativeStationUnavailable("Every cut requires six finite signed force components")
            if column:
                force, moment = [values[1], values[2], values[0]], [values[4], values[5], values[3]]
            else:
                force = [sum(values[a] * native_axes[a][k] for a in range(3)) for k in range(3)]
                moment = [sum(values[a + 3] * native_axes[a][k] for a in range(3)) for k in range(3)]
            local_force = [orientation * _dot(force, axis) for axis in axes]
            local_moment = [orientation * _dot(moment, axis) for axis in axes]
            fraction = row["nativeStation"] / (count - 1)
            if not same_order:
                fraction = 1 - fraction
            # SDK rows do not label which face of a point-load cut they use.
            # Keep the exact endpoints/other cuts, omit ambiguous interior rows.
            if fraction not in (0, 1) and any(abs(fraction * length - position) <= 1e-9 for position in jumps):
                continue
            out.append({"positionM": fraction * length,
                        "side": "right" if fraction == 0 else "left" if fraction == 1 else "continuous",
                        "referenceFrame": "element-local", "localAxes": axes,
                        "components": {"N": local_force[0], "Vy": -local_force[1], "Vz": -local_force[2],
                                       "T": local_moment[0], "My": local_moment[1], "Mz": local_moment[2]},
                        "nativeStationIndex": row["nativeStation"], "nativeComponents": list(values),
                        "nativeComponentOrder": ["Fz", "Fx", "Fy", "Mz", "Mx", "My"] if column else ["N", "Vy", "Vz", "T", "My", "Mz"],
                        "nativeEndpoints": native_ids,
                        "source": {"kind": "native-station-coordinate-mapping", "convention": "pkpm-2025r2.5-frame-stations/v1",
                                   "geometry": native["geometrySource"], "method": row.get("source")}})
        mapped[member_id] = sorted(out, key=lambda row: row["positionM"])
    return mapped
