"""Story floor-load expansion and transfer trace methods of ``StaticLoadContext``.

Moved verbatim from ``opensees_static_loads.py``; mixed into ``StaticLoadContext``.
"""

from typing import Dict, Any, List, Optional, Set, Tuple
import re


class StoryFloorLoadMixin:
    def _is_derived_story_floor_load(self, load: Any) -> bool:
        return self._get_field(load, 'source', None) == 'story_floor_loads'

    def _floor_load_specs_for_case(self, load_case: Any, factor: float) -> List[Dict[str, Any]]:
        load_case_id = str(self._get_field(load_case, 'id', ''))
        load_case_type = str(self._get_field(load_case, 'type', '')).lower()
        return [{
            'types': self._floor_load_types_for_case(load_case_id, load_case_type),
            'factor': factor,
        }]

    def _floor_load_types_for_case(self, load_case_id: str, load_case_type: str) -> Optional[Set[str]]:
        if load_case_type in {'dead', 'live'}:
            return {load_case_type}
        if load_case_type == 'other':
            inferred = self._infer_floor_load_type_from_case_id(load_case_id)
            return {inferred} if inferred else None

        inferred = self._infer_floor_load_type_from_case_id(load_case_id)
        return {inferred} if inferred else None

    def _infer_floor_load_type_from_case_id(self, load_case_id: str) -> Optional[str]:
        normalized = re.sub(r'[^a-z0-9]+', '', load_case_id.lower())
        dead_aliases = {'d', 'dl', 'dead', 'deadload', 'lcde', 'lcdl', 'lcdead'}
        live_aliases = {'l', 'll', 'live', 'liveload', 'lcll', 'lclive'}
        if normalized in dead_aliases or normalized.startswith(('dead', 'deadload', 'dl', 'lcdead', 'lcdl')):
            return 'dead'
        if normalized in live_aliases or normalized.startswith(('live', 'liveload', 'll', 'lclive', 'lcll')):
            return 'live'
        return None

    def _expand_story_floor_loads(
        self,
        parameters: Dict[str, Any],
        floor_specs: Optional[List[Dict[str, Any]]] = None,
    ) -> List[Dict[str, Any]]:
        if parameters.get('includeFloorLoads') is False or parameters.get('include_floor_loads') is False:
            requested_mode = self._floor_load_transfer_mode(parameters)
            warnings = self._floor_load_trace_warnings()
            warnings.append('Story floor load transfer was disabled by analysis parameters.')
            self._floor_load_transfer_trace = {
                'requestedMode': requested_mode,
                'effectiveMode': 'disabled',
                'loadSource': 'story_floor_loads',
                'method': self._floor_load_transfer_method_label('disabled'),
                'methodEn': self._floor_load_transfer_method_label('disabled'),
                'methodZh': self._floor_load_transfer_method_label_zh('disabled'),
                'warnings': warnings,
            }
            return []
        if not getattr(self.model, 'stories', None):
            return []

        requested_mode = self._floor_load_transfer_mode(parameters)
        mode_warnings = self._floor_load_trace_warnings()
        specs = floor_specs if floor_specs is not None else [{'types': None, 'factor': 1.0}]
        self._floor_load_transfer_trace = {
            'requestedMode': requested_mode,
            'effectiveMode': requested_mode,
            'loadSource': 'story_floor_loads',
            'designCode': 'GB 50010-2010(2015) 9.1.1',
            'method': self._floor_load_transfer_method_label(requested_mode),
            'methodEn': self._floor_load_transfer_method_label(requested_mode),
            'methodZh': self._floor_load_transfer_method_label_zh(requested_mode),
            'items': [],
            'warnings': mode_warnings,
        }

        if requested_mode == 'node_tributary':
            loads = self._expand_story_floor_loads_to_nodes(parameters, specs, 'node_tributary')
            self._refresh_floor_load_transfer_effective_mode()
            return loads

        slab_loads = self._expand_story_floor_loads_to_slab_beams(parameters, specs, requested_mode)
        if slab_loads:
            self._refresh_floor_load_transfer_effective_mode()
            return slab_loads

        warnings = self._floor_load_trace_warnings()
        warnings.append('No complete supported slab panel was found; falling back to node tributary-area loads.')
        self._floor_load_transfer_trace['warnings'] = warnings
        self._floor_load_transfer_trace['effectiveMode'] = 'node_tributary'
        self._floor_load_transfer_trace['method'] = self._floor_load_transfer_method_label('node_tributary')
        self._floor_load_transfer_trace['methodEn'] = self._floor_load_transfer_method_label('node_tributary')
        self._floor_load_transfer_trace['methodZh'] = self._floor_load_transfer_method_label_zh('node_tributary')
        loads = self._expand_story_floor_loads_to_nodes(parameters, specs, 'node_tributary')
        self._refresh_floor_load_transfer_effective_mode()
        return loads

    def _expand_story_floor_loads_to_nodes(
        self,
        parameters: Dict[str, Any],
        specs: List[Dict[str, Any]],
        effective_mode: str,
    ) -> List[Dict[str, Any]]:
        expanded: List[Dict[str, Any]] = []

        for story in self.model.stories:
            expanded.extend(self._expand_story_floor_load_to_nodes(story, parameters, specs, effective_mode))

        return expanded

    def _expand_story_floor_load_to_nodes(
        self,
        story: Any,
        parameters: Dict[str, Any],
        specs: List[Dict[str, Any]],
        effective_mode: str,
    ) -> List[Dict[str, Any]]:
        components = self._story_floor_load_components(story)
        if not components:
            return []

        intensity = self._story_floor_load_intensity(components, specs)
        if abs(intensity) <= 1e-12:
            return []

        node_areas = self._story_floor_node_areas(story, parameters)
        if not node_areas:
            self._append_floor_load_warning(
                f"Story {self._get_field(story, 'id', '')}: no floor nodes found for node tributary-area fallback."
            )
            return []

        expanded: List[Dict[str, Any]] = []
        generated_count = 0
        total_load = 0.0
        for node_id, area in node_areas.items():
            fz = -intensity * area
            if abs(fz) <= 1e-12:
                continue
            generated_count += 1
            total_load += intensity * area
            expanded.append({
                'type': 'nodal',
                'node': node_id,
                'fx': 0.0,
                'fy': 0.0,
                'fz': fz,
                'mx': 0.0,
                'my': 0.0,
                'mz': 0.0,
                'forces': [0.0, 0.0, fz, 0.0, 0.0, 0.0],
                'source': 'storyFloorLoad',
            })

        if generated_count > 0:
            self._append_floor_load_trace_item({
                'story': str(self._get_field(story, 'id', '')),
                'method': self._floor_load_transfer_method_label(effective_mode),
                'methodEn': self._floor_load_transfer_method_label(effective_mode),
                'methodZh': self._floor_load_transfer_method_label_zh(effective_mode),
                'effectiveMode': effective_mode,
                'loadIntensityKNPerM2': intensity,
                'generatedLoadType': 'nodal',
                'generatedLoadCount': generated_count,
                'totalLoadKN': total_load,
            })

        return expanded

    def _expand_story_floor_loads_to_slab_beams(
        self,
        parameters: Dict[str, Any],
        specs: List[Dict[str, Any]],
        requested_mode: str,
    ) -> List[Dict[str, Any]]:
        expanded: List[Dict[str, Any]] = []

        for story in self.model.stories:
            story_id = str(self._get_field(story, 'id', ''))
            components = self._story_floor_load_components(story)
            if not components:
                continue

            intensity = self._story_floor_load_intensity(components, specs)
            if abs(intensity) <= 1e-12:
                continue

            panels = self._story_floor_panels(story)
            if not panels:
                self._append_floor_load_warning(f"Story {story_id}: no complete rectangular floor panel found.")
                expanded.extend(self._expand_story_floor_load_to_nodes(story, parameters, specs, 'node_tributary'))
                continue

            story_loads: List[Dict[str, Any]] = []
            all_panels_supported = True
            for panel in panels:
                panel_loads = self._panel_floor_loads(panel, intensity, requested_mode)
                if not panel_loads:
                    all_panels_supported = False
                    continue
                story_loads.extend(panel_loads)

            if story_loads and all_panels_supported:
                expanded.extend(story_loads)
                continue

            self._remove_floor_load_trace_items_for_story(story_id)
            self._append_floor_load_warning(
                f"Story {story_id}: slab-beam transfer was incomplete; falling back to node tributary-area loads."
            )
            expanded.extend(self._expand_story_floor_load_to_nodes(story, parameters, specs, 'node_tributary'))

        return expanded

    def _story_floor_load_intensity(
        self,
        components: List[Tuple[str, float]],
        specs: List[Dict[str, Any]],
    ) -> float:
        intensity = 0.0
        for spec in specs:
            requested_types = spec.get('types')
            factor = self._to_float(spec.get('factor', 1.0), 1.0)
            for component_type, component_value in components:
                if requested_types is None or component_type in requested_types:
                    intensity += component_value * factor
        return intensity

    def _floor_load_transfer_mode(self, parameters: Dict[str, Any]) -> str:
        raw = (
            parameters.get('floorLoadTransferMode')
            or parameters.get('floor_load_transfer_mode')
            or self._get_field(getattr(self.model, 'metadata', {}) or {}, 'floorLoadTransferMode', None)
            or self._get_field(getattr(self.model, 'metadata', {}) or {}, 'floor_load_transfer_mode', None)
            or 'auto_code_cn'
        )
        mode = str(raw).strip().lower()
        aliases = {
            'node': 'node_tributary',
            'node_tributary_area': 'node_tributary',
            'one_way': 'one_way_slab',
            'one-way': 'one_way_slab',
            'two_way': 'two_way_slab',
            'two-way': 'two_way_slab',
            'auto': 'auto_code_cn',
            'cn': 'auto_code_cn',
            'gb50010': 'auto_code_cn',
        }
        normalized = aliases.get(mode, mode)
        if normalized not in {'node_tributary', 'one_way_slab', 'two_way_slab', 'auto_code_cn'}:
            self._append_floor_load_warning(f"Unknown floor load transfer mode '{raw}', using auto_code_cn.")
            return 'auto_code_cn'
        return normalized

    def _floor_load_transfer_method_label(self, mode: str) -> str:
        labels = {
            'node_tributary': 'Node tributary-area equivalent nodal load',
            'one_way_slab': 'One-way slab load transfer to supporting beams',
            'two_way_slab': 'Two-way slab load transfer with triangular/trapezoidal beam loads',
            'auto_code_cn': 'Automatic GB 50010 slab classification and beam load transfer',
            'mixed': 'Mixed floor load transfer methods',
            'disabled': 'Floor load transfer disabled',
        }
        return labels.get(mode, mode)

    def _floor_load_transfer_method_label_zh(self, mode: str) -> str:
        labels = {
            'node_tributary': '节点影响面积等效节点荷载',
            'one_way_slab': '单向板传至支承梁',
            'two_way_slab': '双向板按三角形/梯形荷载传至支承梁',
            'auto_code_cn': '按 GB 50010 自动判别单向/双向板并传至梁',
            'mixed': '混合楼面荷载传递方法',
            'disabled': '楼面荷载传递已关闭',
        }
        return labels.get(mode, mode)

    def _append_floor_load_trace_item(self, item: Dict[str, Any]) -> None:
        if not isinstance(self._floor_load_transfer_trace, dict):
            self._floor_load_transfer_trace = {}
        items = self._floor_load_transfer_trace.setdefault('items', [])
        if isinstance(items, list):
            items.append(item)

    def _remove_floor_load_trace_items_for_story(self, story_id: str) -> None:
        if not isinstance(self._floor_load_transfer_trace, dict):
            return
        items = self._floor_load_transfer_trace.get('items')
        if not isinstance(items, list):
            return
        self._floor_load_transfer_trace['items'] = [
            item for item in items if not isinstance(item, dict) or str(item.get('story', '')) != story_id
        ]

    def _append_floor_load_warning(self, warning: str) -> None:
        if not warning:
            return
        if not isinstance(self._floor_load_transfer_trace, dict):
            self._floor_load_transfer_trace = {}
        warnings = self._floor_load_transfer_trace.setdefault('warnings', [])
        if isinstance(warnings, list) and warning not in warnings:
            warnings.append(warning)

    def _floor_load_trace_warnings(self) -> List[str]:
        warnings = self._floor_load_transfer_trace.get('warnings', [])
        if not isinstance(warnings, list):
            return []
        return [str(warning) for warning in warnings if str(warning)]

    def _refresh_floor_load_transfer_effective_mode(self) -> None:
        if not isinstance(self._floor_load_transfer_trace, dict):
            return
        items = self._floor_load_transfer_trace.get('items')
        if not isinstance(items, list) or not items:
            return
        modes = sorted({
            str(item.get('effectiveMode'))
            for item in items
            if isinstance(item, dict) and item.get('effectiveMode')
        })
        if not modes:
            return
        effective_mode = modes[0] if len(modes) == 1 else 'mixed'
        self._floor_load_transfer_trace['effectiveMode'] = effective_mode
        self._floor_load_transfer_trace['method'] = self._floor_load_transfer_method_label(effective_mode)
        self._floor_load_transfer_trace['methodEn'] = self._floor_load_transfer_method_label(effective_mode)
        self._floor_load_transfer_trace['methodZh'] = self._floor_load_transfer_method_label_zh(effective_mode)

    def _floor_load_transfer_summary(self) -> Optional[Dict[str, Any]]:
        if not isinstance(self._floor_load_transfer_trace, dict) or not self._floor_load_transfer_trace:
            return None
        summary = dict(self._floor_load_transfer_trace)
        items = summary.get('items')
        warnings = summary.get('warnings')
        if isinstance(items, list) and not items:
            summary.pop('items', None)
        if isinstance(warnings, list) and not warnings:
            summary.pop('warnings', None)
        if not summary.get('effectiveMode') and not summary.get('method'):
            return None
        return summary

    def _attach_floor_load_transfer(self, result: Dict[str, Any]) -> Dict[str, Any]:
        from coordinate_semantics import coordinate_contract_metadata

        existing_meta = result.get('meta') if isinstance(result.get('meta'), dict) else {}
        result_with_coordinates = {
            **result,
            'meta': {
                **existing_meta,
                **coordinate_contract_metadata(self.model),
                'units': {
                    'length': 'm',
                    'force': 'kN',
                    'moment': 'kN.m',
                    'displacement': 'm',
                    'rotation': 'rad',
                },
            },
        }
        summary = self._floor_load_transfer_summary()
        if summary is None:
            return result_with_coordinates
        return {**result_with_coordinates, 'floorLoadTransfer': summary}

    def _story_floor_load_components(self, story: Any) -> List[Tuple[str, float]]:
        components: List[Tuple[str, float]] = []
        seen_types: Set[str] = set()

        for floor_load in self._get_field(story, 'floor_loads', []) or []:
            load_type = str(self._get_field(floor_load, 'type', 'other')).lower()
            value = self._to_float(self._get_field(floor_load, 'value', 0.0), 0.0)
            if abs(value) <= 1e-12:
                continue
            components.append((load_type, value))
            seen_types.add(load_type)

        for field_name, load_type in (('dead_load', 'dead'), ('live_load', 'live')):
            if load_type in seen_types:
                continue
            value = self._to_float(self._get_field(story, field_name, 0.0), 0.0)
            if abs(value) > 1e-12:
                components.append((load_type, value))
                seen_types.add(load_type)

        return components

    def _story_floor_node_areas(self, story: Any, parameters: Dict[str, Any]) -> Dict[str, float]:
        target_nodes = self._target_floor_nodes(story)
        if not target_nodes:
            return {}

        x_values = self._unique_sorted_coordinates(float(node.x) for node in target_nodes)
        y_values = self._unique_sorted_coordinates(float(node.y) for node in target_nodes)
        x_lengths = self._tributary_lengths(x_values)

        if len(y_values) >= 2:
            y_lengths = self._tributary_lengths(y_values)
            return {
                str(node.id): x_lengths.get(self._coord_key(float(node.x)), 0.0) * y_lengths.get(self._coord_key(float(node.y)), 0.0)
                for node in target_nodes
            }

        tributary_width = self._floor_load_tributary_width(parameters)
        if len(x_values) >= 2:
            return {
                str(node.id): x_lengths.get(self._coord_key(float(node.x)), 0.0) * tributary_width
                for node in target_nodes
            }

        return {str(node.id): tributary_width for node in target_nodes}

    def _target_floor_nodes(self, story: Any) -> List[Any]:
        story_id = str(self._get_field(story, 'id', ''))
        elevation = self._field_float(story, 'elevation')
        height = self._field_float(story, 'height')

        if elevation is not None and height is not None:
            nodes = self._nodes_at_z(elevation + height)
            if nodes:
                return nodes

        story_ordinal = self._story_ordinal(story_id)
        if story_ordinal is not None:
            levels = self._z_levels()
            if story_ordinal < len(levels):
                nodes = self._nodes_at_z(levels[story_ordinal])
                if nodes:
                    return nodes

        if story_id:
            nodes = [node for node in self.model.nodes if str(getattr(node, 'story', '')) == story_id]
            if nodes:
                return nodes

        if elevation is not None:
            return self._nodes_at_z(elevation)

        return []

    def _story_ordinal(self, story_id: str) -> Optional[int]:
        match = re.search(r'(\d+)$', story_id)
        if not match:
            return None
        value = int(match.group(1))
        return value if value > 0 else None

    def _z_levels(self) -> List[float]:
        return self._unique_sorted_coordinates(float(node.z) for node in self.model.nodes)

    def _nodes_at_z(self, z: float) -> List[Any]:
        tolerance = 1e-6
        return [node for node in self.model.nodes if abs(float(node.z) - z) <= tolerance]

    def _tributary_lengths(self, values: List[float]) -> Dict[int, float]:
        if not values:
            return {}
        if len(values) == 1:
            return {self._coord_key(values[0]): 1.0}

        lengths: Dict[int, float] = {}
        for idx, value in enumerate(values):
            if idx == 0:
                length = (values[1] - value) / 2.0
            elif idx == len(values) - 1:
                length = (value - values[idx - 1]) / 2.0
            else:
                length = (values[idx + 1] - values[idx - 1]) / 2.0
            lengths[self._coord_key(value)] = max(float(length), 0.0)
        return lengths

    def _floor_load_tributary_width(self, parameters: Dict[str, Any]) -> float:
        for key in ('floorLoadTributaryWidthM', 'floor_load_tributary_width_m', 'tributaryWidthM', 'tributary_width_m'):
            value = self._to_float(parameters.get(key, 0.0), 0.0)
            if value > 0.0:
                return value

        metadata = getattr(self.model, 'metadata', {}) or {}
        if isinstance(metadata, dict):
            for key in ('floorLoadTributaryWidthM', 'floor_load_tributary_width_m', 'tributaryWidthM', 'tributary_width_m'):
                value = self._to_float(metadata.get(key, 0.0), 0.0)
                if value > 0.0:
                    return value

        return 1.0
