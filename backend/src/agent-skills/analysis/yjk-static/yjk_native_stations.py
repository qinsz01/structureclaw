"""Physical YJK stations: exact endpoint order, executed geometry and local axes.

Native report wwnl documents nine equally spaced beam sections and column
top/bottom sections. Executed geometry also covers calibrated sloping beams and
ordinary inclined columns. Other layouts and rigid offsets are not inferred.
"""
from __future__ import annotations

import math
from decimal import Decimal
from pathlib import Path
import sys

_runtime = str(Path(__file__).resolve().parents[1] / "runtime")
if _runtime not in sys.path:
    sys.path.insert(0, _runtime)
from coordinate_semantics import build_element_local_axes, get_reference_vector


class StationConventionUnavailable(ValueError):
    pass


def dot(a, b):
    return math.fsum(x * y for x, y in zip(a, b))


def cross(a, b):
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]


def unit(vector):
    length = math.sqrt(dot(vector, vector))
    if not math.isfinite(length) or length <= 1e-12:
        raise StationConventionUnavailable("Degenerate native member axis")
    return [value / length for value in vector]


def canonical_axes(start, end, rotation_angle=0.0, reference_vector=None):
    return build_element_local_axes(start, end, reference_vector, rotation_angle).tolist()


def is_native_ordinary_column(native_member: dict | None) -> bool:
    evidence = (native_member or {}).get("native_geometry") or {}
    return (type(evidence.get("brace_kind")) is int and evidence["brace_kind"] == 2
            and type(evidence.get("is_truss")) is int and evidence["is_truss"] == 0)


def executed_section_axes(frame: dict, points: list, native_member=None) -> list:
    """Read the section axes from executed geometry, including its rotation.

    P[1] is bending about the section width axis; P[2] about its height
    axis. Their signs do not affect the stiffness tensor. Native beam/column
    force signs are retained separately by ``map_stations``.
    """
    native_x = unit([b - a for a, b in zip(*points)])
    direction = frame.get("DIR")
    if not isinstance(direction, list) or len(direction) != 3:
        raise StationConventionUnavailable("Missing executed native section direction")
    # FE DIR is serialized at six significant digits. Recover an orthogonal
    # direction only inside the recorded decimal rounding/truncation interval;
    # never relax response tolerances or accept an actually skew section axis.
    tokens = frame.get("raw", {}).get("DIR", "").split(",")
    bounds = ([min(float(Decimal(10) ** Decimal(token).as_tuple().exponent),
                   max(abs(value) * 1e-5, 1e-12)) for token, value in zip(tokens, direction)]
              if len(tokens) == 3 else [1e-12] * 3)
    residual = dot(native_x, direction)
    if abs(residual) > sum(abs(value)*bound for value, bound in zip(native_x, bounds)) + 1e-12:
        raise StationConventionUnavailable("Native section direction is not perpendicular to member")
    native_y = unit([value-residual*axis for value, axis in zip(direction, native_x)])
    if frame.get("kind") == "BEAM":
        # The native BEAM record retains its true sloping endpoints and DIR
        # section height axis. Six independent global actions on the asymmetric
        # roof frame calibrate the same signed station convention in space.
        native_a = unit(cross(native_y, native_x))
    elif frame.get("kind") == "COLUMN":
        if abs(native_x[2] + 1) > 1e-9:
            raise StationConventionUnavailable("Inclined column station axes await native calibration")
        native_a = unit(cross(native_x, native_y))
    elif frame.get("kind") == "BRACE" and is_native_ordinary_column(native_member):
        if native_x[2] >= 0 or math.degrees(math.acos(-native_x[2])) >= 20:
            raise StationConventionUnavailable("Native inclined column is outside calibrated orientation")
        native_a = unit(cross(native_x, native_y))
    else:
        raise StationConventionUnavailable("Native member kind has no calibrated station layout")
    return [native_x, native_a, native_y]


