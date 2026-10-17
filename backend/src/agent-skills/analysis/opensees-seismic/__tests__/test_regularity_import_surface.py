"""regularity.py keeps its import surface after the split into regularity_* sibling modules."""
from __future__ import annotations

import inspect
import sys
from pathlib import Path

OPENSEES_SEISMIC_DIR = Path(__file__).resolve().parents[1]
BACKEND_SRC_DIR = OPENSEES_SEISMIC_DIR.parents[2]
for path in (
    BACKEND_SRC_DIR / "skill-shared" / "python",
    OPENSEES_SEISMIC_DIR.parent / "runtime",
    OPENSEES_SEISMIC_DIR.parent,
    OPENSEES_SEISMIC_DIR,
):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

import regularity  # noqa: E402

# Top-level functions and constants regularity.py defined before the split.
REGULARITY_NAMES = [
    'G_ACCEL', 'RegularityAssessment', 'SEVERITY_ORDER', '_bbox_area', '_classification_from_explicit',
    '_explicit_story_weight', '_explicit_weak_soft_story_checks', '_floor_diaphragm_discontinuity_checks',
    '_is_true', '_material_elastic_modulus', '_model_payload', '_node_story_key', '_node_value',
    '_plan_aspect_check', '_plan_dimension', '_plan_setback_checks', '_records_by_id', '_section_inertia',
    '_severity_max', '_slab_opening_area', '_stories', '_story_height_checks', '_story_lateral_stiffness_checks',
    '_story_lateral_strength_checks', '_story_lateral_strength_value', '_story_load_checks',
    '_story_load_value', '_story_mass_checks', '_story_nodes', '_story_nodes_by_key', '_story_opening_area',
    '_story_opening_ratio', '_story_opening_records', '_story_plan_area',
    '_structured_plan_irregularity_candidates', '_structured_plan_irregularity_checks',
    '_structured_story_lateral_stiffness_checks', '_structured_story_lateral_stiffness_value',
    '_structured_torsional_displacement_ratio_checks', '_torsional_eccentricity_checks',
    '_torsional_ratio_candidates', '_vertical_lateral_system_discontinuity_checks', 'assess_regularity',
]


def _same_object_as_defining_module(entry, names, sibling_prefix):
    mismatched = []
    for name in names:
        value = getattr(entry, name)
        module_name = getattr(value, "__module__", None)
        if inspect.isfunction(value) and module_name and module_name.startswith(sibling_prefix):
            if getattr(sys.modules[module_name], name) is not value:
                mismatched.append(name)
    return mismatched


def test_regularity_names_import_from_regularity():
    assert len(REGULARITY_NAMES) == 43
    assert [name for name in REGULARITY_NAMES if not hasattr(regularity, name)] == []
    assert _same_object_as_defining_module(regularity, REGULARITY_NAMES, "regularity_") == []
    import regularity_common
    import result_adapter

    assert regularity.SEVERITY_ORDER is regularity_common.SEVERITY_ORDER
    assert result_adapter.RegularityAssessment is regularity.RegularityAssessment
    assert regularity.RegularityAssessment.__module__ == "regularity"
