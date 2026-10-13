from __future__ import annotations

from opensees_shared.errors import OpenSeesInputError, OpenSeesMissingInputError, OpenSeesCapabilityError
from opensees_shared.evidence import attach_execution_artifacts

import math
import hashlib
import json
from typing import Any, Dict, List, Tuple

import numpy as np

from coordinate_semantics import (
    build_element_local_axes,
    coordinate_contract_metadata,
    get_model_metadata,
    get_reference_vector,
    resolve_model_dimension,
    validate_coordinate_contract,
)


FRAME_ELEMENT_TYPES = {"beam", "column"}
TRUSS_ELEMENT_TYPES = {"truss", "brace"}


from opensees_shared.model import OpenSeesModelBuilder


class OpenSeesDynamicExecutor(OpenSeesModelBuilder):
    """OpenSees modal and linear time-history execution in canonical axes."""

    def __init__(self, analyzer):
        super().__init__(analyzer.model)
        self.analyzer = self
        self.effective_settings = {}

    def _direction_dof(self, direction: str) -> Tuple[str, int, int]:
        normalized = str(direction or "x").strip().lower()
        if self.dimension == "2d":
            mapping = {"x": (1, 0), "z": (2, 2)}
        else:
            mapping = {"x": (1, 0), "y": (2, 1), "z": (3, 2)}
        if normalized not in mapping:
            allowed = ", ".join(mapping)
            raise OpenSeesInputError(f"Direction '{direction}' is inactive for a {self.dimension} model; expected {allowed}")
        opensees_dof, global_index = mapping[normalized]
        return normalized, opensees_dof, global_index

    def _build_model(self, ops) -> float:
        self.effective_settings = self.build(ops, mass=True)
        total = sum(self.node_masses.values())
        if total <= 0:
            raise OpenSeesMissingInputError("Dynamic analysis requires positive structural mass")
        return total

    def _execution_evidence(self, ops):
        return {"solver": "OpenSees", "solverVersion": ops.version(), "executed": True,
                "constitutiveModel": "linear-elastic", "effectiveSettings": self.effective_settings,
                "massSource": "explicit-node-mass" if self.mass_source == 'nodal' else "member-density-lumped-half-to-endpoints", "massUnit": "tonne",
                "nodeMasses": self.node_masses}

    def _global_mode_vector(self, vector: Any) -> List[float]:
        values = [float(value) for value in list(vector)]
        required = 2 if self.dimension == "2d" else 3
        if len(values) < required or not all(math.isfinite(value) for value in values[:required]):
            raise ValueError(f"OpenSees returned an incomplete {self.dimension} mode-shape vector")
        if self.dimension == "2d":
            return [values[0], 0.0, values[1]]
        return values[:3]

    def _available_mass_dofs(self) -> int:
        active_indices = (0, 2) if self.dimension == "2d" else (0, 1, 2)
        count = 0
        for node in self.model.nodes:
            if self.node_masses.get(str(node.id), 0.0) <= 0.0:
                continue
            restraints = list(node.restraints or [False] * 6)
            count += sum(1 for index in active_indices if not bool(restraints[index]))
        return count

    def _eigen_values(self, ops: Any, requested_modes: int) -> List[float]:
        available_modes = self._available_mass_dofs()
        if available_modes <= 0:
            raise OpenSeesInputError("Dynamic analysis requires at least one free translational mass DOF")
        count = min(max(1, int(requested_modes)), available_modes)
        last_error: Exception | None = None
        for arguments in ((count,), ("-fullGenLapack", count)):
            try:
                raw = ops.eigen(*arguments)
                values = [raw] if isinstance(raw, (int, float)) else list(raw or [])
                normalized = [float(value) for value in values]
                if not normalized:
                    raise ValueError("OpenSees returned no eigenvalues")
                if not all(math.isfinite(value) and value > 0.0 for value in normalized):
                    raise OpenSeesInputError(
                        "Dynamic model has non-positive or non-finite eigenvalues; check stability and restraints"
                    )
                return normalized
            except Exception as error:
                last_error = error
        raise ValueError(f"OpenSees eigen extraction failed for {count} requested modes: {last_error}")

    def modal_analysis(self, num_modes: int, ops, direction: str = "x") -> Dict[str, Any]:
        if isinstance(num_modes, bool) or int(num_modes) != num_modes or num_modes <= 0:
            raise OpenSeesInputError('numModes must be a positive integer')
        selected_direction, _, _ = self._direction_dof(direction)
        total_mass = self._build_model(ops)
        ops.system("BandSPD")
        ops.numberer("RCM")
        ops.constraints("Transformation")

        eigen_values = self._eigen_values(ops, num_modes)
        modes = []
        for index, eigen_value in enumerate(eigen_values):
            omega = math.sqrt(float(eigen_value))
            mode_shape = {}
            for node in self.model.nodes:
                vector = ops.nodeEigenvector(self.analyzer._ops_node_tag(node.id), index + 1)
                mode_shape[str(node.id)] = self._global_mode_vector(vector)
            modes.append({
                "modeNumber": index + 1,
                "period": 2.0 * math.pi / omega,
                "frequency": omega / (2.0 * math.pi),
                "omega": omega,
                "modeShape": mode_shape,
                "modeShapeFrame": "global",
            })
        if not modes:
            raise ValueError("OpenSees returned no positive dynamic modes")

        result = {
            "status": "success",
            "totalMass": total_mass,
            "modes": modes,
            "direction": selected_direction,
            "meta": {**coordinate_contract_metadata(self.model), "responseCoordinateConvention": "global-xyz"},
            "execution": self._execution_evidence(ops),
        }
        ops.wipe()
        return attach_execution_artifacts(result, self.model, {'analysisType':'modal', 'numModes':num_modes, 'direction':selected_direction})

    def time_history_analysis(
        self,
        time_step: float,
        duration: float,
        damping_ratio: float,
        ground_motion: List[float],
        ops,
        direction: str = "x",
        acceleration_unit: str = "m/s2",
    ) -> Dict[str, Any]:
        selected_direction, excitation_dof, global_index = self._direction_dof(direction)
        if not math.isfinite(time_step) or not math.isfinite(duration) or time_step <= 0.0 or duration <= 0.0:
            raise OpenSeesInputError("timeStep and duration must be positive")
        if not math.isfinite(damping_ratio) or damping_ratio < 0.0 or damping_ratio >= 1.0:
            raise OpenSeesInputError("dampingRatio must be in [0, 1)")
        if acceleration_unit not in {'m/s2', 'g'}:
            raise OpenSeesInputError("groundMotionUnit must be 'm/s2' or 'g'")
        if not ground_motion:
            raise OpenSeesMissingInputError("groundMotion is required; no synthetic earthquake is substituted")
        self._build_model(ops)

        eigen_values = [value for value in self._eigen_values(ops, 2) if value > 0.0]
        if not eigen_values:
            raise ValueError("Cannot derive Rayleigh damping without a positive eigenvalue")
        omega_1 = math.sqrt(eigen_values[0])
        if len(eigen_values) > 1:
            omega_2 = math.sqrt(eigen_values[1])
            alpha_mass = 2.0 * damping_ratio * omega_1 * omega_2 / (omega_1 + omega_2)
            beta_stiffness = 2.0 * damping_ratio / (omega_1 + omega_2)
        else:
            alpha_mass = 2.0 * damping_ratio * omega_1
            beta_stiffness = 0.0
        ops.rayleigh(alpha_mass, beta_stiffness, 0.0, 0.0)

        if ground_motion:
            acceleration = [float(value)*(9.80665 if acceleration_unit == 'g' else 1.0) for value in ground_motion]
        else:
            raise OpenSeesMissingInputError("groundMotion is required; no synthetic earthquake is substituted")
        if not acceleration or not all(math.isfinite(value) for value in acceleration):
            raise OpenSeesInputError("groundMotion must contain finite acceleration values")
        ops.timeSeries("Path", 1, "-dt", time_step, "-values", *acceleration)
        ops.pattern("UniformExcitation", 1, excitation_dof, "-accel", 1)
        ops.system("BandSPD")
        ops.numberer("RCM")
        ops.constraints("Transformation")
        ops.integrator("Newmark", 0.5, 0.25)
        ops.algorithm("Newton")
        ops.analysis("Transient")

        free_nodes = [
            node for node in self.model.nodes
            if not bool((list(node.restraints or [False] * 6))[global_index])
        ]
        monitor_node = max(
            free_nodes,
            key=lambda node: (float(node.z), float(node.y), float(node.x), str(node.id)),
            default=None,
        )
        if monitor_node is None:
            raise OpenSeesInputError(f"No node is free in the selected global {selected_direction.upper()} direction")

        results = []
        current_time = 0.0
        num_steps = int(math.floor(duration / time_step))
        if num_steps < 1:
            raise OpenSeesInputError("duration must include at least one complete time step")
        for _step in range(num_steps):
            analysis_code = int(ops.analyze(1, time_step))
            if analysis_code != 0:
                raise RuntimeError(
                    f"OpenSees transient analysis failed at t={current_time:.8g}s with code {analysis_code}"
                )
            current_time += time_step
            displacement = [float(value) for value in ops.nodeDisp(self.analyzer._ops_node_tag(monitor_node.id))]
            if self.dimension == "2d":
                if len(displacement) < 2:
                    raise ValueError("OpenSees returned an incomplete 2-D displacement vector")
                global_vector = [displacement[0], 0.0, displacement[1]]
            else:
                if len(displacement) < 3:
                    raise ValueError("OpenSees returned an incomplete 3-D displacement vector")
                global_vector = (displacement + [0.0, 0.0, 0.0])[:3]
            results.append({
                "time": current_time,
                "displacement": global_vector[global_index],
                "displacementVector": global_vector,
                "referenceFrame": "global",
            })

        peak = max(results, key=lambda record: abs(record["displacement"])) if results else None
        result = {
            "status": "success",
            "monitorNode": str(monitor_node.id),
            "responseScope": "selected-topmost-free-node",
            "direction": selected_direction,
            "maxDisplacement": abs(peak["displacement"]) if peak else 0.0,
            "signedDisplacementAtPeak": peak["displacement"] if peak else 0.0,
            "timeOfMaxDisp": peak["time"] if peak else 0.0,
            "timeHistory": results,
            "groundMotion": {"accelerationUnit": "m/s2", "sampleCount": len(acceleration),
                             "inputAccelerationUnit": acceleration_unit,
                             "sha256": hashlib.sha256(json.dumps(acceleration, separators=(',', ':'), allow_nan=False).encode()).hexdigest(),
                             "timeStep": time_step, "duration": duration,
                             "postRecordExcitation": "zero"},
            "damping": {"ratio": damping_ratio, "method": "Rayleigh", "alphaMass": alpha_mass,
                        "betaCurrentStiffness": beta_stiffness},
            "meta": {**coordinate_contract_metadata(self.model), "responseCoordinateConvention": "global-xyz"},
            "execution": self._execution_evidence(ops),
        }
        ops.wipe()
        return attach_execution_artifacts(result, self.model, {'analysisType':'time_history', 'timeStep':time_step,
            'duration':duration, 'dampingRatio':damping_ratio, 'direction':selected_direction,
            'groundMotionUnit':acceleration_unit, 'groundMotionSha256':result['groundMotion']['sha256']})
