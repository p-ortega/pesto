"""The server-side shrink (D-22, answer a at the 12-03 checkpoint): Pillow's
second read of the size, and the one PNG copy made in the home store when an
image is wider than the graphics card can hold. Every image is built by the
test in tmp_path, and HOME points into tmp_path."""

from __future__ import annotations

import io
import json
import os
import struct
import zlib
from pathlib import Path

import pytest
from PIL import Image

from pesto.basemap.imageinfo import ImageRefusal
from pesto.basemap.shrink import pillow_size, shrink_copy
from pesto.basemap.store import basemap_dir

from .basemap_images import exif_jpeg_header_bytes, jpeg_header_bytes, with_scan
from .test_basemap_routes import Opened, assert_no_path_leaked, open_run, put_world_file
from .test_basemap_store import snapshot


def _save(image: Image.Image, path: Path, fmt: str, **kw) -> Path:
    image.save(path, fmt, **kw)
    return path


def _record(kind: str, width: int, height: int, tag: str = "abc123") -> dict:
    return {"format": kind, "width": width, "height": height, "tag": tag}


@pytest.fixture
def store_dir(tmp_path, monkeypatch) -> Path:
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    folder = basemap_dir(run_dir)
    folder.mkdir(parents=True)
    return folder


def _claims_ihdr(data: bytes, width: int, height: int) -> bytes:
    """``data`` with its IHDR rewritten to claim another size, CRC fixed, so only the size lies."""
    body = b"IHDR" + struct.pack(">II", width, height) + data[24:29]
    return data[:12] + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF) + data[33:]


# ---------------------------------------------------------------------------
# pillow_size
# ---------------------------------------------------------------------------


def test_pillow_reads_the_size_of_a_png_and_a_jpeg(tmp_path):
    png = _save(Image.new("RGB", (300, 20), "red"), tmp_path / "a.png", "PNG")
    jpeg = _save(Image.new("RGB", (64, 48), "blue"), tmp_path / "b.jpg", "JPEG")
    assert pillow_size(png, "png") == (300, 20)
    assert pillow_size(jpeg, "jpeg") == (64, 48)


def test_a_tiff_is_refused_as_format_whatever_it_is_called(tmp_path):
    tiff = _save(Image.new("RGB", (10, 10)), tmp_path / "scan.png", "TIFF")
    for kind in ("png", "jpeg", "tiff"):
        with pytest.raises(ImageRefusal) as caught:
            pillow_size(tiff, kind)
        assert caught.value.code == "format"
        assert str(tmp_path) not in caught.value.reason


def test_a_jpeg_read_as_png_is_refused_as_format(tmp_path):
    jpeg = _save(Image.new("RGB", (10, 10)), tmp_path / "photo.png", "JPEG")
    with pytest.raises(ImageRefusal) as caught:
        pillow_size(jpeg, "png")
    assert caught.value.code == "format"


def test_a_png_that_claims_a_huge_size_is_too_large_not_an_exception(tmp_path):
    buf = io.BytesIO()
    Image.new("L", (4, 4)).save(buf, "PNG")
    path = tmp_path / "bomb.png"
    path.write_bytes(_claims_ihdr(buf.getvalue(), 30000, 30000))
    with pytest.raises(ImageRefusal) as caught:
        pillow_size(path, "png")
    assert caught.value.code == "too_large"


def test_a_png_just_over_pesto_budget_is_too_large_even_where_pillow_only_warns(tmp_path):
    buf = io.BytesIO()
    Image.new("L", (4, 4)).save(buf, "PNG")
    path = tmp_path / "big.png"
    path.write_bytes(_claims_ihdr(buf.getvalue(), 10000, 9000))
    with pytest.warns(Image.DecompressionBombWarning), pytest.raises(ImageRefusal) as caught:
        pillow_size(path, "png")
    assert caught.value.code == "too_large"
    assert "90,000,000 pixels" in caught.value.reason


def test_a_cut_png_is_refused_as_header(tmp_path):
    buf = io.BytesIO()
    Image.new("L", (4, 4)).save(buf, "PNG")
    path = tmp_path / "cut.png"
    path.write_bytes(buf.getvalue()[:30])
    with pytest.raises(ImageRefusal) as caught:
        pillow_size(path, "png")
    assert caught.value.code in ("header", "format")


