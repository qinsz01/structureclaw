"""pushover.py keeps its import surface after the split into pushover_* sibling modules."""
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

import pushover  # noqa: E402

# Top-level functions and constants pushover.py defined before the split.
PUSHOVER_NAMES = [
    'PUSHOVER_BILINEAR_SDOF_CAPABILITY', 'PUSHOVER_BILINEAR_STORY_SHEAR_CAPABILITY',
    'PUSHOVER_MEMBER_HINGE_2D_CAPABILITY', '_as_record', '_backbone_yield_point', '_base_and_top',
    '_capacity_assessment', '_capacity_spectrum_iteration', '_control_node_tag', '_convergence_settings',
    '_field', '_final_compliance_assessment', '_first_number', '_first_string', '_hinge_ends',
    '_interpolate_curve_displacement_for_base_shear', '_interpolate_curve_value', '_lateral_load_for_node',
    '_looks_like_hinge_record', '_member_plastic_hinge_definitions', '_node_key', '_performance_objective',
    '_pushover_bilinear_parameters', '_records', '_run_bilinear_sdof_pushover_estimate',
    '_run_bilinear_story_shear_pushover_estimate', '_run_member_hinge_2d_pushover_estimate',
    '_story_shear_definition', '_structured_entries', '_total_mass_and_weight', 'run_linear_pushover',
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


def test_pushover_names_import_from_pushover():
    assert len(PUSHOVER_NAMES) == 31
    assert [name for name in PUSHOVER_NAMES if not hasattr(pushover, name)] == []
    assert _same_object_as_defining_module(pushover, PUSHOVER_NAMES, "pushover_") == []
    from nonlinear_time_history import _convergence_settings, _member_plastic_hinge_definitions

    assert _convergence_settings is pushover._convergence_settings
    assert _member_plastic_hinge_definitions is pushover._member_plastic_hinge_definitions
