"""Read the facts a pestpp run record (``case.rec``) states about a run.

The record is pestpp's own account of what it did, so it outranks the
control file for any fact it states. It can be very large, so it is read in
one streaming pass. A line this reader does not know is absent from the
result, never guessed at, and a fact that is not stated reads as absent with
a note saying what was looked for.
"""

from __future__ import annotations

import re
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


_TEXT_CAP = 200
_LOOKED_FOR = (
    "the pestpp version, the shared pestpp-ies options dump, the measurement-noise lines, "
    "the reg_factor line, the localization line, the base-realization line and reinflation lines"
)

_VERSION_RE = re.compile(r"^version:\s*(\S+)")
_DUMP_START = "shared pestpp-ies/pestpp-da options:"
_DUMP_END = "pestpp-sen options:"
_OPTION_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*):[ \t]*(.*)$")
_HEADING_RE = re.compile(r"^\s*---")
_NOISE_RESET_RE = re.compile(r"resetting to `?ies_no_noise`? to true")
_NOISE_NONE_RE = re.compile(r"initializing no-noise observation ensemble of\s*:\s*(\d+)")
_NOISE_DRAWN_RE = re.compile(r"drawing observation noise realizations:\s*(\d+)")
_NOISE_LOADED_RE = re.compile(r"loading obs ensemble from (?:\w+ )?file\s+(\S.*?)\s*$")
_NOISE_STD_RE = re.compile(r"the following observations have 'standard_deviation' defined")
_REG_FACTOR_RE = re.compile(r"using reg_factor:\s*([-+0-9.eE]+)")
_LOC_OFF_RE = re.compile(r"not using localization")
_LOC_ON_RE = re.compile(r"using localized solution with (\d+) sequential upgrade steps")
_BASE_RE = re.compile(r"'base' realization already in parameter ensemble, ignoring")
_REINFLATE_START = "incrementing iteration count for reinflation cycle"
_REINFLATE_FACTOR_RE = re.compile(r"reinflation factor:\s*([-+0-9.eE]+)")
_REPORT_RE = re.compile(r"EnsembleMethod iteration (\d+) report")


def _number(text: str) -> float | None:
    try:
        return float(text)
    except ValueError:
        return None


def _classify(line: str, number: int) -> RecLine | None:
    """Match one line against the single-valued facts. Cheap substring checks
    come first, so a 250,000-line record costs one pass of mostly misses."""
    text = line.strip()[:_TEXT_CAP]

    def make(kind: str, value: str | float | int | None) -> RecLine:
        return RecLine(kind, value, number, text)

    if "reg_factor" in line:
        match = _REG_FACTOR_RE.search(line)
        if match and (value := _number(match.group(1))) is not None:
            return make("reg_factor", value)
    elif "localiz" in line:
        if _LOC_OFF_RE.search(line):
            return make("off", None)
        match = _LOC_ON_RE.search(line)
        if match:
            return make("on", int(match.group(1)))
    elif "'base'" in line:
        if _BASE_RE.search(line):
            return make("base_kept", True)
    elif "ies_no_noise" in line:
        if _NOISE_RESET_RE.search(line):
            return make("reset_to_no_noise", None)
    elif "no-noise observation ensemble" in line:
        match = _NOISE_NONE_RE.search(line)
        if match:
            return make("no_noise_ensemble", int(match.group(1)))
    elif "noise realizations" in line:
        match = _NOISE_DRAWN_RE.search(line)
        if match:
            return make("drawn_noise", int(match.group(1)))
    elif "loading obs ensemble" in line:
        match = _NOISE_LOADED_RE.search(line)
        if match:
            return make("loaded_obs_ensemble", re.split(r"[\\/]", match.group(1))[-1])
    elif "standard_deviation" in line:
        if _NOISE_STD_RE.search(line):
            return make("standard_deviation_column", None)
    return None


