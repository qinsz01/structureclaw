"""StaticLoadContext keeps its full method surface after moving floor-load methods into mixins."""
import sys
from pathlib import Path

SKILL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SKILL))
sys.path.insert(0, str(SKILL.parents[2] / "skill-shared" / "python"))

import opensees_static_loads  # noqa: E402
from opensees_static_floor_loads import StoryFloorLoadMixin  # noqa: E402
from opensees_static_floor_panels import FloorPanelLoadMixin  # noqa: E402
from opensees_static_loads import StaticLoadContext  # noqa: E402

# Methods StaticLoadContext defined before the split.
PRE_SPLIT_METHODS = [
    '__init__', '_run_batch_cases', '_accumulate_case_envelope_tables', '_collect_nodal_loads',
    '_is_derived_story_floor_load', '_floor_load_specs_for_case', '_floor_load_types_for_case',
    '_infer_floor_load_type_from_case_id', '_expand_story_floor_loads', '_expand_story_floor_loads_to_nodes',
    '_expand_story_floor_load_to_nodes', '_expand_story_floor_loads_to_slab_beams', '_story_floor_load_intensity',
    '_floor_load_transfer_mode', '_floor_load_transfer_method_label', '_floor_load_transfer_method_label_zh',
    '_story_floor_panels', '_find_beam_between', '_points_match', '_segment_contains_points', '_point_on_segment',
    '_point_distance', '_panel_floor_loads', '_classify_panel_transfer_mode', '_panel_design_code_rule',
    '_panel_design_code_rule_zh', '_one_way_panel_loads', '_two_way_panel_loads', '_piecewise_linear_gravity_load',
    '_distributed_gravity_load', '_append_floor_load_trace_item', '_remove_floor_load_trace_items_for_story',
    '_append_floor_load_warning', '_floor_load_trace_warnings', '_refresh_floor_load_transfer_effective_mode',
    '_floor_load_transfer_summary', '_attach_floor_load_transfer', '_story_floor_load_components',
    '_story_floor_node_areas', '_target_floor_nodes', '_story_ordinal', '_z_levels', '_nodes_at_z',
    '_tributary_lengths', '_unique_sorted_coordinates', '_coord_key', '_floor_load_tributary_width', '_get_field',
    '_field_float', '_scale_load', '_normalize_load', '_strict_load_number', '_resolved_directional_load_value',
    '_to_float', '_build_envelope', '_reaction_magnitudes', '_iter_numeric_values', '_generate_summary',
]


def test_all_pre_split_methods_resolve_on_static_load_context():
    assert len(PRE_SPLIT_METHODS) == 58
    assert [name for name in PRE_SPLIT_METHODS if not hasattr(StaticLoadContext, name)] == []


def test_mixins_are_bases_and_partition_the_moved_methods():
    assert StaticLoadContext.__mro__[1:3] == (StoryFloorLoadMixin, FloorPanelLoadMixin)
    moved_floor = set(vars(StoryFloorLoadMixin)) & set(PRE_SPLIT_METHODS)
    moved_panel = set(vars(FloorPanelLoadMixin)) & set(PRE_SPLIT_METHODS)
    kept = set(vars(StaticLoadContext)) & set(PRE_SPLIT_METHODS)
    assert (len(moved_floor), len(moved_panel), len(kept)) == (29, 14, 15)
    assert moved_floor | moved_panel | kept == set(PRE_SPLIT_METHODS)


def test_module_level_names_unchanged():
    assert opensees_static_loads.logger.name == opensees_static_loads.__name__
    assert opensees_static_loads.StaticLoadContext is StaticLoadContext
