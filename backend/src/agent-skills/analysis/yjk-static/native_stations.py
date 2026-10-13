"""Physical YJK stations: exact endpoint order, executed geometry and local axes.

Native report wwnl documents nine equally spaced beam sections and column
top/bottom sections. Other station layouts, inclined columns and rigid offsets
are deliberately not inferred from a row count.
"""
from __future__ import annotations

import math


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


def canonical_axes(start, end, rotation_angle=0.0):
    x = unit([b - a for a, b in zip(start, end)])
    reference = [1., 0., 0.] if abs(x[2]) > 0.9 else [0., 0., 1.]
    y = unit(cross(reference, x))
    z = cross(x, y)
    angle = math.radians(rotation_angle)
    return [x, [math.cos(angle) * a + math.sin(angle) * b for a, b in zip(y, z)],
            [-math.sin(angle) * a + math.cos(angle) * b for a, b in zip(y, z)]]


def member_geometry(fe: dict, native_member: dict, element: dict,
                    node_lookup: dict[str, str], nodes: dict[str, dict]) -> dict:
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
    native_x = unit([b - a for a, b in zip(*points)])
    length = math.dist(*points)
    direction = frame.get("DIR")
    if not isinstance(direction, list) or len(direction) != 3:
        raise StationConventionUnavailable("Missing executed native section direction")
    if frame["kind"] == "BEAM":
        if abs(native_x[2]) > 1e-9 or any(abs(a - b) > 1e-9 for a, b in zip(direction, (0., 0., 1.))):
            raise StationConventionUnavailable("Inclined/rotated beam station axes await native calibration")
        native_y = direction
        native_a = unit(cross(native_y, native_x))
        station_count = 9
    elif frame["kind"] == "COLUMN":
        if abs(native_x[2] + 1) > 1e-9 or abs(direction[2]) > 1e-9:
            raise StationConventionUnavailable("Inclined column station axes await native calibration")
        angle = native_member.get("native_geometry", {}).get("angle_info")
        if angle is None or abs(float(angle)) > 1e-9:
            raise StationConventionUnavailable("Rotated column native axes await native calibration")
        native_y = unit(direction)
        native_a = unit(cross(native_x, native_y))
        station_count = 2
    else:
        raise StationConventionUnavailable("Native member kind has no calibrated station layout")
    same_order = endpoint_ids == physical_ids
    start, end = points if same_order else points[::-1]
    return {"length": length, "sameOrder": same_order, "stationCount": station_count,
            "transverseForceSign": -1 if frame["kind"] == "BEAM" else 1,
            "nativeAxes": [native_x, native_a, native_y],
            "axes": canonical_axes(start, end, float(element.get("rotation_angle") or 0)),
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
