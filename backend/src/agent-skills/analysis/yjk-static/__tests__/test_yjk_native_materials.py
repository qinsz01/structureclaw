import copy
import importlib.util
from pathlib import Path
import unittest
import struct
import sqlite3
import tempfile
from contextlib import closing

SPEC = importlib.util.spec_from_file_location("yjk_native_materials", Path(__file__).parents[1] / "yjk_native_materials.py")
materials = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(materials)


def fixture():
    material = {"id": "steel", "name": "Q355", "type": "steel", "E": 206000., "nu": .3,
                "G": 206000 / 2.6, "rho": 7850.}
    model = {"materials": [material], "nodes": [{"id": "i", "x": 0, "y": 0, "z": 3},
              {"id": "j", "x": 4, "y": 0, "z": 3}],
             "sections": [{"id": "s", "properties": {"A": .15, "Iy": .003125, "Iz": .001125, "J": .00281737}}],
             "elements": [{"id": "beam", "nodes": ["i", "j"], "material": "steel", "section": "s"}]}
    fe = {"unit": [0, 0, 0], "sha256": "bound-executed-fe-hash", "gravity": 10.,
          "nodes": {"88": [0, 0, 3], "54": [4, 0, 3]},
          "frames": {"987": {"nodes": ["54", "88"], "kind": "BEAM", "DIR": [0., 0., 1.],
                               "materialId": "3", "sectionId": "5", "RF": [1.] * 6, "R": [0.] * 6}},
          "materials": {"3": {"P": [206000000., .3, 0, 0, 1e-5]}},
          "sections": {"5": {"P": [.15, .003125, .001125, .00281737],
                              "raw": {"P": "0.15,0.003125,0.001125,0.00281737"}}}, "sectionsRaw": {}}
    return model, fe


