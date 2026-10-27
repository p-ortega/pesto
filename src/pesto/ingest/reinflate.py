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

_SETTING = "ies_n_iter_reinflate"
_SOURCE_ORDER = ("run record", "files present", "control file")


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


def _parse_schedule(value_text: str) -> list[int] | None:
    entries = []
    for token in value_text.split(","):
        token = token.strip()
        if not token:
            continue
        try:
            entries.append(int(token))
        except ValueError:
            return None
    return entries


def schedule_iterations(value_text: str, noptmax: int | None) -> tuple[int, ...]:
    """The iteration labels at which the setting reinflates the ensemble.

    The setting is a list of solve intervals. The k-th reinflation lands at
    ``S_k + k``, where ``S_k`` is the sum of the first k entries, because each
    reinflation takes an iteration label of its own. It counts only while
    ``S_k < noptmax``, since pestpp stops after ``noptmax`` solves. A zero
    entry turns it off and a negative entry counts by its size. Nothing is
    placed when ``noptmax`` is not known or the text is not a list of whole
    numbers.
    """
    entries = _parse_schedule(value_text)
    if noptmax is None or entries is None:
        return ()
    placed = []
    running = 0
    for k, entry in enumerate(entries, 1):
        if entry == 0:
            break
        running += abs(entry)
        if running >= noptmax:
            break
        placed.append(running + k)
    return tuple(placed)


def _in_range(iteration: int | None, first: int, last: int) -> bool | None:
    if iteration is None:
        return None
    return first < iteration <= last


def _record_evidence(rec: RecFacts, first: int, last: int) -> list[ReinflationEvidence]:
    found = []
    for item in rec.reinflations:
        factor = f" with factor {item.factor:g}" if item.factor is not None else ""
        if item.iteration is None:
            text = (
                f"{rec.name} line {item.line}: a reinflation{factor}, "
                f"but the iteration is not known"
            )
        else:
            text = f"{rec.name} line {item.line}: reinflation{factor} at iteration {item.iteration}"
        found.append(
            ReinflationEvidence("run record", item.iteration, text, _in_range(item.iteration, first, last))
        )
    return found


def _file_evidence(run: RunLayout, first: int, last: int) -> list[ReinflationEvidence]:
    found = []
    named = sorted(
        (key[0], path)
        for key, path in run.pcs.items()
        if key[1] == "reinflate" and isinstance(key[0], int)
    )
    for iteration, path in named:
        found.append(
            ReinflationEvidence(
                "files present",
                iteration,
                f"{path.name} is present and is labelled iteration {iteration}",
                _in_range(iteration, first, last),
            )
        )
    return found


def assess_reinflation(
    run: RunLayout,
    first: int,
    last: int,
    rec: RecFacts | ReadFailure | None,
    options: ControlOptions | ReadFailure | None,
) -> ReinflationVerdict:
    """Say whether the ensemble was reinflated between ``first`` and ``last``.

    ``first`` and ``last`` are the first and last parameter iterations the
    caller ingested. A reinflation labelled N is inside only when
    ``first < N <= last``; one outside is still listed. Evidence comes in the
    fixed order run record, files present, control-file setting, and sources
    naming the same iteration merge into one finding.

    The verdict is ``found`` when some finding is inside the range,
    ``none_found`` when at least one source was read and none placed a
    reinflation in range, and ``unchecked`` when no source could be read or
    the only evidence cannot be placed because its iteration is not known.
    """
    evidence: list[ReinflationEvidence] = []
    checked: list[str] = []
    notes: list[str] = []
    readable = False

    # Run record
    if rec is None:
        checked.append("run record: there is none in the run directory")
    elif isinstance(rec, ReadFailure):
        checked.append(f"run record: not read ({rec.reason})")
    else:
        understood = bool(
            rec.version or rec.options or rec.noise or rec.reg_factor
            or rec.localization or rec.base_kept or rec.reinflations
        )
        found = _record_evidence(rec, first, last)
        evidence.extend(found)
        if found:
            readable = True
            checked.append(f"run record {rec.name}: {len(found)} reinflation line(s)")
        elif understood:
            readable = True
            checked.append(f"run record {rec.name}: no reinflation line")
        else:
            checked.append(
                f"run record {rec.name}: states none of the lines pesto knows, "
                f"so it says nothing about reinflation"
            )

    # Files present
    found = _file_evidence(run, first, last)
    evidence.extend(found)
    pattern = f"{run.case}.N.reinflate.pcs.csv"
    if found:
        readable = True
        checked.append(f"files present: {len(found)} file(s) named like {pattern}")
    elif run.pcs:
        readable = True
        checked.append(f"files present: {len(run.pcs)} pcs file(s), none named like {pattern}")
    else:
        checked.append(f"files present: no pcs files, so none named like {pattern}")

    # Control-file setting
    reading = None
    if options is None:
        checked.append(f"control file: not read, so the {_SETTING} setting is not known")
    elif isinstance(options, ReadFailure):
        checked.append(f"control file: not read ({options.reason}), so the {_SETTING} setting is not known")
    else:
        reading = options.get(_SETTING)
        if reading is None:
            checked.append(f"control file {options.path_name}: no {_SETTING} setting")
    if reading is not None:
        label = f"{reading.raw_key} {reading.value} (line {reading.line})"
        if _parse_schedule(reading.value) is None:
            checked.append(f"control file: {label} is not a list of whole numbers")
        elif run.noptmax is None:
            checked.append(f"control file: {label} was not read because noptmax is not known")
        else:
            readable = True
            placed = schedule_iterations(reading.value, run.noptmax)
            for iteration in placed:
                evidence.append(
                    ReinflationEvidence(
                        "control file",
                        iteration,
                        f"from the setting: {label} with noptmax {run.noptmax} places a "
                        f"reinflation at iteration {iteration}",
                        _in_range(iteration, first, last),
                    )
                )
            if placed:
                checked.append(f"control file: {label} places {len(placed)} reinflation(s)")
            else:
                checked.append(
                    f"control file: {label} with noptmax {run.noptmax} places no reinflation"
                )

    grouped: dict[int | None, list[ReinflationEvidence]] = {}
    for item in evidence:
        grouped.setdefault(item.iteration, []).append(item)
    order = {name: position for position, name in enumerate(_SOURCE_ORDER)}
    findings = tuple(
        (iteration, tuple(sorted(items, key=lambda e: order[e.source])))
        for iteration, items in sorted(
            grouped.items(), key=lambda pair: (pair[0] is None, pair[0] or 0)
        )
    )

    in_range_by_source: dict[str, set[int]] = {}
    for item in evidence:
        if item.in_range:
            in_range_by_source.setdefault(item.source, set()).add(item.iteration)
    if len({frozenset(s) for s in in_range_by_source.values()}) > 1:
        parts = "; ".join(
            f"{source} says {', '.join(str(i) for i in sorted(in_range_by_source[source]))}"
            for source in _SOURCE_ORDER
            if source in in_range_by_source
        )
        notes.append(f"the sources disagree about when the reinflation happened: {parts}")

    unplaced = grouped.get(None)
    if unplaced:
        notes.append(
            "a reinflation is reported whose iteration is not known, so it is not counted "
            "as inside or outside the range"
        )

    if any(item.in_range for item in evidence):
        verdict = "found"
    elif unplaced:
        verdict = "unchecked"
    elif readable:
        verdict = "none_found"
    else:
        verdict = "unchecked"

    return ReinflationVerdict(
        verdict=verdict,
        first=first,
        last=last,
        findings=findings,
        checked=tuple(checked),
        notes=tuple(notes),
    )
