"""Decide whether the ensemble was reinflated between two iterations.

Three sources can say so: the run record, the file names in the run
directory, and the control file's reinflation setting. Each is listed by
name, in that order, and none is silently preferred. When no source can be
read the verdict is ``unchecked`` and says what was looked for.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from pesto.ingest.discover import RunLayout
from pesto.ingest.failures import ReadFailure
from pesto.ingest.recfile import RecFacts
from pesto.ingest.runopts import ControlOptions


@dataclass(frozen=True)
class ReinflationEvidence:
    source: Literal["run record", "files present", "control file"]
    iteration: int | None
    text: str
    in_range: bool | None


@dataclass(frozen=True)
class ReinflationVerdict:
    verdict: Literal["found", "none_found", "unchecked"]
    first: int
    last: int
    findings: tuple[tuple[int | None, tuple[ReinflationEvidence, ...]], ...]
    checked: tuple[str, ...]
    notes: tuple[str, ...]


def schedule_iterations(value_text: str, noptmax: int | None) -> tuple[int, ...]:
    return ()


def assess_reinflation(
    run: RunLayout,
    first: int,
    last: int,
    rec: RecFacts | ReadFailure | None,
    options: ControlOptions | ReadFailure | None,
) -> ReinflationVerdict:
    return ReinflationVerdict("unchecked", first, last, (), (), ())
