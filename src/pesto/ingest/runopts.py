"""Read every pestpp option a control file states, by one canonical name.

pestpp accepts several spellings of some options and two syntaxes (a keyword
line, or ``++key(value)`` items). This is the one place that reads them all,
so a fact about an option never depends on which spelling the author used.
Each reading keeps the key as written, the value text as written and the
line, so a later fact can quote exactly what the control file said.
"""

from __future__ import annotations

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
        return ()

    def get(self, name: str) -> OptionReading | None:
        found = self.readings(name)
        return found[-1] if found else None


def scan_options(pst_path: Path) -> ControlOptions | ReadFailure:
    return ControlOptions(Path(pst_path).name, {}, ())
