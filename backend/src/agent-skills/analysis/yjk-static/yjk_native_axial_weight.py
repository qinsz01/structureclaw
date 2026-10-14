"""Compile axial member gravity after official rigid-end data generation.

The source remains a uniform physical load. For a vertical elastic member its
axial shape functions are linear: integrating q over the elastic span gives
q*l/2 at each end, while each rigid segment contributes q*r at its physical
node. YJK's column point-load coordinate uses the full member length, so its
midpoint supplies exactly that elastic load vector. This is input compilation,
not a structural solve; internal point-load fields are not physical UDL fields.
"""
from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path
import re

from native_fe import parse_fe
from yjk_self_weight import compile_self_weight


def _hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode()).hexdigest()


def _plan(model, mapping, fe, before):
    if fe['unit'] != [0., 0., 0.]:
        raise ValueError('Unverified native FE units / 原生有限元单位未校准')
    weight = compile_self_weight(model)
    nodes = {str(n['id']): [float(n[k]) for k in ('x', 'y', 'z')] for n in model['nodes']}
    source = {str(e['id']): e for e in model['elements']}
    cases = {}
    for line in fe['sectionsRaw']['STATIC_LDCASE']:
        match = re.match(r'(\d+)\s+N=(\S+)\s', line)
        if match:
            cases[match[2]] = match[1]
    bound = [row for row in mapping['load_cases'] if row['sourceCaseId'] == weight['loadCaseId']]
    if len(bound) != 1 or bound[0]['nativeName'] not in cases:
        raise ValueError('Gravity case has no unique native binding / 自重工况缺少唯一原生绑定')
    native_case = cases[bound[0]['nativeName']]
    targets = {}
    for row in weight['members']:
        element = source[row['elementId']]
        if element['type'] != 'column':
            continue
        points = [nodes[str(tag)] for tag in element['nodes']]
        matches = []
        for tag, frame in fe['frames'].items():
            actual = [fe['nodes'][key] for key in frame['nodes']]
            if actual == points or actual[::-1] == points:
                matches.append((tag, frame, actual))
        if len(matches) != 1:
            raise ValueError('Axial gravity member binding is ambiguous / 轴向自重构件映射不唯一')
        tag, frame, actual = matches[0]
        rigid = frame.get('RZL')
        if (frame['kind'] != 'COLUMN' or frame.get('E') != [0.] * 6
                or actual[0][:2] != actual[1][:2] or not isinstance(rigid, list)
                or len(rigid) != 2 or any(not math.isfinite(r) or r < 0 for r in rigid)):
            raise ValueError('Axial gravity requires verified vertical-column rigid ends / 轴向自重须有已核对的竖柱刚域')
        length = math.dist(*actual)
        clear = length - sum(rigid)
        if clear <= 0 or length != row['lengthM']:
            raise ValueError('Invalid axial gravity elastic span / 轴向自重弹性跨度无效')
        if sum(rigid) == 0:
            continue
        q = row['intensityKnM']
        nodal = [{'nativeNodeId': key, 'sourceNodeId': next(k for k in element['nodes'] if nodes[str(k)] == fe['nodes'][key]),
                  'lengthM': r, 'forceVectorKn': [0., 0., q*r]}
                 for key, r in zip(frame['nodes'], rigid) if r]
        targets[tag] = {'sourceSegmentId': row['elementId'], 'physicalElementId': row['elementId'],
            'sourceNodeIds': list(map(str, element['nodes'])), 'nativeNodeIds': frame['nodes'],
            'nativeFrameId': tag, 'loadCaseId': weight['loadCaseId'], 'nativeCaseId': native_case,
            'startM': 0., 'endM': length, 'nativeRigidLengthsM': rigid,
            'elasticLengthM': clear, 'sourceIntensityVectorKnM': [0., 0., q],
            'point': {'nativePositionM': length/2, 'forceVectorKn': [0., 0., q*clear]},
            'rigidSegmentNodeLoads': nodal,
            'consistentEndForceVectorKn': [[0., 0., q*(clear/2+r)] for r in rigid],
            'nativeInteriorFieldSemantics': 'computational-load-vector; not-physical-uniform-load'}
    seen, replacements, output = set(), [], []
    active, section = None, None
    for line in before.decode('gb18030').splitlines(keepends=True):
        clean = line.strip()
        if clean.startswith('*USE-STLD'):
            match = re.search(r'LCID=(\d+)', clean); active = match[1] if match else None
        if clean.startswith('*'):
            section = clean[1:].split()[0]
        tag = clean.split()[0] if clean else ''
        if active == native_case and section == 'FRAMELOAD' and tag in targets:
            row = targets[tag]
            fields = dict(re.findall(r'\b([A-Z]+)=([^\s]+)', clean))
            values = [float(v) for v in fields.get('F', '').split(',')]
            q = row['sourceIntensityVectorKnM'][2]
            if (tag in seen or fields.get('T') != 'UNILOAD' or fields.get('DIR') != 'GZ'
                    or fields.get('G') != '0' or values != [0., float(format(q, '.6g')), -1., float(format(q, '.6g'))]):
                raise ValueError('Original column gravity input differs / 原始柱自重输入不符')
            seen.add(tag)
            f = row['point']['forceVectorKn'][2]
            text = f"{tag} T=CONLOAD DIR=GZ F={row['endM']/2:.17g},{f:.17g} G=0\n"
            if row['rigidSegmentNodeLoads']:
                text += '*NODELOAD\n'
                for item in row['rigidSegmentNodeLoads']:
                    text += f"{item['nativeNodeId']} F=0,0,{item['forceVectorKn'][2]:.17g},0,0,0 G=0\n"
                text += '*FRAMELOAD\n'
            replacements.append({'sourceLine': line, 'compiledLines': text, 'nativeFrameId': tag})
            output.append(text)
        else:
            output.append(line)
    if seen != set(targets):
        raise ValueError('Missing native axial gravity records / 缺少原生轴向自重记录')
    after = ''.join(output).encode('gb18030')
    receipt = {'schema': 'sclaw-yjk-consistent-axial-gravity/v1', 'method': 'axial-uniform-load-exact-virtual-work',
        'physicalModelHash': _hash(model), 'sourceFeaSha256': hashlib.sha256(before).hexdigest(),
        'plannedLoadViewSha256': hashlib.sha256(after).hexdigest(), 'members': list(targets.values()),
        'replacements': replacements, 'scope': 'verified-column-gravity-only; geometry-and-stiffness-unchanged',
        'verified': False}
    return receipt, after


