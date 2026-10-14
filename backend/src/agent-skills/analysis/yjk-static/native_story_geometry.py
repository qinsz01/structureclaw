"""YJK compatibility import for the shared pure natural-storey compiler."""
from pathlib import Path
import sys

_shared = str(Path(__file__).resolve().parents[3] / 'skill-shared/python')
if _shared not in sys.path:
    sys.path.insert(0, _shared)
from structure_protocol.story_geometry import compile_story_geometry, exact_mm

__all__ = ['compile_story_geometry', 'exact_mm']
