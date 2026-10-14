"""Strict, lossless ground-motion input. File samples never come from previews."""
from __future__ import annotations

import csv
import hashlib
import io
import json
import math
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass
class ParsedGroundMotionValues:
    values: list[float]
    inferred_dt: float | None = None
    source_format: str = "values"
    inferred_unit: str | None = None
    time_origin: float = 0.0
    source: dict[str, Any] | None = None


def _first(record: dict, *keys: str) -> Any:
    return next((record[key] for key in keys if key in record and record[key] is not None), None)


def _number(value: Any, where: str) -> float:
    if isinstance(value, bool) or value is None or isinstance(value, str) and not value.strip():
        raise ValueError(f"GROUND_MOTION_BAD_CELL: {where}")
    try:
        result = float(value)
    except (ValueError, TypeError, OverflowError) as error:
        raise ValueError(f"GROUND_MOTION_BAD_CELL: {where}") from error
    if not math.isfinite(result):
        raise ValueError(f"GROUND_MOTION_BAD_CELL: {where}")
    return result


def unit_scale(unit: str) -> float:
    key = str(unit).strip().lower().replace("²", "2").replace("^", "").replace(" ", "")
    scales = {"g": 9.80665, "gravity": 9.80665, "gal": .01, "cm/s2": .01,
              "m/s2": 1.0, "m/s/s": 1.0, "mm/s2": .001}
    if key not in scales:
        raise ValueError(f"GROUND_MOTION_UNIT_REQUIRED_OR_UNSUPPORTED: {unit}")
    return scales[key]


def _column(value: Any, headers: list, label: str) -> int:
    if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
        return value
    if isinstance(value, str):
        matches = [i for i, name in enumerate(headers) if str(name).strip().lower() == value.strip().lower()]
        if len(matches) == 1:
            return matches[0]
    raise ValueError(f"GROUND_MOTION_COLUMN_REQUIRED_OR_AMBIGUOUS: {label}={value}")


def _header_unit(header: Any) -> str | None:
    text = str(header).strip().lower().replace("²", "2").replace("^", "")
    for token in ("mm/s2", "cm/s2", "m/s2", "gal", "g"):
        if re.search(r"(?:^|[_\s(\[])+" + re.escape(token) + r"(?:$|[)\]\s])", text):
            return token
    return None


def _time_scale(record: dict, header: Any) -> float:
    explicit = _first(record, "timeUnit", "time_unit")
    text = str(header).strip().lower()
    # The public 'time'/'t' columns are seconds; an annotated column overrides it.
    annotation = re.search(r"(?:_|\(|\[|\s)([^_\s()\[\]]+)[)\]]?$", text)
    unit = explicit if explicit is not None else annotation.group(1) if annotation else "s"
    if str(unit).strip().lower() in {"s", "sec", "second", "seconds"}:
        return 1.0
    if str(unit).strip().lower() in {"ms", "millisecond", "milliseconds"}:
        return .001
    raise ValueError(f"GROUND_MOTION_TIME_UNIT_UNSUPPORTED: {unit}")


def _time_axis(times: list[float]) -> float:
    if len(times) < 2:
        raise ValueError("GROUND_MOTION_TIME_AXIS_TOO_SHORT")
    dt = times[1] - times[0]
    # Only floating-point representation noise is admitted, not variable sampling.
    tolerance = 64 * math.ulp(max(max(abs(v) for v in times), abs(dt), 1.0))
    if dt <= 0 or any(value <= previous or abs((value - previous) - dt) > tolerance
                      for previous, value in zip(times, times[1:])):
        raise ValueError("GROUND_MOTION_TIME_AXIS_NOT_UNIFORM_INCREASING")
    return dt


