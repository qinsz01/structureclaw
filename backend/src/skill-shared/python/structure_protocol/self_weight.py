"""One source-case and SI gravity contract for every solver adapter."""
from __future__ import annotations

import math


class SelfWeightInputError(ValueError):
    error_code = "ANALYSIS_INPUT_REQUIRED"


def resolve_self_weight(model: dict) -> dict:
    """Resolve authored choices without editing the canonical model or its loads."""
    controls = model.get("analysis_control") or {}
    enabled = controls.get("self_weight")
    if enabled is not None and type(enabled) is not bool:
        raise SelfWeightInputError("self_weight must be boolean / 自重开关须为布尔值")
    gravity = controls.get("gravity_m_s2")
    gravity = 9.80665 if gravity is None else gravity
    if type(gravity) not in (float, int) or not math.isfinite(gravity) or gravity <= 0:
        raise SelfWeightInputError("gravity_m_s2 must be finite and positive / 重力加速度须为正有限数值")
    direction = controls.get("gravity_direction") or "-z"
    if direction not in ("x", "-x", "y", "-y", "z", "-z"):
        raise SelfWeightInputError("Unknown global gravity direction / 全局重力方向不明确")
    result = {"enabled": enabled is True, "gravityMps2": float(gravity), "direction": direction,
              "vectorMps2": [(-1. if direction.startswith("-") else 1.) * gravity if axis == direction[-1] else 0.
                             for axis in ("x", "y", "z")],
              "source": "explicit" if enabled is not None else "default-disabled",
              "gravitySource": "explicit" if controls.get("gravity_m_s2") is not None else "standard-gravity",
              "directionSource": "explicit" if controls.get("gravity_direction") is not None else "global-negative-z"}
    if not result["enabled"]:
        return result
    cases = model.get("load_cases", [])
    case_id = controls.get("self_weight_case_id")
    if case_id is None:
        candidates = [row["id"] for row in cases if row.get("type") == "dead"]
        if len(candidates) != 1:
            raise SelfWeightInputError("Specify self_weight_case_id when there is not exactly one dead case / 非唯一恒载工况时须指定自重工况")
        case_id = candidates[0]
        basis = "unique-dead-case"
    else:
        basis = "explicit-case-id"
    if not isinstance(case_id, str) or sum(row.get("id") == case_id for row in cases) != 1:
        raise SelfWeightInputError("Self-weight case must identify one existing source case / 自重工况须对应唯一已存在的源工况")
    return {**result, "loadCaseId": case_id, "caseSource": basis}
