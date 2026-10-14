"""Bounded DXF evidence extraction. Geometry stays in the source drawing frame."""
import io
import json
import math
import sys
from collections import Counter

import ezdxf
from ezdxf import units


def extract(text, limit=500, text_limit=200, file_path=None):
    doc = ezdxf.readfile(file_path) if file_path else ezdxf.read(io.StringIO(text))
    lines, texts, annotations, dimensions, unsupported = [], [], [], [], Counter()
    counts = Counter()
    code = int(doc.header.get("$INSUNITS", 0))
    try:
        unit_name = units.unit_name(code)
        scale = units.conversion_factor(code, units.M) if code else None
    except (ValueError, TypeError):
        unit_name, scale = f"code-{code}", None

    def point(value):
        result = [float(value.x), float(value.y), float(value.z)]
        if not all(math.isfinite(v) for v in result):
            raise ValueError("Non-finite DXF coordinates / DXF坐标不是有限值")
        return result

    def visit(entity, source, depth=0):
        if depth > 12:
            unsupported["INSERT_DEPTH_LIMIT"] += 1
            return
        kind = entity.dxftype()
        counts["expanded"] += 1
        if counts["expanded"] > 100000:
            raise ValueError("DXF expansion limit exceeded / DXF实体展开数量超限")
        layer = entity.dxf.get("layer", "0")
        effective_layer = source.get("effectiveLayer", layer) if layer == "0" else layer
        provenance = {**source, "entityType": kind, "handle": entity.dxf.get("handle"), "layer": layer, "effectiveLayer": effective_layer}
        if kind in ("INSERT", "LWPOLYLINE", "POLYLINE"):
            if kind == "POLYLINE" and not (entity.is_2d_polyline or entity.is_3d_polyline):
                unsupported[kind] += 1
                return
            try:
                children = entity.multi_insert() if kind == "INSERT" and entity.mcount > 1 else [entity]
                for instance in children:
                    for index, child in enumerate(instance.virtual_entities()):
                        visit(child, {**provenance, "parentHandle": entity.dxf.get("handle"), "childIndex": index, "blockPath": source.get("blockPath", []) + ([entity.dxf.name] if kind == "INSERT" else [])}, depth + 1)
            except (ezdxf.DXFError, NotImplementedError) as error:
                unsupported[f"{kind}:{type(error).__name__}"] += 1
        elif kind == "LINE":
            start, end = point(entity.dxf.start), point(entity.dxf.end)
            counts["line"] += 1
            if len(lines) < limit:
                lines.append(dict(zip(("x1", "y1", "z1", "x2", "y2", "z2"), start + end), layer=effective_layer, source=provenance))
        elif kind in ("TEXT", "MTEXT", "ATTRIB"):
            text_value = entity.plain_text() if kind == "MTEXT" else entity.dxf.text
            counts["text"] += 1
            if len(texts) < text_limit:
                texts.append(text_value)
                annotations.append({"text": text_value, "position": point(entity.dxf.insert), "source": provenance})
        elif kind == "DIMENSION":
            counts["dimension"] += 1
            if len(dimensions) < text_limit:
                dimensions.append({"text": entity.dxf.get("text", ""), "dimensionType": entity.dxf.dimtype,
                                   "definitionPoint": point(entity.dxf.defpoint), "source": provenance})
            # Dimension graphics are annotations, never structural member candidates.
        else:
            unsupported[kind] += 1

    for index, entity in enumerate(doc.modelspace()):
        counts["root"] += 1
        visit(entity, {"entityIndex": index, "rootHandle": entity.dxf.get("handle")})
        if entity.dxftype() == "INSERT":
            for attribute in entity.attribs:
                visit(attribute, {"entityIndex": index, "rootHandle": entity.dxf.get("handle")})
    excluded_layouts = [{"name": layout.name, "entityCount": len(layout)} for layout in doc.layouts if layout.name != "Model" and len(layout)]
    if excluded_layouts:
        unsupported["PAPERSPACE_NOT_EXTRACTED"] = sum(layout["entityCount"] for layout in excluded_layouts)
    return {"lines": lines, "texts": texts, "annotations": annotations, "dimensions": dimensions, "excludedLayouts": excluded_layouts,
            "entityCount": counts["root"], "expandedEntityCount": counts["expanded"],
            "lineEntityCount": counts["line"], "textEntityCount": counts["text"], "invalidLineCount": 0,
            "dimensionEntityCount": counts["dimension"],
            "insertionUnits": {"code": code, "name": unit_name, "metersPerUnit": scale},
            "linesTruncated": counts["line"] > len(lines), "textsTruncated": counts["text"] > len(texts),
            "dimensionsTruncated": counts["dimension"] > len(dimensions),
            "unsupportedEntities": dict(unsupported), "complete": not unsupported and counts["line"] <= len(lines) and counts["text"] <= len(texts) and counts["dimension"] <= len(dimensions),
            "parser": "ezdxf", "parserVersion": ezdxf.__version__}


if __name__ == "__main__":
    try:
        request = json.load(sys.stdin)
        data = extract(request.get("text", ""), min(max(int(request.get("maxLines", 500)), 1), 100000), min(max(int(request.get("maxTexts", 200)), 1), 100000), request.get("filePath"))
        print(json.dumps({"ok": True, "data": data}, ensure_ascii=False))
    except Exception as error:
        print(json.dumps({"ok": False, "errorCode": "INVALID_DXF", "message": str(error)}, ensure_ascii=False))