def read_rec(path: Path) -> RecFacts | ReadFailure:
    """Read ``path`` in one pass. Returns a :class:`ReadFailure` only when the
    file cannot be opened; a record that states nothing pesto knows comes
    back as empty facts with one note saying what was looked for.

    Bytes that are not UTF-8 are replaced, counted, and named in one note.
    The first of each single-valued line is kept; a later one that says
    something different is named in a note.
    """
    path = Path(path)
    version: RecLine | None = None
    reg_factor: RecLine | None = None
    localization: RecLine | None = None
    base_kept: RecLine | None = None
    options: dict[str, RecOption] = {}
    noise: dict[str, RecLine] = {}
    reinflations: list[RecReinflation] = []
    notes: list[str] = []
    disagreements: list[str] = []
    replaced = 0

    in_dump = False
    pending_key: str | None = None
    pending_line = 0
    # A reinflation waiting for its iteration report: [line, factor]
    open_reinflation: list | None = None

    def note_repeat(label: str, kept: RecLine | None, new: RecLine) -> None:
        if kept is not None and (kept.kind, kept.value) != (new.kind, new.value):
            disagreements.append(
                f"the run record says {label} more than once and differently "
                f"(line {kept.line} and line {new.line}); the first is kept"
            )

    def close_reinflation(iteration: int | None) -> None:
        nonlocal open_reinflation
        line, factor = open_reinflation
        reinflations.append(RecReinflation(iteration, factor, line))
        if iteration is None:
            notes.append(
                f"the run record reports a reinflation at line {line} that no iteration "
                f"report follows, so its iteration is not known"
            )
        open_reinflation = None

    try:
        with path.open("r", encoding="utf-8", errors="replace") as handle:
            for number, raw in enumerate(handle, 1):
                line = raw.rstrip("\r\n")
                if "�" in line:
                    replaced += line.count("�")

                if in_dump:
                    if pending_key is not None:
                        wanted, pending_key = pending_key, None
                        stripped = line.strip()
                        if stripped and not _OPTION_RE.match(line) and _DUMP_END not in line:
                            options.setdefault(wanted, RecOption(stripped, pending_line))
                            continue
                        options.setdefault(wanted, RecOption("", pending_line))
                    if _DUMP_END in line or _HEADING_RE.match(line):
                        in_dump = False
                        continue
                    match = _OPTION_RE.match(line)
                    if match:
                        key = match.group(1).strip().lower()
                        value = match.group(2).strip()
                        if value:
                            existing = options.get(key)
                            if existing is not None and existing.value != value:
                                disagreements.append(
                                    f"the run record's options dump gives {key} twice and "
                                    f"differently (line {existing.line} and line {number}); "
                                    f"the first is kept"
                                )
                            options.setdefault(key, RecOption(value, number))
                        else:
                            pending_key, pending_line = key, number
                    continue

                if _DUMP_START in line:
                    in_dump = True
                    continue

                if open_reinflation is not None:
                    match = _REPORT_RE.search(line)
                    if match:
                        close_reinflation(int(match.group(1)))
                        continue
                    match = _REINFLATE_FACTOR_RE.search(line)
                    if match and open_reinflation[1] is None:
                        open_reinflation[1] = _number(match.group(1))
                        continue
                if _REINFLATE_START in line:
                    if open_reinflation is not None:
                        close_reinflation(None)
                    open_reinflation = [number, None]
                    continue

                if version is None:
                    match = _VERSION_RE.match(line)
                    if match:
                        version = RecLine("version", match.group(1), number, line.strip()[:_TEXT_CAP])
                        continue

                new = _classify(line, number)
                if new is None:
                    continue
                if new.kind in ("off", "on"):
                    note_repeat("whether localization is used", localization, new)
                    localization = localization or new
                elif new.kind == "reg_factor":
                    note_repeat("the reg_factor", reg_factor, new)
                    reg_factor = reg_factor or new
                elif new.kind == "base_kept":
                    base_kept = base_kept or new
                else:
                    note_repeat(f"a {new.kind} line", noise.get(new.kind), new)
                    noise.setdefault(new.kind, new)
    except OSError as error:
        return ReadFailure(
            name="rec",
            path=str(path),
            reason=f"could not open the run record {path.name}: {error.strerror or error}",
        )

    if pending_key is not None:
        options.setdefault(pending_key, RecOption("", pending_line))
    if open_reinflation is not None:
        close_reinflation(None)

    if replaced:
        notes.append(
            f"{replaced} characters in the run record {path.name} were not valid UTF-8 "
            f"and were replaced"
        )
    notes.extend(disagreements)

    found = version or options or noise or reg_factor or localization or base_kept or reinflations
    if not found:
        notes.append(f"the run record {path.name} states none of what was looked for: {_LOOKED_FOR}")

    return RecFacts(
        name=path.name,
        version=version,
        options=options,
        noise=tuple(noise.values()),
        reg_factor=reg_factor,
        localization=localization,
        base_kept=base_kept,
        reinflations=tuple(reinflations),
        replaced_chars=replaced,
        notes=tuple(notes),
    )
