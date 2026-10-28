"""World files: finding the one beside an image, reading its six numbers,
and turning them into the image's outer corners (D-18, D-19).

Lines are A, D, B, E, C, F. C and F are the centre of the top-left pixel, so
the outer corner sits half a pixel further out.
"""

from __future__ import annotations

import math
import os
import re
from dataclasses import dataclass
from pathlib import Path

ROTATED_REASON = "rotated images are not supported"
MIRRORED_REASON = (
    "mirrored or flipped images are not supported: line 1 must be positive and line 4 negative"
)


@dataclass(frozen=True)
class WorldFile:
    a: float
    d: float
    b: float
    e: float
    c: float
    f: float


class WorldFileRefusal(Exception):
    """A world file pesto cannot use. ``line`` is 1-based, or None when the
    problem is not one line's; ``code`` is "malformed", "rotated" or "mirrored"."""

    def __init__(self, line: int | None, reason: str, *, code: str = "malformed") -> None:
        super().__init__(reason)
        self.line = line
        self.reason = reason
        self.code = code


# The names D-18 lists for each sniffed kind, on top of those built from the image's own extension.
_KIND_EXTENSIONS = {"png": {"pgw", "pngw"}, "jpeg": {"jgw", "jpgw", "jpegw"}}

MAX_BYTES = 4096

# float() would also take nan, inf, 1_0 and hex-like text, so only a plain decimal or exponent passes.
_PLAIN_NUMBER = re.compile(r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?")


def _candidate_extensions(image_name: str, kind: str | None) -> set[str]:
    suffix = Path(image_name).suffix.lower().lstrip(".")
    found = {"wld"} | _KIND_EXTENSIONS.get(kind or "", set())
    if suffix:
        found.add(suffix + "w")
        if len(suffix) >= 2:
            found.add(suffix[0] + suffix[-1] + "w")
    return found


def find_world_files(image_path: Path, kind: str | None = None) -> list[str]:
    """Names of the files beside ``image_path`` that could be its world file,
    compared case-insensitively and sorted. Several are returned as they are;
    the caller never picks one."""
    image_path = Path(image_path)
    stem = image_path.stem.lower() if image_path.suffix else image_path.name.lower()
    wanted = {f"{stem}.{ext}" for ext in _candidate_extensions(image_path.name, kind)}
    try:
        with os.scandir(image_path.parent) as it:
            return sorted(e.name for e in it if e.name.lower() in wanted and e.is_file())
    except OSError as exc:
        raise WorldFileRefusal(
            None, f"the image's folder could not be searched for a world file: {exc.strerror}"
        ) from exc


def _number(text: str, line: int, name: str) -> float:
    if not _PLAIN_NUMBER.fullmatch(text):
        if _PLAIN_NUMBER.fullmatch(text.replace(",", ".", 1)):
            raise WorldFileRefusal(line, f"line {line} of {name} uses a decimal comma, not a plain number")
        raise WorldFileRefusal(line, f"line {line} of {name} is not a plain number")
    value = float(text)
    if not math.isfinite(value):
        raise WorldFileRefusal(line, f"line {line} of {name} is too large to be a finite number")
    return value


def parse_world_file(path: Path) -> WorldFile:
    """Six plain numbers, one per line. Every refusal names the file, and the
    line when one line is to blame."""
    path = Path(path)
    name = path.name
    try:
        with open(path, "rb") as f:
            data = f.read(MAX_BYTES + 1)
    except OSError as exc:
        raise WorldFileRefusal(None, f"the world file {name} could not be read: {exc.strerror}") from exc
    if len(data) > MAX_BYTES:
        raise WorldFileRefusal(None, f"the world file {name} is larger than {MAX_BYTES} bytes")
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise WorldFileRefusal(None, f"the world file {name} is not UTF-8 text") from None

    lines = [line.strip() for line in text.splitlines()]
    while lines and not lines[-1]:
        lines.pop()
    for number, line in enumerate(lines, start=1):
        if not line:
            raise WorldFileRefusal(number, f"line {number} of {name} is empty")
    if len(lines) != 6:
        raise WorldFileRefusal(None, f"the world file {name} has {len(lines)} lines, expected 6")
    return WorldFile(*(_number(line, number, name) for number, line in enumerate(lines, start=1)))


def corners(wf: WorldFile, width: int, height: int) -> tuple[float, float, float, float]:
    """``(xmin, xmax, ymin, ymax)`` of the image's outer edge."""
    if wf.d != 0.0 or wf.b != 0.0:
        raise WorldFileRefusal(None, ROTATED_REASON, code="rotated")
    if wf.a <= 0.0 or wf.e >= 0.0:
        raise WorldFileRefusal(None, MIRRORED_REASON, code="mirrored")
    xmin = wf.c - wf.a / 2.0
    ymax = wf.f - wf.e / 2.0
    return (xmin, xmin + wf.a * width, ymax + wf.e * height, ymax)