def member_geometry(fe: dict, native_member: dict, element: dict,
                    node_lookup: dict[str, str], nodes: dict[str, dict], *, metadata=None) -> dict:
    tag = str(native_member.get("tot_id", native_member.get("id")))
    frame = fe.get("frames", {}).get(tag)
    if fe.get("unit") != [0., 0., 0.] or not frame:
        raise StationConventionUnavailable("Executed FE geometry/units are unavailable")
    native_ids = [str(native_member.get(key)) for key in ("node_i", "node_j")]
    if frame.get("nodes") != native_ids:
        raise StationConventionUnavailable("Native result endpoints differ from executed FE endpoints")
    endpoint_ids = [node_lookup.get(tag) for tag in native_ids]
    physical_ids = element.get("nodes")
    if (not isinstance(physical_ids, list) or len(physical_ids) != 2
            or set(endpoint_ids) != set(physical_ids)):
        raise StationConventionUnavailable("Native endpoints do not match the physical member")
    for field, size in (("E", 6), ("RZL", 2), ("R", 6)):
        values = frame.get(field)
        # YJK's executed inclined-column record omits rigid-zone lengths.
        # This is a calibrated record variant, not a fabricated zero result.
        if field == "RZL" and values is None and frame.get("kind") == "BRACE" and is_native_ordinary_column(native_member):
            continue
        if not isinstance(values, list) or len(values) != size or any(value != 0 for value in values):
            raise StationConventionUnavailable("Native offsets/releases require separate station calibration")
    points = []
    for native_id, physical_id in zip(native_ids, endpoint_ids):
        point = fe.get("nodes", {}).get(native_id)
        model_node = nodes[physical_id]
        wanted = [float(model_node[key + "_m"]) if key + "_m" in model_node
                  else float(model_node[key + "_mm"]) / 1000 for key in ("x", "y", "z")]
        if point is None or any(abs(a - b) > 1e-7 for a, b in zip(point, wanted)):
            raise StationConventionUnavailable("Executed FE node coordinates differ from the physical member")
        points.append(point)
    length = math.dist(*points)
    native_axes = executed_section_axes(frame, points, native_member)
    station_count = 9 if frame["kind"] == "BEAM" else 2
    same_order = endpoint_ids == physical_ids
    start, end = points if same_order else points[::-1]
    return {"length": length, "sameOrder": same_order, "stationCount": station_count,
            "transverseForceSign": -1 if frame["kind"] == "BEAM" else 1,
            "nativeAxes": native_axes,
            "axes": canonical_axes(start, end, float(element.get("rotation_angle") or 0),
                get_reference_vector(metadata or {}, str(element.get("id", element.get("v2_id"))))),
            "nativeEndpoints": endpoint_ids, "endpoints": list(physical_ids),
            "source": {"kind": "native-station-coordinate-mapping", "artifact": "fea.dat",
                       "sha256": fe["sha256"], "convention": "yjk8-frame-stations-v1"}}


def map_stations(rows: list, geometry: dict) -> list[dict]:
    if len(rows) != geometry["stationCount"]:
        raise StationConventionUnavailable("Native station count differs from the documented member layout")
    s, a, b = geometry["nativeAxes"]
    x, y, z = geometry["axes"]
    orientation = 1 if geometry["sameOrder"] else -1
    stations = []
    for index, row in enumerate(rows):
        if len(row) != 6 or any(isinstance(v, bool) or not isinstance(v, (float, int)) or not math.isfinite(v) for v in row):
            raise ValueError("Native station requires six finite simultaneous signed components")
        mx, my, qx, qy, axial, torsion = row
        # Positive native endpoint action, expressed globally; the physical cut
        # reverses when the user's endpoint order reverses. Moments and forces
        # are transformed as vectors, not independently renamed or maximized.
        # YJK beam Qx uses the opposite sign from the section X axis; columns
        # use the positive axis. Independently verified by five unit-load cases
        # against nodal six-component equilibrium with rigid floors disabled.
        force = [orientation * (-axial * s[k] + geometry["transverseForceSign"] * qx * a[k] + qy * b[k]) for k in range(3)]
        moment = [orientation * (mx * a[k] + my * b[k] - torsion * s[k]) for k in range(3)]
        fraction = index / (len(rows) - 1)
        if not geometry["sameOrder"]:
            fraction = 1 - fraction
        position = geometry["length"] * fraction
        # The vendor row does not identify left/right at an interior point
        # load. Omit that ambiguous cut instead of labelling it continuous.
        if any(abs(position - point) <= 1e-9 for point in geometry.get("discontinuities", [])):
            continue
        side = "right" if fraction == 0 else "left" if fraction == 1 else "continuous"
        stations.append({"positionM": position, "side": side,
                         "referenceFrame": "element-local", "localAxes": geometry["axes"],
                         "components": {"N": -dot(force, x), "Vy": dot(force, y), "Vz": dot(force, z),
                                        "T": -dot(moment, x), "My": -dot(moment, y), "Mz": -dot(moment, z)},
                         "nativeStationIndex": index, "nativeComponents": list(row),
                         "nativeComponentOrder": ["Mx", "My", "Qx", "Qy", "N", "T"],
                         "nativeEndpoints": geometry["nativeEndpoints"],
                         "source": geometry["source"]})
    return sorted(stations, key=lambda row: row["positionM"])


def station_envelope(stations: list[dict]) -> dict:
    """Display-only signed component envelope, never a simultaneous vector."""
    values = [row["components"] for row in stations]
    result = {key: max((row[key] for row in values), key=abs) for key in ("N", "Vy", "Vz", "T", "My", "Mz")}
    result["V"] = max(math.hypot(row["Vy"], row["Vz"]) for row in values)
    result["M"] = max(math.hypot(row["My"], row["Mz"]) for row in values)
    return result
