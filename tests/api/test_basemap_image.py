"""Image sniffing, the pure-Python header size read and the pixel budget
(D-17, D-22, D-34)."""

from __future__ import annotations

import pytest

from pesto.basemap.imageinfo import (
    PIXEL_BUDGET,
    SNIFF_CAP,
    TIFF_REASON,
    ImageRefusal,
    check_budget,
    extension_note,
    format_refusal,
    image_size,
    jpeg_orientation,
    orientation_note,
    sniff,
)

from .basemap_images import exif_jpeg_header_bytes, jpeg_header_bytes, png_bytes, tiff_bytes, xmp_segment


@pytest.mark.parametrize(
    "head, kind",
    [
        (png_bytes(2, 2)[:16], "png"),
        (jpeg_header_bytes(2, 2)[:16], "jpeg"),
        (tiff_bytes("II"), "tiff"),
        (tiff_bytes("MM"), "tiff"),
        (tiff_bytes("II", big=True), "tiff"),
        (tiff_bytes("MM", big=True), "tiff"),
        (b"GIF89a" + bytes(10), "other"),
        (b"", "other"),
        (b"hello, world\n", "other"),
    ],
)
def test_sniff_reads_the_kind_from_the_bytes(head, kind):
    assert sniff(head) == kind


def test_the_tiff_reason_names_m2():
    assert TIFF_REASON == "TIFF and GeoTIFF basemaps are not supported yet (planned for M2)"


@pytest.mark.parametrize(
    "head, named",
    [
        (b"GIF89a" + bytes(10), "GIF"),
        (b"GIF87a" + bytes(10), "GIF"),
        (b"BM" + b"\x10\x00\x00\x00" + bytes(4) + bytes(6), "BMP"),
        (b"%PDF-1.7\n" + bytes(7), "PDF"),
        (b"RIFF\x00\x00\x00\x00WEBPVP8 ", "WebP"),
        (b"PK\x03\x04" + bytes(12), "ZIP"),
    ],
)
def test_the_format_refusal_names_a_known_other_format(head, named):
    assert f"a {named} file" in format_refusal(head)


def test_the_format_refusal_for_unknown_bytes_says_so():
    assert "match no PNG, JPEG or TIFF signature" in format_refusal(b"BMhello text")


def _file(tmp_path, data, name="img"):
    path = tmp_path / name
    path.write_bytes(data)
    return path


def test_png_size(tmp_path):
    assert image_size(_file(tmp_path, png_bytes(100, 50)), "png") == (100, 50)


def test_baseline_jpeg_size(tmp_path):
    assert image_size(_file(tmp_path, jpeg_header_bytes(640, 480)), "jpeg") == (640, 480)


def test_progressive_jpeg_size(tmp_path):
    assert image_size(_file(tmp_path, jpeg_header_bytes(31, 17, progressive=True)), "jpeg") == (31, 17)


def test_a_jpeg_with_an_app1_segment_before_the_frame(tmp_path):
    assert image_size(_file(tmp_path, jpeg_header_bytes(40, 20, app1=True)), "jpeg") == (40, 20)


@pytest.mark.parametrize(
    "data, kind",
    [
        (png_bytes(10, 10)[:20], "png"),
        (jpeg_header_bytes(10, 10)[:26], "jpeg"),
        (jpeg_header_bytes(10, 10)[:21], "jpeg"),
        (b"\xff\xd8\xff\xd9", "jpeg"),
    ],
)
def test_a_truncated_header_is_refused(tmp_path, data, kind):
    with pytest.raises(ImageRefusal) as caught:
        image_size(_file(tmp_path, data), kind)
    assert caught.value.code == "header"


def test_the_budget_passes_just_under_the_limit():
    check_budget(9459, 9459)


def test_the_budget_refuses_just_over_the_limit_with_both_numbers():
    with pytest.raises(ImageRefusal) as caught:
        check_budget(9460, 9460)
    assert caught.value.code == "too_large"
    assert caught.value.reason == "the image has 89,491,600 pixels; the limit is 89,478,485"
    assert PIXEL_BUDGET == 89_478_485


def test_an_empty_image_is_refused():
    with pytest.raises(ImageRefusal):
        check_budget(0, 10)


# ---------------------------------------------------------------------------
# The extension note (D-17) and the EXIF orientation flag (D-36)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "name, kind, note",
    [
        ("map.png", "png", None),
        ("MAP.PNG", "png", None),
        ("photo.jpg", "jpeg", None),
        ("photo.jpeg", "jpeg", None),
        ("scan.tif", "tiff", None),
        ("scan.tiff", "tiff", None),
        ("photo.jpg", "png", "named .jpg but the bytes are PNG"),
        ("map.png", "jpeg", "named .png but the bytes are JPEG"),
        ("scan.png", "tiff", "named .png but the bytes are TIFF"),
        ("map", "png", "named without an extension but the bytes are PNG"),
    ],
)
def test_the_extension_note_says_when_the_name_and_the_bytes_disagree(name, kind, note):
    assert extension_note(name, kind) == note


def test_the_sniff_cap_is_five_thousand():
    assert SNIFF_CAP == 5000


@pytest.mark.parametrize("order", ["II", "MM"])
@pytest.mark.parametrize("orientation", [1, 3, 6, 8])
def test_the_orientation_is_read_in_either_byte_order(tmp_path, order, orientation):
    path = _file(tmp_path, exif_jpeg_header_bytes(40, 20, orientation, order))
    assert jpeg_orientation(path) == orientation
    assert image_size(path, "jpeg") == (40, 20)


def test_an_xmp_segment_before_the_exif_one_is_skipped(tmp_path):
    path = _file(tmp_path, exif_jpeg_header_bytes(40, 20, 6, before=xmp_segment()))
    assert jpeg_orientation(path) == 6


@pytest.mark.parametrize(
    "data",
    [
        jpeg_header_bytes(40, 20),
        jpeg_header_bytes(40, 20, app1=True),
        png_bytes(4, 4),
        b"\xff\xd8",
        b"",
    ],
)
def test_no_exif_orientation_is_none(tmp_path, data):
    assert jpeg_orientation(_file(tmp_path, data)) is None


def test_a_truncated_exif_segment_is_none_not_an_error(tmp_path):
    whole = exif_jpeg_header_bytes(40, 20, 6)
    app1_at = whole.index(b"Exif")
    for cut in range(app1_at - 4, app1_at + 40):
        assert jpeg_orientation(_file(tmp_path, whole[:cut])) is None, cut


def test_an_orientation_entry_past_the_read_limit_is_none(tmp_path):
    padding = b"\xff\xe2" + (65533).to_bytes(2, "big") + bytes(65531)
    path = _file(tmp_path, exif_jpeg_header_bytes(40, 20, 6, before=padding))
    assert jpeg_orientation(path) is None


def test_the_orientation_note_names_the_flag():
    assert orientation_note(None) is None
    assert orientation_note(1) is None
    assert orientation_note(6) == (
        "the file's rotation flag (EXIF orientation 6) is ignored; "
        "the image is placed as stored, which is what the world file describes"
    )
