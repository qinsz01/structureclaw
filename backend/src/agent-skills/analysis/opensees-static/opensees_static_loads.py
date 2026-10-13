from opensees_shared.errors import OpenSeesInputError, OpenSeesMissingInputError, OpenSeesCapabilityError
"""Load normalization, floor transfer and summaries; no numerical solver implementation."""
import numpy as np
from typing import Dict, Any, List, Optional, Set, Tuple
import logging
import math
import re

logger = logging.getLogger(__name__)


class StaticLoadContext:
    def __init__(self, model):
        """
        初始化分析器

        Args:
            model: 结构模型数据
        """
        self.model = model
        self.nodes = {n.id: n for n in model.nodes}
        self.elements = {e.id: e for e in model.elements}
        self.materials = {m.id: m for m in model.materials}
        self.sections = {s.id: s for s in model.sections}

        # 位移结果
        self.displacements = {}
        # 内力结果
        self.forces = {}
        # 应力结果
        self.stresses = {}

        # Lazily cached coordinate semantics metadata.
        self._coordinate_metadata: Optional[Dict[str, Any]] = None
        self._floor_load_transfer_trace: Dict[str, Any] = {}

        from coordinate_semantics import validate_coordinate_contract

        validate_coordinate_contract(model)


    def _run_batch_cases(self, parameters: Dict[str, Any], solver_func) -> Dict[str, Any]:
        """
        批量工况分析，并返回跨工况包络。
        """
        batch_cases = parameters.get('batchCases', [])
        if not isinstance(batch_cases, list) or not batch_cases:
            raise OpenSeesInputError("batchCases must be a non-empty list")

        case_results: Dict[str, Dict[str, Any]] = {}
        summary_envelope = {
            'maxAbsDisplacement': 0.0,
            'maxAbsAxialForce': 0.0,
            'maxAbsShearForce': 0.0,
            'maxAbsMoment': 0.0,
            'maxAbsReaction': 0.0,
            'controlCase': {
                'displacement': '',
                'axialForce': '',
                'shearForce': '',
                'moment': '',
                'reaction': '',
            },
        }
        node_displacement_envelope: Dict[str, Dict[str, Any]] = {}
        element_force_envelope: Dict[str, Dict[str, Any]] = {}
        node_reaction_envelope: Dict[str, Dict[str, Any]] = {}

        for idx, case in enumerate(batch_cases):
            case_id = str(case.get('id', f'case_{idx + 1}'))
            case_parameters = {k: v for k, v in parameters.items() if k != 'batchCases'}
            for key in ('loadCases', 'loadCaseIds', 'loadCombinationId', 'combinationIds'):
                if key in case:
                    case_parameters[key] = case[key]

            case_result = solver_func(case_parameters)
            case_results[case_id] = case_result
            self._accumulate_case_envelope_tables(
                case_id,
                case_result,
                node_displacement_envelope,
                element_force_envelope,
                node_reaction_envelope,
            )

            env = case_result.get('envelope', {})
            mapping = [
                ('maxAbsDisplacement', 'displacement'),
                ('maxAbsAxialForce', 'axialForce'),
                ('maxAbsShearForce', 'shearForce'),
                ('maxAbsMoment', 'moment'),
                ('maxAbsReaction', 'reaction'),
            ]
            for metric, control_name in mapping:
                value = float(env.get(metric, 0.0))
                if value > float(summary_envelope[metric]):
                    summary_envelope[metric] = value
                    summary_envelope['controlCase'][control_name] = case_id

        return self._attach_floor_load_transfer({
            'status': 'success',
            'analysisMode': case_results[next(iter(case_results))].get('analysisMode', 'batch'),
            'batchCaseCount': len(case_results),
            'caseResults': case_results,
            'envelope': summary_envelope,
            'envelopeTables': {
                'nodeDisplacement': node_displacement_envelope,
                'elementForce': element_force_envelope,
                'nodeReaction': node_reaction_envelope,
            },
            'summary': {
                'caseCount': len(case_results),
                'maxAbsDisplacement': summary_envelope['maxAbsDisplacement'],
            },
        })


    def _accumulate_case_envelope_tables(
        self,
        case_id: str,
        case_result: Dict[str, Any],
        node_displacement_envelope: Dict[str, Dict[str, Any]],
        element_force_envelope: Dict[str, Dict[str, Any]],
        node_reaction_envelope: Dict[str, Dict[str, Any]],
    ) -> None:
        """累计单工况结果到跨工况明细包络表。"""
        displacements = case_result.get('displacements', {})
        for node_id, disp in displacements.items():
            ux = float(disp.get('ux', 0.0))
            uy = float(disp.get('uy', 0.0))
            uz = float(disp.get('uz', 0.0))
            mag = float(np.sqrt(ux * ux + uy * uy + uz * uz))
            item = node_displacement_envelope.setdefault(
                str(node_id),
                {
                    'maxAbsDisplacement': 0.0,
                    'controlCase': '',
                },
            )
            if mag > float(item['maxAbsDisplacement']):
                item['maxAbsDisplacement'] = mag
                item['controlCase'] = case_id

        forces = case_result.get('forces', {})
        for elem_id, force in forces.items():
            axial = abs(float(force.get('axial', 0.0))) if isinstance(force, dict) else 0.0
            shear = 0.0
            moment = 0.0
            if isinstance(force, dict):
                if isinstance(force.get('n1'), dict):
                    shear = max(shear, abs(float(force['n1'].get('V', 0.0))))
                    moment = max(moment, abs(float(force['n1'].get('M', 0.0))))
                if isinstance(force.get('n2'), dict):
                    shear = max(shear, abs(float(force['n2'].get('V', 0.0))))
                    moment = max(moment, abs(float(force['n2'].get('M', 0.0))))

            item = element_force_envelope.setdefault(
                str(elem_id),
                {
                    'maxAbsAxialForce': 0.0,
                    'maxAbsShearForce': 0.0,
                    'maxAbsMoment': 0.0,
                    'controlCaseAxial': '',
                    'controlCaseShear': '',
                    'controlCaseMoment': '',
                },
            )
            if axial > float(item['maxAbsAxialForce']):
                item['maxAbsAxialForce'] = axial
                item['controlCaseAxial'] = case_id
            if shear > float(item['maxAbsShearForce']):
                item['maxAbsShearForce'] = shear
                item['controlCaseShear'] = case_id
            if moment > float(item['maxAbsMoment']):
                item['maxAbsMoment'] = moment
                item['controlCaseMoment'] = case_id

        reactions = case_result.get('reactions', {})
        for node_id, reaction in reactions.items():
            max_reaction = 0.0
            for v in self._iter_numeric_values(reaction):
                max_reaction = max(max_reaction, abs(float(v)))

            item = node_reaction_envelope.setdefault(
                str(node_id),
                {
                    'maxAbsReaction': 0.0,
                    'controlCase': '',
                },
            )
            if max_reaction > float(item['maxAbsReaction']):
                item['maxAbsReaction'] = max_reaction
                item['controlCase'] = case_id


    def _collect_nodal_loads(self, parameters: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Collect standardized loads.

        Explicit nodal/distributed loads take precedence. When selected load
        cases contain no explicit loads, story floor loads are expanded into
        equivalent gravity nodal loads so OpenSees can analyze V2 floor-load
        models without engine-specific preprocessing.
        """
        self._floor_load_transfer_trace = {}
        explicit_loads: List[Dict[str, Any]] = []

        load_combination_id = (
            parameters.get('loadCombinationId')
            or parameters.get('load_combination_id')
            or parameters.get('combinationId')
        )
        if load_combination_id:
            floor_specs: List[Dict[str, Any]] = []
            combo_found = False
            for combo in self.model.load_combinations:
                if combo.id != str(load_combination_id):
                    continue
                combo_found = True
                case_map = {lc.id: lc for lc in self.model.load_cases}
                for case_id, factor in combo.factors.items():
                    lc = case_map.get(case_id)
                    if not lc:
                        continue
                    case_load_count = 0
                    has_derived_floor_loads = False
                    for load in lc.loads:
                        if self._is_derived_story_floor_load(load):
                            has_derived_floor_loads = True
                            continue
                        normalized = self._normalize_load(load)
                        if normalized is not None:
                            explicit_loads.append(self._scale_load(normalized, float(factor)))
                            case_load_count += 1
                    if case_load_count == 0 or has_derived_floor_loads:
                        floor_specs.extend(self._floor_load_specs_for_case(lc, float(factor)))
                if combo_found:
                    expanded_floor_loads = self._expand_story_floor_loads(parameters, floor_specs)
                    return explicit_loads + expanded_floor_loads
            raise OpenSeesInputError(f"Unknown load combination '{load_combination_id}'")

        parameter_load_cases = parameters.get('loadCases') or parameters.get('load_cases') or []
        parameter_floor_specs: List[Dict[str, Any]] = []
        for lc in parameter_load_cases:
            if not isinstance(lc, dict):
                continue
            case_load_count = 0
            has_derived_floor_loads = False
            for load in lc.get('loads', []):
                if self._is_derived_story_floor_load(load):
                    has_derived_floor_loads = True
                    continue
                normalized = self._normalize_load(load)
                if normalized is not None:
                    explicit_loads.append(normalized)
                    case_load_count += 1
            if case_load_count == 0 or has_derived_floor_loads:
                parameter_floor_specs.extend(self._floor_load_specs_for_case(lc, 1.0))

        if parameter_floor_specs:
            return explicit_loads + self._expand_story_floor_loads(parameters, parameter_floor_specs)
        if explicit_loads:
            return explicit_loads

        load_case_ids = parameters.get('loadCaseIds') or parameters.get('load_case_ids')
        if load_case_ids:
            allowed = set(str(i) for i in load_case_ids)
            unknown = allowed - {lc.id for lc in self.model.load_cases}
            if unknown:
                raise OpenSeesInputError(f"Unknown load cases: {sorted(unknown)}")
            selected_floor_specs: List[Dict[str, Any]] = []
            for lc in self.model.load_cases:
                if lc.id in allowed:
                    case_load_count = 0
                    has_derived_floor_loads = False
                    for load in lc.loads:
                        if self._is_derived_story_floor_load(load):
                            has_derived_floor_loads = True
                            continue
                        normalized = self._normalize_load(load)
                        if normalized is not None:
                            explicit_loads.append(normalized)
                            case_load_count += 1
                    if case_load_count == 0 or has_derived_floor_loads:
                        selected_floor_specs.extend(self._floor_load_specs_for_case(lc, 1.0))
            if selected_floor_specs:
                return explicit_loads + self._expand_story_floor_loads(parameters, selected_floor_specs)
            return explicit_loads

        default_floor_specs: List[Dict[str, Any]] = []
        for lc in self.model.load_cases:
            case_load_count = 0
            has_derived_floor_loads = False
            for load in lc.loads:
                if self._is_derived_story_floor_load(load):
                    has_derived_floor_loads = True
                    continue
                normalized = self._normalize_load(load)
                if normalized is not None:
                    explicit_loads.append(normalized)
                    case_load_count += 1
            if case_load_count == 0 or has_derived_floor_loads:
                default_floor_specs.extend(self._floor_load_specs_for_case(lc, 1.0))

        if default_floor_specs:
            return explicit_loads + self._expand_story_floor_loads(parameters, default_floor_specs)

        if explicit_loads:
            return explicit_loads

        return self._expand_story_floor_loads(parameters)


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


    def _one_way_panel_loads(self, panel: Dict[str, Any], intensity: float) -> List[Dict[str, Any]]:
        lx = self._to_float(panel.get('lx', 0.0), 0.0)
        ly = self._to_float(panel.get('ly', 0.0), 0.0)
        edges = panel.get('edges') if isinstance(panel.get('edges'), dict) else {}

        if lx <= ly and edges.get('x_min') and edges.get('x_max'):
            line_load = intensity * lx / 2.0
            return [
                self._distributed_gravity_load(edges['x_min'], line_load, panel),
                self._distributed_gravity_load(edges['x_max'], line_load, panel),
            ]
        if edges.get('y_min') and edges.get('y_max'):
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
            raise OpenSeesInputError(f"Panel {panel.get('id')}: invalid supporting-beam segment for '{element_id}'")

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
            'wz': -line_load * coverage_ratio,
            'source': 'storyFloorLoad',
            'panel': panel.get('id'),
        }
        if coverage_ratio < 1.0:
            load['tributarySegmentLength'] = segment_length
            load['elementLength'] = element_length
        return load


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


    def _unique_sorted_coordinates(self, values: Any) -> List[float]:
        by_key: Dict[int, float] = {}
        for value in values:
            key = self._coord_key(float(value))
            by_key.setdefault(key, float(value))
        return sorted(by_key.values())


    def _coord_key(self, value: float) -> int:
        return int(round(float(value) * 1_000_000))


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


    def _get_field(self, obj: Any, key: str, fallback: Any = None) -> Any:
        if isinstance(obj, dict):
            return obj.get(key, fallback)
        return getattr(obj, key, fallback)


    def _field_float(self, obj: Any, key: str) -> Optional[float]:
        value = self._get_field(obj, key, None)
        if value is None:
            return None
        return self._to_float(value, 0.0)


    def _scale_load(self, load: Dict[str, Any], factor: float) -> Dict[str, Any]:
        """按组合系数缩放荷载中的数值字段。"""
        scaled = dict(load)
        numeric_keys = ['fx', 'fy', 'fz', 'mx', 'my', 'mz', 'wx', 'wy', 'wz', 'ux', 'uy', 'uz', 'rx', 'ry', 'rz']
        for key in numeric_keys:
            if key in scaled:
                scaled[key] = float(scaled[key]) * factor
        if isinstance(scaled.get('forces'), list):
            scaled['forces'] = [float(value) * factor for value in scaled['forces']]
        if isinstance(scaled.get('points'), list):
            scaled['points'] = [dict(point, **{key: float(point.get(key, 0.0)) * factor
                for key in ('wx', 'wy', 'wz')}) for point in scaled['points']]
        return scaled


    def _normalize_load(self, load: Any) -> Optional[Dict[str, Any]]:
        if not isinstance(load, dict):
            raise OpenSeesInputError("Every structural load must be an object")

        from structure_protocol.load_contract import validate_load_contract
        try:
            validate_load_contract(load)
        except ValueError as error:
            raise OpenSeesInputError(str(error)) from error

        load_type = str(load.get('type', '')).lower()
        if load_type not in {'', 'nodal', 'distributed', 'point', 'displacement', 'settlement'}:
            raise OpenSeesCapabilityError(f"Unsupported structural load type '{load_type}'")
        node_targets = [load.get(key) for key in ('node', 'nodeId', 'node_id') if load.get(key) is not None]
        element_targets = [load.get(key) for key in ('element', 'elementId', 'element_id') if load.get(key) is not None]
        if node_targets and element_targets:
            raise OpenSeesInputError("A structural load cannot target both a node and an element")
        if len({str(value) for value in node_targets}) > 1 or len({str(value) for value in element_targets}) > 1:
            raise OpenSeesInputError("A structural load contains conflicting target aliases")

        if load_type in {'displacement', 'settlement'}:
            node_id = str(node_targets[0]) if node_targets else ''
            if node_id not in self.nodes or element_targets:
                raise OpenSeesInputError("A prescribed displacement must reference a known node")
            if load.get('reference_frame', 'global') != 'global':
                raise OpenSeesInputError("Prescribed displacements must be global")
            dofs = ('ux', 'uy', 'uz', 'rx', 'ry', 'rz')
            if not any(k in load for k in dofs):
                raise OpenSeesInputError("A prescribed displacement requires an explicit displacement component")
            return {'type': 'displacement', 'node': node_id, 'reference_frame': 'global',
                    **{k: self._strict_load_number(load[k], k) for k in dofs if k in load}}

        if load_type == 'point':
            element_id = str(element_targets[0]) if element_targets else ''
            if element_id not in self.elements or node_targets:
                raise OpenSeesInputError("A member point load must reference a known element")
            if 'position' not in load:
                raise OpenSeesInputError("A member point load requires position in metres from the i end")
            reference = load.get('reference_frame', 'global')
            if reference not in {'global', 'element-local'}:
                raise OpenSeesInputError("Member point loads require global or element-local reference_frame")
            if any(k in load for k in ('forces', 'wx', 'wy', 'wz', 'direction', 'magnitude')):
                raise OpenSeesInputError("Member point loads must use explicit fx/fy/fz/mx/my/mz")
            return {'type': 'point', 'element': element_id, 'reference_frame': reference,
                    'position': self._strict_load_number(load['position'], 'position'),
                    **{k: self._strict_load_number(load.get(k, 0), k) for k in ('fx', 'fy', 'fz', 'mx', 'my', 'mz')}}

        if load_type == 'distributed' or element_targets:
            element_id = str(element_targets[0]) if element_targets else ''
            if not element_id:
                raise OpenSeesInputError("A distributed load must reference an element")
            if element_id not in self.elements:
                raise OpenSeesInputError(f"Distributed load references unknown element '{element_id}'")
            if any(key in load for key in ('fx', 'fy', 'fz', 'mx', 'my', 'mz', 'forces')):
                raise OpenSeesInputError("Distributed loads must use wx/wy/wz, not nodal force or moment components")

            direction = str(load.get('direction', load.get('axis', ''))).lower()
            reference_frame = str(load.get(
                'reference_frame',
                'element-local' if direction.startswith('local-') else 'global',
            ))
            if reference_frame not in {'global', 'element-local'}:
                raise OpenSeesInputError(
                    f"Distributed load on element '{element_id}' has invalid reference_frame '{reference_frame}'"
                )
            magnitude_keys = [key for key in ('q', 'w', 'value', 'magnitude') if key in load]

            wx = self._strict_load_number(load.get('wx', 0.0), 'wx')
            if direction in {'z', 'local-z', '2'}:
                if direction == 'local-z' and reference_frame != 'element-local':
                    raise OpenSeesInputError("direction='local-z' requires reference_frame='element-local'")
                wy = 0.0
                wz = self._resolved_directional_load_value(load, magnitude_keys, ('wz',), 'z')
            elif direction in {'y', 'local-y', '1'}:
                if direction == 'local-y' and reference_frame != 'element-local':
                    raise OpenSeesInputError("direction='local-y' requires reference_frame='element-local'")
                wy = self._resolved_directional_load_value(load, magnitude_keys, ('wy',), 'y')
                wz = 0.0
            elif direction in {'x', 'local-x', '0'}:
                if direction == 'local-x' and reference_frame != 'element-local':
                    raise OpenSeesInputError("direction='local-x' requires reference_frame='element-local'")
                wx = self._resolved_directional_load_value(load, magnitude_keys, ('wx',), 'x')
                wy = 0.0
                wz = 0.0
            else:
                if direction:
                    raise OpenSeesInputError(f"Distributed load on element '{element_id}' has unknown direction '{direction}'")
                has_wy = 'wy' in load
                has_wz = 'wz' in load
                if has_wy:
                    wy = self._strict_load_number(load.get('wy'), 'wy')
                else:
                    wy = 0.0
                if has_wz:
                    wz = self._strict_load_number(load.get('wz'), 'wz')
                else:
                    wz = 0.0
                if magnitude_keys:
                    raise OpenSeesInputError(
                        f"Distributed load on element '{element_id}' must declare a direction for q/w/value/magnitude"
                    )

            return {
                'type': 'distributed',
                'element': element_id,
                'reference_frame': reference_frame,
                'wx': wx,
                'wy': wy,
                'wz': wz,
                **{key: load[key] for key in ('start', 'end', 'distribution', 'points', 'source') if key in load},
            }

        node_id = str(node_targets[0]) if node_targets else ''
        if not node_id:
            raise OpenSeesInputError("A nodal load must reference a node")
        if node_id not in self.nodes:
            raise OpenSeesInputError(f"Nodal load references unknown node '{node_id}'")
        reference_frame = str(load.get('reference_frame', 'global'))
        if reference_frame != 'global':
            raise OpenSeesInputError(f"Nodal load on node '{node_id}' must use reference_frame='global'")
        if any(key in load for key in ('wx', 'wy', 'wz')):
            raise OpenSeesInputError("Nodal loads must use fx/fy/fz, not member-load w components")
        legacy_names = [
            key for key in ('Fx', 'Fy', 'Fz', 'Mx', 'My', 'Mz', 'momentX', 'momentY', 'momentZ')
            if key in load
        ]
        if legacy_names:
            raise OpenSeesInputError("V2 nodal loads must use lowercase component names")

        if isinstance(load.get('forces'), list):
            if len(load['forces']) != 6:
                raise OpenSeesInputError("Nodal load forces must contain [fx, fy, fz, mx, my, mz]")
            if any(key in load for key in ('fx', 'fy', 'fz', 'mx', 'my', 'mz', 'value', 'magnitude', 'direction', 'axis')):
                raise OpenSeesInputError("Nodal load forces cannot be combined with component or directional aliases")
            raw_forces = [self._strict_load_number(value, f'forces[{index}]') for index, value in enumerate(load['forces'])]
            fx, fy, fz, mx, my, mz = raw_forces
        else:
            direction = str(load.get('direction', load.get('axis', ''))).lower()
            magnitude_keys = [key for key in ('value', 'magnitude') if key in load]

            fx = self._strict_load_number(load.get('fx', 0.0), 'fx')
            fy = self._strict_load_number(load.get('fy', 0.0), 'fy')
            fz = self._strict_load_number(load.get('fz', 0.0), 'fz')
            mx = self._strict_load_number(load.get('mx', 0.0), 'mx')
            my = self._strict_load_number(load.get('my', 0.0), 'my')
            mz = self._strict_load_number(load.get('mz', 0.0), 'mz')

            if direction in {'x', 'fx'}:
                fx = self._resolved_directional_load_value(load, magnitude_keys, ('fx',), 'x')
            elif direction in {'y', 'fy'}:
                fy = self._resolved_directional_load_value(load, magnitude_keys, ('fy',), 'y')
            elif direction in {'z', 'fz'}:
                fz = self._resolved_directional_load_value(load, magnitude_keys, ('fz',), 'z')
            elif direction in {'mx', 'rx'}:
                mx = self._resolved_directional_load_value(load, magnitude_keys, ('mx',), 'mx')
            elif direction in {'my', 'ry'}:
                my = self._resolved_directional_load_value(load, magnitude_keys, ('my',), 'my')
            elif direction in {'mz', 'rz'}:
                mz = self._resolved_directional_load_value(load, magnitude_keys, ('mz',), 'mz')
            elif direction:
                raise OpenSeesInputError(f"Nodal load on node '{node_id}' has unknown direction '{direction}'")

        return {
            'type': 'nodal',
            'node': node_id,
            'reference_frame': 'global',
            'fx': fx,
            'fy': fy,
            'fz': fz,
            'mx': mx,
            'my': my,
            'mz': mz,
            'forces': [fx, fy, fz, mx, my, mz],
        }


    def _strict_load_number(self, value: Any, label: str) -> float:
        try:
            number = float(value)
        except (TypeError, ValueError) as error:
            raise OpenSeesInputError(f"Load component '{label}' must be finite") from error
        if not math.isfinite(number):
            raise OpenSeesInputError(f"Load component '{label}' must be finite")
        return number


    def _resolved_directional_load_value(
        self,
        load: Dict[str, Any],
        magnitude_keys: List[str],
        component_keys: Tuple[str, ...],
        direction: str,
    ) -> float:
        values = [
            (key, self._strict_load_number(load[key], key))
            for key in [*magnitude_keys, *component_keys]
            if key in load
        ]
        if not values:
            raise OpenSeesInputError(f"Directional load '{direction}' must provide a finite magnitude")
        reference = values[0][1]
        if any(abs(value - reference) > 1e-9 for _, value in values[1:]):
            keys = ', '.join(key for key, _ in values)
            raise OpenSeesInputError(f"Directional load '{direction}' has conflicting values in {keys}")
        return reference


    def _to_float(self, value: Any, fallback: float = 0.0) -> float:
        if isinstance(value, (int, float, np.floating, np.integer)):
            return float(value)
        if isinstance(value, str):
            try:
                return float(value)
            except ValueError:
                return fallback
        return fallback


    def _build_envelope(self, displacements: Dict[str, Any], forces: Dict[str, Any], reactions: Dict[str, Any]) -> Dict[str, Any]:
        """构建结果包络：最大位移、内力与反力绝对值。"""
        max_abs_disp = 0.0
        control_node_disp = ''
        for node_id, disp in displacements.items():
            if not isinstance(disp, dict):
                continue
            ux = float(disp.get('ux', 0.0))
            uy = float(disp.get('uy', 0.0))
            uz = float(disp.get('uz', 0.0))
            mag = float(np.sqrt(ux * ux + uy * uy + uz * uz))
            if mag > max_abs_disp:
                max_abs_disp = mag
                control_node_disp = str(node_id)

        max_abs_axial = 0.0
        max_abs_shear = 0.0
        max_abs_moment = 0.0
        control_element_axial = ''
        control_element_shear = ''
        control_element_moment = ''
        for elem_id, force in forces.items():
            if isinstance(force, dict):
                axial = abs(float(force.get('axial', 0.0)))
                if axial > max_abs_axial:
                    max_abs_axial = axial
                    control_element_axial = str(elem_id)

                if 'n1' in force and isinstance(force['n1'], dict):
                    shear_n1 = abs(float(force['n1'].get('V', 0.0)))
                    moment_n1 = abs(float(force['n1'].get('M', 0.0)))
                    if shear_n1 > max_abs_shear:
                        max_abs_shear = shear_n1
                        control_element_shear = str(elem_id)
                    if moment_n1 > max_abs_moment:
                        max_abs_moment = moment_n1
                        control_element_moment = str(elem_id)
                if 'n2' in force and isinstance(force['n2'], dict):
                    shear_n2 = abs(float(force['n2'].get('V', 0.0)))
                    moment_n2 = abs(float(force['n2'].get('M', 0.0)))
                    if shear_n2 > max_abs_shear:
                        max_abs_shear = shear_n2
                        control_element_shear = str(elem_id)
                    if moment_n2 > max_abs_moment:
                        max_abs_moment = moment_n2
                        control_element_moment = str(elem_id)
            elif isinstance(force, list):
                for v in force:
                    axial = abs(float(v))
                    if axial > max_abs_axial:
                        max_abs_axial = axial
                        control_element_axial = str(elem_id)

        max_abs_reaction = 0.0
        control_node_reaction = ''
        for node_id, reaction in reactions.items():
            for v in self._iter_numeric_values(reaction):
                abs_v = abs(float(v))
                if abs_v > max_abs_reaction:
                    max_abs_reaction = abs_v
                    control_node_reaction = str(node_id)

        return {
            'maxAbsDisplacement': max_abs_disp,
            'maxAbsAxialForce': max_abs_axial,
            'maxAbsShearForce': max_abs_shear,
            'maxAbsMoment': max_abs_moment,
            'maxAbsReaction': max_abs_reaction,
            'controlNodeDisplacement': control_node_disp,
            'controlElementAxialForce': control_element_axial,
            'controlElementShearForce': control_element_shear,
            'controlElementMoment': control_element_moment,
            'controlNodeReaction': control_node_reaction,
        }


    def _iter_numeric_values(self, obj: Any):
        if isinstance(obj, dict):
            for value in obj.values():
                yield from self._iter_numeric_values(value)
        elif isinstance(obj, list):
            for value in obj:
                yield from self._iter_numeric_values(value)
        elif isinstance(obj, (int, float, np.floating, np.integer)):
            yield float(obj)


    def _generate_summary(self, displacements: Dict, forces: Dict) -> Dict:
        """生成分析结果摘要"""
        if not displacements:
            return {}

        # 找最大位移
        max_disp = 0
        max_disp_node = None
        for node_id, disp in displacements.items():
            total_disp = (disp['ux']**2 + disp['uy']**2 + disp['uz']**2)**0.5
            if total_disp > max_disp:
                max_disp = total_disp
                max_disp_node = node_id

        return {
            'maxDisplacement': max_disp,
            'maxDisplacementNode': max_disp_node,
            'nodeCount': len(displacements),
            'elementCount': len(forces)
        }
