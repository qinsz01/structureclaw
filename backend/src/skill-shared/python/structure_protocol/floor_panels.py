"""Floor panel geometry and one-/two-way panel load transfer methods of ``StaticLoadContext``.

Shared by static analysis and deterministic modelling operations.
"""

from typing import Dict, Any, List, Optional, Tuple


class FloorPanelLoadMixin:
    _floor_transfer_error = ValueError
    preserve_floor_segments = False

    def _story_floor_panels(self, story: Any) -> List[Dict[str, Any]]:
        target_nodes = self._target_floor_nodes(story)
        if not target_nodes:
            return []

        z_values = self._unique_sorted_coordinates(float(node.z) for node in target_nodes)
        if len(z_values) != 1:
            return []
        z = z_values[0]
        x_values = self._unique_sorted_coordinates(float(node.x) for node in target_nodes)
        y_values = self._unique_sorted_coordinates(float(node.y) for node in target_nodes)
        if len(x_values) < 2 or len(y_values) < 2:
            return []

        story_id = str(self._get_field(story, 'id', ''))
        panels: List[Dict[str, Any]] = []
        for x_idx in range(len(x_values) - 1):
            for y_idx in range(len(y_values) - 1):
                x0 = x_values[x_idx]
                x1 = x_values[x_idx + 1]
                y0 = y_values[y_idx]
                y1 = y_values[y_idx + 1]
                edges = {
                    'x_min': self._find_beam_between(z, x0, y0, x0, y1, story_id),
                    'x_max': self._find_beam_between(z, x1, y0, x1, y1, story_id),
                    'y_min': self._find_beam_between(z, x0, y0, x1, y0, story_id),
                    'y_max': self._find_beam_between(z, x0, y1, x1, y1, story_id),
                }
                panels.append({
                    'id': f"{story_id or 'story'}:{x_idx + 1}:{y_idx + 1}",
                    'story': story_id,
                    'z': z,
                    'x0': x0,
                    'x1': x1,
                    'y0': y0,
                    'y1': y1,
                    'lx': x1 - x0,
                    'ly': y1 - y0,
                    'edges': edges,
                })
        return panels

    def _find_beam_between(
        self,
        z: float,
        x1: float,
        y1: float,
        x2: float,
        y2: float,
        story_id: str,
    ) -> Optional[Dict[str, Any]]:
        for elem in self.model.elements:
            if getattr(elem, 'type', '') != 'beam' or len(elem.nodes) < 2:
                continue
            if story_id and getattr(elem, 'story', None) not in {None, story_id}:
                continue
            start = self.nodes.get(elem.nodes[0])
            end = self.nodes.get(elem.nodes[1])
            if start is None or end is None:
                continue
            p_start = (float(start.x), float(start.y), float(start.z))
            p_end = (float(end.x), float(end.y), float(end.z))
            a = (x1, y1, z)
            b = (x2, y2, z)
            if self._segment_contains_points(p_start, p_end, a, b):
                direction = tuple(p_end[idx] - p_start[idx] for idx in range(3))
                length_sq = sum(value * value for value in direction)
                first_fraction = sum((a[idx] - p_start[idx]) * direction[idx] for idx in range(3)) / length_sq
                second_fraction = sum((b[idx] - p_start[idx]) * direction[idx] for idx in range(3)) / length_sq
                return {
                    'id': str(elem.id),
                    'segmentLength': self._point_distance(a, b),
                    'elementLength': self._point_distance(p_start, p_end),
                    'startFraction': max(0.0, min(first_fraction, second_fraction)),
                    'endFraction': min(1.0, max(first_fraction, second_fraction)),
                }
        return None

    def _points_match(self, first: Tuple[float, float, float], second: Tuple[float, float, float]) -> bool:
        tolerance = 1e-6
        return all(abs(first[idx] - second[idx]) <= tolerance for idx in range(3))

    def _segment_contains_points(
        self,
        start: Tuple[float, float, float],
        end: Tuple[float, float, float],
        first: Tuple[float, float, float],
        second: Tuple[float, float, float],
    ) -> bool:
        return self._point_on_segment(first, start, end) and self._point_on_segment(second, start, end)

    def _point_on_segment(
        self,
        point: Tuple[float, float, float],
        start: Tuple[float, float, float],
        end: Tuple[float, float, float],
    ) -> bool:
        tolerance = 1e-6
        direction = tuple(end[idx] - start[idx] for idx in range(3))
        relative = tuple(point[idx] - start[idx] for idx in range(3))
        length_sq = sum(value * value for value in direction)
        if length_sq <= tolerance ** 2:
            return self._points_match(point, start)
        cross = (
            relative[1] * direction[2] - relative[2] * direction[1],
            relative[2] * direction[0] - relative[0] * direction[2],
            relative[0] * direction[1] - relative[1] * direction[0],
        )
        cross_norm_sq = sum(value * value for value in cross)
        if cross_norm_sq > (tolerance ** 2) * length_sq:
            return False
        dot = sum(relative[idx] * direction[idx] for idx in range(3))
        return -tolerance <= dot <= length_sq + tolerance

    def _point_distance(self, first: Tuple[float, float, float], second: Tuple[float, float, float]) -> float:
        return sum((first[idx] - second[idx]) ** 2 for idx in range(3)) ** 0.5

    def _panel_floor_loads(
        self,
        panel: Dict[str, Any],
        intensity: float,
        requested_mode: str,
    ) -> List[Dict[str, Any]]:
        lx = self._to_float(panel.get('lx', 0.0), 0.0)
        ly = self._to_float(panel.get('ly', 0.0), 0.0)
        if lx <= 0.0 or ly <= 0.0:
            return []

        edges = panel.get('edges') if isinstance(panel.get('edges'), dict) else {}
        edge_ids = {key: value for key, value in edges.items() if value}
        ratio = max(lx, ly) / min(lx, ly)
        mode = self._classify_panel_transfer_mode(requested_mode, lx, ly, edge_ids)
        if mode is None:
            self._append_floor_load_warning(f"Panel {panel.get('id')}: supporting beams are incomplete.")
            return []

        if mode == 'one_way_slab':
            loads = self._one_way_panel_loads(panel, intensity)
        else:
            loads = self._two_way_panel_loads(panel, intensity)

        total_load = intensity * lx * ly
        trace_item = {
            'story': panel.get('story'),
            'panelId': panel.get('id'),
            'requestedMode': requested_mode,
            'effectiveMode': mode,
            'method': self._floor_load_transfer_method_label(mode),
            'methodEn': self._floor_load_transfer_method_label(mode),
            'methodZh': self._floor_load_transfer_method_label_zh(mode),
            'designCodeRule': self._panel_design_code_rule(mode, ratio, edge_ids),
            'designCodeRuleEn': self._panel_design_code_rule(mode, ratio, edge_ids),
            'designCodeRuleZh': self._panel_design_code_rule_zh(mode, ratio, edge_ids),
            'spanX': lx,
            'spanY': ly,
            'longShortRatio': ratio,
            'loadIntensityKNPerM2': intensity,
            'generatedLoadType': 'distributed',
            'generatedLoadCount': len(loads),
            'totalLoadKN': total_load,
        }
        if mode == 'two_way_slab':
            trace_item['note'] = (
                'Two-way slab triangular and trapezoidal line loads are integrated with '
                'three-point Gaussian beam loads, preserving their consistent end actions.'
            )
            trace_item['noteEn'] = trace_item['note']
            trace_item['noteZh'] = '双向板三角形和梯形线荷载采用三点高斯梁荷载积分，保持一致节点力和端弯矩。'
        self._append_floor_load_trace_item(trace_item)
        return loads

    def _classify_panel_transfer_mode(
        self,
        requested_mode: str,
        lx: float,
        ly: float,
        edge_ids: Dict[str, Any],
    ) -> Optional[str]:
        has_x_pair = bool(edge_ids.get('x_min') and edge_ids.get('x_max'))
        has_y_pair = bool(edge_ids.get('y_min') and edge_ids.get('y_max'))

        if requested_mode == 'one_way_slab':
            return 'one_way_slab' if (has_x_pair or has_y_pair) else None
        if requested_mode == 'two_way_slab':
            return 'two_way_slab' if (has_x_pair and has_y_pair) else None

        if has_x_pair and has_y_pair:
            ratio = max(lx, ly) / min(lx, ly)
            return 'one_way_slab' if ratio >= 3.0 else 'two_way_slab'
        if has_x_pair or has_y_pair:
            return 'one_way_slab'
        return None

    def _panel_design_code_rule(self, mode: str, ratio: float, edge_ids: Dict[str, Any]) -> str:
        if not (edge_ids.get('x_min') and edge_ids.get('x_max') and edge_ids.get('y_min') and edge_ids.get('y_max')):
            return 'GB 50010 9.1.1: slab supported on two opposite sides is calculated as one-way slab.'
        if mode == 'one_way_slab':
            return 'GB 50010 9.1.1: four-side supported slab with long/short span ratio >= 3.0 may be calculated as one-way slab along the short span.'
        if ratio <= 2.0:
            return 'GB 50010 9.1.1: four-side supported slab with long/short span ratio <= 2.0 is calculated as two-way slab.'
        return 'GB 50010 9.1.1: four-side supported slab with long/short span ratio between 2.0 and 3.0 is preferably calculated as two-way slab.'

    def _panel_design_code_rule_zh(self, mode: str, ratio: float, edge_ids: Dict[str, Any]) -> str:
        if not (edge_ids.get('x_min') and edge_ids.get('x_max') and edge_ids.get('y_min') and edge_ids.get('y_max')):
            return 'GB 50010 9.1.1：两对边支承板按单向板计算。'
        if mode == 'one_way_slab':
            return 'GB 50010 9.1.1：四边支承板长短边比不小于 3.0 时，可按沿短边方向受力的单向板计算。'
        if ratio <= 2.0:
            return 'GB 50010 9.1.1：四边支承板长短边比不大于 2.0 时，按双向板计算。'
        return 'GB 50010 9.1.1：四边支承板长短边比大于 2.0 且小于 3.0 时，宜按双向板计算。'

    def _one_way_panel_loads(self, panel: Dict[str, Any], intensity: float, direction: Optional[str] = None) -> List[Dict[str, Any]]:
        lx = self._to_float(panel.get('lx', 0.0), 0.0)
        ly = self._to_float(panel.get('ly', 0.0), 0.0)
        edges = panel.get('edges') if isinstance(panel.get('edges'), dict) else {}

        if (direction == 'x' or direction is None and lx <= ly) and edges.get('x_min') and edges.get('x_max'):
            line_load = intensity * lx / 2.0
            return [
                self._distributed_gravity_load(edges['x_min'], line_load, panel),
                self._distributed_gravity_load(edges['x_max'], line_load, panel),
            ]
        if direction in {None, 'y'} and edges.get('y_min') and edges.get('y_max'):
            line_load = intensity * ly / 2.0
            return [
                self._distributed_gravity_load(edges['y_min'], line_load, panel),
                self._distributed_gravity_load(edges['y_max'], line_load, panel),
            ]
        return []

    def _two_way_panel_loads(self, panel: Dict[str, Any], intensity: float) -> List[Dict[str, Any]]:
        lx = self._to_float(panel.get('lx', 0.0), 0.0)
        ly = self._to_float(panel.get('ly', 0.0), 0.0)
        edges = panel.get('edges') if isinstance(panel.get('edges'), dict) else {}
        if not all(edges.get(key) for key in ('x_min', 'x_max', 'y_min', 'y_max')):
            return []

        a = min(lx, ly)
        b = max(lx, ly)
        peak_line_load = intensity * a / 2.0

        if lx <= ly:
            return [
                self._piecewise_linear_gravity_load(edges['x_min'], peak_line_load, panel, a / 2.0),
                self._piecewise_linear_gravity_load(edges['x_max'], peak_line_load, panel, a / 2.0),
                self._piecewise_linear_gravity_load(edges['y_min'], peak_line_load, panel),
                self._piecewise_linear_gravity_load(edges['y_max'], peak_line_load, panel),
            ]
        return [
            self._piecewise_linear_gravity_load(edges['y_min'], peak_line_load, panel, a / 2.0),
            self._piecewise_linear_gravity_load(edges['y_max'], peak_line_load, panel, a / 2.0),
            self._piecewise_linear_gravity_load(edges['x_min'], peak_line_load, panel),
            self._piecewise_linear_gravity_load(edges['x_max'], peak_line_load, panel),
        ]

    def _piecewise_linear_gravity_load(
        self,
        edge: Any,
        peak_line_load: float,
        panel: Dict[str, Any],
        ramp_length: Optional[float] = None,
    ) -> Dict[str, Any]:
        edge_data = edge if isinstance(edge, dict) else {'id': str(edge)}
        element_id = str(edge_data.get('id', ''))
        segment_length = self._to_float(edge_data.get('segmentLength', 0.0), 0.0)
        start_fraction = self._to_float(edge_data.get('startFraction', 0.0), 0.0)
        end_fraction = self._to_float(edge_data.get('endFraction', 1.0), 1.0)
        if segment_length <= 0.0 or end_fraction <= start_fraction:
            raise self._floor_transfer_error(f"Panel {panel.get('id')}: invalid supporting-beam segment for '{element_id}'")

        relative_positions = [0.0, 0.5, 1.0]
        profile = 'triangular'
        if ramp_length is not None:
            ramp_ratio = min(max(float(ramp_length) / segment_length, 0.0), 0.5)
            if ramp_ratio < 0.5 - 1e-12:
                relative_positions = [0.0, ramp_ratio, 1.0 - ramp_ratio, 1.0]
                profile = 'trapezoidal'

        points = []
        for index, relative_position in enumerate(relative_positions):
            at_edge = index == 0 or index == len(relative_positions) - 1
            points.append({
                'position': start_fraction + (end_fraction - start_fraction) * relative_position,
                'wx': 0.0,
                'wy': 0.0,
                'wz': 0.0 if at_edge else -peak_line_load,
            })

        return {
            'type': 'distributed',
            'element': element_id,
            'distribution': 'piecewise_linear',
            'profile': profile,
            'points': points,
            'reference_frame': 'global',
            'source': 'storyFloorLoad',
            'panel': panel.get('id'),
            'tributarySegmentLength': segment_length,
            'elementLength': self._to_float(edge_data.get('elementLength', segment_length), segment_length),
        }

    def _distributed_gravity_load(self, edge: Any, line_load: float, panel: Dict[str, Any]) -> Dict[str, Any]:
        edge_data = edge if isinstance(edge, dict) else {'id': str(edge)}
        element_id = str(edge_data.get('id', ''))
        segment_length = self._to_float(edge_data.get('segmentLength', 0.0), 0.0)
        element_length = self._to_float(edge_data.get('elementLength', 0.0), 0.0)
        coverage_ratio = segment_length / element_length if segment_length > 0.0 and element_length > 0.0 else 1.0
        load = {
            'type': 'distributed',
            'element': element_id,
            'wy': 0.0,
            'wz': -line_load * (1.0 if self.preserve_floor_segments else coverage_ratio),
            'source': 'storyFloorLoad',
            'panel': panel.get('id'),
        }
        if self.preserve_floor_segments:
            load['start'] = float(edge_data.get('startFraction', 0.0)) * element_length
            load['end'] = float(edge_data.get('endFraction', 1.0)) * element_length
            load['reference_frame'] = 'global'
        if coverage_ratio < 1.0:
            load['tributarySegmentLength'] = segment_length
            load['elementLength'] = element_length
        return load

    def _unique_sorted_coordinates(self, values: Any) -> List[float]:
        by_key: Dict[int, float] = {}
        for value in values:
            key = self._coord_key(float(value))
            by_key.setdefault(key, float(value))
        return sorted(by_key.values())

    def _coord_key(self, value: float) -> int:
        return int(round(float(value) * 1_000_000))
