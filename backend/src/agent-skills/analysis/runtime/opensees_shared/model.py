"""One elastic line-member builder for static, modal and transient analysis.

The physical protocol uses m, kN, MPa, kg/m3 and global XYZ (Z up).
OpenSees uses m, kN, tonne and, in 2-D, XY with its rotation opposite global Ry.
"""
from __future__ import annotations

from opensees_shared.errors import OpenSeesInputError, OpenSeesMissingInputError, OpenSeesCapabilityError

import math
from typing import Any

import numpy as np

from coordinate_semantics import (build_element_local_axes, get_model_metadata,
    get_reference_vector, resolve_model_dimension, validate_coordinate_contract)
from opensees_shared.tags import OpenSeesTagMapper

FRAME_ELEMENT_TYPES = {"beam", "column"}
TRUSS_ELEMENT_TYPES = {"truss", "brace"}


class OpenSeesModelBuilder(OpenSeesTagMapper):
    def __init__(self, model):
        super().__init__(model)
        validate_coordinate_contract(model)
        if model.unit_system != 'SI':
            raise OpenSeesInputError('OpenSees requires canonical SI input (m, kN, MPa); convert source units before execution')
        self.dimension = resolve_model_dimension(model)
        self.nodes = {str(n.id): n for n in model.nodes}
        self.sections = {str(s.id): s for s in model.sections}
        self.materials = {str(m.id): m for m in model.materials}
        self.has_frame_elements = any(e.type in FRAME_ELEMENT_TYPES for e in model.elements)
        self.frame_node_ids = {str(n) for e in model.elements if e.type in FRAME_ELEMENT_TYPES for n in e.nodes}
        self.ndf = (3 if self.has_frame_elements else 2) if self.dimension == "2d" else (6 if self.has_frame_elements else 3)
        self.node_masses = {}
        self.mass_source = None

    @staticmethod
    def _field(record, key, default=None):
        return record.get(key, default) if isinstance(record, dict) else getattr(record, key, default)

    def _section_property(self, section, key):
        value = float(section.properties.get(key, 0.0))
        if not math.isfinite(value) or value <= 0:
            raise OpenSeesMissingInputError(f"Section '{section.id}' requires finite {key} > 0")
        return value

    def _material_properties(self, material):
        e, nu, rho = float(material.E) * 1000.0, float(material.nu), float(material.rho)
        if not all(math.isfinite(v) for v in (e, nu, rho)) or e <= 0 or rho < 0 or not 0 <= nu <= .5:
            raise OpenSeesInputError(f"Material '{material.id}' requires E > 0, rho >= 0 and 0 <= nu <= 0.5")
        return e, e / (2 * (1 + nu)), rho

    def _element_axes(self, element):
        start, end = [self.nodes[str(n)] for n in element.nodes]
        if self.dimension == "2d":
            x = np.array([end.x - start.x, 0.0, end.z - start.z], dtype=float)
            x /= np.linalg.norm(x)
            y = np.array([0.0, 1.0, 0.0])
            return np.vstack([x, y, np.cross(x, y)])
        return build_element_local_axes([start.x, start.y, start.z], [end.x, end.y, end.z],
            get_reference_vector(get_model_metadata(self.model), str(element.id)), element.rotation_angle)

    def _element_length(self, element):
        a, b = [self.nodes[str(n)] for n in element.nodes]
        return math.sqrt((b.x-a.x)**2 + (b.y-a.y)**2 + (b.z-a.z)**2)

    def _control_evidence(self):
        control = self.model.analysis_control
        declared = control.model_fields_set if control is not None else set()
        evidence = {}
        for name in ("self_weight", "p_delta", "rigid_floor", "rigid_offsets", "construction_stage"):
            value = getattr(control, name, None) if control is not None else None
            explicit = name in declared and value is not None
            if explicit and value and name not in {"self_weight", "rigid_floor"}:
                raise OpenSeesCapabilityError(f"OpenSees elastic line analysis cannot yet map explicit analysis_control.{name}=true")
            evidence[name] = {"value": bool(value) if explicit else False,
                              "source": "explicit" if explicit else "legacy-engine-default"}
        evidence['storyDiaphragms'] = []
        if evidence['rigid_floor']['value'] and not self.model.stories:
            raise OpenSeesMissingInputError('rigid_floor=true requires explicit story membership or elevations')
        for story in self.model.stories:
            explicit = "rigid_diaphragm" in story.model_fields_set
            enabled = story.rigid_diaphragm if explicit else evidence['rigid_floor']['value']
            evidence['storyDiaphragms'].append({'storyId': story.id, 'value': enabled,
                'source': 'explicit-story' if explicit else evidence['rigid_floor']['source']})
        return evidence

    def build(self, ops, *, mass=False, validate_controls=True):
        controls = self._control_evidence() if validate_controls else {}
        ops.wipe()
        ops.model("basic", "-ndm", 2 if self.dimension == "2d" else 3, "-ndf", self.ndf)
        for node in self.model.nodes:
            tag = self._ops_node_tag(node.id)
            coords = [node.x, node.z] if self.dimension == "2d" else [node.x, node.y, node.z]
            ops.node(tag, *coords)
            r = list(node.restraints or [False] * 6)
            active = [r[0], r[2]] if self.dimension == "2d" else r[:3]
            if self.has_frame_elements:
                active += [r[4]] if self.dimension == "2d" else r[3:6]
                if str(node.id) not in self.frame_node_ids:
                    active[len(coords):] = [True] * (self.ndf-len(coords))
            ops.fix(tag, *[int(v) for v in active])
        for material in self.model.materials:
            e, _, _ = self._material_properties(material)
            ops.uniaxialMaterial("Elastic", self._ops_material_tag(material.id), e)
        self.node_masses = {str(n.id): 0.0 for n in self.model.nodes}
        for element in self.model.elements:
            if len(element.nodes) != 2 or element.type not in FRAME_ELEMENT_TYPES | TRUSS_ELEMENT_TYPES:
                raise OpenSeesCapabilityError(f"OpenSees elastic line analysis does not support element '{element.id}' type '{element.type}'")
            if element.releases:
                raise OpenSeesCapabilityError(f"End releases on '{element.id}' require a verified release mapping; they cannot be ignored")
            if element.offsets and any(abs(float(v)) > 1e-12 for v in element.offsets.values()):
                raise OpenSeesCapabilityError(f"End offsets on '{element.id}' require a verified physical-length mapping; they cannot be ignored")
            material, section = self.materials[element.material], self.sections[element.section]
            e, g, rho = self._material_properties(material)
            area = self._section_property(section, "A")
            tag = self._ops_element_tag(element.id)
            n1, n2 = [self._ops_node_tag(n) for n in element.nodes]
            if element.type in TRUSS_ELEMENT_TYPES:
                ops.element("truss", tag, n1, n2, area, self._ops_material_tag(element.material))
            elif self.dimension == "2d":
                ops.geomTransf("Linear", tag)
                ops.element("elasticBeamColumn", tag, n1, n2, area, e, self._section_property(section, "Iy"), tag)
            else:
                ops.geomTransf("Linear", tag, *self._element_axes(element)[2].tolist())
                ops.element("elasticBeamColumn", tag, n1, n2, area, e, g,
                    self._section_property(section, "J"), self._section_property(section, "Iy"),
                    self._section_property(section, "Iz"), tag)
            half_mass = rho * area * self._element_length(element) / 2000.0
            for node_id in element.nodes:
                self.node_masses[str(node_id)] += half_mass
        declared_mass_source = getattr(self.model.analysis_control, 'mass_source', None)
        has_nodal_mass = any(n.mass is not None for n in self.model.nodes)
        if has_nodal_mass and declared_mass_source == 'member-density':
            raise OpenSeesInputError('node.mass conflicts with mass_source=member-density; mass sources cannot be added implicitly')
        self.mass_source = declared_mass_source or ('nodal' if has_nodal_mass else 'member-density')
        if self.mass_source == 'nodal':
            if not has_nodal_mass:
                raise OpenSeesMissingInputError('mass_source=nodal requires explicit node.mass values in tonnes')
            self.node_masses = {str(n.id): float(n.mass or 0.0) for n in self.model.nodes}
        if mass:
            self.assign_masses(ops, self.node_masses)
        for setting in controls.get('storyDiaphragms', []):
            if not setting['value']:
                continue
            story = next(s for s in self.model.stories if s.id == setting['storyId'])
            floor_nodes = [n for n in self.model.nodes if n.story == story.id]
            if not floor_nodes and story.elevation is not None:
                floor_nodes = [n for n in self.model.nodes if abs(n.z-story.elevation-story.height) <= 1e-8]
            if not floor_nodes:
                raise OpenSeesMissingInputError(f"Rigid diaphragm story '{story.id}' has no identifiable nodes")
            if max(n.z for n in floor_nodes)-min(n.z for n in floor_nodes) > 1e-8:
                raise OpenSeesInputError(f"Rigid diaphragm story '{story.id}' must be horizontal")
            if len(floor_nodes) > 1:
                master, *slaves = [self._ops_node_tag(n.id) for n in floor_nodes]
                if self.dimension == '2d':
                    for slave in slaves:
                        ops.equalDOF(master, slave, 1)
                elif self.ndf == 6:
                    ops.rigidDiaphragm(3, master, *slaves)
                else:
                    raise OpenSeesInputError('A 3-D rigid diaphragm requires rotational DOFs')
                setting.update(masterNodeId=floor_nodes[0].id, slaveNodeIds=[n.id for n in floor_nodes[1:]])
        return controls

    def assign_masses(self, ops, masses, *, directions=None):
        self.node_masses = dict(masses)
        for node in self.model.nodes:
            m = float(masses.get(str(node.id), 0.0))
            if not math.isfinite(m) or m < 0:
                raise OpenSeesInputError("Nodal mass must be finite and non-negative")
            translational = [m, m] if self.dimension == "2d" else [m, m, m]
            if directions is not None:
                axes = ["x", "z"] if self.dimension == "2d" else ["x", "y", "z"]
                translational = [m if a in directions else 0.0 for a in axes]
            ops.mass(self._ops_node_tag(node.id), *(translational + [0.0]*(self.ndf-len(translational))))

    def global_vector(self, values):
        values = [float(v) for v in values]
        if len(values) != self.ndf or not all(math.isfinite(v) for v in values):
            raise ValueError("OpenSees returned an incomplete or non-finite nodal response")
        if self.dimension == "2d":
            return [values[0], 0.0, values[1], 0.0, -values[2] if self.has_frame_elements else 0.0, 0.0]
        return values + [0.0]*(6-len(values))

    def load_vector(self, values):
        values = list(values)
        if self.dimension == "2d":
            if any(abs(values[i]) > 1e-12 for i in (1, 3, 5)):
                raise OpenSeesInputError("Out-of-plane load in 2-D model")
            result = [values[0], values[2]]
            if self.has_frame_elements:
                result.append(-values[4])
            elif abs(values[4]) > 1e-12:
                raise OpenSeesInputError("A truss model has no rotational load DOF")
            return result
        if not self.has_frame_elements and any(abs(v) > 1e-12 for v in values[3:]):
            raise OpenSeesInputError("A truss model has no rotational load DOF")
        return values[:self.ndf]
