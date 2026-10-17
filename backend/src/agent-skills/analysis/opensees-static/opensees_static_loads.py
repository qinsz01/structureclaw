from opensees_shared.errors import OpenSeesInputError, OpenSeesMissingInputError, OpenSeesCapabilityError
"""Load normalization, floor transfer and summaries; no numerical solver implementation."""
import numpy as np
from typing import Dict, Any, List, Optional, Set, Tuple
import logging
import math
import re
from opensees_static_floor_loads import StoryFloorLoadMixin
from opensees_static_floor_panels import FloorPanelLoadMixin

logger = logging.getLogger(__name__)


class StaticLoadContext(StoryFloorLoadMixin, FloorPanelLoadMixin):
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
                'reactionMoment': '',
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
                ('maxAbsReactionMoment', 'reactionMoment'),
            ]
            for metric, control_name in mapping:
                if metric not in env:
                    continue
                value = float(env[metric])
                if metric not in summary_envelope or value > float(summary_envelope[metric]):
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
            item = node_reaction_envelope.setdefault(
                str(node_id),
                {
                    'maxAbsReaction': 0.0,
                    'controlCase': '',
                    'controlCaseReactionMoment': '',
                },
            )
            for metric, control, components in (
                ('maxAbsReaction', 'controlCase', ('fx', 'fy', 'fz')),
                ('maxAbsReactionMoment', 'controlCaseReactionMoment', ('mx', 'my', 'mz')),
            ):
                values = self._reaction_magnitudes(reaction, components)
                if not values:
                    continue
                peak = max(values)
                if metric not in item or peak > float(item[metric]):
                    item[metric] = peak
                    item[control] = case_id

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

        reaction_envelope = {}
        for metric, control, components in (
            ('maxAbsReaction', 'controlNodeReaction', ('fx', 'fy', 'fz')),
            ('maxAbsReactionMoment', 'controlNodeReactionMoment', ('mx', 'my', 'mz')),
        ):
            peak, control_node = None, ''
            for node_id, reaction in reactions.items():
                for value in self._reaction_magnitudes(reaction, components):
                    if peak is None or value > peak:
                        peak, control_node = value, str(node_id)
            if peak is not None:
                reaction_envelope.update({metric: peak, control: control_node})

        return {
            'maxAbsDisplacement': max_abs_disp,
            'maxAbsAxialForce': max_abs_axial,
            'maxAbsShearForce': max_abs_shear,
            'maxAbsMoment': max_abs_moment,
            **reaction_envelope,
            'controlNodeDisplacement': control_node_disp,
            'controlElementAxialForce': control_element_axial,
            'controlElementShearForce': control_element_shear,
            'controlElementMoment': control_element_moment,
        }

    @staticmethod
    def _reaction_magnitudes(reaction, components):
        if not isinstance(reaction, dict):
            return []
        return [abs(float(value)) for key in components
                if isinstance(value := reaction.get(key), (int, float)) and math.isfinite(value)]

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