def compile_input(directory, model, mapping):
    """Plan SDK load changes from this run's generated, read-only FE geometry."""
    root = Path(directory).resolve()
    path = root / 'fea.dat'
    before = path.read_bytes()
    receipt, after = _plan(model, mapping, parse_fe(path), before)
    # Never overwrite a prior execution receipt or use this as a result edit.
    archive = root / 'fea-before-axial-gravity.dat'
    if archive.exists() or (root/'native-axial-gravity-compilation.json').exists():
        raise ValueError('Axial gravity input already compiled / 轴向自重输入已编译')
    archive.write_bytes(before)
    (root / 'axial-gravity-expected-loads.dat').write_bytes(after)
    (root/'native-axial-gravity-compilation.json').write_text(json.dumps(receipt, indent=2), 'utf8')
    return receipt


def verify_compilation(directory, model, mapping, fe):
    """Verify the second SDK generation, not a hand-edited FE export view."""
    root = Path(directory)
    saved = json.loads((root/'native-axial-gravity-compilation.json').read_text('utf8'))
    before_path = root/'fea-before-axial-gravity.dat'
    geometry_mapping = json.loads((root/'geometry-mapping.json').read_text('utf8'))
    initial = parse_fe(before_path)
    expected, _ = _plan(model, geometry_mapping, initial, before_path.read_bytes())
    if saved != expected:
        raise ValueError('Axial gravity receipt differs from its source / 轴向自重记录与源依据不符')
    for field in ('nodes','frames','materials','sections','unit','gravity'):
        if initial[field] != fe[field]:
            raise ValueError('Axial gravity regeneration changed native geometry or stiffness / 轴向自重重建改变了原生几何或刚度: '+field)
    # Verify official exchange load definitions independently of FE output.
    loads = {(case['sourceCaseId'],load['sourceLoadId']):load
             for case in mapping['load_cases'] for load in case['loads']}
    for member in saved['members']:
        key=(member['loadCaseId'],'self-weight:'+member['sourceSegmentId'])
        actual=loads.get(key,{})
        expected_shape=[float(format(value,'.15g')) for value in
                        (5,-member['point']['forceVectorKn'][2],member['point']['nativePositionM'],0,0,0,0)]
        if (actual.get('consistentAxialWeight') != member or actual.get('elementKind') != 11
                or [float(x) for x in actual.get('shapeVal','').split(',') if x] != expected_shape):
            raise ValueError('SDK axial point load does not match source work / SDK 轴向点载与源荷载功不一致')
    return {**saved,'geometryFeaSha256':initial['sha256'],'sourceFeaSha256':fe['sha256'],
            'verified':False,'sourceModelHash':saved['physicalModelHash']}