def test_a_missing_file_is_an_os_error_not_a_refusal(tmp_path):
    with pytest.raises(FileNotFoundError):
        pillow_size(tmp_path / "gone.png", "png")


# ---------------------------------------------------------------------------
# shrink_copy
# ---------------------------------------------------------------------------


def test_a_wide_png_is_shrunk_once_into_the_store_and_reused(tmp_path, store_dir):
    source = _save(Image.new("RGB", (3000, 40), "green"), tmp_path / "wide.png", "PNG")

    path, width, height = shrink_copy(source, _record("png", 3000, 40), 1024, store_dir)

    assert path == store_dir / "image_abc123_1024.png"
    assert (width, height) == (1024, 14)
    with Image.open(path) as copy:
        assert copy.format == "PNG"
        assert copy.size == (1024, 14)
    first = path.stat()

    again = shrink_copy(source, _record("png", 3000, 40), 1024, store_dir)

    assert again == (path, 1024, 14)
    assert (path.stat().st_mtime_ns, path.stat().st_ino) == (first.st_mtime_ns, first.st_ino)
    assert sorted(p.name for p in store_dir.iterdir()) == ["image_abc123_1024.png"]


def test_another_target_or_tag_is_another_copy(tmp_path, store_dir):
    source = _save(Image.new("RGB", (3000, 40)), tmp_path / "wide.png", "PNG")
    shrink_copy(source, _record("png", 3000, 40), 1024, store_dir)
    shrink_copy(source, _record("png", 3000, 40), 512, store_dir)
    shrink_copy(source, _record("png", 3000, 40, tag="def456"), 1024, store_dir)
    assert sorted(p.name for p in store_dir.iterdir()) == [
        "image_abc123_1024.png",
        "image_abc123_512.png",
        "image_def456_1024.png",
    ]


def test_a_tall_jpeg_keeps_its_aspect(tmp_path, store_dir):
    source = _save(Image.new("RGB", (40, 3000), "white"), tmp_path / "tall.jpg", "JPEG")
    _path, width, height = shrink_copy(source, _record("jpeg", 40, 3000), 1024, store_dir)
    assert (width, height) == (14, 1024)


def test_a_cmyk_jpeg_comes_out_as_an_rgb_png(tmp_path, store_dir):
    source = _save(Image.new("CMYK", (2000, 100), (0, 255, 255, 0)), tmp_path / "print.jpg", "JPEG")
    path, _w, _h = shrink_copy(source, _record("jpeg", 2000, 100), 512, store_dir)
    with Image.open(path) as copy:
        assert (copy.format, copy.mode, copy.size) == ("PNG", "RGB", (512, 26))
        red, green, blue = copy.convert("RGB").getpixel((10, 10))
        assert red > 200 and green < 60 and blue < 60


def test_a_palette_png_with_transparency_comes_out_as_rgba(tmp_path, store_dir):
    image = Image.new("P", (2000, 100), 1)
    image.putpalette([0, 0, 0, 255, 0, 0] + [0] * 762)
    image.paste(0, (0, 0, 1000, 100))
    source = _save(image, tmp_path / "pal.png", "PNG", transparency=0)
    path, _w, _h = shrink_copy(source, _record("png", 2000, 100), 512, store_dir)
    with Image.open(path) as copy:
        assert copy.mode == "RGBA"
        assert copy.getpixel((10, 10))[3] == 0
        assert copy.getpixel((500, 10)) == (255, 0, 0, 255)


def test_a_palette_png_without_transparency_comes_out_as_rgb(tmp_path, store_dir):
    image = Image.new("P", (2000, 100), 1)
    image.putpalette([0, 0, 0, 0, 0, 255] + [0] * 762)
    source = _save(image, tmp_path / "pal.png", "PNG")
    path, _w, _h = shrink_copy(source, _record("png", 2000, 100), 512, store_dir)
    with Image.open(path) as copy:
        assert copy.mode == "RGB"
        assert copy.getpixel((10, 10)) == (0, 0, 255)


