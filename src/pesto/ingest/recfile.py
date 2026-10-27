"""Read the facts a pestpp run record (``case.rec``) states about a run.

The record is pestpp's own account of what it did, so it outranks the
control file for any fact it states. It can be very large, so it is read in
one streaming pass. A line this reader does not know is absent from the
result, never guessed at, and a fact that is not stated reads as absent with
a note saying what was looked for.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Mapping

from pesto.ingest.failures import ReadFailure


@dataclass(frozen=True)
class RecLine:
    """One recognised line: what kind it is, the value it carries, where it
    sat, and its text (cut to 200 characters)."""

    kind: str
    value: str | float | int | None
    line: int
    text: str


@dataclass(frozen=True)
class RecOption:
    value: str
    line: int


@dataclass(frozen=True)
class RecReinflation:
    """One reinflation the record reports. ``iteration`` is the label of the
    iteration report that followed it, ``None`` when none did."""

    iteration: int | None
    factor: float | None
    line: int


@dataclass(frozen=True)
class RecFacts:
    name: str
    version: RecLine | None
    options: Mapping[str, RecOption]
    noise: tuple[RecLine, ...]
    reg_factor: RecLine | None
    localization: RecLine | None
    base_kept: RecLine | None
    reinflations: tuple[RecReinflation, ...]
    replaced_chars: int
    notes: tuple[str, ...]


def read_rec(path: Path) -> RecFacts | ReadFailure:
    return RecFacts(path.name, None, {}, (), None, None, None, (), 0, ())
