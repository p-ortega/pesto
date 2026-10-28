"""Pure-Python builders for the basemap tests' image, TIFF and world-file
bytes, so no test needs Pillow or any image on disk beforehand (D-27)."""

from __future__ import annotations

import struct
import zlib


def _chunk(kind: bytes, data: bytes) -> bytes:
    body = kind + data
    return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)


def png_bytes(width: int, height: int) -> bytes:
    """A real 8-bit greyscale PNG with IHDR, a zlib IDAT and IEND."""
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0)
    raw = b"".join(b"\x00" + bytes(width) for _ in range(height))
    return (
        b"\x89PNG\r\n\x1a\n"
        + _chunk(b"IHDR", ihdr)
        + _chunk(b"IDAT", zlib.compress(raw))
        + _chunk(b"IEND", b"")
    )


def _segment(marker: int, payload: bytes) -> bytes:
    return bytes([0xFF, marker]) + struct.pack(">H", len(payload) + 2) + payload


def jpeg_header_bytes(width: int, height: int, *, progressive: bool = False, app1: bool = False) -> bytes:
    """SOI, APP0, an optional APP1, SOF0 or SOF2 with the size, then EOI.
    Enough for a header read, not a decodable picture."""
    app0 = _segment(0xE0, b"JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00")
    exif = _segment(0xE1, b"Exif\x00\x00" + bytes(40)) if app1 else b""
    sof_body = struct.pack(">BHHB", 8, height, width, 3) + b"\x01\x22\x00\x02\x11\x01\x03\x11\x01"
    sof = _segment(0xC2 if progressive else 0xC0, sof_body)
    return b"\xff\xd8" + app0 + exif + sof + b"\xff\xd9"


def tiff_bytes(order: str = "II", big: bool = False) -> bytes:
    if order == "II":
        head = b"II+\x00" if big else b"II*\x00"
    else:
        head = b"MM\x00+" if big else b"MM\x00*"
    return head + bytes(12)


def world_file_text(a, d, b, e, c, f, newline: str = "\n") -> str:
    return newline.join(str(v) for v in (a, d, b, e, c, f)) + newline
