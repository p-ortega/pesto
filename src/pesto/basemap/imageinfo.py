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
# Files a folder listing opens to sniff before it stops and counts the rest as not checked (D-33).
SNIFF_CAP = 5000
_ORIENTATION_READ = 64 * 1024

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
    suffix = Path(name).suffix
    if suffix.lower() in _EXTENSIONS.get(kind, set()):
        return None
    shown = suffix or "without an extension"
    return f"named {shown} but the bytes are {_LABELS[kind]}"


def _exif_orientation(payload: bytes) -> int | None:
    tiff = payload[6:]
    if tiff[:2] == b"II":
        end = "<"
    elif tiff[:2] == b"MM":
        end = ">"
    else:
        return None
    if len(tiff) < 8 or struct.unpack(end + "H", tiff[2:4])[0] != 42:
        return None
    ifd = struct.unpack(end + "I", tiff[4:8])[0]
    if ifd + 2 > len(tiff):
        return None
    count = struct.unpack(end + "H", tiff[ifd : ifd + 2])[0]
    for i in range(count):
        at = ifd + 2 + 12 * i
        entry = tiff[at : at + 12]
        if len(entry) < 12:
            return None
        tag, kind = struct.unpack(end + "HH", entry[:4])
        # Orientation is a SHORT (type 3), held in the first two bytes of the value field.
        if tag == 0x0112 and kind == 3:
            return int(struct.unpack(end + "H", entry[8:10])[0])
    return None


def jpeg_orientation(path: Path) -> int | None:
    """The EXIF orientation of a JPEG, or None when it has none or the bytes
    run out. It only feeds a note, so it never refuses (D-36)."""
    with open(path, "rb") as f:
        data = f.read(_ORIENTATION_READ)
    if not data.startswith(b"\xff\xd8"):
        return None
    at = 2
    while at + 4 <= len(data):
        if data[at] != 0xFF:
            return None
        marker = data[at + 1]
        if marker == 0xFF:
            at += 1
            continue
        if marker == 0x01 or 0xD0 <= marker <= 0xD8:
            at += 2
            continue
        # APP1 always comes before the frame and the scan.
        if marker in (0xD9, 0xDA) or marker in _JPEG_SOF:
            return None
        length = struct.unpack(">H", data[at + 2 : at + 4])[0]
        end = at + 2 + length
        if length < 2 or end > len(data):
            return None
        payload = data[at + 4 : end]
        if marker == 0xE1 and payload.startswith(b"Exif\x00\x00"):
            return _exif_orientation(payload)
        at = end
    return None


def orientation_note(orientation: int | None) -> str | None:
    if orientation is None or orientation == 1:
        return None
    return (
        f"the file's rotation flag (EXIF orientation {orientation}) is ignored; "
        "the image is placed as stored, which is what the world file describes"
    )


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


def _other_format(head: bytes) -> str | None:
    if head[:6] in (b"GIF87a", b"GIF89a"):
        return "GIF"
    # "BM" alone is too common in text; a real BMP header has four reserved zero bytes after the size.
    if head[:2] == b"BM" and head[6:10] == b"\x00\x00\x00\x00":
        return "BMP"
    if head[:5] == b"%PDF-":
        return "PDF"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "WebP"
    if head[:4] in (b"PK\x03\x04", b"PK\x05\x06"):
        return "ZIP"
    return None


def format_refusal(head: bytes) -> str:
    """The refusal for bytes that are neither PNG, JPEG nor TIFF, naming what they are when known."""
    found = _other_format(head)
    if found is None:
        what = "the file holds bytes that match no PNG, JPEG or TIFF signature"
    else:
        what = f"the file is a {found} file"
    return f"{what}; only PNG and JPEG basemaps are supported"
