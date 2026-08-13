"""Control file into parameter and observation tables.

Tracer scope narrows to the core columns pesto uses today: ``parnme``,
``pargp``, ``parlbnd``, ``parubnd``, ``partrans`` for parameters and
``obsnme``, ``obgnme``, ``weight`` for observations, each kept in
control-file order with no sorting. Later plans in this phase widen the
column set and tighten dtypes (D-04); this tracer proves the seam the
whole read layer shares, not the whole surface.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import pandas as pd

from pesto.ingest.failures import ReadFailure

_PAR_COLUMNS = ("parnme", "pargp", "parlbnd", "parubnd", "partrans")
_OBS_COLUMNS = ("obsnme", "obgnme", "weight")


@dataclass(frozen=True)
class ControlTables:
    """Parameter and observation tables read from one control file, plus
    provenance. Column order matches the control file; nothing is sorted."""

    par: pd.DataFrame
    obs: pd.DataFrame
    source_path: Path
    notes: tuple[str, ...]


def _select(df: pd.DataFrame, columns: tuple[str, ...], notes: list[str], label: str) -> pd.DataFrame:
    """Strip and lower every column name before selecting the core columns.

    pyemu's external-file merge lowercases column names and never strips
    them, so a header written with a leading space survives as a distinct
    column that an exact-match lookup misses silently (RESEARCH.md
    Pitfall 2). A note is appended naming any column whose raw name
    differed from its stripped/lowered name.
    """
    renamed: dict[object, str] = {}
    for raw in df.columns:
        cleaned = str(raw).strip().lower()
        if cleaned != raw:
            notes.append(f"{label} column {raw!r} was stripped/lowered to {cleaned!r}")
        renamed[raw] = cleaned
    cleaned_df = df.rename(columns=renamed)
    return cleaned_df.loc[:, [c for c in columns if c in cleaned_df.columns]]


def read_control(pst_path: Path) -> "ControlTables | ReadFailure":
    """Read ``pst_path`` into parameter and observation tables.

    Any exception raised while parsing returns a ``ReadFailure`` named for
    ``pst_path.name`` with a reason naming the control file and the parse
    failure -- this function never propagates a pyemu exception to its
    caller.
    """
    from pesto.warm import load_pyemu

    path = Path(pst_path)
    try:
        pyemu = load_pyemu()
        pst = pyemu.Pst(str(path))
        notes: list[str] = []
        par = _select(pst.parameter_data, _PAR_COLUMNS, notes, "parameter")
        obs = _select(pst.observation_data, _OBS_COLUMNS, notes, "observation")
        return ControlTables(par=par, obs=obs, source_path=path, notes=tuple(notes))
    except Exception as exc:
        return ReadFailure(
            name=path.name,
            path=str(path),
            reason=f"failed to parse control file {path.name}: {exc}",
        )
