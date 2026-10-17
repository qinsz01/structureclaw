"""GB 50011 seismic code-check skill entry.

The check implementations live in the sibling ``checks`` package, grouped by
check family. This module is loaded by file path (``code-check/code_check.py``
and the skill tests) and keeps re-exporting every name it historically defined,
so ``get_rules``, ``check_element`` and all helpers stay reachable from here.
"""

from __future__ import annotations

import math
import sys
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from types import ModuleType
from typing import Any, Dict, List, Optional

from gb50011_drift_limits import gb50011_elastic_drift_limit_metadata

_CHECKS_PACKAGE = 'gb50011_checks'
_CHECKS_DIR = Path(__file__).resolve().parent / 'checks'


def _load_checks_package() -> ModuleType:
    """Register the sibling ``checks`` directory as package ``gb50011_checks``.

    This entry is loaded by path under varying module names, so it is not part
    of a package and relative imports are unavailable. Loading the package
    explicitly avoids putting this directory, which holds its own
    ``code_check.py``, on ``sys.path``.
    """
    loaded = sys.modules.get(_CHECKS_PACKAGE)
    if loaded is not None and Path(loaded.__file__).resolve().parent == _CHECKS_DIR:
        return loaded
    for name in [key for key in sys.modules if key == _CHECKS_PACKAGE or key.startswith(_CHECKS_PACKAGE + '.')]:
        del sys.modules[name]
    spec = spec_from_file_location(
        _CHECKS_PACKAGE,
        _CHECKS_DIR / '__init__.py',
        submodule_search_locations=[str(_CHECKS_DIR)],
    )
    if spec is None or spec.loader is None:
        raise ImportError(f'Unable to load GB50011 checks package: {_CHECKS_DIR}')
    package = module_from_spec(spec)
    sys.modules[_CHECKS_PACKAGE] = package
    spec.loader.exec_module(package)
    return package


_load_checks_package()

