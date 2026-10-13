"""Hash actual runtime artifacts without claiming application run identity."""
from __future__ import annotations

from copy import deepcopy
import hashlib
import json


def artifact_sha256(value):
    encoded = json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False)
    return hashlib.sha256(encoded.encode('utf-8')).hexdigest()


def attach_execution_artifacts(result, model, parameters):
    """Call only after real solver success; runId/modelHash belong to the host service.

    Hash serialization is explicitly Python sorted JSON, not the host's physical
    identity hash. The persisted raw output carries all the response hash inputs.
    """
    execution = result.get('execution')
    if not isinstance(execution, dict) or execution.get('executed') is not True:
        return result
    payload = model.model_dump(mode='json', exclude_unset=True) if hasattr(model, 'model_dump') else model
    response_keys = [key for key in ('displacements', 'reactions', 'forces', 'solverMesh', 'effectiveLoads',
        'segmentResults', 'modes', 'totalMass', 'timeHistory', 'groundMotion', 'damping') if key in result]
    responses = {key: result[key] for key in response_keys}
    settings = {'parameters': parameters, 'effectiveSettings': execution.get('effectiveSettings'),
                'solverConfiguration': execution.get('solverConfiguration')}
    artifacts = {
        'hashFormat': 'sha256:python-json-sort-keys-utf8-compact-v1',
        'normalizedInputSha256': artifact_sha256(payload),
        'settingsSha256': artifact_sha256(settings),
        'solverResponseSha256': artifact_sha256(responses),
        'solverResponseKeys': response_keys,
        'settings': settings,
    }
    result['execution'] = {**execution, 'artifacts': artifacts}
    result['meta'] = {**result.get('meta', {}), 'solverVersion': execution['solverVersion'],
                      'execution': deepcopy(result['execution'])}
    return result
