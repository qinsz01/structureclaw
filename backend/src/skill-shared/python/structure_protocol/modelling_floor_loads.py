"""Use the existing slab panel expander without invoking a solver or inventing floor area."""
import math
from types import SimpleNamespace
from structure_protocol.floor_panels import FloorPanelLoadMixin


class ModellingFloorContext(FloorPanelLoadMixin):
    preserve_floor_segments = True

    def __init__(self, payload):
        self.nodes = {node['id']: SimpleNamespace(**node) for node in payload['nodes']}
        self.model = SimpleNamespace(elements=[SimpleNamespace(**element) for element in payload['elements']])
        self.payload = payload

    def _target_floor_nodes(self, _story):
        x0, x1 = self.payload['bounds']['x']
        y0, y1 = self.payload['bounds']['y']
        z = float(self.payload['z'])
        actual = [node for node in self.nodes.values() if abs(node.z-z) < 1e-8]
        xs = sorted({x0, x1, *(node.x for node in actual if x0 < node.x < x1)})
        ys = sorted({y0, y1, *(node.y for node in actual if y0 < node.y < y1)})
        return [SimpleNamespace(x=x, y=y, z=z) for x in xs for y in ys]

    @staticmethod
    def _get_field(value, key, fallback=None):
        return value.get(key, fallback) if isinstance(value, dict) else getattr(value, key, fallback)

    @staticmethod
    def _to_float(value, fallback=0.0):
        return fallback if value is None else float(value)


def expand_modelling_floor_load(payload):
    x0, x1 = payload['bounds']['x']
    y0, y1 = payload['bounds']['y']
    pressure = float(payload['pressureKNM2'])
    if x1 <= x0 or y1 <= y0 or not all(math.isfinite(value) for value in [x0, x1, y0, y1, pressure, float(payload['z'])]):
        raise ValueError('Invalid floor bounds or pressure / 楼面范围或面荷载无效')
    context = ModellingFloorContext(payload)
    panels = context._story_floor_panels(SimpleNamespace(id=''))
    loads = []
    mode = payload['distribution']
    if mode not in {'one-way-x', 'one-way-y', 'two-way'}:
        raise ValueError('Explicit floor transfer direction is required / 必须明确楼面传荷方向')
    for panel in panels:
        edges = panel['edges']
        required = ['x_min', 'x_max'] if mode == 'one-way-x' else ['y_min', 'y_max'] if mode == 'one-way-y' else list(edges)
        if any(not edges.get(key) for key in required):
            raise ValueError(f"Floor panel {panel['id']} has missing supporting beams / 楼板单元缺少支承梁")
        loads.extend(context._two_way_panel_loads(panel, pressure) if mode == 'two-way'
                     else context._one_way_panel_loads(panel, pressure, 'x' if mode == 'one-way-x' else 'y'))
    if not loads:
        raise ValueError('No supported floor panels / 没有完整支承的楼板单元')
    for load in loads:
        load['source'] = 'modelling_floor_loads'
    return {'loads': loads, 'totalKN': pressure * (x1-x0) * (y1-y0)}
