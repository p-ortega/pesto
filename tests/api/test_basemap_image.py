"""Image sniffing, the pure-Python header size read and the pixel budget
(D-17, D-22, D-34)."""

from __future__ import annotations

import pytest

from pesto.basemap.imageinfo import (
    PIXEL_BUDGET,
    TIFF_REASON,
    ImageRefusal,
    check_budget,
    format_refusal,
    image_size,
    sniff,
)

from .basemap_images import jpeg_header_bytes, png_bytes, tiff_bytes


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
