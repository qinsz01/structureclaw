"""Import surface of gb50011/code_check.py after the split into the ``checks`` package."""
from __future__ import annotations

import importlib.util
import inspect
import sys
from pathlib import Path

_SHARED_PYTHON_PATH = str(Path(__file__).resolve().parents[4] / "skill-shared" / "python")
if _SHARED_PYTHON_PATH not in sys.path:
    sys.path.insert(0, _SHARED_PYTHON_PATH)

_MODULE_PATH = Path(__file__).resolve().parent.parent / "code_check.py"


def _load(name: str):
    spec = importlib.util.spec_from_file_location(name, _MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


entry = _load("gb50011_import_surface_entry")

PUBLIC_NAMES = [
    "C30_DESIGN_STRENGTH_MPA",
    "C35_DESIGN_STRENGTH_MPA",
    "FRAME_COLUMN_AXIAL_RATIO_LIMITS",
    "FRAME_COLUMN_STIRRUP_CHARACTERISTIC_VALUES",
    "FRAME_COLUMN_STIRRUP_CHARACTERISTIC_VALUE_BINS",
    "FRAME_JOINT_CORE_CHARACTERISTIC_MINIMUMS",
    "FRAME_JOINT_CORE_VOLUME_RATIO_MINIMUMS",
    "GB50011_2024_CODE_VERSION",
    "GLOBAL_SEISMIC_ELEMENT_ID",
    "STEEL_SEISMIC_DETAILING_MARKER_KEYS",
    "STORY_MINIMUM_SHEAR_COEFFICIENT_HIGH_ACCELERATION",
    "STORY_MINIMUM_SHEAR_COEFFICIENT_LONG_PERIOD",
    "STORY_MINIMUM_SHEAR_COEFFICIENT_SHORT_PERIOD",
    "check_element",
    "get_rules",
    "gb50011_elastic_drift_limit_metadata",
]

# Top-level functions and constants defined by code_check.py before the split.
PRE_SPLIT_TOP_LEVEL_DEFINITION_COUNT = 213


def _package_definitions():
    package = sys.modules["gb50011_checks"]
    definitions = {}
    for path in sorted(Path(package.__path__[0]).glob("*.py")):
        if path.stem == "__init__":
            continue
        module = sys.modules[f"gb50011_checks.{path.stem}"]
        for name, value in vars(module).items():
            if inspect.isfunction(value) and value.__module__ == module.__name__:
                definitions[name] = value
            elif name.isupper():
                definitions[name] = value
    return definitions


def test_public_names_import_from_entry():
    missing = [name for name in PUBLIC_NAMES if not hasattr(entry, name)]
    assert missing == []
    assert callable(entry.get_rules) and callable(entry.check_element)


def test_every_package_definition_is_reexported_as_same_object():
    definitions = _package_definitions()
    definitions["check_element"] = entry.check_element
    assert len(definitions) == PRE_SPLIT_TOP_LEVEL_DEFINITION_COUNT
    not_same = [name for name, value in definitions.items() if getattr(entry, name, None) is not value]
    assert not_same == []


def test_constants_keep_identity_across_entry_loads():
    second = _load("gb50011_import_surface_entry_second")
    assert second.FRAME_COLUMN_AXIAL_RATIO_LIMITS is entry.FRAME_COLUMN_AXIAL_RATIO_LIMITS
    assert second.GLOBAL_SEISMIC_ELEMENT_ID == entry.GLOBAL_SEISMIC_ELEMENT_ID
    assert entry.get_rules()["code"] == "GB50011"
