import io
import unittest
import ezdxf
from dxf_worker import extract


class DxfEvidenceTests(unittest.TestCase):
    def extract_doc(self, doc, **kwargs):
        stream = io.StringIO()
        doc.write(stream)
        return extract(stream.getvalue(), **kwargs)

    def test_symbols_and_annotations_do_not_make_file_incomplete(self):
        doc = ezdxf.new()
        doc.header["$INSUNITS"] = 4
        block = doc.blocks.new("SYMBOL")
        block.add_line((0, 0), (1, 1))
        space = doc.modelspace()
        space.add_blockref("SYMBOL", (10, 2))
        space.add_circle((0, 0), 1)
        space.add_arc((0, 0), 1, 0, 90)
        space.add_hatch().paths.add_polyline_path([(0, 0), (1, 0), (1, 1)], is_closed=True)
        space.add_line((0, 0), (6000, 0))
        space.add_linear_dim(base=(0, 2), p1=(0, 0), p2=(6000, 0), text="6000 nominal").render()
        result = self.extract_doc(doc)
        self.assertTrue(result["complete"])
        self.assertEqual(result["lineEntityCount"], 1)
        self.assertEqual(result["ignoredAnnotations"], {"INSERT": 1, "CIRCLE": 1, "ARC": 1, "HATCH": 1})
        dimension = result["dimensions"][0]
        self.assertEqual(dimension["measurement"], 6000)
        self.assertEqual(dimension["text"], "6000 nominal")
        self.assertEqual(dimension["metersPerUnit"], 0.001)
        self.assertEqual(dimension["definitionPoints"]["defpoint3"], [6000, 0, 0])

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
        self.assertIn("CURVED_POLYLINE", result["unsupportedEntities"])
        self.assertIn("PAPERSPACE_NOT_EXTRACTED", result["unsupportedEntities"])


if __name__ == '__main__':
    unittest.main()
