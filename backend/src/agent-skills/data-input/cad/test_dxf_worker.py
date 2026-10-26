import io
import unittest
from unittest.mock import patch
import ezdxf
from ezdxf.xclip import XClip
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
        self.assertEqual(result["lineEntityCount"], 2)
        self.assertEqual(result["ignoredAnnotations"], {"CIRCLE": 1, "ARC": 1, "HATCH": 1})
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

    def test_insert_preserves_frame_geometry_and_file_provenance(self):
        doc = ezdxf.new()
        block = doc.blocks.new("FRAME")
        for start, end in [((0, 0), (0, 3)), ((0, 3), (6, 3)), ((6, 3), (6, 0))]:
            block.add_line(start, end)
        reference = doc.modelspace().add_blockref("FRAME", (10, 2), dxfattribs={"layer": "STRUCTURE"})
        result = self.extract_doc(doc)
        self.assertTrue(result["complete"])
        self.assertEqual(result["lineEntityCount"], 3)
        self.assertEqual([(r["x1"], r["y1"], r["x2"], r["y2"]) for r in result["lines"]],
                         [(10, 2, 10, 5), (10, 5, 16, 5), (16, 5, 16, 2)])
        for line in result["lines"]:
            self.assertEqual(line["layer"], "STRUCTURE")
            self.assertEqual(line["source"]["rootHandle"], reference.dxf.handle)
            self.assertEqual(line["source"]["insertPath"][0]["name"], "FRAME")

    def test_nested_insert_applies_base_point_scale_rotation_and_layer_override(self):
        doc = ezdxf.new()
        inner = doc.blocks.new("INNER", base_point=(1, 1, 0))
        inner.add_line((1, 1), (3, 1))
        inner.add_line((1, 1), (1, 2), dxfattribs={"layer": "BRACE"})
        outer = doc.blocks.new("OUTER")
        outer.add_blockref("INNER", (2, 0), dxfattribs={"xscale": 2, "yscale": 2, "zscale": 2})
        doc.modelspace().add_blockref("OUTER", (10, 5), dxfattribs={"rotation": 90, "layer": "FRAME"})
        result = self.extract_doc(doc)
        self.assertTrue(result["complete"])
        expected = [(10, 7, 10, 11), (10, 7, 8, 7)]
        for line, coordinates in zip(result["lines"], expected):
            for key, value in zip(("x1", "y1", "x2", "y2"), coordinates):
                self.assertAlmostEqual(line[key], value)
            self.assertEqual([p["name"] for p in line["source"]["insertPath"]], ["OUTER", "INNER"])
        self.assertEqual([line["layer"] for line in result["lines"]], ["FRAME", "BRACE"])

    def test_multi_insert_keeps_all_instances_and_attached_attributes_once(self):
        doc = ezdxf.new()
        block = doc.blocks.new("BEAM")
        block.add_line((0, 0), (2, 0))
        reference = doc.modelspace().add_blockref("BEAM", (10, 2))
        reference.grid((2, 2), (4, 6))
        reference.add_attrib("NAME", "B1", (10, 3))
        result = self.extract_doc(doc)
        self.assertTrue(result["complete"])
        self.assertEqual([(r["x1"], r["y1"]) for r in result["lines"]], [(10, 2), (16, 2), (10, 6), (16, 6)])
        self.assertEqual(result["texts"], ["B1"] * 4)
        self.assertEqual([r["position"] for r in result["annotations"]],
                         [[10, 3, 0], [16, 3, 0], [10, 7, 0], [16, 7, 0]])

    def test_partial_block_reads_report_truncation(self):
        doc = ezdxf.new()
        block = doc.blocks.new("FRAME")
        block.add_line((0, 0), (1, 0))
        block.add_line((1, 0), (2, 0))
        doc.modelspace().add_blockref("FRAME", (0, 0))
        result = self.extract_doc(doc, limit=1)
        self.assertEqual(result["lineEntityCount"], 2)
        self.assertEqual(len(result["lines"]), 1)
        self.assertTrue(result["linesTruncated"])
        self.assertFalse(result["complete"])

    def test_missing_recursive_clipped_and_untransformable_blocks_never_report_complete(self):
        doc = ezdxf.new()
        doc.modelspace().add_blockref("MISSING", (0, 0))
        result = self.extract_doc(doc)
        self.assertFalse(result["complete"])
        self.assertIn("INSERT_BLOCK_NOT_FOUND", result["unsupportedEntities"])

        doc = ezdxf.new()
        block = doc.blocks.new("CYCLE")
        block.add_blockref("CYCLE", (0, 0))
        doc.modelspace().add_blockref("CYCLE", (0, 0))
        result = self.extract_doc(doc)
        self.assertFalse(result["complete"])
        self.assertIn("INSERT_DEPTH_LIMIT", result["unsupportedEntities"])

        doc = ezdxf.new()
        block = doc.blocks.new("CLIPPED")
        block.add_line((0, 0), (10, 0))
        reference = doc.modelspace().add_blockref("CLIPPED", (0, 0))
        XClip(reference).set_block_clipping_path([(0, -1), (2, 1)])
        result = self.extract_doc(doc)
        self.assertFalse(result["complete"])
        self.assertEqual(result["lines"], [])
        self.assertIn("INSERT_CLIPPING", result["unsupportedEntities"])

        XClip(reference).disable_clipping()
        with patch("ezdxf.entities.Line.transform", side_effect=NotImplementedError):
            result = self.extract_doc(doc)
        self.assertFalse(result["complete"])
        self.assertIn("INSERT_TRANSFORM:LINE", result["unsupportedEntities"])

    def test_nested_array_spacing_uses_ancestor_scale(self):
        doc = ezdxf.new()
        beam = doc.blocks.new("BEAM")
        beam.add_line((0, 0), (1, 0))
        array = doc.blocks.new("ARRAY")
        array.add_blockref("BEAM", (0, 0)).grid((1, 2), (0, 3))
        doc.modelspace().add_blockref("ARRAY", (10, 5), dxfattribs={"xscale": 2, "yscale": 3})
        result = self.extract_doc(doc)
        self.assertTrue(result["complete"])
        self.assertEqual([(r["x1"], r["y1"], r["x2"], r["y2"]) for r in result["lines"]],
                         [(10, 5, 12, 5), (16, 5, 18, 5)])

    def test_mirrored_spatial_blocks_and_external_references(self):
        doc = ezdxf.new()
        block = doc.blocks.new("SPATIAL")
        block.add_line((0, 0, 1), (2, 3, 4))
        doc.modelspace().add_blockref("SPATIAL", (10, 20, 30), dxfattribs={"xscale": -2, "yscale": 3, "zscale": 2})
        result = self.extract_doc(doc)
        self.assertTrue(result["complete"])
        self.assertEqual([result["lines"][0][k] for k in ("x1", "y1", "z1", "x2", "y2", "z2")],
                         [10, 20, 32, 6, 29, 38])
        external = doc.blocks.new("EXTERNAL")
        external.block.dxf.flags = 4
        external.block.dxf.xref_path = "unavailable.dxf"
        doc.modelspace().add_blockref("EXTERNAL", (0, 0))
        result = self.extract_doc(doc)
        self.assertFalse(result["complete"])
        self.assertIn("INSERT_EXTERNAL_REFERENCE", result["unsupportedEntities"])

    def test_nonuniform_line_scaling_is_exact_but_text_is_not_silently_accepted(self):
        doc = ezdxf.new()
        block = doc.blocks.new("SCALED")
        block.add_line((0, 0), (2, 3))
        block.add_text("B1")
        doc.modelspace().add_blockref("SCALED", (10, 5), dxfattribs={"xscale": 2, "yscale": 3})
        result = self.extract_doc(doc)
        self.assertEqual((result["lines"][0]["x2"], result["lines"][0]["y2"]), (14, 14))
        self.assertFalse(result["complete"])
        self.assertEqual(result["texts"], [])
        self.assertIn("INSERT_NON_UNIFORM_TEXT", result["unsupportedEntities"])

    def test_array_of_empty_blocks_still_obeys_the_expansion_budget(self):
        doc = ezdxf.new()
        doc.blocks.new("EMPTY")
        doc.modelspace().add_blockref("EMPTY", (0, 0)).grid((4, 4), (1, 1))
        with patch("dxf_worker.MAX_EXPANDED_ENTITIES", 5):
            with self.assertRaisesRegex(ValueError, "DXF expansion limit exceeded"):
                self.extract_doc(doc)

    def test_attached_attribute_coordinates_are_not_transformed_twice(self):
        doc = ezdxf.new()
        block = doc.blocks.new("BEAM")
        block.add_line((0, 0), (1, 0))
        reference = doc.modelspace().add_blockref("BEAM", (10, 5), dxfattribs={"xscale": 2, "yscale": 3})
        reference.add_attrib("NAME", "B1", (12, 11))
        result = self.extract_doc(doc)
        self.assertTrue(result["complete"])
        self.assertEqual(result["texts"], ["B1"])
        self.assertEqual(result["annotations"][0]["position"], [12, 11, 0])

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
