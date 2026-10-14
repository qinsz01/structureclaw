"""Bind SATWE's executed beam-load input to SDK assignments and source members.

This reads input records, never infers a load from the computed forces. The
native text bridge rounds some values before storing float32 solver records.
Both representations are retained; source loads remain unchanged.
"""
from __future__ import annotations

import hashlib
import math
from pathlib import Path
import re
import struct

from native_numeric_sections import _members, _point


def _fail():
    raise ValueError("Native beam load input is not uniquely verified / 原生梁荷载输入未能唯一核对")


def _integer(value):
    if not math.isfinite(value) or value != int(value) or value < 0:
        _fail()
    return int(value)


def _floats(payload):
    if len(payload) % 4:
        _fail()
    return struct.unpack('<' + 'f' * (len(payload) // 4), payload)


def _f32(value):
    return struct.unpack('<f', struct.pack('<f', value))[0]


def _text_beams(payload, model):
    text = payload.decode('gb18030')
    lines = text.splitlines()
    if lines[0].split(',')[-1] != '20221025':
        _fail()

    def blocks(name):
        index = lines.index('# ' + name) + 1
        result, identity, values = {}, None, []
        for line in lines[index:]:
            if line.startswith('# '):
                break
            if line.startswith('#'):
                if identity is not None:
                    result[identity] = values
                match = re.fullmatch(r'#(\d+):.*', line)
                if not match:
                    _fail()
                identity, values = int(match[1]), []
            elif line.strip():
                values.append(line)
        if identity is not None:
            result[identity] = values
        return result

    nodes = {key: [float(token) / 1000 for token in rows[0].split(',')[1:4]]
             for key, rows in blocks('节点信息').items()}
    grids = {key: [int(token) for token in rows[0].split(',')[1:3]]
             for key, rows in blocks('网格线信息').items()}
    source_nodes = {str(row['id']): [float(row[k]) for k in ('x', 'y', 'z')] for row in model['nodes']}
    source_edges = {frozenset(_point(source_nodes[str(tag)]) for tag in row['nodes']): str(row['id'])
                    for row in model['elements'] if row['type'] == 'beam'}
    result = {}
    for rows in blocks('梁信息').values():
        if len(rows) < 8:
            _fail()
        grid = int(rows[0].split(',')[0])
        edge = frozenset(_point(nodes[tag]) for tag in grids[grid])
        identity = source_edges.get(edge)
        count = int(rows[7])
        if identity is None or identity in result or len(rows) != 8 + count:
            _fail()
        result[identity] = []
        for line in rows[8:]:
            tokens = line.split(',')
            row = [float(token) for token in tokens]
            # Type 5: uniform full-span load; slots 5/11 are the two
            # downward global-Z intensities. Other force/moment slots are zero.
            if (len(row) != 27 or row[1] != 5 or row[5] != row[11]
                    or any(row[i] for i in range(2, 24) if i not in (5, 11))):
                _fail()
            result[identity].append({'nativeCaseId': _integer(row[0]), 'downwardIntensityKnM': row[5],
                'sourceText': line, 'intensityToken': tokens[5], 'nativeTextValues': row})
    if set(result) != set(source_edges.values()):
        _fail()
    return result


def read_beam_load_inputs(directory, model):
    """Read every calibrated full-span global-Z beam load, including empty sets."""
    directory = Path(directory)
    payload = (directory / 'DATA.SAT').read_bytes()
    data = _floats(payload)
    members = _members(payload, model)
    by_native = {(row['floor'], row['ordinal']): key for key, row in members.items()
                 if row['member']['type'] == 'beam'}
    result = {key: [] for key in by_native.values()}
    hashes = {'DATA.SAT': hashlib.sha256(payload).hexdigest()}

    def accept(floor, row, path, index, custom=False):
        if row[1] != 2:  # Node and column loads have different calibrated records.
            return
        identity = by_native.get((floor, _integer(row[0])))
        if identity is None:
            _fail()
        member = members[identity]
        length = math.dist(member['row'][6:9], member['row'][9:12])
        if (len(row) != (10 if custom else 9) or row[3] != row[4] or row[5] != 0
                or _f32(row[6]) != _f32(length) or row[7] != 31 or row[8] != row[0]):
            _fail()
        if custom:
            case = _integer(row[9])
            if case < 201 or row[2] != 9999:
                _fail()
        else:
            if row[2] not in (0, 9999):
                _fail()
            case = 1 if row[2] == 0 else 2
        result[identity].append({'nativeCaseId': case, 'globalZIntensityKnM': row[3],
            'inputValues': list(row), 'file': path, 'byteOffset': index * 4,
            'nativeFloor': floor, 'nativeOrdinal': member['ordinal']})

    for floor in range(_integer(data[2])):
        header = data[_integer(data[100 + floor]):][:20]
        index = _integer(header[3]) + 60 * _integer(header[13])
        # No walls/braces/slabs can sit between the audited columns and loads.
        if any(_integer(header[k]) != index for k in (4, 5, 6)):
            _fail()
        count = _integer(data[index])
        if index + 1 + 9 * count > len(data):
            _fail()
        for offset in range(index + 1, index + 1 + 9 * count, 9):
            accept(floor + 1, data[offset:offset + 9], 'DATA.SAT', offset)
    custom_path = directory / 'LoadZDY.SAT'
    if custom_path.exists():
        payload = custom_path.read_bytes(); custom = _floats(payload)
        hashes[custom_path.name] = hashlib.sha256(payload).hexdigest()
        for floor in range(_integer(data[2])):
            index = _integer(custom[floor])
            if index < 200 or index >= len(custom):
                _fail()
            count = _integer(custom[index])
            if index + 1 + 10 * count > len(custom):
                _fail()
            for offset in range(index + 1, index + 1 + 10 * count, 10):
                accept(floor + 1, custom[offset:offset + 10], custom_path.name, offset, True)
    text_payload = (directory / 'spas_sat.txt').read_bytes()
    hashes['spas_sat.txt'] = hashlib.sha256(text_payload).hexdigest()
    text = _text_beams(text_payload, model)
    for identity, records in result.items():
        remaining = list(text[identity])
        for record in records:
            candidates = [row for row in remaining if row['nativeCaseId'] == record['nativeCaseId']
                          and _f32(-row['downwardIntensityKnM']) == record['globalZIntensityKnM']]
            if not candidates:
                _fail()
            source = candidates[0]
            remaining.remove(source)
            record.update(sourceText=source['sourceText'], intensityToken=source['intensityToken'])
        if remaining:
            _fail()
    return {'members': result, 'files': hashes, 'method': 'native-text-and-binary-load-record-readback'}
