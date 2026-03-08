from __future__ import annotations

from typing import Dict, List

from converters.base import FormatConverter
from converters.simple_v1_converter import SimpleV1Converter
from converters.v1_converter import StructureModelV1Converter


_CONVERTERS: Dict[str, FormatConverter] = {
    StructureModelV1Converter.format_name: StructureModelV1Converter(),
    SimpleV1Converter.format_name: SimpleV1Converter(),
}


def get_converter(format_name: str) -> FormatConverter | None:
    return _CONVERTERS.get(format_name)


def supported_formats() -> List[str]:
    return sorted(_CONVERTERS.keys())
