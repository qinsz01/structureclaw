"""Commercial case combinations require simultaneous, calibrated vectors.

This module never combines design envelopes. Native adapters own the evidence
that enables the context; caller-supplied analysis parameters are not evidence.
"""
from __future__ import annotations

import copy
import math
from contracts import AnalysisCapabilityError

COMPONENTS = ("N", "Vy", "Vz", "T", "My", "Mz")
CONTEXT_KEYS = ("engine", "engineVersion", "physicalModelHash", "stiffnessHash", "settingsHash")


def require_verified_linear_context(context: dict) -> None:
    if (any(context.get(key) is not True for key in
            ("linearStatic", "effectiveSettingsVerified", "stationConventionsVerified"))
            or any(not isinstance(context.get(k), str) or not context[k].strip() for k in CONTEXT_KEYS)):
        raise AnalysisCapabilityError(engine=str(context.get("engine", "commercial")), capability="user-load-combination",
            reason="Linear native combinations require calibrated stiffness, settings and simultaneous station conventions / 原生线性组合需要已校准的刚度、有效设置与同截面内力约定")


def combine_linear_native_results(cases: dict[str, dict], factors: dict[str, float], context: dict) -> dict:
    """Combine only identical physical stations under identical verified physics."""
    require_verified_linear_context(context)
    if not factors:
        raise ValueError("An explicit non-empty factor map is required")
    selected = []
    for key, factor in factors.items():
        if isinstance(factor, bool) or not isinstance(factor, (int, float)) or not math.isfinite(factor):
            raise ValueError(f"Non-finite combination factor for '{key}'")
        if key not in cases:
            raise ValueError(f"Combination references missing case '{key}'")
        case = cases[key]
        if case.get("status") != "success" or case.get("forceSemantics") != "simultaneous-signed-stations":
            raise ValueError(f"Case '{key}' is failed, incomplete or an envelope")
        other = case.get("nativeContext", {})
        require_verified_linear_context(other)
        if any(other.get(k) != context.get(k) for k in CONTEXT_KEYS):
            raise ValueError(f"Case '{key}' has different model, stiffness, settings or engine")
        if case.get("units") != {"displacement": "m", "rotation": "rad", "force": "kN", "moment": "kN.m"}:
            raise ValueError(f"Case '{key}' has unverified units")
        selected.append((key, float(factor), case))
    prototype = selected[0][2]

    def vector_sum(rows: list[tuple[float, dict]], keys: set[str]) -> dict:
        if any(set(row) != keys for _, row in rows):
            raise ValueError("Simultaneous vectors have different component coverage")
        values = {}
        for component in sorted(keys):
            numbers = [row[component] for _, row in rows]
            if any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in numbers):
                raise ValueError(f"Non-finite native component '{component}'")
            values[component] = math.fsum(factor * row[component] for factor, row in rows)
        return values

    result = {"status": "success", "forceSemantics": "simultaneous-signed-stations",
              "units": copy.deepcopy(prototype["units"]), "nativeContext": copy.deepcopy(context),
              "source": {"kind": "linear-combination", "factors": dict(factors), "method": "signed-vector-superposition"}}
    for field in ("displacements", "reactions"):
        block = prototype.get(field, {})
        if any(set(case.get(field, {})) != set(block) for _, _, case in selected):
            raise ValueError(f"Cases have different {field} object coverage")
        result[field] = {}
        for object_id, vector in block.items():
            # R is a derived magnitude, not a signed physical component. Its
            # linear combination is wrong for non-collinear/cancelling forces.
            rows = [(factor, {key: value for key, value in case[field][object_id].items()
                              if field != "reactions" or key != "R"}) for _, factor, case in selected]
            keys = set(vector) - ({"R"} if field == "reactions" else set())
            combined = vector_sum(rows, keys)
            if field == "reactions" and {"fx", "fy", "fz"}.issubset(combined):
                combined["R"] = math.hypot(combined["fx"], combined["fy"], combined["fz"])
            result[field][object_id] = combined
    members = prototype.get("memberStations", {})
    if not members or any(set(case.get("memberStations", {})) != set(members) for _, _, case in selected):
        raise ValueError("Cases need identical complete member-station coverage")
    result["memberStations"] = {}
    for member_id, rows in members.items():
        if not rows:
            raise ValueError(f"Missing physical stations for '{member_id}'")
        if any(len(case["memberStations"][member_id]) != len(rows) for _, _, case in selected):
            raise ValueError(f"Station counts differ for '{member_id}'")
        combined = []
        seen_positions = set()
        for index, row in enumerate(rows):
            position = row.get("positionM")
            if (isinstance(position, bool) or not isinstance(position, (int, float))
                    or not math.isfinite(position) or position < 0):
                raise ValueError("Native station index is not a calibrated physical position")
            station_key = (position, row.get("side"))
            if row.get("side") not in {"left", "right", "continuous"} or station_key in seen_positions:
                raise ValueError(f"Ambiguous or duplicate physical station for '{member_id}'")
            seen_positions.add(station_key)
            for _, _, case in selected:
                other = case["memberStations"][member_id][index]
                if other.get("positionM") != position or other.get("side") != row.get("side") or other.get("referenceFrame") != "element-local":
                    raise ValueError(f"Physical station, side or axes differ for '{member_id}'")
                if other.get("localAxes") != row.get("localAxes"):
                    raise ValueError(f"Calibrated local axes differ for '{member_id}'")
            vector = vector_sum([(factor, case["memberStations"][member_id][index]["components"]) for _, factor, case in selected], set(COMPONENTS))
            station = {"positionM": position, "side": row.get("side"), "referenceFrame": "element-local", "components": vector,
                       "source": {"kind": "linear-combination", "factors": dict(factors),
                                  "cases": {key: copy.deepcopy(case["memberStations"][member_id][index].get("source"))
                                            for key, _, case in selected}}}
            if "localAxes" in row:
                station["localAxes"] = copy.deepcopy(row["localAxes"])
            combined.append(station)
        result["memberStations"][member_id] = combined
    missing = {item for _, _, case in selected for item in case.get("missingCapabilities", [])}
    if not result["displacements"] or any(not {"ux", "uy", "uz"}.issubset(row) for row in result["displacements"].values()):
        missing.add("nodal-translations")
    if not result["displacements"] or any(not {"rx", "ry", "rz"}.issubset(row) for row in result["displacements"].values()):
        missing.add("nodal-rotations")
    if not result["reactions"] or any(not {"fx", "fy", "fz", "mx", "my", "mz"}.issubset(row) for row in result["reactions"].values()):
        missing.add("nodal-reactions")
    result["missingCapabilities"] = sorted(missing)
    result["capabilityStatus"] = "partial" if missing else "complete"
    return result
