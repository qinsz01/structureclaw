"""Regressions from the SATWE 2025R2.5 native three-storey report."""
from __future__ import annotations

from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from out_parsers import _parse_floor_dimensions, _parse_unit_mass, _parse_wdisp_cases
from report_render import _generate_docx, _generate_markdown, _generate_pdf
import report_render


FIXTURES = Path(__file__).parent / "fixtures"


def _vertical_cases():
    return _parse_wdisp_cases((FIXTURES / "vertical-displacement-2025r2.5.out").read_text(encoding="utf-8"))


def _report():
    return {"summary": {}, "detailed": {"out_file_data": {
        "wdisp_cases": _vertical_cases(),
        "unit_mass": _parse_unit_mass((FIXTURES / "zero-area-mass-2025r2.5.out").read_text(encoding="utf-8")),
    }}}


def test_indented_native_cases_keep_each_floor_and_four_column_vertical_values():
    cases = _vertical_cases()
    assert [case["case_num"] for case in cases] == [1, 2]
    assert [[row["floor"] for row in case["floors"]] for case in cases] == [[3, 2, 1], [3, 2, 1]]
    assert [[row["jmax"] for row in case["floors"]] for case in cases] == [[66, 46, 26], [66, 46, 26]]
    assert [[row["max_disp"] for row in case["floors"]] for case in cases] == [
        [-0.97, -0.82, -0.50], [-0.30, -0.27, -0.17],
    ]
    assert all(row["axis"] == "z" and row.get("ave_disp") is None for case in cases for row in case["floors"])


def test_horizontal_headers_preserve_axes_averages_and_exponents_without_crossing_rows():
    cases = _parse_wdisp_cases("""  === 工况 3 === 风作用
 Floor Tower Jmax Max-(X) Ave-(X) Ratio-(X)
 3 1 66 -1.20E-2 -0.01 1.2
 2 1 46 -0.02
 Floor Tower Jmax Max-(Y) Ave-(Y) Ratio-(Y)
 3 1 67 0.03 0.025 1.2
 最大层间位移角: 1/1000
""")
    assert len(cases) == 1
    assert [(r["floor"], r["axis"], r["max_disp"], r["ave_disp"]) for r in cases[0]["floors"]] == [
        (3, "x", -0.012, -0.01), (3, "y", 0.03, 0.025),
    ]
    assert cases[0]["max_drift_summary"] == "1/1000"


def test_numeric_lines_without_a_verified_displacement_header_are_not_results():
    assert _parse_wdisp_cases("=== 工况 1 === unknown\n 3 1 66 -0.97 2\n")[0]["floors"] == []


def test_zero_native_floor_area_cannot_publish_unit_area_mass_but_keeps_raw_values():
    text = (FIXTURES / "zero-area-mass-2025r2.5.out").read_text(encoding="utf-8")
    dimensions = _parse_floor_dimensions(text)
    assert [(row["floor"], row["area"]) for row in dimensions] == [(1, 0), (2, 0), (3, 0)]
    rows = _parse_unit_mass(text)
    assert [row["native_unit_mass"] for row in rows] == [669600, 669600, 511500]
    assert all(row["unit_mass"] is None and row["status"] == "unavailable"
               and row["reason"] == "FLOOR_AREA_UNAVAILABLE" and row["floor_area"] == 0 for row in rows)


def test_positive_native_area_keeps_vendor_mass_without_recalculating_it():
    text = (FIXTURES / "zero-area-mass-2025r2.5.out").read_text(encoding="utf-8")
    text = text.replace("0.00      0.00      0.00", "432.00    0.00      0.00")
    assert [row["unit_mass"] for row in _parse_unit_mass(text)] == [669600, 669600, 511500]


def test_markdown_reports_absolute_vertical_values_without_fabricated_averages_or_area_mass():
    text = _generate_markdown(_report())
    assert "楼层位移 / Floor displacements" in text
    assert "工况 1:" in text and "工况 2:" in text
    assert "| 2 | 1 | Z | -0.82 |" in text
    assert "| 1 | 1 | Z | -0.17 |" in text
    assert "平均位移" not in text
    assert "| 82 |" not in text and "| 27 |" not in text
    assert "669600" not in text and "511500" not in text
    assert "不可用 / N/A" in text


def test_docx_keeps_vertical_axis_and_omits_unavailable_columns(tmp_path):
    docx = pytest.importorskip("docx")
    output = tmp_path / "report.docx"
    _generate_docx(_report(), output)
    document = docx.Document(output)
    tables = [[list(cell.text for cell in row.cells) for row in table.rows] for table in document.tables]
    assert [["2", "1", "Z", "-0.82"], ["1", "1", "Z", "-0.5"]] == tables[-2][-2:]
    assert all("平均位移" not in cell for table in tables for row in table for cell in row)
    assert any("不可用 / N/A" in cell for table in tables for row in table for cell in row)


def test_pdf_renders_both_vertical_cases_without_a_fake_average(tmp_path, monkeypatch):
    pytest.importorskip("reportlab")
    from reportlab.platypus import Table

    rows = []
    original = Table.__init__

    def capture(self, data, *args, **kwargs):
        rows.append(data)
        original(self, data, *args, **kwargs)

    monkeypatch.setattr(Table, "__init__", capture)
    output = tmp_path / "report.pdf"
    _generate_pdf(_report(), output)
    assert output.read_bytes().startswith(b"%PDF")
    assert any(["2", "1", "Z", "-0.82"] in table for table in rows)
    assert any(["2", "1", "Z", "-0.27"] in table for table in rows)
    assert all("平均位移" not in str(cell) for table in rows for row in table for cell in row)


def test_pdf_embeds_available_cjk_truetype_font(tmp_path):
    pytest.importorskip("reportlab")
    font = Path("C:/Windows/Fonts/simsun.ttc")
    if not font.is_file():
        pytest.skip("Windows SimSun font is not installed on this platform")
    output = tmp_path / "embedded-cjk.pdf"
    _generate_pdf(_report(), output)
    assert b"/FontFile2" in output.read_bytes()


def test_pdf_font_fallback_works_without_installed_font_files(tmp_path, monkeypatch):
    pytest.importorskip("reportlab")
    monkeypatch.setattr(report_render, "_pdf_cjk_font_candidates", lambda: [], raising=False)
    output = tmp_path / "cid-font.pdf"
    _generate_pdf(_report(), output)
    assert output.read_bytes().startswith(b"%PDF")
    assert b"/STSong-Light" in output.read_bytes()


def test_pdf_repeats_column_headers_when_a_native_table_spans_pages(tmp_path, monkeypatch):
    pytest.importorskip("reportlab")
    from reportlab.platypus import Table

    splits = []
    original = Table.split

    def capture(self, *args, **kwargs):
        parts = original(self, *args, **kwargs)
        if len(parts) > 1:
            splits.append((self._cellvalues[0], [part._cellvalues[0] for part in parts]))
        return parts

    monkeypatch.setattr(Table, "split", capture)
    report = _report()
    report["detailed"]["out_file_data"]["unit_mass"] = [
        {"floor": floor, "tower": 1, "unit_mass": 500, "mass_ratio": 1} for floor in range(1, 121)
    ]
    _generate_pdf(report, tmp_path / "split-table.pdf")
    assert splits
    assert all(all(header == original_header for header in parts) for original_header, parts in splits)