def test_a_sixteen_bit_grey_png_is_scaled_to_eight_bits_not_clipped_white(tmp_path, store_dir):
    source = _save(Image.new("I;16", (2000, 100), 32768), tmp_path / "dem.png", "PNG")
    path, _w, _h = shrink_copy(source, _record("png", 2000, 100), 512, store_dir)
    with Image.open(path) as copy:
        assert copy.mode == "RGB"
        assert copy.getpixel((10, 10)) == (128, 128, 128)


def test_a_size_that_disagrees_with_the_record_is_refused_naming_both(tmp_path, store_dir):
    source = _save(Image.new("RGB", (3000, 40)), tmp_path / "wide.png", "PNG")
    with pytest.raises(ImageRefusal) as caught:
        shrink_copy(source, _record("png", 3000, 41), 1024, store_dir)
    assert caught.value.code == "header"
    assert "3000 × 40" in caught.value.reason and "3000 × 41" in caught.value.reason
    assert list(store_dir.iterdir()) == []


def test_a_png_whose_pixels_are_cut_is_refused_and_leaves_no_copy(tmp_path, store_dir):
    buf = io.BytesIO()
    Image.effect_noise((3000, 40), 64).save(buf, "PNG")
    source = tmp_path / "cut.png"
    source.write_bytes(buf.getvalue()[: len(buf.getvalue()) // 2])
    with pytest.raises(ImageRefusal) as caught:
        shrink_copy(source, _record("png", 3000, 40), 1024, store_dir)
    assert caught.value.code == "header"
    assert str(tmp_path) not in caught.value.reason
    assert list(store_dir.iterdir()) == []


def test_a_link_where_the_copy_goes_is_replaced_never_served(tmp_path, store_dir):
    source = _save(Image.new("RGB", (3000, 40)), tmp_path / "wide.png", "PNG")
    elsewhere = _save(Image.new("RGB", (1024, 14)), tmp_path / "elsewhere.png", "PNG")
    before = elsewhere.read_bytes()
    (store_dir / "image_abc123_1024.png").symlink_to(elsewhere)

    path, _w, _h = shrink_copy(source, _record("png", 3000, 40), 1024, store_dir)

    assert not path.is_symlink()
    assert elsewhere.read_bytes() == before


def test_a_damaged_copy_is_made_again(tmp_path, store_dir):
    source = _save(Image.new("RGB", (3000, 40)), tmp_path / "wide.png", "PNG")
    (store_dir / "image_abc123_1024.png").write_bytes(b"not a png")
    path, width, height = shrink_copy(source, _record("png", 3000, 40), 1024, store_dir)
    assert (width, height) == (1024, 14)
    with Image.open(path) as copy:
        assert copy.size == (1024, 14)


def test_pillow_global_bomb_limit_is_left_alone(tmp_path, store_dir):
    before = Image.MAX_IMAGE_PIXELS
    source = _save(Image.new("RGB", (3000, 40)), tmp_path / "wide.png", "PNG")
    pillow_size(source, "png")
    shrink_copy(source, _record("png", 3000, 40), 1024, store_dir)
    assert Image.MAX_IMAGE_PIXELS == before


# ---------------------------------------------------------------------------
# The image route and inspect
# ---------------------------------------------------------------------------

@pytest.fixture
def opened(tmp_path, monkeypatch) -> Opened:
    return open_run(tmp_path, monkeypatch)


def _register(opened: Opened, name: str) -> dict:
    file_id = opened.file_id(name)
    inspected = opened.post("/api/run/basemap/inspect", json={"id": file_id})
    assert inspected.status_code == 200, inspected.text
    stamp = inspected.json()["stamp"]
    state = opened.post("/api/run/basemap", json={"id": file_id, "stamp": stamp, "by": "world_file"})
    assert state.status_code == 200, state.text
    return state.json()


def _wide(opened: Opened, name: str = "wide.png", fmt: str = "PNG", size=(3000, 40)) -> Path:
    path = _save(Image.new("RGB", size, "green"), opened.images / name, fmt)
    put_world_file(opened.images, Path(name).stem + (".pgw" if fmt == "PNG" else ".jgw"), a=0.01, e=-0.01, c=1000.0, f=2001.0)
    return path


def _meta(response) -> dict:
    return json.loads(response.headers["x-pesto-meta"])


def _store(opened: Opened) -> Path:
    return basemap_dir(opened.run_dir)


def test_a_wide_png_is_served_as_a_shrunk_copy_with_a_note_and_the_copy_is_reused(opened):
    _wide(opened)
    state = _register(opened, "wide.png")

    served = opened.get("/api/run/basemap/image", params={"max": 1024})

    assert served.status_code == 200, served.text
    assert served.headers["content-type"] == "image/png"
    with Image.open(io.BytesIO(served.content)) as image:
        assert (image.format, image.size) == ("PNG", (1024, 14))
    meta = _meta(served)
    assert meta["resize_to"] is None
    assert (meta["width"], meta["height"]) == (3000, 40)
    assert (meta["served_width"], meta["served_height"]) == (1024, 14)
    assert meta["format"] == "png"
    assert meta["tag"] == state["tag"]
    assert "pesto shrank the image from 3000 × 40 to 1024 × 14 pixels to fit the graphics card" in meta["notes"]
    copy = _store(opened) / f"image_{state['tag']}_1024.png"
    first = copy.stat()

    again = opened.get("/api/run/basemap/image", params={"max": 1024})

    assert again.content == served.content
    assert (copy.stat().st_mtime_ns, copy.stat().st_ino) == (first.st_mtime_ns, first.st_ino)
    assert_no_path_leaked(opened)


def test_an_image_that_fits_is_served_as_its_own_bytes(opened):
    source = _wide(opened)
    _register(opened, "wide.png")

    served = opened.get("/api/run/basemap/image", params={"max": 4096})

    assert served.content == source.read_bytes()
    meta = _meta(served)
    assert meta["resize_to"] is None
    assert (meta["served_width"], meta["served_height"]) == (3000, 40)
    assert not any("shrank" in n for n in meta["notes"])
    assert not list(_store(opened).glob("image_*.png"))


def test_the_target_is_never_above_the_texture_cap(opened):
    _wide(opened, size=(9000, 30))
    _register(opened, "wide.png")
    meta = _meta(opened.get("/api/run/basemap/image", params={"max": 16384}))
    assert (meta["served_width"], meta["served_height"]) == (8192, 27)


def test_a_wide_jpeg_is_served_as_a_png_copy(opened):
    _wide(opened, "wide.jpg", "JPEG")
    _register(opened, "wide.jpg")
    served = opened.get("/api/run/basemap/image", params={"max": 512})
    assert served.headers["content-type"] == "image/png"
    assert _meta(served)["format"] == "png"
    with Image.open(io.BytesIO(served.content)) as image:
        assert (image.format, image.size) == ("PNG", (512, 7))


def test_a_shrink_that_fails_answers_a_problem_naming_the_reason(opened):
    buf = io.BytesIO()
    Image.effect_noise((3000, 40), 64).save(buf, "PNG")
    path = opened.images / "wide.png"
    path.write_bytes(buf.getvalue())
    put_world_file(opened.images, "wide.pgw", a=0.01, e=-0.01, c=1000.0, f=2001.0)
    _register(opened, "wide.png")
    # Cut the pixels but keep the size and time the record holds, so only the decode can catch it.
    st = path.stat()
    data = path.read_bytes()
    path.write_bytes(data[: len(data) // 2] + bytes(len(data) - len(data) // 2))
    os.utime(path, ns=(st.st_atime_ns, st.st_mtime_ns))

    served = opened.get("/api/run/basemap/image", params={"max": 1024})

    assert served.status_code == 422
    assert served.headers["content-type"] == "application/problem+json"
    assert served.json()["code"] == "header"
    assert served.json()["title"].startswith("the image could not be decoded")
    assert not list(_store(opened).glob("image_*.png"))
    assert_no_path_leaked(opened)


def test_the_image_route_refuses_to_shrink_into_a_store_inside_the_cache_root(opened, tmp_path):
    _wide(opened)
    _register(opened, "wide.png")
    opened.client.app.state.cache_root = str(tmp_path)
    before = snapshot(_store(opened))

    served = opened.get("/api/run/basemap/image", params={"max": 1024})

    assert served.status_code == 409
    assert served.json()["code"] == "store_inside_run"
    assert snapshot(_store(opened)) == before


def test_inspect_refuses_a_jpeg_whose_two_size_reads_disagree_naming_both(opened):
    (opened.images / "two.jpg").write_bytes(with_scan(jpeg_header_bytes(40, 20), then_frame=(50, 30)))
    put_world_file(opened.images, "two.jgw", a=1.0, e=-1.0, c=1000.0, f=2000.0)

    response = opened.post("/api/run/basemap/inspect", json={"id": opened.file_id("two.jpg")})

    assert response.status_code == 422
    assert response.json()["code"] == "header"
    assert "40 × 20" in response.json()["title"] and "50 × 30" in response.json()["title"]


def test_inspect_refuses_a_jpeg_pillow_cannot_open(opened):
    (opened.images / "bare.jpg").write_bytes(exif_jpeg_header_bytes(40, 20, 1))
    put_world_file(opened.images, "bare.jgw", a=1.0, e=-1.0, c=1000.0, f=2000.0)

    response = opened.post("/api/run/basemap/inspect", json={"id": opened.file_id("bare.jpg")})

    assert response.status_code == 422
    assert response.json()["code"] == "format"
    assert response.json()["title"] == "Pillow cannot read this file as a JPEG image"
    assert_no_path_leaked(opened)


def test_shrinking_and_removing_touch_nothing_but_the_store(opened, tmp_path):
    _wide(opened)
    guarded = (opened.run_dir, opened.cache_root, opened.images)
    before = [snapshot(f) for f in guarded]
    state = _register(opened, "wide.png")

    assert opened.get("/api/run/basemap/image", params={"max": 1024}).status_code == 200
    assert opened.get("/api/run/basemap/image", params={"max": 512}).status_code == 200
    assert sorted(p.name for p in _store(opened).iterdir()) == [
        "basemap.json",
        f"image_{state['tag']}_1024.png",
        f"image_{state['tag']}_512.png",
    ]
    assert [snapshot(f) for f in guarded] == before

    assert opened.post("/api/run/basemap/remove").json() == {"status": "none"}

    assert list(_store(opened).iterdir()) == []
    assert [snapshot(f) for f in guarded] == before
    assert_no_path_leaked(opened)


@pytest.mark.parametrize(
    "requested, expected",
    [(-5, 512), (0, 512), (511, 512), (512, 512), (1023, 512), (1500, 1024), (4096, 4096), (5000, 4096), (16384, 8192)],
)
def test_the_serve_limit_snaps_down_to_a_fixed_step(requested, expected):
    from pesto.api.basemap import _serve_limit

    assert _serve_limit(requested) == expected


def test_many_different_max_values_make_only_a_few_copies(opened):
    _wide(opened, size=(9000, 30))
    _register(opened, "wide.png")
    for requested in range(600, 8000, 250):
        assert opened.get("/api/run/basemap/image", params={"max": requested}).status_code == 200
    assert len(list(_store(opened).glob("image_*.png"))) <= 4


def test_registering_again_clears_the_copies_of_the_old_tag_and_keeps_the_new_ones(opened):
    _wide(opened)
    first = _register(opened, "wide.png")
    assert opened.get("/api/run/basemap/image", params={"max": 1024}).status_code == 200
    old_copy = _store(opened) / f"image_{first['tag']}_1024.png"
    assert old_copy.exists()
    (_store(opened) / "keep.txt").write_text("not pesto's to delete")

    put_world_file(opened.images, "wide.pgw", a=0.01, e=-0.01, c=1001.0, f=2001.0)
    second = _register(opened, "wide.png")

    assert second["tag"] != first["tag"]
    assert not old_copy.exists()
    assert sorted(p.name for p in _store(opened).iterdir()) == ["basemap.json", "keep.txt"]


def test_remove_also_clears_a_temp_file_a_crashed_write_left_and_leaves_the_rest(opened):
    _wide(opened)
    _register(opened, "wide.png")
    (_store(opened) / ".ingest-abc123.tmp").write_bytes(b"half a write")
    (_store(opened) / "keep.txt").write_text("not pesto's to delete")

    assert opened.post("/api/run/basemap/remove").json() == {"status": "none"}

    assert [p.name for p in _store(opened).iterdir()] == ["keep.txt"]
