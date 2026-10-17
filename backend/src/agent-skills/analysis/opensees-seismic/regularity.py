from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Tuple

from seismic_contracts import as_record, optional_number

from regularity_common import (  # noqa: F401
    G_ACCEL,
    SEVERITY_ORDER,
    _bbox_area,
    _classification_from_explicit,
    _is_true,
    _material_elastic_modulus,
    _model_payload,
    _node_story_key,
    _node_value,
    _records_by_id,
    _section_inertia,
    _severity_max,
    _stories,
    _story_nodes_by_key,
)
from regularity_plan import (  # noqa: F401
    _plan_aspect_check,
    _plan_dimension,
    _plan_setback_checks,
    _structured_plan_irregularity_candidates,
    _structured_plan_irregularity_checks,
    _structured_torsional_displacement_ratio_checks,
    _torsional_eccentricity_checks,
    _torsional_ratio_candidates,
)
from regularity_stiffness import (  # noqa: F401
    _explicit_weak_soft_story_checks,
    _story_lateral_stiffness_checks,
    _story_lateral_strength_checks,
    _story_lateral_strength_value,
    _structured_story_lateral_stiffness_checks,
    _structured_story_lateral_stiffness_value,
    _vertical_lateral_system_discontinuity_checks,
)
from regularity_story import (  # noqa: F401
    _explicit_story_weight,
    _floor_diaphragm_discontinuity_checks,
    _slab_opening_area,
    _story_height_checks,
    _story_load_checks,
    _story_load_value,
    _story_mass_checks,
    _story_nodes,
    _story_opening_area,
    _story_opening_ratio,
    _story_opening_records,
    _story_plan_area,
)


@dataclass
class RegularityAssessment:
    classification: str
    source: str
    checks: List[Dict[str, Any]] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)
    assumptions: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "classification": self.classification,
            "source": self.source,
            "checks": self.checks,
            "warnings": self.warnings,
            "assumptions": self.assumptions,
        }


def assess_regularity(model: Any, workflow: Dict[str, Any]) -> RegularityAssessment:
    payload = _model_payload(model)
    requirements = as_record(workflow.get("designRequirements"))
    structure = as_record(workflow.get("structure"))
    regularity = as_record(workflow.get("regularityAssessment"))
    explicit = _classification_from_explicit(
        requirements.get("irregularity")
        or structure.get("irregularity")
        or regularity.get("classification")
        or regularity.get("regularity")
        or workflow.get("irregularity")
        or as_record(payload.get("metadata")).get("irregularity")
    )

    classification = explicit or "regular"
    source = "structured_requirement" if explicit else "model_heuristic"
    checks: List[Dict[str, Any]] = []
    warnings: List[str] = []
    assumptions: List[str] = []

    if explicit:
        checks.append({
            "name": "explicit_regularity",
            "severity": explicit,
            "value": explicit,
            "basis": "structured seismicWorkflow/model metadata",
        })

    stories = _stories(payload)
    for severity, new_checks, new_assumptions in (
        _story_height_checks(stories),
        _story_load_checks(stories),
        _story_mass_checks(payload),
        _floor_diaphragm_discontinuity_checks(payload),
        _structured_story_lateral_stiffness_checks(stories),
        _story_lateral_stiffness_checks(payload),
        _story_lateral_strength_checks(stories),
        _explicit_weak_soft_story_checks(payload, workflow),
        _plan_setback_checks(payload),
        _plan_aspect_check(payload),
        _structured_plan_irregularity_checks(payload, workflow),
        _vertical_lateral_system_discontinuity_checks(payload, workflow),
        _structured_torsional_displacement_ratio_checks(payload, workflow),
        _torsional_eccentricity_checks(payload),
    ):
        checks.extend(new_checks)
        assumptions.extend(new_assumptions)
        if severity != "unknown":
            classification = _severity_max(classification, severity)

    if not checks:
        classification = "unknown"
        source = "insufficient_model_data"
        warnings.append("No model regularity checks could be evaluated from the available structure model.")

    if classification in {"irregular", "particularly_irregular"}:
        warnings.append(
            "Automatic regularity assessment is heuristic and should be reviewed by the engineer against GB/T 50011 irregularity clauses."
        )

    return RegularityAssessment(
        classification=classification,
        source=source,
        checks=checks,
        warnings=warnings,
        assumptions=list(dict.fromkeys(assumptions)),
    )
