"""Read every pestpp option a control file states, by one canonical name.

pestpp accepts several spellings of some options and two syntaxes (a keyword
line, or ``++key(value)`` items). This is the one place that reads them all,
so a fact about an option never depends on which spelling the author used.
Each reading keeps the key as written, the value text as written and the
line, so a later fact can quote exactly what the control file said.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping

from pesto.ingest.failures import ReadFailure

# Canonical name -> every spelling pestpp's own parser accepts.
OPTION_ALIASES: dict[str, tuple[str, ...]] = {
    "ies_include_base": ("ies_include_base", "ies_add_base"),
    "ies_reg_factor": ("ies_reg_factor", "ies_reg_fac"),
    "ies_n_iter_reinflate": ("ies_n_iter_reinflate", "ies_n_iter_mean"),
    "ies_parameter_ensemble": ("ies_parameter_ensemble", "ies_par_en"),
    "ies_observation_ensemble": ("ies_observation_ensemble", "ies_obs_en"),
    "ies_localizer_forgive_missing": (
        "ies_localizer_forgive_missing",
        "ies_localizer_forgive_extra",
    ),
    "ies_no_noise": ("ies_no_noise",),
    "ies_localizer": ("ies_localizer",),
    "ies_reinflate_factor": ("ies_reinflate_factor",),
    "ies_num_reals": ("ies_num_reals",),
}


@dataclass(frozen=True)
class OptionReading:
    raw_key: str
    value: str
    line: int


@dataclass(frozen=True)
class ControlOptions:
    path_name: str
    by_name: Mapping[str, tuple[OptionReading, ...]]
    notes: tuple[str, ...]

    def readings(self, name: str) -> tuple[OptionReading, ...]:
        """Every occurrence of ``name`` (in any accepted spelling), in file order."""
        return self.by_name.get(canonical_name(name), ())

    def get(self, name: str) -> OptionReading | None:
        """The reading pestpp uses: the last occurrence, as it overwrites on each parse."""
        found = self.readings(name)
        return found[-1] if found else None


_CANONICAL_BY_SPELLING = {
    spelling: canonical for canonical, spellings in OPTION_ALIASES.items() for spelling in spellings
}
_PLUS_ITEM_RE = re.compile(r"\+\+\s*([A-Za-z][A-Za-z0-9_]*)\s*\(([^)]*)\)")
_KEY_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]*$")


def canonical_name(key: str) -> str:
    """The canonical name for ``key``, matched case-insensitively. A key with
    no alias is its own lower-cased name."""
    lowered = key.strip().lower()
    return _CANONICAL_BY_SPELLING.get(lowered, lowered)


def scan_options(pst_path: Path) -> ControlOptions | ReadFailure:
    """Read every option line in the control file in one pass.

    Keyword lines count only before the first section or inside
    ``* control data``; a ``++key(value)`` item counts anywhere. Strict
    UTF-8: a file that cannot be decoded is a failure, not a partial read.
    """
    pst_path = Path(pst_path)
    found: dict[str, list[OptionReading]] = {}
    notes: list[str] = []
    in_options_section = True

    def add(raw_key: str, value: str, number: int) -> None:
        name = canonical_name(raw_key)
        earlier = found.setdefault(name, [])
        reading = OptionReading(raw_key, value, number)
        if earlier:
            before = earlier[-1]
            notes.append(
                f"{name} is set more than once in {pst_path.name}: {before.raw_key} on line "
                f"{before.line}, then {raw_key} on line {number}; the later one is used"
            )
        earlier.append(reading)

    try:
        with pst_path.open("r", encoding="utf-8", errors="strict") as handle:
            for number, raw in enumerate(handle, 1):
                line = raw.split("#", 1)[0].strip()
                if not line:
                    continue
                if line.startswith("*"):
                    in_options_section = line.lower().startswith("* control data")
                    continue

                items = list(_PLUS_ITEM_RE.finditer(line))
                if items:
                    for item in items:
                        add(item.group(1), item.group(2).strip(), number)
                    continue
                if line.startswith("++") or not in_options_section:
                    continue

                parts = line.split()
                key = parts[0]
                if len(parts) < 2 or not _KEY_RE.match(key):
                    continue
                if "_" not in key and key.lower() not in _CANONICAL_BY_SPELLING:
                    continue
                add(key, parts[1], number)
    except (OSError, UnicodeDecodeError) as error:
        reason = error.strerror if isinstance(error, OSError) and error.strerror else error
        return ReadFailure(
            name="control file",
            path=str(pst_path),
            reason=f"could not read the options in the control file {pst_path.name}: {reason}",
        )

    return ControlOptions(
        path_name=pst_path.name,
        by_name={name: tuple(readings) for name, readings in found.items()},
        notes=tuple(notes),
    )
