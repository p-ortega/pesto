"""World files: finding the one beside an image, reading its six numbers,
and turning them into the image's outer corners (D-18, D-19).

Lines are A, D, B, E, C, F. C and F are the centre of the top-left pixel, so
the outer corner sits half a pixel further out.
"""

from __future__ import annotations

import os
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


def _candidate_extensions(image_name: str) -> set[str]:
    suffix = Path(image_name).suffix.lower().lstrip(".")
    found = {"wld"}
    if suffix:
        found.add(suffix + "w")
        if len(suffix) >= 2:
            found.add(suffix[0] + suffix[-1] + "w")
    return found


def find_world_files(image_path: Path) -> list[str]:
    """Names of the files beside ``image_path`` that could be its world file,
    sorted. Several are returned as they are; the caller never picks one."""
    image_path = Path(image_path)
    stem = image_path.stem.lower() if image_path.suffix else image_path.name.lower()
    wanted = {f"{stem}.{ext}" for ext in _candidate_extensions(image_path.name)}
    try:
        with os.scandir(image_path.parent) as it:
            return sorted(e.name for e in it if e.name.lower() in wanted and e.is_file())
    except OSError as exc:
        raise WorldFileRefusal(
            None, f"the image's folder could not be searched for a world file: {exc.strerror}"
        ) from exc


def parse_world_file(path: Path) -> WorldFile:
    path = Path(path)
    try:
        text = path.read_text(encoding="utf-8-sig")
    except OSError as exc:
        raise WorldFileRefusal(
            None, f"the world file {path.name} could not be read: {exc.strerror}"
        ) from exc
    except UnicodeDecodeError:
        raise WorldFileRefusal(None, f"the world file {path.name} is not UTF-8 text") from None
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if len(lines) != 6:
        raise WorldFileRefusal(None, f"the world file {path.name} has {len(lines)} lines, expected 6")
    values = []
    for number, line in enumerate(lines, start=1):
        try:
            values.append(float(line))
        except ValueError:
            raise WorldFileRefusal(number, f"line {number} of {path.name} is not a plain number") from None
    return WorldFile(*values)


def corners(wf: WorldFile, width: int, height: int) -> tuple[float, float, float, float]:
    """``(xmin, xmax, ymin, ymax)`` of the image's outer edge."""
    if wf.d != 0.0 or wf.b != 0.0:
        raise WorldFileRefusal(None, ROTATED_REASON, code="rotated")
    if wf.a <= 0.0 or wf.e >= 0.0:
        raise WorldFileRefusal(None, MIRRORED_REASON, code="mirrored")
    xmin = wf.c - wf.a / 2.0
    ymax = wf.f - wf.e / 2.0
    return (xmin, xmin + wf.a * width, ymax + wf.e * height, ymax)
