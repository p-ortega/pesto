"""Pillow's part of the basemap (D-22): a second read of the image size, and
one shrunk PNG copy in the home store when the image is larger than the
graphics card can hold.

Pillow is imported inside each function, never at module scope, so launching
pesto does not wait on it. Pillow opens only PNG and JPEG here, and its
process-wide bomb limit is never changed; pesto's own pixel budget is applied
to the size Pillow reads.
"""

from __future__ import annotations

import io
from pathlib import Path

from pesto.basemap.imageinfo import ImageRefusal, check_budget, image_size
from pesto.cache._atomic import write_atomic_bytes

_FORMATS = {"png": ["PNG"], "jpeg": ["JPEG"]}
_LABELS = {"png": "PNG", "jpeg": "JPEG"}
_SIXTEEN_BIT = {"I", "I;16", "I;16B", "I;16L", "I;16N"}


def _open(f, kind: str):
    """Pillow's lazy, header-only open of an already open file, with every
    failure turned into an ImageRefusal."""
    from PIL import Image, UnidentifiedImageError

    formats = _FORMATS.get(kind)
    if formats is None:
        raise ImageRefusal("format", f"only PNG and JPEG images can be read, not {kind}")
    try:
        return Image.open(f, formats=formats)
    except Image.DecompressionBombError:
        raise ImageRefusal("too_large", "Pillow refused the image as far too large to open safely") from None
    except UnidentifiedImageError:
        # Pillow's own message quotes the file object, path and all.
        raise ImageRefusal("format", f"Pillow cannot read this file as a {_LABELS[kind]} image") from None
    except MemoryError:
        raise
    except Exception as exc:
        raise ImageRefusal("header", f"Pillow cannot read the image header: {exc}") from None


def pillow_size(path: Path, kind: str) -> tuple[int, int]:
    """``(width, height)`` as Pillow reads it from the header, checked against
    pesto's pixel budget. Raises ImageRefusal for an image Pillow will not
    open, and OSError when the file itself cannot be read."""
    with open(path, "rb") as f:
        with _open(f, kind) as im:
            width, height = im.size
    check_budget(width, height)
    return width, height


def _eight_bit_grey(im):
    """A 16-bit grey image as 8-bit grey, scaled, since Pillow's own convert clips everything above 255 to white."""
    import numpy as np
    from PIL import Image

    values = np.clip(np.asarray(im, dtype=np.int64), 0, 65535)
    grey = (values >> 8).astype(np.uint8)
    key = im.info.get("transparency")
    if isinstance(key, int):
        alpha = np.where(values == key, 0, 255).astype(np.uint8)
        return Image.fromarray(np.dstack([grey, alpha]), "LA")
    return Image.fromarray(grey, "L")


def _shrunk(im, target: int):
    from PIL import Image

    if im.mode in _SIXTEEN_BIT:
        im = _eight_bit_grey(im)
    elif im.mode in ("1", "P", "PA"):
        # Pillow resamples these by nearest neighbour only, so expand them first.
        im = im.convert("RGBA" if im.has_transparency_data else "RGB")
    im.thumbnail((target, target), Image.Resampling.LANCZOS)
    mode = "RGBA" if im.has_transparency_data else "RGB"
    return im if im.mode == mode else im.convert(mode)


def _reusable(path: Path, target: int) -> tuple[int, int] | None:
    if path.is_symlink() or not path.is_file():
        return None
    try:
        width, height = image_size(path, "png")
    except (ImageRefusal, OSError):
        return None
    return (width, height) if max(width, height) == target else None


def shrink_copy(path: Path, record: dict, target: int, dest_dir: Path) -> tuple[Path, int, int]:
    """A PNG copy of the registered image whose longest side is ``target``,
    kept aspect, written once to ``dest_dir`` as ``image_<tag>_<target>.png``
    and reused after. Returns the copy's path and size.

    Raises ImageRefusal when Pillow cannot read or decode the image, or reads
    another size than the record holds, and OSError when the image cannot be
    read or the copy cannot be written.
    """
    out = dest_dir / f"image_{record['tag']}_{target}.png"
    reused = _reusable(out, target)
    if reused is not None:
        return out, reused[0], reused[1]

    width, height = record["width"], record["height"]
    buf = io.BytesIO()
    with open(path, "rb") as f:
        with _open(f, record["format"]) as im:
            if im.size != (width, height):
                raise ImageRefusal(
                    "header",
                    f"Pillow reads the image as {im.size[0]} × {im.size[1]} pixels "
                    f"but it was registered as {width} × {height}",
                )
            try:
                small = _shrunk(im, target)
                small.save(buf, "PNG")
            except MemoryError:
                raise
            except Exception as exc:
                raise ImageRefusal("header", f"the image could not be decoded: {exc}") from None
    data = buf.getvalue()
    dest_dir.mkdir(parents=True, exist_ok=True)
    write_atomic_bytes(out, lambda tmp: tmp.write(data))
    return out, small.width, small.height