from gb50011_checks.constants import (  # noqa: E402,F401
    C30_DESIGN_STRENGTH_MPA,
    C35_DESIGN_STRENGTH_MPA,
    FRAME_COLUMN_AXIAL_RATIO_LIMITS,
    FRAME_COLUMN_STIRRUP_CHARACTERISTIC_VALUES,
    FRAME_COLUMN_STIRRUP_CHARACTERISTIC_VALUE_BINS,
    FRAME_JOINT_CORE_CHARACTERISTIC_MINIMUMS,
    FRAME_JOINT_CORE_VOLUME_RATIO_MINIMUMS,
    GB50011_2024_CODE_VERSION,
    GLOBAL_SEISMIC_ELEMENT_ID,
    STORY_MINIMUM_SHEAR_COEFFICIENT_HIGH_ACCELERATION,
    STORY_MINIMUM_SHEAR_COEFFICIENT_LONG_PERIOD,
    STORY_MINIMUM_SHEAR_COEFFICIENT_SHORT_PERIOD,
)
from gb50011_checks.rules import (  # noqa: E402,F401
    get_rules,
)
from gb50011_checks.common import (  # noqa: E402,F401
    _aggregate_check_status,
    _check_item,
    _concrete_grade_from_material,
    _concrete_grade_value,
    _element_context,
    _element_metadata,
    _element_type,
    _first_number_from_records,
    _is_concrete_frame_beam,
    _is_concrete_frame_beam_or_column,
    _is_concrete_frame_column,
    _is_concrete_frame_joint,
    _is_concrete_shear_wall,
    _is_false,
    _is_steel_member,
    _is_transfer_frame_member,
    _is_true,
    _material_strength_mpa,
    _minimum_required_ratio_check_item,
    _normalize_seismic_grade,
    _number,
    _number_from_keys,
    _optional_bool_from_sources,
    _ratio_percent_from_keys,
    _ratio_percent_from_sources,
    _record,
    _section_modulus_mm3,
)
from gb50011_checks.design_basis import (  # noqa: E402,F401
    _design_basis_completeness_item,
    _expected_fortification_trace,
    _fortification_category_item,
    _fortification_category_key,
    _gb18306_standard_status_item,
    _seismic_grade_design_basis_item,
)
from gb50011_checks.reinforcement import (  # noqa: E402,F401
    _column_longitudinal_reinforcement_group,
    _column_stirrup_group,
    _dimension_from_keys_mm,
    _dimension_mm,
    _rebar_strength_from_grade,
    _reinforcement_area_mm2,
    _reinforcement_count,
    _reinforcement_data,
    _reinforcement_diameter_mm,
    _reinforcement_end_area_mm2,
    _reinforcement_group,
    _section_area_mm2,
    _section_dimension_mm,
    _structured_rebar_strength_mpa,
)
from gb50011_checks.element_context import (  # noqa: E402,F401
    _axial_compression_ratio_limit,
    _beam_span_mm,
    _column_position_text,
    _column_shear_span_ratio_info,
    _element_axial_demand_kn,
    _frame_column_axial_limit_info,
    _frame_column_min_side_mm,
    _is_corner_or_frame_supported_column,
    _member_combination_action_entries,
    _member_combination_axial_demand_kn,
    _seismic_grade,
    _site_category_text,
    _story_count,
    _structured_high_rise,
)
from gb50011_checks.member_capacity import (  # noqa: E402,F401
    _component_capacity_adjustment_from_sources,
    _component_capacity_from_sources,
    _member_capacity_screening_item,
    _member_force_entries_from_map,
    _structured_capacity_sources,
    _structured_capacity_utilization_from_sources,
    _structured_seismic_combination_member_capacity_item,
    _vertical_member_capacity_items,
    _vertical_member_capacity_records,
    _vertical_member_explicit_capacity_result,
)
from gb50011_checks.response_spectrum import (  # noqa: E402,F401
    _design_basic_acceleration_g,
    _design_intensity,
    _fundamental_period,
    _has_significant_torsion,
    _modal_mass_participation_item,
    _response_spectrum_long_period_special_study_item,
    _site_seismic_record,
    _story_label,
    _story_minimum_seismic_shear_coefficient_item,
    _story_minimum_shear_base_limit,
    _story_minimum_shear_coefficient_rows,
    _story_shear_weight_entries,
    _story_shear_weight_entries_from_rows,
    _story_shear_weight_ratio_from_row,
)
from gb50011_checks.seismic_review import (  # noqa: E402,F401
    _capability_boundary_item,
    _over_limit_special_review_item,
    _review_reasons,
    _review_requirement_trace,
    _review_status_trace,
    _special_system_check_traces,
    _special_system_review_item,
    _workflow_input_mode_item,
)
from gb50011_checks.time_history import (  # noqa: E402,F401
    _actual_ground_motion_item,
    _elastic_plastic_time_history_final_compliance_item,
    _ground_motion_record_count_item,
    _ground_motion_scale_factor_item,
    _ground_motion_spectrum_compatibility_item,
    _required_time_history_item,
    _time_history_combination_rule_item,
    _time_history_direction_trace_item,
)
from gb50011_checks.global_checks import (  # noqa: E402,F401
    _elastic_drift_limit_metadata,
    _global_seismic_checks,
    _horizontal_seismic_member_force_item,
    _member_design_action_combination_capacity_items,
    _member_design_action_combination_item,
    _pushover_final_compliance_item,
    _pushover_nonlinear_estimate_item,
    _regularity_time_history_trigger_item,
    _vertical_seismic_action_item,
    _vertical_seismic_member_force_item,
)
from gb50011_checks.frame_joint import (  # noqa: E402,F401
    _frame_joint_core_group,
    _frame_joint_core_shear_capacity_item,
    _frame_joint_core_stirrup_detailing_item,
    _frame_joint_strong_column_weak_beam_item,
    _joint_core_adjacent_column_volume_ratio_percent,
    _joint_core_characteristic_value,
    _joint_core_shear_demand_capacity,
    _joint_core_volume_ratio_percent,
    _strong_column_weak_beam_marker,
    _strong_column_weak_beam_records,
    _strong_column_weak_beam_sources,
    _strong_column_weak_beam_subcheck,
)
from gb50011_checks.frame_column_stirrup import (  # noqa: E402,F401
    _column_axial_compression_ratio_value,
    _column_non_confined_stirrup_volume_ratio_percent,
    _column_stirrup_characteristic_value,
    _column_stirrup_type_key,
    _column_stirrup_volume_ratio_percent,
    _column_stirrup_yield_strength_mpa,
    _frame_column_stirrup_confined_zone_range_item,
    _frame_column_stirrup_detailing_item,
    _frame_column_stirrup_volume_ratio_item,
)
from gb50011_checks.frame_beam_data import (  # noqa: E402,F401
    _beam_end_bottom_top_area_ratio,
    _beam_end_compression_zone_ratio,
    _beam_end_longitudinal_group,
    _beam_end_stirrup_group,
    _beam_end_tension_reinforcement_ratio_percent,
    _beam_longitudinal_diameter_mm,
    _beam_through_joint_bar_diameter_mm,
    _beam_through_joint_column_dimension_mm,
    _beam_through_joint_longitudinal_group,
    _flat_beam_column_longitudinal_diameter_mm,
    _flat_beam_detailing_group,
    _max_reinforcement_diameter_mm,
    _reinforcement_area_from_group_keys,
)
from gb50011_checks.frame_column import (  # noqa: E402,F401
    _concrete_frame_member_strength_grade_item,
    _frame_column_axial_compression_ratio_item,
    _frame_column_longitudinal_detailing_item,
    _frame_column_longitudinal_reinforcement_item,
    _frame_column_section_geometry_item,
    _frame_column_shear_span_ratio_item,
)
from gb50011_checks.frame_beam import (  # noqa: E402,F401
    _frame_beam_end_longitudinal_ductility_item,
    _frame_beam_flat_beam_detailing_item,
    _frame_beam_longitudinal_reinforcement_item,
    _frame_beam_section_geometry_item,
    _frame_beam_stirrup_detailing_item,
    _frame_beam_through_joint_bar_diameter_item,
)
from gb50011_checks.shear_wall import (  # noqa: E402,F401
    _shear_wall_axial_compression_ratio_item,
    _shear_wall_axial_ratio_from_sources,
    _shear_wall_axial_ratio_limit_from_sources,
    _shear_wall_detailing_group,
    _shear_wall_distributed_reinforcement_item,
    _shear_wall_section_area_mm2,
    _shear_wall_thickness_item,
    _wall_bool,
    _wall_dimension_from_sources,
    _wall_orientation_group,
    _wall_reinforcement_diameter_mm,
    _wall_reinforcement_ratio_percent,
)
from gb50011_checks.shear_wall_boundary import (  # noqa: E402,F401
    _first_wall_boundary_dimension,
    _first_wall_boundary_ratio_percent,
    _shear_wall_boundary_element_item,
    _wall_boundary_ratio_limit_percent,
    _wall_boundary_ratio_percent,
    _wall_boundary_records,
    _wall_boundary_required,
    _wall_boundary_transverse_group,
)
from gb50011_checks.steel import (  # noqa: E402,F401
    STEEL_SEISMIC_DETAILING_MARKER_KEYS,
    _explicit_steel_detailing_subcheck,
    _steel_detailing_number_info,
    _steel_detailing_subcheck_from_pair,
    _steel_member_seismic_detailing_item,
    _steel_seismic_detailing_sources,
)
from gb50011_checks.strong_shear_weak_bending import (  # noqa: E402,F401
    _frame_member_strong_shear_weak_bending_item,
    _strong_shear_weak_bending_marker,
    _strong_shear_weak_bending_records,
    _strong_shear_weak_bending_sources,
    _strong_shear_weak_bending_subcheck,
)
from gb50011_checks.shear_compression import (  # noqa: E402,F401
    _concrete_member_shear_compression_limit_item,
    _is_concrete_shear_compression_member,
    _shear_compression_coefficient,
    _shear_compression_demand_kn,
    _shear_compression_effective_depth_mm,
    _shear_compression_explicit_utilization,
    _shear_compression_gamma_re,
    _shear_compression_group,
    _shear_compression_has_marker,
    _shear_compression_span_depth_ratio,
    _shear_compression_width_mm,
)


