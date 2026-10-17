"""Import surface of yjk_driver.py after moving result mapping into sibling modules."""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

YJK_STATIC_DIR = Path(__file__).resolve().parents[1]

# Top-level names yjk_driver.py defined before the split.
PRE_SPLIT_NAMES = [
    'SCRIPT_DIR', '_CURRENT_WORK_DIR', '_DLL_HANDLES', '_OWNED_LAUNCHER', '_SDK_PIPE',
    '_accumulate_element_envelope', '_accumulate_node_envelope', '_accumulate_reaction_envelope',
    '_build_analysis_result', '_build_element_lookups', '_build_result_node_lookup',
    '_build_yjk_design_results', '_case_block', '_case_descriptors', '_category_element_type',
    '_collect_out_files', '_connect_owned_host', '_coord_key', '_element_category', '_emit_json',
    '_endpoint_key', '_env_flag', '_env_float', '_env_path', '_env_text', '_error', '_find_yjks_exe',
    '_finish_after_json', '_finite_result_float', '_flush_stdio', '_force_from_sections',
    '_id_candidates', '_load_json_file', '_member_id_for', '_merge_max_force', '_merge_max_reaction',
    '_merge_member_definition', '_native_case_code', '_node_lookup_from_mapping',
    '_owned_native_processes', '_prepare_axial_gravity', '_prepare_owned_launcher',
    '_raw_member_definition_lookup', '_reaction_from_raw', '_record_step', '_run', '_run_cmd',
    '_safe_float', '_select_owned_host', '_setup_paths', '_signed_max_abs', '_windows_session',
    '_write_driver_output_json', '_write_steps_json', 'main',
]


def _load_driver():
    spec = importlib.util.spec_from_file_location("yjk_driver_import_surface", YJK_STATIC_DIR / "yjk_driver.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_all_pre_split_names_import_from_driver():
    driver = _load_driver()
    assert [name for name in PRE_SPLIT_NAMES if not hasattr(driver, name)] == []


def test_moved_functions_are_the_sibling_module_objects():
    driver = _load_driver()
    siblings = {"yjk_result_lookup", "yjk_result_mapping"}
    moved = {name: getattr(driver, name).__module__ for name in PRE_SPLIT_NAMES
             if getattr(getattr(driver, name), "__module__", None) in siblings}
    assert len(moved) == 27
    assert moved["_build_analysis_result"] == "yjk_result_mapping"
    assert moved["_safe_float"] == "yjk_result_lookup"
    for name, module_name in moved.items():
        assert getattr(driver, name) is getattr(sys.modules[module_name], name), name


def test_driver_import_does_not_load_vendor_modules():
    _load_driver()
    assert "YJKAPI" not in sys.modules