def _rows(record: dict) -> ParsedGroundMotionValues:
    rows = record.get("rows")
    if not isinstance(rows, list) or not rows:
        raise ValueError("GROUND_MOTION_SAMPLES_REQUIRED")
    headers = record.get("headers", [])
    if not isinstance(headers, list):
        raise ValueError("GROUND_MOTION_HEADERS_INVALID")
    # A headerless table reader may expose the first numeric row as headers.
    if headers and all(isinstance(v, (int, float, str)) and re.fullmatch(r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?", str(v).strip()) for v in headers):
        rows, headers = [headers, *rows], []
    elif any(re.fullmatch(r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?", str(v).strip()) for v in headers):
        raise ValueError("GROUND_MOTION_HEADER_OR_FIRST_SAMPLE_INVALID")
    time_spec = _first(record, "timeColumn", "time_column")
    acc_spec = _first(record, "accelerationColumn", "accelColumn", "valueColumn", "acceleration_column")
    normalized = [str(value).strip().lower() for value in headers]
    time_candidates = [i for i, value in enumerate(normalized) if re.fullmatch(r"(?:time|t|sec|second|seconds)(?:[_\s(\[].*)?", value)]
    acc_candidates = [i for i, value in enumerate(normalized) if re.match(r"^(?:acc(?:el(?:eration)?)?|ag|a)(?:$|[_\s(\[])", value) or value in {"g", "gal", "m/s2", "cm/s2"}]
    if time_spec is not None:
        time_col = _column(time_spec, headers, "time")
    elif len(time_candidates) == 1:
        time_col = time_candidates[0]
    elif time_candidates:
        raise ValueError("GROUND_MOTION_TIME_COLUMN_AMBIGUOUS")
    else:
        time_col = None
    if acc_spec is not None:
        acc_col = _column(acc_spec, headers, "acceleration")
    elif len(acc_candidates) == 1:
        acc_col = acc_candidates[0]
    elif not headers and all(isinstance(row, (list, tuple)) and len(row) == 1 for row in rows):
        acc_col = 0
    else:
        raise ValueError("GROUND_MOTION_ACCELERATION_COLUMN_REQUIRED_OR_AMBIGUOUS")
    if time_col == acc_col:
        raise ValueError("GROUND_MOTION_TIME_AND_ACCELERATION_COLUMN_CONFLICT")
    def cell(row: Any, index: int, number: int) -> float:
        if isinstance(row, dict):
            if index >= len(headers) or headers[index] not in row:
                raise ValueError(f"GROUND_MOTION_MISSING_CELL: row {number}, column {index}")
            return _number(row[headers[index]], f"row {number}, column {index}")
        if not isinstance(row, (list, tuple)) or index >= len(row):
            raise ValueError(f"GROUND_MOTION_MISSING_CELL: row {number}, column {index}")
        return _number(row[index], f"row {number}, column {index}")
    values = [cell(row, acc_col, i + 1) for i, row in enumerate(rows)]
    header = headers[time_col] if time_col is not None and time_col < len(headers) else ""
    times = [cell(row, time_col, i + 1) * _time_scale(record, header) for i, row in enumerate(rows)] if time_col is not None else []
    return ParsedGroundMotionValues(values, _time_axis(times) if times else None, "rows",
                                   _header_unit(headers[acc_col]) if acc_col < len(headers) else None,
                                   times[0] if times else 0.0)


def _text(text: str, record: dict) -> ParsedGroundMotionValues:
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    marker = next((i for i, line in enumerate(lines) if re.search(r"\bNPTS\s*=", line, re.I)), None)
    if marker is not None:
        header = lines[marker]
        npts = re.search(r"\bNPTS\s*=\s*(\d+)", header, re.I)
        dt = re.search(r"\bDT\s*=\s*([+\-\d.eE]+)\s*(SEC|S)?", header, re.I)
        if not npts or not dt:
            raise ValueError("GROUND_MOTION_AT2_HEADER_INVALID")
        tokens = [token for line in lines[marker + 1:] for token in re.split(r"[\s,;]+", line)]
        values = [_number(value, f"AT2 sample {i+1}") for i, value in enumerate(tokens)]
        if len(values) != int(npts.group(1)):
            raise ValueError(f"GROUND_MOTION_SAMPLE_COUNT_MISMATCH: expected {npts.group(1)}, found {len(values)}")
        unit_match = re.search(r"(?:UNITS?\s+OF|UNITS?\s*[:=])\s*(G|GAL|CM/S\^?2|M/S\^?2)\b", " ".join(lines[:marker]), re.I)
        return ParsedGroundMotionValues(values, _number(dt.group(1), "AT2 dt"), "text", unit_match.group(1) if unit_match else None)
    if not lines:
        raise ValueError("GROUND_MOTION_SAMPLES_REQUIRED")
    separator = "\t" if "\t" in lines[0] else "," if "," in lines[0] else ";" if ";" in lines[0] else None
    rows = list(csv.reader(io.StringIO(text), delimiter=separator)) if separator else [line.split() for line in lines]
    first_numeric = all(re.fullmatch(r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?", str(value).strip()) for value in rows[0])
    parsed = _rows({**record, "headers": [] if first_numeric else rows[0], "rows": rows if first_numeric else rows[1:]})
    parsed.source_format = "text"
    return parsed


def _file_record(record: dict) -> tuple[dict, dict]:
    reference = record["fileReference"]
    if not isinstance(reference, dict) or reference.get("format") != "sclaw-parsed-input-v1":
        raise ValueError("GROUND_MOTION_FILE_REFERENCE_INVALID")
    for file_key, hash_key in (("path", "sha256"), ("parsedPath", "parsedSha256")):
        file_path, expected = reference.get(file_key), reference.get(hash_key)
        if not isinstance(file_path, str) or not isinstance(expected, str):
            raise ValueError("GROUND_MOTION_FILE_REFERENCE_INVALID")
        path = Path(file_path)
        if not path.is_file() or path.stat().st_size > 50 * 1024 * 1024:
            raise ValueError("GROUND_MOTION_FILE_UNAVAILABLE_OR_TOO_LARGE")
        data = path.read_bytes()
        if hashlib.sha256(data).hexdigest() != expected:
            raise ValueError(f"GROUND_MOTION_FILE_HASH_MISMATCH: {file_key}")
    payload = json.loads(data)
    if payload.get("format") != reference["format"] or payload.get("source", {}).get("sha256") != reference["sha256"]:
        raise ValueError("GROUND_MOTION_PARSED_SOURCE_MISMATCH")
    if payload.get("type") == "excel":
        sheet = record.get("sheetName")
        if not isinstance(sheet, str) or sheet not in payload.get("sheets", {}):
            raise ValueError("GROUND_MOTION_SHEET_REQUIRED")
        selected = payload["sheets"][sheet]
    else:
        selected = payload
    settings = {key: value for key, value in record.items() if key not in
                {"values", "accelerations", "accel", "rows", "headers", "content", "text", "csv", "at2", "data", "fileReference"}}
    return {**selected, **settings}, {**reference, "sheetName": record.get("sheetName")}


def values(record: dict) -> ParsedGroundMotionValues:
    if not isinstance(record, dict):
        raise ValueError("GROUND_MOTION_RECORD_INVALID")
    source = None
    if "fileReference" in record:
        record, source = _file_record(record)
    if record.get("truncated"):
        raise ValueError("GROUND_MOTION_TRUNCATED_INPUT")
    for key in ("values", "accelerations", "accel"):
        if key in record:
            if not isinstance(record[key], list):
                raise ValueError("GROUND_MOTION_VALUES_INVALID")
            parsed = ParsedGroundMotionValues([_number(value, f"sample {i+1}") for i, value in enumerate(record[key])])
            break
    else:
        if "rows" in record:
            parsed = _rows(record)
        else:
            text = _first(record, "content", "text", "csv", "at2", "data")
            if isinstance(text, str):
                parsed = _text(text, record)
            else:
                nested = next((record[key] for key in ("fileAnalysis", "analysis", "parsedFile", "file") if isinstance(record.get(key), dict)), None)
                if nested is None:
                    raise ValueError("GROUND_MOTION_SAMPLES_REQUIRED")
                parsed = values({**nested, **{k: v for k, v in record.items() if k not in ("fileAnalysis", "analysis", "parsedFile", "file")}})
    if not parsed.values:
        raise ValueError("GROUND_MOTION_SAMPLES_REQUIRED")
    explicit_dt = _first(record, "dt", "timeStep", "time_step")
    dt = _number(explicit_dt, "dt") if explicit_dt is not None else parsed.inferred_dt
    if dt is None or dt <= 0:
        raise ValueError("GROUND_MOTION_DT_REQUIRED_OR_INVALID")
    if parsed.inferred_dt is not None and not math.isclose(dt, parsed.inferred_dt, rel_tol=1e-12, abs_tol=1e-14):
        raise ValueError("GROUND_MOTION_DT_CONFLICT")
    unit = record.get("unit") if record.get("unit") is not None else parsed.inferred_unit
    scale = unit_scale(unit)
    if parsed.inferred_unit is not None and scale != unit_scale(parsed.inferred_unit):
        raise ValueError("GROUND_MOTION_UNIT_CONFLICT")
    parsed.inferred_dt, parsed.inferred_unit, parsed.source = dt, str(unit), source
    return parsed


def motion_direction(record: dict) -> str | None:
    raw = [_first(record, key) for key in ("direction", "component", "axis", "seismicDirection") if _first(record, key) is not None]
    mapped = []
    for value in raw:
        key = str(value).strip().lower()
        if key not in {"x", "global_x", "ux", "y", "global_y", "uy"}:
            # Geographic component names require an explicit global-axis mapping.
            raise ValueError(f"GROUND_MOTION_DIRECTION_REQUIRED_OR_UNSUPPORTED: {value}")
        mapped.append("x" if key in {"x", "global_x", "ux"} else "y")
    if len(set(mapped)) > 1:
        raise ValueError("GROUND_MOTION_DIRECTION_CONFLICT")
    return mapped[0] if mapped else None
