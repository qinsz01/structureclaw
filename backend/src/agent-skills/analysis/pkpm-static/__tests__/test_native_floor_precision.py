from __future__ import annotations

import base64
import json
from pathlib import Path
import struct
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'runtime'))
from native_geometry import bind_native_geometry, NativeGeometryUnavailable


def f32(value):
    return struct.unpack('<f', struct.pack('<f', value))[0]


def precision_frame():
    # Construct a representation-only variant in memory. The frozen solved
    # fixture and its numerical reference outputs remain unchanged.
    data = json.loads((Path(__file__).parent / 'fixtures/native-two-floor-frame.json').read_text(encoding='utf-8'))
    files = {name: base64.b64decode(value) for name, value in data['files'].items()}
    heights = {0: 0, 3.6: 8.1, 7.2: 11.7}
    for node in data['model']['nodes']:
        node['z'] = heights[node['z']]
    data['model']['stories'][0].update(elevation=0, height=8.1)
    data['model']['stories'][1].update(elevation=8.1, height=3.6)
    data['snapshot']['floors'][0].update(bottomM=0, heightMm=8100)
    data['snapshot']['floors'][1].update(bottomM=f32(8.1), heightMm=3600)
    native_heights = {f32(source): target for source, target in heights.items()}
    mesh = bytearray(files['MESH.SAT'])
    for offset in range(20, len(mesh), 20):
        struct.pack_into('<f', mesh, offset + 8, native_heights[struct.unpack_from('<f', mesh, offset + 8)[0]])
    files['MESH.SAT'] = bytes(mesh)
    return data, files


def test_floor_components_are_checked_before_source_endpoints_are_bound_to_native_mesh():
    data, files = precision_frame()
    readback = data['snapshot']['floors'][1]
    assert f32(readback['bottomM'] + readback['heightMm'] / 1000) != f32(11.7)
    geometry = bind_native_geometry(data['model'], data['snapshot'], files)
    assert len(geometry['native_members']) == 36
    assert any(member.get('topCoordinates', [0, 0, 0])[2] == 11.7 for member in geometry['native_members'].values())


@pytest.mark.parametrize('field', ['bottomM', 'heightMm'])
def test_a_real_one_native_ulp_component_change_still_fails(field):
    data, files = precision_frame()
    floor = data['snapshot']['floors'][1]
    bits = struct.unpack('<I', struct.pack('<f', floor[field]))[0]
    floor[field] = struct.unpack('<f', struct.pack('<I', bits + 1))[0]
    with pytest.raises(NativeGeometryUnavailable):
        bind_native_geometry(data['model'], data['snapshot'], files)


def test_changed_mesh_endpoints_are_not_hidden_by_api_component_precision():
    data, files = precision_frame()
    mesh = bytearray(files['MESH.SAT'])
    for offset in range(20, len(mesh), 20):
        if struct.unpack_from('<f', mesh, offset + 8)[0] == f32(11.7):
            struct.pack_into('<f', mesh, offset + 8, 11.701)
            break
    files['MESH.SAT'] = bytes(mesh)
    with pytest.raises(NativeGeometryUnavailable):
        bind_native_geometry(data['model'], data['snapshot'], files)
