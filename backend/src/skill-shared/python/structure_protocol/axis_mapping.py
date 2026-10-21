"""Exact right-handed signed-axis mappings; no inferred source frame."""
from copy import deepcopy
import math

AXES = "xyz"


def axis_mapping(frame):
    """Source basis directions expressed in canonical coordinates."""
    if frame == "y-up":
        frame = {"x": "x", "y": "z", "z": "-y"}
    elif frame == "z-up":
        frame = dict(zip(AXES, AXES))
    if not isinstance(frame, dict) or set(frame) != set(AXES):
        raise ValueError("source_frame requires x/y/z signed axes or y-up/z-up / 源坐标系须指定三轴或 y-up/z-up")
    columns = []
    for axis in AXES:
        value = frame[axis]
        if value not in ("x", "y", "z", "+x", "+y", "+z", "-x", "-y", "-z"):
            raise ValueError("Only orthogonal signed axes are supported / 仅支持正交有向坐标轴")
        columns.append((AXES.index(value[-1]), -1 if value.startswith("-") else 1))
    indices = [item[0] for item in columns]
    inversions = sum(indices[i] > indices[j] for i in range(3) for j in range(i + 1, 3))
    if len(set(indices)) != 3 or (-1) ** inversions * math.prod(item[1] for item in columns) != 1:
        raise ValueError("Source axes must form a right-handed frame / 源坐标轴须构成右手系")
    return columns


def map_vector(values, frame, *, inverse=False, restraints=False):
    columns = axis_mapping(frame)
    if len(values) not in (3, 6):
        raise ValueError("Axis vector requires 3 or 6 components / 向量须有三个或六个分量")
    output = [False if restraints else 0.] * len(values)
    for offset in range(0, len(values), 3):
        for source, (target, sign) in enumerate(columns):
            source, target = (target, source) if inverse else (source, target)
            value = values[offset + source]
            if restraints:
                if type(value) is not bool:
                    raise ValueError("Restraints must be boolean / 约束须为布尔值")
                output[offset + target] = value
            else:
                if type(value) not in (int, float) or not math.isfinite(value):
                    raise ValueError("Vector components must be finite / 向量分量须为有限数值")
                output[offset + target] = value * sign
    return output


def _record(row, keys, frame, inverse=False):
    if any(key in row for key in keys):
        values = map_vector([row.get(key, 0.) for key in keys], frame, inverse=inverse)
        row.update(zip(keys, values))


def canonicalize_source_frame(model):
    """Consume source_frame once and retain its reversible mapping in metadata."""
    if model.get("source_frame") is None:
        return deepcopy(model)
    result = deepcopy(model)
    frame = result.pop("source_frame")
    axis_mapping(frame)
    # Building stories describe elevation along source up, so only a declared
    # positive source-up to canonical Z is representable by scalar elevations.
    if result.get("stories") and not (frame in ("y-up", "z-up") if isinstance(frame, str)
                                     else any(value in ("z", "+z") for value in frame.values())):
        raise ValueError("Story elevations require positive source up / 楼层标高需要源坐标正向竖轴")
    if result.get("wall_openings") or result.get("slab_openings"):
        raise ValueError("Source-frame openings are not mapped / 源坐标洞口暂不支持映射")
    for node in result.get("nodes", []):
        _record(node, tuple(AXES), frame)
        if "restraints" in node:
            node["restraints"] = map_vector(node["restraints"], frame, restraints=True)
    for case in result.get("load_cases", []):
        for load in case.get("loads", []):
            if load.get("reference_frame", "global") == "element-local":
                continue
            if any(key in load for key in ("direction", "axis", "value", "magnitude")):
                raise ValueError("Source-frame loads require vector components / 源坐标荷载须使用向量分量")
            for keys in (("fx", "fy", "fz"), ("mx", "my", "mz"), ("wx", "wy", "wz"),
                         ("ux", "uy", "uz"), ("rx", "ry", "rz")):
                _record(load, keys, frame)
            if "forces" in load:
                load["forces"] = map_vector(load["forces"], frame)
    metadata = result.setdefault("metadata", {})
    for key, vector in metadata.get("elementReferenceVectors", {}).items():
        metadata["elementReferenceVectors"][key] = map_vector(vector, frame)
    controls = result.get("analysis_control") or {}
    if controls.get("gravity_direction"):
        direction = controls["gravity_direction"]
        vector = [(-1 if direction.startswith("-") else 1) if axis == direction[-1] else 0 for axis in AXES]
        mapped = map_vector(vector, frame)
        controls["gravity_direction"] = next(("-" if value < 0 else "") + AXES[i] for i, value in enumerate(mapped) if value)
    if controls.get("mass_directions"):
        columns = axis_mapping(frame)
        controls["mass_directions"] = [AXES[columns[AXES.index(axis)][0]] for axis in controls["mass_directions"]]
    metadata["sourceFrameMapping"] = {"sourceFrame": frame, "canonicalFrame": "global-z-up"}
    metadata["coordinateSemantics"] = "global-z-up"
    return result


def results_in_source_frame(result, frame):
    """Return a source-coordinate view; member-local forces stay member-local."""
    output = deepcopy(result)
    def transform(view):
        for field, families in (("displacements", (("ux", "uy", "uz"), ("rx", "ry", "rz"))),
                                ("reactions", (("fx", "fy", "fz"), ("mx", "my", "mz")))):
            for row in view.get(field, {}).values():
                for keys in families:
                    _record(row, keys, frame, inverse=True)
        for field in ("caseResults", "combinationResults"):
            for row in view.get(field, {}).values():
                transform(row)
    transform(output)
    output["referenceFrame"] = {"sourceFrame": deepcopy(frame)}
    return output
