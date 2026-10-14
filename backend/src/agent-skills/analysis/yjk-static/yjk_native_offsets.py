"""Official rigid-end lengths bound to physical member station coordinates."""
from __future__ import annotations

import copy
import math


def audit_rigid_offsets(model: dict, fe: dict, member_audit: dict, native_members: dict) -> dict:
    nodes = {str(row['id']): [float(row[key]) for key in ('x','y','z')] for row in model['nodes']}
    members, failures = {}, []
    for element in model['elements']:
        key = str(element['id'])
        tag = member_audit.get('members', {}).get(key, {}).get('nativeFrameId')
        frame = fe['frames'].get(tag, {})
        native = native_members.get(tag, {})
        try:
            if frame.get('kind') not in {'BEAM','COLUMN'} or frame.get('E') != [0.] * 6:
                raise ValueError('Native eccentric/inclined rigid-end geometry needs a separate mapping / 原生偏心或斜构件刚域需要独立几何映射')
            lengths = frame.get('RZL')
            readback = native.get('native_geometry', {}).get('rigid')
            if not isinstance(lengths, list) or len(lengths) != 2 or not isinstance(readback, list) or len(readback) != 2:
                raise ValueError('Native rigid lengths are missing / 缺少原生刚域长度')
            if any(type(value) not in (int,float) or not math.isfinite(value) or value < 0 for value in lengths + readback):
                raise ValueError('Native rigid lengths must be finite and nonnegative / 原生刚域长度须为有限非负数')
            # Public BeamRigid returns m, ColumnRigid returns mm in SDK8.
            scale = .001 if frame['kind'] == 'COLUMN' else 1.
            raw_m = [value * scale for value in readback]
            if [float(format(value, '.6g')) for value in raw_m] != lengths:
                raise ValueError('SDK rigid lengths differ from executed FE RZL / SDK 刚域长度与实际有限元 RZL 不一致')
            source_nodes = list(map(str, element['nodes']))
            source_points = [nodes[node] for node in source_nodes]
            actual_points = [fe['nodes'][node] for node in frame['nodes']]
            forward = all(math.dist(a,b) <= 1e-7 for a,b in zip(source_points,actual_points))
            reverse = all(math.dist(a,b) <= 1e-7 for a,b in zip(source_points[::-1],actual_points))
            if forward == reverse:
                raise ValueError('Native rigid endpoints do not uniquely match the source / 原生刚域端点不能唯一对应源构件')
            length = math.dist(*source_points)
            start, end = lengths if forward else lengths[::-1]
            if start + end >= length:
                raise ValueError('Native rigid zones leave no positive elastic span / 原生刚域侵占全部弹性跨度')
            members[key] = {'physicalLengthM':length, 'elasticStartM':start, 'elasticEndM':length-end,
                'startLengthM':start, 'endLengthM':end, 'sourceNodeIds':source_nodes,
                'nativeStationDomain':'elastic-span', 'source':{'nativeFrameId':tag,
                    'artifacts':[{'path':'fea.dat','sha256':fe['sha256']}],
                    'readbackFields':{'FE.RZL':lengths, 'SDK.method':frame['kind'].title()+'Rigid',
                                      'SDK.rigid':readback, 'SDK.lengthUnit':'mm' if scale==.001 else 'm'},
                    'method':'official-rigid-lengths-and-executed-FE-readback'}}
        except (ValueError, KeyError, TypeError) as exc:
            failures.append({'member':key, 'reason':'rigid-offset-readback-invalid', 'message':str(exc)})
    return {'verified':bool(members) and not failures, 'sourceFeaSha256':fe['sha256'],
            'method':'native-rigid-end-readback', 'members':members, 'failures':failures}


def restore_physical_offsets(offsets: dict, receipt: dict) -> dict:
    result = copy.deepcopy(offsets)
    original = result['members']
    physical = {}
    for identifier, segments in receipt['members'].items():
        values = [original[row['id']] for row in segments]
        for index, (segment, value) in enumerate(zip(segments, values)):
            if not math.isclose(value['physicalLengthM'], segment['end']-segment['start'], rel_tol=0, abs_tol=1e-9):
                raise ValueError('Rigid-end result differs from the physical mesh length / 刚域结果与物理分段长度不一致')
            if (index and value['startLengthM'] != 0) or (index < len(values)-1 and value['endLengthM'] != 0):
                raise ValueError('Native mesh introduced an unrequested internal rigid zone / 原生计算分段引入了未指定的内部刚域')
        first, last = values[0], values[-1]
        length = segments[-1]['end']
        physical[identifier] = {'physicalLengthM':length, 'elasticStartM':first['startLengthM'],
            'elasticEndM':length-last['endLengthM'], 'startLengthM':first['startLengthM'],
            'endLengthM':last['endLengthM'], 'sourceNodeIds':[first['sourceNodeIds'][0],last['sourceNodeIds'][1]],
            'nativeStationDomain':'elastic-span', 'source':{'method':'physical-member-native-segment-mapping',
                'artifacts':[{'path':'fea.dat','sha256':offsets['sourceFeaSha256']}],
                'readbackFields':{'segments':[{'sourceSegmentId':segment['id'], 'startM':segment['start'],
                    'endM':segment['end'], **value} for segment,value in zip(segments,values)]}}}
    result['members'] = physical
    return result