class NativeMaterialTests(unittest.TestCase):
    def test_numeric_section_carrier_preserves_source_and_six_independent_rigidities(self):
        model, fe = fixture()
        model["analysis_control"] = dict.fromkeys(("self_weight", "rigid_floor", "rigid_offsets", "construction_stage", "p_delta"), False)
        model["materials"][0].update(name="M1", E=203000, G=76321, nu=.31)
        section = model["sections"][0]
        section.update(type="custom", properties={"A": .134, "Iy": .00241, "Iz": .00117,
                       "J": .000837, "Asy": .067, "Asz": .039})
        original = copy.deepcopy(model)
        plan = materials.compile_stiffness_plan(model)
        self.assertEqual(model, original)
        entry = plan["members"]["beam"]
        self.assertEqual(entry["sectionRepresentation"]["method"], "native-reference-carrier")
        self.assertFalse(entry["sectionRepresentation"]["physicalGeometryVerified"])
        self.assertEqual(entry["authoredSection"], section["properties"])
        self.assertEqual(entry["materialBaseline"]["sourceGrade"], None)
        self.assertEqual(entry["targetRigidities"], {"EA": 203000*.134, "EIy": 203000*.00241,
            "EIz": 203000*.00117, "GJ": 76321*.000837, "GAsy": 76321*.067, "GAsz": 76321*.039})
        base = entry["sectionBaseline"]
        self.assertAlmostEqual(entry["expectedRF"][4], 76321*.039 / ((206000/2.6)*base["Asz"]))
        self.assertAlmostEqual(entry["expectedRF"][5], 76321*.067 / ((206000/2.6)*base["Asy"]))
        raw = ",".join(format(entry["sectionBaseline"][key], ".7g") for key in ("A", "Iy", "Iz", "J", "Asy", "Asz"))
        fe["sections"]["5"] = {"P": list(map(float, raw.split(","))), "raw": {"P": raw}}
        raw_rf = ",".join(format(struct.unpack("f", struct.pack("f", value))[0], ".6g") for value in entry["expectedRF"])
        fe["frames"]["987"].update(RF=list(map(float, raw_rf.split(","))), raw={"RF": raw_rf})
        audit = materials.audit_frames(model, fe, plan)
        self.assertTrue(audit["passed"], audit["failures"])
        self.assertEqual(audit["members"]["beam"]["sectionRepresentation"], entry["sectionRepresentation"])
        # Native reference dimensions cannot certify the physical source shape.
        self.assertNotEqual(audit["members"]["beam"]["nativeSection"]["A"], section["properties"]["A"])
        for key in ("A", "Iy", "Iz", "J", "Asy", "Asz"):
            broken = copy.deepcopy(model)
            del broken["sections"][0]["properties"][key]
            with self.assertRaisesRegex(ValueError, "explicit positive"):
                materials.compile_stiffness_plan(broken)
        model["analysis_control"]["self_weight"] = True
        self.assertEqual(materials.compile_stiffness_plan(model)["members"]["beam"]["targetRigidities"],
                         plan["members"]["beam"]["targetRigidities"])

    def test_identity_migration_preserves_authored_material_values_and_input(self):
        model, _ = fixture()
        original = copy.deepcopy(model["materials"][0])
        actual = materials.normalize_material(original)
        self.assertEqual(actual["category"], "steel")
        self.assertEqual(actual["grade"], "Q355")
        self.assertNotIn("type", actual)
        self.assertEqual(actual["G"], original["G"])
        self.assertEqual(original, model["materials"][0])

    def test_category_not_guessed_from_modulus(self):
        material = fixture()[0]["materials"][0]
        material.update(name="user-defined")
        del material["type"]
        with self.assertRaisesRegex(ValueError, "explicit category"):
            materials.normalize_material(material)

    def test_grade_category_conflict_fails(self):
        material = fixture()[0]["materials"][0]
        material.update(category="concrete")
        with self.assertRaisesRegex(ValueError, "conflict"):
            materials.normalize_material(material)

    def test_every_executed_frame_is_matched_without_native_id_arithmetic(self):
        model, fe = fixture()
        actual = materials.audit_frames(model, fe)
        self.assertTrue(actual["passed"])
        self.assertEqual(actual["members"]["beam"]["nativeFrameId"], "987")

    def test_material_poisson_and_explicit_G_and_J_mismatches_are_not_ignored(self):
        for change, expected in ((lambda m, f: f["materials"]["3"]["P"].__setitem__(1, .25), "nu"),
                                 (lambda m, f: m["materials"][0].__setitem__("G", 79000), "G"),
                                 (lambda m, f: m["sections"][0]["properties"].__setitem__("J", .0028), "J")):
            model, fe = fixture()
            change(model, fe)
            audit = materials.audit_frames(model, fe)
            self.assertFalse(audit["passed"])
            self.assertIn(expected, [failure["field"] for failure in audit["failures"]])

    def test_unmapped_native_member_and_added_floor_stiffness_fail(self):
        for change in (lambda f: f["frames"].update({"other": copy.deepcopy(f["frames"]["987"])}),
                       lambda f: f["frames"]["987"].__setitem__("RF", [1, 1.3, 1.3, 1, 1, 1])):
            model, fe = fixture()
            change(fe)
            self.assertFalse(materials.audit_frames(model, fe)["passed"])

    def test_writer_precision_is_bounded_and_does_not_treat_trimmed_zeroes_as_error_budget(self):
        self.assertTrue(materials._rounding_match(.0018984375, "1.898437E-03"))
        self.assertFalse(materials._rounding_match(.101, "0.1"))

    def test_scalar_receipt_alone_cannot_enable_verified_context(self):
        model, fe = fixture()
        audit = materials.audit_frames(model, fe)
        context = materials.physics_context(model, fe, audit, {"passed": True}, engine_version="8.0-test")
        self.assertFalse(context["effectiveSettingsVerified"])
        self.assertFalse(context["linearStatic"])
        self.assertFalse(context["stationConventionsVerified"])

    def test_effective_evidence_must_be_for_the_same_executed_FE(self):
        model, fe = fixture()
        audit = materials.audit_frames(model, fe)
        for fe_hash, expected in (("stale", False), (fe["sha256"], True)):
            context = materials.physics_context(model, fe, audit, {"passed": True}, engine_version="8.0-test",
                effective_settings_audit={"passed": True, "linearStatic": True, "feaSha256": fe_hash})
            self.assertEqual(context["effectiveSettingsVerified"], expected)
            self.assertFalse(context["stationConventionsVerified"])

    def test_explicit_shear_and_torsion_transfer_preserves_all_six_rigidities(self):
        model, fe = fixture()
        model["materials"][0].update(name="C30", type="concrete", E=30000., nu=.2, G=12500.123, rho=2500.)
        section = model["sections"][0]
        section.update(type="rectangular", shape={"kind": "rectangular", "B": 300., "H": 500.})
        section["properties"]["J"] = .0027  # Explicit torsion model must be retained.
        plan = materials.compile_stiffness_plan(model)
        entry = plan["members"]["beam"]
        self.assertNotEqual(entry["coefficients"][1], 1.)
        self.assertNotEqual(entry["coefficients"][3], 1.)
        self.assertEqual(entry["coefficients"][0], 1.)
        for coefficient in entry["coefficients"][4:]:
            self.assertAlmostEqual(coefficient, 1., places=14)
        self.assertIn("1.041676916666666", entry["shapeVal"])
        baseline = entry["sectionBaseline"]
        values = [baseline[key] for key in ("A", "Iy", "Iz", "J", "Asy", "Asz")]
        raw = ",".join(format(value, ".7g") for value in values)
        fe["sections"]["5"] = {"P": list(map(float, raw.split(","))), "raw": {"P": raw}}
        fe["materials"]["3"]["P"] = [30000000., .25, 0, 0, 1e-5]
        raw_rf = ",".join(format(struct.unpack("f", struct.pack("f", value))[0], ".6g") for value in entry["expectedRF"])
        fe["frames"]["987"].update(RF=list(map(float, raw_rf.split(","))), raw={"RF": raw_rf})
        audit = materials.audit_frames(model, fe, plan)
        self.assertTrue(audit["passed"], audit["failures"])
        # Equal scalar properties cannot hide a physically rotated section.
        fe["frames"]["987"]["DIR"] = [0., 1., 0.]
        wrong_axes = materials.audit_frames(model, fe, plan)
        self.assertFalse(wrong_axes["passed"])
        self.assertIn("sectionAxes", [failure["field"] for failure in wrong_axes["failures"]])
        fe["frames"]["987"]["DIR"] = [0., 0., 1.]
        # Swapping bending/shear coefficients must fail even if their envelope
        # contains exactly the same six numbers.
        fe["frames"]["987"]["RF"][1], fe["frames"]["987"]["RF"][4] = fe["frames"]["987"]["RF"][4], fe["frames"]["987"]["RF"][1]
        self.assertFalse(materials.audit_frames(model, fe, plan)["passed"])

    def test_column_rotation_preserves_canonical_width_axis_and_explicit_reference(self):
        model, _ = fixture()
        element = model["elements"][0]
        model["nodes"][0].update(x=0, y=0, z=0)
        model["nodes"][1].update(x=0, y=0, z=3)
        nodes = {row["id"]: row for row in model["nodes"]}
        entry = materials.compile_orientation(model, element, nodes)
        self.assertEqual(entry["nativeRotationDegrees"], 90.)
        self.assertEqual(entry["canonicalAxes"][1], [0., -1., 0.])
        model["metadata"] = {"elementReferenceVectors": {"beam": [0., 1., 0.]}}
        self.assertEqual(materials.compile_orientation(model, element, nodes)["nativeRotationDegrees"], 0.)
        element["rotation_angle"] = 30
        self.assertAlmostEqual(materials.compile_orientation(model, element, nodes)["nativeRotationDegrees"], 30.)
        element["nodes"].reverse()
        self.assertAlmostEqual(materials.compile_orientation(model, element, nodes)["nativeRotationDegrees"], 150.)

    def test_beam_rotation_respects_native_axis_direction_and_reference(self):
        model, _ = fixture()
        element = model["elements"][0]
        nodes = {row["id"]: row for row in model["nodes"]}
        element["rotation_angle"] = 30
        self.assertAlmostEqual(materials.compile_orientation(model, element, nodes)["nativeRotationDegrees"], 30.)
        element["nodes"].reverse()
        self.assertAlmostEqual(materials.compile_orientation(model, element, nodes)["nativeRotationDegrees"], 150.)
        model["metadata"] = {"elementReferenceVectors": {"beam": [0., 1., 0.]}}
        element["rotation_angle"] = 0
        self.assertEqual(materials.compile_orientation(model, element, nodes)["nativeRotationDegrees"], 90.)

    def test_exchange_precision_repair_keeps_typed_arrays_and_other_properties(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = root / "generated.ydb"
            with closing(sqlite3.connect(path)) as db, db:
                db.execute("CREATE TABLE tblProperty (ID INTEGER,Name TEXT,Type INTEGER,ShapeVal TEXT)")
                db.executemany("INSERT INTO tblProperty VALUES (?,?,?,?)", [
                    (11, "SpBarRig", 27, "1.00,1.04,1.04,1.04,1.00,1.00,"),
                    (11, "HNTDJ", 5, "30")])
            coefficients = [1., 25/24, 25/24, 25/24, 1., 1.]
            text = ",".join(format(value, ".17g") for value in coefficients) + ","
            plan = {"physicalModelHash": "same-model", "members": {"beam": {"coefficients": coefficients, "shapeVal": text}}}
            result = materials.repair_exchange_precision(path, root, {"beam": {"yjk_model_id": 11}}, plan)
            self.assertTrue(result["passed"])
            with closing(sqlite3.connect(path)) as db, db:
                self.assertEqual(db.execute("SELECT Type,ShapeVal FROM tblProperty WHERE Name='SpBarRig'").fetchone(), (27, text))
                self.assertEqual(db.execute("SELECT ShapeVal FROM tblProperty WHERE Name='HNTDJ'").fetchone()[0], "30")
            self.assertNotEqual(result["beforeSha256"], result["afterSha256"])
            self.assertTrue((root / "native-stiffness-precision.json").is_file())

    def test_precision_repair_cannot_touch_native_projects_or_other_directories(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            outside = root / "other"
            outside.mkdir()
            path = outside / "generated.ydb"
            path.touch()
            with self.assertRaisesRegex(ValueError, "this run"):
                materials.repair_exchange_precision(path, root, {}, {"members": {}})
            (outside / "saved.ymd").touch()
            with self.assertRaisesRegex(ValueError, "precede native import"):
                materials.repair_exchange_precision(path, outside, {}, {"members": {}})

    def test_wrong_target_stiffness_aborts_before_any_precision_write(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = root / "generated.ydb"
            with closing(sqlite3.connect(path)) as db, db:
                db.execute("CREATE TABLE tblProperty (ID INTEGER,Name TEXT,Type INTEGER,ShapeVal TEXT)")
                db.executemany("INSERT INTO tblProperty VALUES (?,?,?,?)", [
                    (11, "SpBarRig", 27, "1.00,1.04,1.04,1.04,1.00,1.00,"),
                    (12, "SpBarRig", 27, "9,9,9,9,9,9,")])
            coefficients = [1., 25/24, 25/24, 25/24, 1., 1.]
            entry = {"coefficients": coefficients, "shapeVal": ",".join(map(str, coefficients)) + ","}
            before = path.read_bytes()
            with self.assertRaisesRegex(ValueError, "beyond the SDK"):
                materials.repair_exchange_precision(path, root, {"a": {"yjk_model_id": 11}, "b": {"yjk_model_id": 12}},
                    {"physicalModelHash": "same-model", "members": {"a": entry, "b": entry}})
            self.assertEqual(path.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