def check_element(checker: Any, elem_id: str, context: Dict[str, Any]) -> Dict[str, Any]:
    if elem_id == GLOBAL_SEISMIC_ELEMENT_ID:
        return checker._build_element_result(
            elem_id,
            'global-seismic',
            _global_seismic_checks(context),
            GB50011_2024_CODE_VERSION,
        )

    axial_ratio_item = _frame_column_axial_compression_ratio_item(elem_id, context)
    shear_span_item = _frame_column_shear_span_ratio_item(elem_id, context)
    column_longitudinal_reinforcement_item = _frame_column_longitudinal_reinforcement_item(elem_id, context)
    column_longitudinal_detailing_item = _frame_column_longitudinal_detailing_item(elem_id, context)
    column_stirrup_detailing_item = _frame_column_stirrup_detailing_item(elem_id, context)
    column_stirrup_confined_zone_range_item = _frame_column_stirrup_confined_zone_range_item(elem_id, context)
    column_stirrup_volume_ratio_item = _frame_column_stirrup_volume_ratio_item(elem_id, context)
    joint_core_shear_capacity_item = _frame_joint_core_shear_capacity_item(elem_id, context)
    joint_strong_column_weak_beam_item = _frame_joint_strong_column_weak_beam_item(elem_id, context)
    joint_core_stirrup_detailing_item = _frame_joint_core_stirrup_detailing_item(elem_id, context)
    concrete_strength_item = _concrete_frame_member_strength_grade_item(elem_id, context)
    beam_geometry_item = _frame_beam_section_geometry_item(elem_id, context)
    beam_flat_beam_detailing_item = _frame_beam_flat_beam_detailing_item(elem_id, context)
    beam_longitudinal_reinforcement_item = _frame_beam_longitudinal_reinforcement_item(elem_id, context)
    beam_end_longitudinal_ductility_item = _frame_beam_end_longitudinal_ductility_item(elem_id, context)
    beam_through_joint_bar_diameter_item = _frame_beam_through_joint_bar_diameter_item(elem_id, context)
    beam_stirrup_detailing_item = _frame_beam_stirrup_detailing_item(elem_id, context)
    column_geometry_item = _frame_column_section_geometry_item(elem_id, context)
    shear_wall_thickness_item = _shear_wall_thickness_item(elem_id, context)
    shear_wall_axial_ratio_item = _shear_wall_axial_compression_ratio_item(elem_id, context)
    shear_wall_distributed_reinforcement_item = _shear_wall_distributed_reinforcement_item(elem_id, context)
    shear_wall_boundary_element_item = _shear_wall_boundary_element_item(elem_id, context)
    structured_member_capacity_item = _structured_seismic_combination_member_capacity_item(elem_id, context)
    steel_member_seismic_detailing_item = _steel_member_seismic_detailing_item(elem_id, context)
    strong_shear_weak_bending_item = _frame_member_strong_shear_weak_bending_item(elem_id, context)
    shear_compression_limit_item = _concrete_member_shear_compression_limit_item(elem_id, context)
    section_items = [
        checker._calc_item(elem_id, '轴压比', context, 'GB/T 50011-2010(2024) 6.3.6', 'N/(fc*A) <= ξ_lim', 1.0),
        checker._calc_item(elem_id, '剪跨比', context, 'GB/T 50011-2010(2024) 6.3.7', 'a/h0 >= 2.0', 1.0),
    ]
    if axial_ratio_item is not None:
        section_items.append(axial_ratio_item)
    if shear_span_item is not None:
        section_items.append(shear_span_item)
    if column_longitudinal_reinforcement_item is not None:
        section_items.append(column_longitudinal_reinforcement_item)
    if column_longitudinal_detailing_item is not None:
        section_items.append(column_longitudinal_detailing_item)
    if column_stirrup_detailing_item is not None:
        section_items.append(column_stirrup_detailing_item)
    if column_stirrup_confined_zone_range_item is not None:
        section_items.append(column_stirrup_confined_zone_range_item)
    if column_stirrup_volume_ratio_item is not None:
        section_items.append(column_stirrup_volume_ratio_item)
    if joint_core_shear_capacity_item is not None:
        section_items.append(joint_core_shear_capacity_item)
    if joint_strong_column_weak_beam_item is not None:
        section_items.append(joint_strong_column_weak_beam_item)
    if joint_core_stirrup_detailing_item is not None:
        section_items.append(joint_core_stirrup_detailing_item)
    if concrete_strength_item is not None:
        section_items.append(concrete_strength_item)
    if beam_geometry_item is not None:
        section_items.append(beam_geometry_item)
    if beam_flat_beam_detailing_item is not None:
        section_items.append(beam_flat_beam_detailing_item)
    if beam_longitudinal_reinforcement_item is not None:
        section_items.append(beam_longitudinal_reinforcement_item)
    if beam_end_longitudinal_ductility_item is not None:
        section_items.append(beam_end_longitudinal_ductility_item)
    if beam_through_joint_bar_diameter_item is not None:
        section_items.append(beam_through_joint_bar_diameter_item)
    if beam_stirrup_detailing_item is not None:
        section_items.append(beam_stirrup_detailing_item)
    if column_geometry_item is not None:
        section_items.append(column_geometry_item)
    if shear_wall_thickness_item is not None:
        section_items.append(shear_wall_thickness_item)
    if shear_wall_axial_ratio_item is not None:
        section_items.append(shear_wall_axial_ratio_item)
    if shear_wall_distributed_reinforcement_item is not None:
        section_items.append(shear_wall_distributed_reinforcement_item)
    if shear_wall_boundary_element_item is not None:
        section_items.append(shear_wall_boundary_element_item)
    if structured_member_capacity_item is not None:
        section_items.append(structured_member_capacity_item)
    if steel_member_seismic_detailing_item is not None:
        section_items.append(steel_member_seismic_detailing_item)
    if strong_shear_weak_bending_item is not None:
        section_items.append(strong_shear_weak_bending_item)
    if shear_compression_limit_item is not None:
        section_items.append(shear_compression_limit_item)

    checks = [
        {
            'name': '截面抗震验算',
            'items': section_items,
        },
        {
            'name': '位移验算',
            'items': [
                checker._calc_item(elem_id, '弹性层间位移角', context, 'GB/T 50011-2010(2024) 5.5.1', 'θ_e <= θ_lim', 1.0),
            ],
        },
    ]
    return checker._build_element_result(elem_id, 'column', checks, GB50011_2024_CODE_VERSION)
