"""Bounded DXF evidence extraction. Geometry stays in the source drawing frame."""
import io
import json
import math
import sys
from collections import Counter

import ezdxf
from ezdxf import units
from ezdxf.xclip import XClip


MAX_INSERT_DEPTH = 12
MAX_EXPANDED_ENTITIES = 100000


def extract(text, limit=500, text_limit=200, file_path=None):
    doc = ezdxf.readfile(file_path) if file_path else ezdxf.read(io.StringIO(text))
    lines, texts, annotations, dimensions, unsupported = [], [], [], [], Counter()
    counts = Counter()
    ignored = Counter()
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

    def visit(entity, source, depth=0, parent_matrix=None):
        if depth > MAX_INSERT_DEPTH:
            unsupported["INSERT_DEPTH_LIMIT"] += 1
            return
        kind = entity.dxftype()
        counts["expanded"] += 1
        if counts["expanded"] > MAX_EXPANDED_ENTITIES:
            raise ValueError("DXF expansion limit exceeded / DXF实体展开数量超限")
        layer = entity.dxf.get("layer", "0")
        effective_layer = source.get("effectiveLayer", layer) if layer == "0" else layer
        provenance = {**source, "entityType": kind, "handle": entity.dxf.get("handle"), "layer": layer, "effectiveLayer": effective_layer}
        if parent_matrix is not None and kind in ("LINE", "TEXT", "MTEXT", "ATTRIB", "DIMENSION"):
            if kind in ("TEXT", "MTEXT", "ATTRIB") and source.get("nonUniformScaling"):
                # ezdxf does not guarantee accurate text transforms under anisotropic scaling.
                unsupported["INSERT_NON_UNIFORM_TEXT"] += 1
                return
            try:
                entity = entity.copy().transform(parent_matrix)
            except (ezdxf.DXFError, NotImplementedError, ValueError):
                unsupported[f"INSERT_TRANSFORM:{kind}"] += 1
                return
        if kind == "INSERT":
            block = entity.block()
            if block is None:
                unsupported["INSERT_BLOCK_NOT_FOUND"] += 1
                return
            if block.block.is_xref:
                unsupported["INSERT_EXTERNAL_REFERENCE"] += 1
                return
            clip = XClip(entity)
            if clip.has_clipping_path and clip.is_clipping_enabled:
                # virtual_entities ignores XCLIP: never expose hidden geometry as complete.
                unsupported["INSERT_CLIPPING"] += 1
                return

            references = entity.multi_insert() if entity.mcount > 1 else (entity,)
            try:
                for instance, reference in enumerate(references):
                    if reference is not entity:
                        counts["expanded"] += 1
                        if counts["expanded"] > MAX_EXPANDED_ENTITIES:
                            raise ValueError("DXF expansion limit exceeded / DXF实体展开数量超限")
                    insertion = reference.ocs().to_wcs(reference.dxf.insert)
                    if parent_matrix is not None:
                        insertion = parent_matrix.transform(insertion)
                    block_source = {**provenance, "insertPath": [*source.get("insertPath", []),
                        {"name": reference.dxf.name, "position": point(insertion), "instance": instance}],
                        "nonUniformScaling": source.get("nonUniformScaling", False) or not reference.has_uniform_scaling}
                    matrix = reference.matrix44()
                    if parent_matrix is not None:
                        matrix = matrix @ parent_matrix
                    # Expand in definition coordinates before composing transformations.
                    # Transforming a nested MINSERT first loses its scaled grid spacing.
                    for index, child in enumerate(block):
                        if child.dxftype() == "ATTDEF":
                            continue  # Instantiated values are in reference.attribs.
                        visit(child, {**block_source, "parentHandle": entity.dxf.get("handle"), "childIndex": index}, depth + 1, matrix)
                    for index, attribute in enumerate(reference.attribs):
                        # Attached ATTRIB positions already include their own INSERT transform.
                        visit(attribute, {**block_source, "attributeIndex": index,
                            "nonUniformScaling": source.get("nonUniformScaling", False)}, depth + 1, parent_matrix)
            except (ezdxf.DXFError, NotImplementedError) as error:
                unsupported[f"INSERT:{type(error).__name__}"] += 1
        elif kind in ("CIRCLE", "ARC", "LEADER", "MLEADER", "MULTILEADER", "SOLID", "HATCH"):
            if kind == "ARC" and source.get("entityType") in ("LWPOLYLINE", "POLYLINE"):
                unsupported["CURVED_POLYLINE"] += 1
            else:
                ignored[kind] += 1
        elif kind in ("LWPOLYLINE", "POLYLINE"):
            if kind == "POLYLINE" and not (entity.is_2d_polyline or entity.is_3d_polyline):
                unsupported[kind] += 1
                return
            try:
                for index, child in enumerate(entity.virtual_entities()):
                    visit(child, {**provenance, "parentHandle": entity.dxf.get("handle"), "childIndex": index}, depth + 1, parent_matrix)
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
                try:
                    measurement = entity.get_measurement()
                    measurement = list(measurement) if hasattr(measurement, "x") else float(measurement)
                    values = measurement if isinstance(measurement, list) else [measurement]
                    if not all(math.isfinite(value) for value in values):
                        raise ValueError("Non-finite dimension")
                except (ezdxf.DXFError, ValueError, TypeError, AttributeError, NotImplementedError):
                    measurement = None
                    unsupported["DIMENSION_MEASUREMENT"] += 1
                angular = entity.dimtype in (2, 5)
                dimensions.append({"text": entity.dxf.get("text", ""), "dimensionType": entity.dxf.dimtype,
                                   "measurement": measurement, "measurementUnit": "degree" if angular else unit_name,
                                   "metersPerUnit": None if angular else scale,
                                   "definitionPoint": point(entity.dxf.defpoint),
                                   "definitionPoints": {name: point(entity.dxf.get(name)) for name in
                                                        ("defpoint", "defpoint2", "defpoint3", "defpoint4", "defpoint5")
                                                        if entity.dxf.hasattr(name)}, "source": provenance})
            # Dimension graphics are annotations, never structural member candidates.
        else:
            unsupported[kind] += 1

    for index, entity in enumerate(doc.modelspace()):
        counts["root"] += 1
        visit(entity, {"entityIndex": index, "rootHandle": entity.dxf.get("handle")})
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
            "ignoredAnnotations": dict(ignored),
            "annotationNote": "Ignored as annotation; not structural geometry / 作为注释忽略，不作为结构几何",
            "unsupportedEntities": dict(unsupported), "complete": not unsupported and counts["line"] <= len(lines) and counts["text"] <= len(texts) and counts["dimension"] <= len(dimensions),
            "parser": "ezdxf", "parserVersion": ezdxf.__version__}


if __name__ == "__main__":
    try:
        request = json.load(sys.stdin)
        data = extract(request.get("text", ""), min(max(int(request.get("maxLines", 500)), 1), 100000), min(max(int(request.get("maxTexts", 200)), 1), 100000), request.get("filePath"))
        print(json.dumps({"ok": True, "data": data}, ensure_ascii=False))
    except Exception as error:
        print(json.dumps({"ok": False, "errorCode": "INVALID_DXF", "message": str(error)}, ensure_ascii=False))
