from __future__ import annotations

from opensees_shared.errors import OpenSeesInputError, OpenSeesMissingInputError, OpenSeesCapabilityError

from typing import Any, Dict

from opensees_shared.mesh import MemberMesh
from opensees_shared.model import OpenSeesModelBuilder, FRAME_ELEMENT_TYPES
from opensees_shared.response import member_end_actions
from opensees_shared.evidence import attach_execution_artifacts


class OpenSeesStaticExecutor:
    """Real OpenSees for pure axial, pure frame and mixed line structures."""

    def __init__(self, analyzer):
        self.analyzer = analyzer

    def run(self, parameters: Dict[str, Any]) -> Dict[str, Any]:
        if parameters.get('batchCases'):
            return self.analyzer._run_batch_cases(parameters, self.run)
        import openseespy.opensees as ops

        model = self.analyzer.model
        if parameters.get('combinationIds'):
            ids = parameters['combinationIds']
            if len(ids) != 1:
                raise OpenSeesInputError('Select exactly one combination per static run, or use batchCases')
            parameters = dict(parameters, loadCombinationId=ids[0])
        selected = parameters.get('loadCaseIds') or parameters.get('load_case_ids')
        combination = parameters.get('loadCombinationId') or parameters.get('load_combination_id') or parameters.get('combinationId')
        if selected and combination:
            raise OpenSeesInputError('A run must select either load cases or one combination, not both')
        if not selected and not combination and not parameters.get('loadCases') and len(model.load_cases) > 1:
            raise OpenSeesMissingInputError('Multiple model load cases require an explicit loadCaseIds or loadCombinationId selection')
        loads = self.analyzer._collect_nodal_loads(parameters)
        physical = OpenSeesModelBuilder(model)
        controls = physical._control_evidence()
        if controls['self_weight']['value']:
            dead_ids = [lc.id for lc in model.load_cases if lc.type == 'dead']
            if len(dead_ids) != 1:
                raise OpenSeesMissingInputError('self_weight=true requires exactly one dead load case to define its case/combination factor')
            dead_id = dead_ids[0]
            if combination:
                combo = next(c for c in model.load_combinations if c.id == combination)
                weight_factor = float(combo.factors.get(dead_id, 0.0))
            else:
                weight_factor = 1.0 if dead_id in (selected or [lc.id for lc in model.load_cases]) else 0.0
            controls['self_weight'].update(loadCaseId=dead_id, factor=weight_factor)
            for e in model.elements:
                weight = weight_factor * physical._material_properties(physical.materials[e.material])[2] * physical._section_property(physical.sections[e.section], 'A') * 9.80665/1000
                if e.type in FRAME_ELEMENT_TYPES:
                    loads.append({'type': 'distributed', 'element': e.id, 'reference_frame': 'global',
                                  'wz': -weight, 'source': 'explicit-self-weight'})
                else:
                    for node in e.nodes:
                        loads.append({'type': 'nodal', 'node': node, 'reference_frame': 'global',
                                      'fz': -weight*physical._element_length(e)/2, 'source': 'explicit-self-weight'})
        mesh = MemberMesh(model, loads)
        builder = mesh.builder
        try:
            applied_controls = builder.build(ops)
            applied_controls['self_weight'] = controls['self_weight']
            controls = applied_controls
            mesh.apply(ops)
            ops.system('BandGeneral')
            ops.numberer('RCM')
            ops.constraints('Transformation')
            ops.integrator('LoadControl', 1.0)
            ops.algorithm('Linear')
            ops.analysis('Static')
            code = int(ops.analyze(1))
            if code != 0:
                raise RuntimeError(f'OpenSees static analysis failed with code {code}; check stability and restraints')
            ops.reactions()
            all_displacements, all_reactions = {}, {}
            for node in mesh.model.nodes:
                tag = builder._ops_node_tag(node.id)
                all_displacements[node.id] = builder.nodal_response(node.id, ops.nodeDisp(tag))
                all_reactions[node.id] = dict(zip(('fx', 'fy', 'fz', 'mx', 'my', 'mz'), builder.global_vector(ops.nodeReaction(tag))))
            segments = {}
            for element in mesh.model.elements:
                segments[element.id] = member_end_actions(builder, ops, element)
            forces = {}
            for member, records in mesh.mapping.items():
                first, last = segments[records[0]['id']], segments[records[-1]['id']]
                forces[member] = dict(first, n2=last['n2'], solverSegmentIds=[r['id'] for r in records])
            displacements = {n.id: all_displacements[n.id] for n in model.nodes}
            imposed_nodes = {load['node'] for load in loads if load['type'] == 'displacement'}
            reactions = {n.id: all_reactions[n.id] for n in model.nodes if any(n.restraints or []) or n.id in imposed_nodes}
            result = {
                'status': 'success', 'analysisMode': f'opensees_{builder.dimension}_' + ('frame' if builder.has_frame_elements else 'truss'),
                'plane': 'xz' if builder.dimension == '2d' else None,
                'responseCoordinateConvention': 'global-xyz',
                'displacements': displacements, 'forces': forces, 'reactions': reactions,
                'nodalResponseAvailability': builder.nodal_response_availability,
                'envelope': self.analyzer._build_envelope(displacements, forces, reactions),
                'summary': self.analyzer._generate_summary(displacements, forces),
                'solverMesh': mesh.evidence(), 'effectiveLoads': mesh.loads,
                'segmentResults': {'displacements': all_displacements, 'forces': segments},
                'execution': {'solver': 'OpenSees', 'solverVersion': ops.version(), 'executed': True,
                              'analysisReturnCode': code, 'constitutiveModel': 'linear-elastic',
                              'solverConfiguration': {'system':'BandGeneral','numberer':'RCM','constraints':'Transformation',
                                  'integrator':'LoadControl','algorithm':'Linear','analysis':'Static'},
                              'effectiveSettings': controls, 'loadCaseIds': list(selected or []),
                              'loadCombinationId': combination},
                'meta': {'responseCoordinateConvention': 'global-xyz', 'forceConvention': 'element-end-resisting-actions',
                         'memberPositionUnit': 'm', 'selfWeight': controls['self_weight']},
            }
            return attach_execution_artifacts(self.analyzer._attach_floor_load_transfer(result), model, parameters)
        finally:
            ops.wipe()
