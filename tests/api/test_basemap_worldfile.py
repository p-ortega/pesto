"""World files: which names count, what a valid file is, and the corners
with the half-pixel shift (D-18, D-19, D-35)."""

from __future__ import annotations

import pytest

from pesto.basemap.worldfile import (
    MIRRORED_REASON,
    ROTATED_REASON,
    WorldFile,
    WorldFileRefusal,
    corners,
    find_world_files,
    parse_world_file,
)

from .basemap_images import world_file_text


def _touch(folder, *names):
    for name in names:
        (folder / name).write_text("x")


# ---------------------------------------------------------------------------
# Finding the world file
# ---------------------------------------------------------------------------


def test_png_world_file_names_match_case_insensitively(tmp_path):
    _touch(tmp_path, "Map.PNG", "map.pgw", "MAP.PNGW", "map.wld", "other.pgw", "map.jgw.bak")
    assert find_world_files(tmp_path / "Map.PNG", "png") == ["MAP.PNGW", "map.pgw", "map.wld"]


def test_jpg_world_file_names(tmp_path):
    _touch(tmp_path, "a.jpg", "a.jgw", "a.jpgw", "a.wld", "b.jgw")
    assert find_world_files(tmp_path / "a.jpg", "jpeg") == ["a.jgw", "a.jpgw", "a.wld"]


def test_jpeg_also_takes_jpegw(tmp_path):
    _touch(tmp_path, "a.jpeg", "a.jpegw", "a.jgw")
    assert find_world_files(tmp_path / "a.jpeg", "jpeg") == ["a.jgw", "a.jpegw"]


def test_a_file_with_another_stem_never_matches(tmp_path):
    _touch(tmp_path, "map.png", "map2.pgw", "amap.pgw", "map.png.pgw")
    assert find_world_files(tmp_path / "map.png", "png") == []


def test_a_folder_named_like_a_world_file_is_not_one(tmp_path):
    _touch(tmp_path, "map.png")
    (tmp_path / "map.pgw").mkdir()
    assert find_world_files(tmp_path / "map.png", "png") == []


# ---------------------------------------------------------------------------
# Parsing: what is accepted
# ---------------------------------------------------------------------------


def _write(tmp_path, text, name="map.pgw", encoding="utf-8"):
    path = tmp_path / name
    path.write_bytes(text.encode(encoding) if isinstance(text, str) else text)
    return path


def test_crlf_bom_spaces_and_trailing_blank_lines_are_accepted(tmp_path):
    text = "﻿  2.0 \r\n0\r\n0\r\n-2.0\r\n 1000.5\r\n2000\r\n\r\n   \r\n"
    assert parse_world_file(_write(tmp_path, text)) == WorldFile(2.0, 0.0, 0.0, -2.0, 1000.5, 2000.0)


def test_exponents_and_signs_are_accepted(tmp_path):
    path = _write(tmp_path, world_file_text("2.5E+01", "0", "-0.0", "-.5", "+1e3", "2000."))
    assert parse_world_file(path) == WorldFile(25.0, 0.0, -0.0, -0.5, 1000.0, 2000.0)


# ---------------------------------------------------------------------------
# Parsing: what is refused, naming the line
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("bad", ["1,5", "nan", "inf", "-Infinity", "1e400", "1_0", "0x10", "2 0", "abc"])
def test_a_line_that_is_not_a_plain_finite_number_is_refused_by_line(tmp_path, bad):
    path = _write(tmp_path, world_file_text(2, 0, 0, bad, 1000, 2000))
    with pytest.raises(WorldFileRefusal) as caught:
        parse_world_file(path)
    assert caught.value.line == 4
    assert caught.value.reason.startswith("line 4 of map.pgw")
    assert caught.value.code == "malformed"


def test_a_decimal_comma_is_named_as_such(tmp_path):
    path = _write(tmp_path, world_file_text("1,5", 0, 0, -2, 1000, 2000))
    with pytest.raises(WorldFileRefusal, match="line 1 of map.pgw uses a decimal comma"):
        parse_world_file(path)


def test_an_empty_middle_line_is_refused_by_line(tmp_path):
    path = _write(tmp_path, "2\n0\n\n0\n-2\n1000\n2000\n")
    with pytest.raises(WorldFileRefusal) as caught:
        parse_world_file(path)
    assert caught.value.line == 3
    assert "line 3 of map.pgw is empty" in caught.value.reason


@pytest.mark.parametrize("count", [5, 7])
def test_the_wrong_line_count_is_refused(tmp_path, count):
    path = _write(tmp_path, "\n".join(["1"] * count) + "\n")
    with pytest.raises(WorldFileRefusal, match=f"has {count} lines, expected 6"):
        parse_world_file(path)


def test_a_file_over_4096_bytes_is_refused(tmp_path):
    path = _write(tmp_path, world_file_text(2, 0, 0, -2, 1000, 2000) + " " * 5000)
    with pytest.raises(WorldFileRefusal, match="larger than 4096 bytes"):
        parse_world_file(path)


def test_bytes_that_are_not_utf8_are_refused(tmp_path):
    path = _write(tmp_path, b"2\n0\n0\n-2\n\xff\xfe1000\n2000\n")
    with pytest.raises(WorldFileRefusal, match="is not UTF-8 text"):
        parse_world_file(path)


# ---------------------------------------------------------------------------
# Corners
# ---------------------------------------------------------------------------


def test_corners_take_the_half_pixel_shift():
    wf = WorldFile(a=2.0, d=0.0, b=0.0, e=-2.0, c=1000.0, f=2000.0)
    assert corners(wf, 100, 50) == (999.0, 1199.0, 1901.0, 2001.0)


@pytest.mark.parametrize("d, b", [(0.1, 0.0), (0.0, -0.1), (1.0, 1.0)])
def test_a_rotation_term_is_refused(d, b):
    with pytest.raises(WorldFileRefusal) as caught:
        corners(WorldFile(2.0, d, b, -2.0, 1000.0, 2000.0), 10, 10)
    assert caught.value.code == "rotated"
    assert caught.value.reason == ROTATED_REASON


@pytest.mark.parametrize("a, e", [(-2.0, -2.0), (0.0, -2.0), (2.0, 2.0), (2.0, 0.0)])
def test_a_mirrored_or_flipped_axis_is_refused(a, e):
    with pytest.raises(WorldFileRefusal) as caught:
        corners(WorldFile(a, 0.0, 0.0, e, 1000.0, 2000.0), 10, 10)
    assert caught.value.code == "mirrored"
    assert caught.value.reason == MIRRORED_REASON
