"""Read the executed YJK FE model without guessing units or filling omissions."""
from __future__ import annotations

import hashlib
import math
from pathlib import Path
import re


def _numbers(text: str) -> list[float]:
    values = [float(item) for item in text.split(",")]
    if not all(math.isfinite(value) for value in values):
        raise ValueError("Non-finite YJK FE value")
    return values


def _fields(text: str) -> dict[str, str]:
    return dict(re.findall(r"\b([A-Za-z][A-Za-z0-9_]*)=([^\s]+)", text))


def parse_fe(path: str | Path) -> dict:
    """Return native tags, explicit geometry, stiffness and original evidence hash.

    Coordinates/sections retain the file units. Callers must validate ``unit``
    before comparing them with the canonical metre/kN model.
    """
    payload = Path(path).read_bytes()
    text = payload.decode("gb18030")
    sections: dict[str, list[str]] = {}
    current, pending = "", ""
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("//"):
            continue
        if line.startswith("*"):
            if pending:
                raise ValueError("Unterminated YJK FE continuation")
            header = line[1:].split(maxsplit=1)
            current = header[0]
            sections.setdefault(current, [])
            if len(header) > 1:
                sections[current].append(header[1])
            continue
        if not current:
            continue
        pending += (" " if pending else "") + line.rstrip("&").strip()
        if not line.endswith("&"):
            sections[current].append(pending)
            pending = ""
    if pending:
        raise ValueError("Unterminated YJK FE continuation")

    def objects(name: str) -> dict[str, dict]:
        result = {}
        for line in sections.get(name, []):
            tag = line.split(maxsplit=1)[0]
            if not tag.isdigit() or tag in result:
                raise ValueError(f"Invalid/duplicate YJK FE {name} tag: {tag}")
            result[tag] = _fields(line)
        return result

    nodes = {tag: _numbers(item["C"]) for tag, item in objects("NODE").items()}
    if any(len(value) != 3 for value in nodes.values()):
        raise ValueError("YJK FE node needs three coordinates")
    frames = {}
    for tag, item in objects("FRAME").items():
        frame = {"kind": item.get("T"), "raw": item}
        for field, key in (("M", "materialId"), ("SEC", "sectionId")):
            if field in item:
                frame[key] = item[field]
        if "N" in item:
            frame["nodes"] = item["N"].split(",")
        for key in ("RF", "RZL", "E", "DIR", "R"):
            if key in item:
                frame[key] = _numbers(item[key])
        frames[tag] = frame
    result = {"nodes": nodes, "frames": frames, "sectionsRaw": sections,
              "sha256": hashlib.sha256(payload).hexdigest()}
    for section, target in (("MATERIAL", "materials"), ("SECTION", "sections")):
        result[target] = {tag: {"P": _numbers(item["P"]), "raw": item}
                          for tag, item in objects(section).items()}
    for section, field, target in (("UNIT", "UNIT", "unit"), ("STRUCTURE", "GRAV", "gravity")):
        matching = [_fields(line)[field] for line in sections.get(section, []) if field in _fields(line)]
        if len(matching) != 1:
            raise ValueError(f"YJK FE requires one explicit {field}")
        values = _numbers(matching[0])
        result[target] = values[0] if target == "gravity" else values
    return result
