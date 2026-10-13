"""Deterministic solver refinement; physical member IDs and loads stay immutable."""
from __future__ import annotations

from opensees_shared.errors import OpenSeesInputError, OpenSeesMissingInputError, OpenSeesCapabilityError

import copy
import math

import numpy as np

from opensees_shared.model import OpenSeesModelBuilder, FRAME_ELEMENT_TYPES


class MemberMesh:
    def __init__(self, model, loads):
        self.physical = model
        self.loads = copy.deepcopy(loads)
        physical_builder = OpenSeesModelBuilder(model)
        self.axes = {e.id: physical_builder._element_axes(e) for e in model.elements}
        self.lengths = {e.id: physical_builder._element_length(e) for e in model.elements}
        self.mapping = {}
        self.node_positions = {}
        nodes = list(model.nodes)
        elements = []
        node_ids = {n.id for n in nodes}
        element_ids = {e.id for e in model.elements}
        references = dict(model.metadata.get('elementReferenceVectors', {}))
        for element in model.elements:
            length = self.lengths[element.id]
            cuts = {0.0, length}
            for load in self.loads:
                if load.get('element') != element.id:
                    continue
                if load['type'] == 'point':
                    cuts.add(self._position(load['position'], length))
                elif load['type'] == 'distributed':
                    if element.type not in FRAME_ELEMENT_TYPES:
                        raise OpenSeesCapabilityError(f"Distributed loads on axial member '{element.id}' are not implemented")
                    start = self._position(load.get('start', 0), length)
                    end = self._position(load.get('end', length), length)
                    if end <= start:
                        raise OpenSeesInputError("A distributed load must have end > start")
                    load.update(start=start, end=end)
                    cuts.update((start, end))
                    if load.get('distribution', 'uniform') == 'piecewise_linear':
                        points = load.get('points')
                        if not isinstance(points, list) or len(points) < 2:
                            raise OpenSeesInputError("Piecewise-linear member loads require at least two points")
                        positions = [self._position(p.get('position'), 1.0) for p in points]
                        if any(b <= a for a, b in zip(positions, positions[1:])):
                            raise OpenSeesInputError("Piecewise-linear positions must be strictly increasing fractions")
                        if abs(positions[0]*length-start) > 1e-9 or abs(positions[-1]*length-end) > 1e-9:
                            raise OpenSeesInputError("Piecewise-linear points must cover the declared member-load start/end")
                        for point in points:
                            for key in ('wx', 'wy', 'wz'):
                                value = float(point.get(key, 0))
                                if not math.isfinite(value):
                                    raise OpenSeesInputError("Piecewise-linear load values must be finite")
                                point[key] = value
                        cuts.update(p*length for p in positions)
                    elif load.get('distribution', 'uniform') != 'uniform':
                        raise OpenSeesCapabilityError(f"Unsupported load distribution '{load['distribution']}'")
            cuts = sorted(cuts)
            # Coalesce arithmetic roundoff, without moving a physical discontinuity.
            cuts = [v for i, v in enumerate(cuts) if i == 0 or v-cuts[i-1] > 1e-10*max(1, length)]
            start_node, end_node = [physical_builder.nodes[str(n)] for n in element.nodes]
            chain = [start_node.id]
            self.node_positions[(element.id, 0.0)] = start_node.id
            self.node_positions[(element.id, length)] = end_node.id
            for index, position in enumerate(cuts[1:-1], 1):
                node_id = f'__ops__{element.id}__n{index}'
                if node_id in node_ids:
                    raise OpenSeesInputError(f"Reserved generated solver node ID collision: '{node_id}'")
                ratio = position/length
                node = start_node.model_copy(update={'id': node_id, 'x': start_node.x+ratio*(end_node.x-start_node.x),
                    'y': start_node.y+ratio*(end_node.y-start_node.y), 'z': start_node.z+ratio*(end_node.z-start_node.z),
                    'restraints': None, 'mass': None, 'story': start_node.story if start_node.story == end_node.story else None})
                nodes.append(node)
                node_ids.add(node_id)
                chain.append(node_id)
                self.node_positions[(element.id, position)] = node_id
            chain.append(end_node.id)
            records = []
            for index, (start, end) in enumerate(zip(cuts, cuts[1:])):
                segment_id = element.id if len(cuts) == 2 else f'__ops__{element.id}__s{index+1}'
                if segment_id != element.id and segment_id in element_ids:
                    raise OpenSeesInputError(f"Reserved generated solver element ID collision: '{segment_id}'")
                elements.append(element.model_copy(update={'id': segment_id, 'nodes': chain[index:index+2]}))
                if element.id in references:
                    references[segment_id] = references[element.id]
                records.append({'id': segment_id, 'physicalElementId': element.id, 'start': start, 'end': end,
                                'nodes': chain[index:index+2]})
            self.mapping[element.id] = records
        references = {key: value for key, value in references.items() if key in {e.id for e in elements}}
        metadata = dict(model.metadata)
        if references:
            metadata['elementReferenceVectors'] = references
        elif 'elementReferenceVectors' in metadata:
            del metadata['elementReferenceVectors']
        self.model = model.model_copy(update={'nodes': nodes, 'elements': elements, 'load_cases': [],
                                               'load_combinations': [], 'metadata': metadata})
        self.builder = OpenSeesModelBuilder(self.model)

    @staticmethod
    def _position(value, length):
        try:
            position = float(value)
        except (TypeError, ValueError) as error:
            raise OpenSeesInputError("Member load positions must be finite") from error
        if not math.isfinite(position) or position < -1e-10 or position > length+1e-10:
            raise OpenSeesInputError(f"Member load position {value} is outside [0, {length}]")
        return max(0.0, min(length, position))

    def global_point(self, load):
        force = np.array([float(load.get(k, 0)) for k in ('fx', 'fy', 'fz')])
        moment = np.array([float(load.get(k, 0)) for k in ('mx', 'my', 'mz')])
        if load.get('reference_frame') == 'element-local':
            axes = self.axes[load['element']]
            force, moment = axes.T @ force, axes.T @ moment
        return [*force.tolist(), *moment.tolist()]

    def apply(self, ops):
        if not self.loads:
            return
        ops.timeSeries('Linear', 1)
        ops.pattern('Plain', 1, 1)
        prescribed = {}
        for load in self.loads:
            kind = load['type']
            if kind == 'displacement':
                for index, key in enumerate(('ux', 'uy', 'uz', 'rx', 'ry', 'rz')):
                    if key not in load:
                        continue
                    active = {0: (1, 1), 2: (2, 1), 4: (3, -1)} if self.builder.dimension == '2d' else {i: (i+1, 1) for i in range(6)}
                    if index not in active or active[index][0] > self.builder.ndf:
                        raise OpenSeesInputError(f"Prescribed {key} is inactive in this model")
                    dof, sign = active[index]
                    target = (self.builder._ops_node_tag(load['node']), dof)
                    prescribed[target] = prescribed.get(target, 0.0) + sign*float(load[key])
            elif kind in {'nodal', 'point'}:
                node_id = load['node'] if kind == 'nodal' else self.node_positions[(load['element'], self._position(load['position'], self.lengths[load['element']]))]
                vector = self.global_point(load)
                if str(node_id) not in self.builder.frame_node_ids and any(abs(v) > 1e-12 for v in vector[3:]):
                    raise OpenSeesInputError("A node incident only to axial members cannot carry a moment")
                ops.load(self.builder._ops_node_tag(node_id), *self.builder.load_vector(vector))
            elif kind == 'distributed':
                self._distributed(ops, load)
            else:
                raise OpenSeesCapabilityError(f"Unsupported standardized load type '{kind}'")
        for (tag, dof), value in prescribed.items():
            # Replace a fixed SP, preserving prescribed displacement as an explicit support action.
            ops.remove('sp', tag, dof)
            ops.sp(tag, dof, value)

    def _distributed(self, ops, load):
        member = load['element']
        axes = self.axes[member]
        def components(vector):
            global_vector = axes.T @ vector if load.get('reference_frame', 'global') == 'element-local' else vector
            if self.builder.dimension == '2d':
                # The planar OpenSees element retains its in-plane solver axes;
                # canonical local loads and output use the rotated section axes.
                x, y = axes[0], np.array([0.0, 1.0, 0.0])
                return np.vstack([x, y, np.cross(x, y)]) @ global_vector
            return axes @ global_vector
        for segment in self.mapping[member]:
            a, b = segment['start'], segment['end']
            if a < load['start']-1e-10 or b > load['end']+1e-10:
                continue
            tag = self.builder._ops_element_tag(segment['id'])
            if load.get('distribution') == 'piecewise_linear':
                # Three Gauss points integrate the cubic beam shape functions times a linear load exactly.
                points = load['points']
                length = self.lengths[member]
                for location, weight in zip((-math.sqrt(3/5), 0, math.sqrt(3/5)), (5/9, 8/9, 5/9)):
                    x = (a+b)/2+(b-a)/2*location
                    pair = next((p, q) for p, q in zip(points, points[1:]) if p['position']*length-1e-10 <= x <= q['position']*length+1e-10)
                    p, q = pair
                    ratio = (x/length-p['position'])/(q['position']-p['position'])
                    vector = np.array([(1-ratio)*p.get(k, 0)+ratio*q.get(k, 0) for k in ('wx', 'wy', 'wz')])
                    local = components(vector)*weight*(b-a)/2
                    if self.builder.dimension == '2d':
                        if abs(local[1]) > 1e-10:
                            raise OpenSeesInputError("Out-of-plane member load in 2-D model")
                        ops.eleLoad('-ele', tag, '-type', '-beamPoint', float(local[2]), (x-a)/(b-a), float(local[0]))
                    else:
                        ops.eleLoad('-ele', tag, '-type', '-beamPoint', float(local[1]), float(local[2]), (x-a)/(b-a), float(local[0]))
            else:
                vector = np.array([float(load.get(k, 0)) for k in ('wx', 'wy', 'wz')])
                local = components(vector)
                if self.builder.dimension == '2d':
                    if abs(local[1]) > 1e-10:
                        raise OpenSeesInputError("Out-of-plane member load in 2-D model")
                    ops.eleLoad('-ele', tag, '-type', '-beamUniform', float(local[2]), float(local[0]))
                else:
                    ops.eleLoad('-ele', tag, '-type', '-beamUniform', float(local[1]), float(local[2]), float(local[0]))

    def evidence(self):
        return {'schemaVersion': 1, 'positionUnit': 'm', 'nodes': [
            {'id': n.id, 'solverTag': self.builder._ops_node_tag(n.id), 'x': n.x, 'y': n.y, 'z': n.z,
             'physicalNodeId': n.id if n.id in {p.id for p in self.physical.nodes} else None} for n in self.model.nodes],
            'elements': [{**segment, 'solverTag': self.builder._ops_element_tag(segment['id']),
                          'localAxes': dict(zip(('x', 'y', 'z'), self.axes[member].tolist()))}
                         for member, segments in self.mapping.items() for segment in segments],
            'physicalElements': self.mapping}
