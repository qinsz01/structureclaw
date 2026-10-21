"""Compatibility import for the shared deterministic slab-to-beam expander."""
from opensees_shared.errors import OpenSeesInputError
from structure_protocol.floor_panels import FloorPanelLoadMixin as SharedFloorPanelLoadMixin


class FloorPanelLoadMixin(SharedFloorPanelLoadMixin):
    _floor_transfer_error = OpenSeesInputError
