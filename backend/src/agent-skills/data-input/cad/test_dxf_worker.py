import io
import unittest
import ezdxf
from dxf_worker import extract


class DxfEvidenceTests(unittest.TestCase):
    def extract_doc(self, doc, **kwargs):
        stream = io.StringIO()
        doc.write(stream)
        return extract(stream.getvalue(), **kwargs)

    def test_insert_transform_polyline_and_provenance(self):
        doc = ezdxf.new()
        block = doc.blocks.new("FRAME")
        block.add_lwpolyline([(0, 0), (4, 0), (4, 3)])
        doc.modelspace().add_blockref("FRAME", (10, 2), dxfattribs={"layer": "STRUCT"})
        result = self.extract_doc(doc)
        self.assertEqual(result["lineEntityCount"], 2)
        self.assertEqual((result["lines"][0]["x1"], result["lines"][0]["y1"]), (10, 2))
        self.assertEqual(result["lines"][0]["source"]["blockPath"], ["FRAME"])
        self.assertEqual(result["lines"][0]["source"]["effectiveLayer"], "STRUCT")

    def test_dimension_graphics_never_become_structural_lines(self):
        doc = ezdxf.new()
        doc.modelspace().add_linear_dim(base=(0, 2), p1=(0, 0), p2=(4, 0)).render()
        result = self.extract_doc(doc)
        self.assertEqual(result["lineEntityCount"], 0)
        self.assertEqual(result["dimensionEntityCount"], 1)

    def test_bulges_layouts_and_truncation_are_explicit(self):
        doc = ezdxf.new()
        doc.modelspace().add_lwpolyline([(0, 0, 1), (4, 0, 0)], format="xyb")
        doc.modelspace().add_line((0, 0), (1, 0))
        doc.modelspace().add_line((1, 0), (2, 0))
        doc.layout().add_text("Paper detail")
        result = self.extract_doc(doc, limit=1)
        self.assertTrue(result["linesTruncated"])
        self.assertFalse(result["complete"])
        self.assertIn("ARC", result["unsupportedEntities"])
        self.assertIn("PAPERSPACE_NOT_EXTRACTED", result["unsupportedEntities"])


if __name__ == '__main__':
    unittest.main()
