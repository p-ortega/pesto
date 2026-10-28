"""What an image file is and how many pixels it holds, read from its first
bytes in pure Python, so nothing is decoded before the size is known.

The file type comes from the bytes, never the extension (D-17). The size
comes from the PNG IHDR chunk or the JPEG start-of-frame segment, and an
image over the pixel budget is refused before anything could decode it
(D-22, D-34).
"""

from __future__ import annotations

import struct
from pathlib import Path

PIXEL_BUDGET = 89_478_485
TEXTURE_CAP = 8192
TIFF_REASON = "TIFF and GeoTIFF basemaps are not supported yet (planned for M2)"
SNIFF_BYTES = 16

_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
_JPEG_SIGNATURE = b"\xff\xd8\xff"
_TIFF_SIGNATURES = (b"II*\x00", b"MM\x00*", b"II+\x00", b"MM\x00+")

# Start-of-frame markers; C4, C8 and CC share the range but are not frames.
_JPEG_SOF = set(range(0xC0, 0xD0)) - {0xC4, 0xC8, 0xCC}

_LABELS = {"png": "PNG", "jpeg": "JPEG", "tiff": "TIFF"}
_EXTENSIONS = {
    "png": {".png"},
    "jpeg": {".jpg", ".jpeg", ".jpe", ".jfif"},
    "tiff": {".tif", ".tiff"},
}


class ImageRefusal(Exception):
    """An image pesto will not place, with a machine code and a reason a
    person can read."""

    def __init__(self, code: str, reason: str) -> None:
        super().__init__(reason)
        self.code = code
        self.reason = reason


def sniff(head: bytes) -> str:
    """``"png"``, ``"jpeg"``, ``"tiff"`` or ``"other"``, from the first bytes."""
    if head.startswith(_PNG_SIGNATURE):
        return "png"
    if head.startswith(_JPEG_SIGNATURE):
        return "jpeg"
    if head[:4] in _TIFF_SIGNATURES:
        return "tiff"
    return "other"


def read_head(path: Path) -> bytes:
    with open(path, "rb") as f:
        return f.read(SNIFF_BYTES)


def extension_note(name: str, kind: str) -> str | None:
    """A note when the file name's extension disagrees with its bytes (D-17)."""
    suffix = Path(name).suffix.lower()
    if suffix in _EXTENSIONS.get(kind, set()):
        return None
    shown = f"ends in {suffix}" if suffix else "has no extension"
    return f"the name {shown} but the bytes are {_LABELS[kind]}"


def _png_size(f) -> tuple[int, int]:
    data = f.read(24)
    if len(data) < 24 or data[:8] != _PNG_SIGNATURE or data[12:16] != b"IHDR":
        raise ImageRefusal("header", "the PNG header is cut short or has no IHDR chunk")
    width, height = struct.unpack(">II", data[16:24])
    return int(width), int(height)


def _jpeg_size(f) -> tuple[int, int]:
    f.seek(2)
    while True:
        byte = f.read(1)
        while byte and byte != b"\xff":
            byte = f.read(1)
        while byte == b"\xff":
            byte = f.read(1)
        if not byte:
            raise ImageRefusal("header", "the JPEG ends before its frame header")
        marker = byte[0]
        if marker == 0x01 or 0xD0 <= marker <= 0xD8:
            continue
        if marker in (0xD9, 0xDA):
            raise ImageRefusal("header", "the JPEG has no frame header before its image data")
        length_bytes = f.read(2)
        if len(length_bytes) < 2:
            raise ImageRefusal("header", "the JPEG ends inside a segment header")
        length = struct.unpack(">H", length_bytes)[0]
        if length < 2:
            raise ImageRefusal("header", "the JPEG has a segment with an impossible length")
        if marker in _JPEG_SOF:
            body = f.read(5)
            if len(body) < 5:
                raise ImageRefusal("header", "the JPEG frame header is cut short")
            height, width = struct.unpack(">HH", body[1:5])
            return int(width), int(height)
        f.seek(length - 2, 1)


def image_size(path: Path, kind: str) -> tuple[int, int]:
    """``(width, height)`` from the header alone. Raises ImageRefusal with
    code ``"header"`` when the header cannot be read."""
    reader = {"png": _png_size, "jpeg": _jpeg_size}.get(kind)
    if reader is None:
        raise ImageRefusal("format", f"only PNG and JPEG sizes can be read, not {kind}")
    with open(path, "rb") as f:
        return reader(f)


def check_budget(width: int, height: int) -> None:
    """Refuse an empty image, or one over PIXEL_BUDGET, naming both numbers."""
    if width <= 0 or height <= 0:
        raise ImageRefusal("header", f"the image header gives a size of {width} × {height} pixels")
    pixels = width * height
    if pixels > PIXEL_BUDGET:
        raise ImageRefusal(
            "too_large", f"the image has {pixels:,} pixels; the limit is {PIXEL_BUDGET:,}"
        )


def format_refusal(head: bytes) -> str:
    """The refusal for bytes that are neither PNG, JPEG nor TIFF."""
    return "the file holds bytes that match no PNG, JPEG or TIFF signature; only PNG and JPEG basemaps are supported"
