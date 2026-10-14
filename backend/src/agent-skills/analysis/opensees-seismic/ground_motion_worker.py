"""Read-only full-file inspection used by the same public attachment tool."""
import json
import math
import sys

from ground_motion_input import motion_direction, unit_scale, values


def inspect(record):
    parsed = values(record)
    direction = motion_direction(record)
    if direction is None:
        raise ValueError("GROUND_MOTION_DIRECTION_REQUIRED")
    scale = unit_scale(parsed.inferred_unit)
    count = len(parsed.values)
    step = max(1, math.ceil(count / 600))
    indices = list(range(0, count, step))
    if indices[-1] != count - 1:
        indices.append(count - 1)
    return {"pointCount": count, "dt": parsed.inferred_dt, "timeUnit": "s",
            "timeOrigin": parsed.time_origin, "duration": (count - 1) * parsed.inferred_dt,
            "originalUnit": parsed.inferred_unit, "unit": "m/s2", "direction": direction,
            "source": parsed.source, "pgaMps2": max(abs(value) for value in parsed.values) * scale,
            "preview": {"kind": "sampled-display", "sampledPointCount": len(indices),
                        "points": [{"index": i, "time": i * parsed.inferred_dt,
                                    "acceleration": parsed.values[i] * scale} for i in indices]}}


if __name__ == '__main__':
    try:
        print(json.dumps({"ok": True, "data": inspect(json.load(sys.stdin))}, allow_nan=False))
    except Exception as error:
        print(json.dumps({"ok": False, "errorCode": "GROUND_MOTION_INPUT_INVALID", "message": str(error)}))
