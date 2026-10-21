"""Generators for runs whose observations have awkward names and times.

A plain helper module like ``fixtures.py``: callers import from it, and it
writes only under the directory it is given (in practice a test's
``tmp_path``). ``obs_control_tables`` builds a control table in memory;
``make_obs_run`` writes a whole run to disk, with a real control file, so an
ingest of it exercises the same path a real run takes.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd

from pesto.ingest.control import ControlTables

from .fixtures import (
    _ENSEMBLE_WRITERS,
    control_ordered_names,
    sample_values,
    survivor_names,
)

# Real runs store these as text, with real nulls for blank cells.
STRING_COLUMNS = ("datetime", "time", "x", "y", "icpl", "layer", "id")


@dataclass(frozen=True)
class SiteSpec:
    """One site: a group, a name, and one observation per entry in ``times``,
    listed in the order they go into the control file.

    ``style`` says where the time lives:
    ``"time-token"`` puts ``_time:<t>`` in the name and also fills the
    ``time`` column; ``"datetime-token"`` the same with ``_datetime:<t>``;
    ``"token-only"`` writes the name token and leaves the columns blank;
    ``"time-column"`` and ``"datetime-column"`` fill the column only, so the
    name carries no token; ``"none"`` gives no time at all.
    """

    group: str
    site: str
    times: tuple = (None,)
    style: str = "time-token"
    weight: float = 1.0
    obsval: float = 1.5
    extras: dict = field(default_factory=dict)


DEFAULT_SITES = (
    # Listed out of order on purpose, and 9 against 10 sorts wrong as text.
    SiteSpec("gw_head", "oname:hds_otype:lst_usecol:trgw-0-1", (10.0, 1.0, 9.0), "time-token"),
    SiteSpec(
        "gw_date",
        "oname:hds_otype:lst_usecol:trgw-0-2",
        ("2020-03-01", "2020-01-15", "2020-02-10"),
        "datetime-token",
        weight=0.0,
    ),
    SiteSpec("gw_none", "oname:sfr_otype:lst_usecol:flow", (None,), "none", obsval=1e30),
)


def _text(value) -> str | None:
    if value is None:
        return None
    if isinstance(value, float) and np.isnan(value):
        return None
    return str(value)


def rows_for(sites=DEFAULT_SITES) -> list[dict]:
    """Expand site specs into one row per observation, in control order."""
    rows: list[dict] = []
    for spec in sites:
        for index, t in enumerate(spec.times):
            row = {
                "obgnme": spec.group,
                "obsval": spec.obsval,
                "weight": spec.weight,
                "datetime": None,
                "time": None,
            }
            style = spec.style
            if style in ("time-token", "token-only") and t is not None:
                name = f"{spec.site}_time:{t}"
            elif style == "datetime-token" and t is not None:
                name = f"{spec.site}_datetime:{t}"
            elif style in ("time-column", "datetime-column"):
                name = f"{spec.site}_{index}"
            else:
                name = spec.site if len(spec.times) == 1 else f"{spec.site}_{index}"
            if t is not None and style in ("time-token", "time-column"):
                row["time"] = _text(t)
            if t is not None and style in ("datetime-token", "datetime-column"):
                row["datetime"] = _text(t)
            row["obsnme"] = name
            row.update(spec.extras)
            rows.append(row)
    return rows


def obs_control_tables(rows, columns=None) -> ControlTables:
    """A control table held in memory, with observation columns stored the
    way real runs store them: text for ``STRING_COLUMNS`` and real nulls for
    blanks. ``rows`` is a list of dicts; ``columns`` fixes the column order
    (every key seen in ``rows`` otherwise, ``obsnme`` first)."""
    rows = list(rows)
    if columns is None:
        seen: list[str] = []
        for row in rows:
            for key in row:
                if key not in seen:
                    seen.append(key)
        columns = ["obsnme", "obgnme", *[c for c in seen if c not in ("obsnme", "obgnme")]]
    frame = pd.DataFrame({c: [row.get(c) for row in rows] for c in columns})
    for column in columns:
        if column in STRING_COLUMNS:
            frame[column] = pd.Series([_text(v) for v in frame[column]], dtype="object")
    if "obgnme" in frame:
        frame["obgnme"] = frame["obgnme"].astype("category")
    if "weight" in frame:
        frame["weight"] = frame["weight"].astype("float64")
    par = pd.DataFrame(
        {
            "parnme": ["par0"],
            "pargp": pd.Series(["pg"], dtype="category"),
            "parlbnd": [0.0],
            "parubnd": [1.0],
            "partrans": pd.Series(["log"], dtype="category"),
        }
    )
    groups = tuple(dict.fromkeys(str(g) for g in frame["obgnme"])) if "obgnme" in frame else ()
    return ControlTables(
        par=par,
        obs=frame,
        par_groups=("pg",),
        obs_groups=groups,
        source_path=Path("in-memory.pst"),
        notes=(),
        ambiguities=(),
    )


def obs_arrow(rows, columns=None):
    """The observation part of ``obs_control_tables`` as a pyarrow table."""
    import pyarrow as pa

    return pa.Table.from_pandas(obs_control_tables(rows, columns).obs, preserve_index=False)


@dataclass(frozen=True)
class ObsRun:
    """What ``make_obs_run`` wrote. ``values`` maps an iteration to the
    observation values as a realization-major array in control order, so a
    test can state what any cached number should be."""

    root: Path
    case: str
    pst_path: Path
    obs_data_path: Path
    grid_path: Path
    obs_names: list[str]
    real_names: list[str]
    par_ens: dict[int, Path]
    obs_ens: dict[int, Path]
    values: dict[int, np.ndarray]
    rows: list[dict]


def make_obs_run(
    root: Path,
    *,
    case: str = "case",
    sites=DEFAULT_SITES,
    iterations: tuple[int, ...] = (0, 1),
    par_iterations: tuple[int, ...] | None = None,
    n_real: int = 4,
    ensemble_format: str = "jcb",
    hash_ordered: bool = False,
    real_names: list[str] | None = None,
    n_par: int = 6,
) -> ObsRun:
    """Write a run with a real control file whose observations come from
    ``sites``, parameter ensembles for ``par_iterations`` (the same as
    ``iterations`` by default; pass ``()`` for an observation-only run) and
    observation ensembles for ``iterations``. Everything lands under
    ``root``. Values come from ``np.random.default_rng``, never the global
    generator."""
    from pesto.warm import load_pyemu

    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    writer, ext = _ENSEMBLE_WRITERS[ensemble_format]
    if par_iterations is None:
        par_iterations = iterations

    rows = rows_for(sites)
    obs_names = [row["obsnme"] for row in rows]
    par_names = control_ordered_names("par", n_par)
    if real_names is None:
        real_names = survivor_names() if n_real == 4 else control_ordered_names("real", n_real)

    pyemu = load_pyemu()
    pst = pyemu.Pst.from_par_obs_names(par_names=par_names, obs_names=obs_names)
    pst.control_data.noptmax = 3
    # from_par_obs_names sorts the names; the control file must keep this order.
    pst.observation_data = pst.observation_data.loc[obs_names].copy()
    data = pst.observation_data
    for column in ("obgnme", "obsval", "weight"):
        data[column] = [row[column] for row in rows]
    extra_columns: list[str] = []
    for row in rows:
        for key in row:
            if key not in ("obsnme", "obgnme", "obsval", "weight") and key not in extra_columns:
                extra_columns.append(key)
    for column in extra_columns:
        data[column] = [_text(row.get(column)) for row in rows]
    pst_path = root / f"{case}.pst"
    pst.write(str(pst_path), version=2)
    obs_data_path = root / f"{case}.obs_data.csv"

    n_obs = len(obs_names)
    values: dict[int, np.ndarray] = {}
    obs_ens: dict[int, Path] = {}
    par_ens: dict[int, Path] = {}
    for iteration in iterations:
        generated = sample_values(n_real, n_obs, seed=iteration + 1000)
        values[iteration] = generated
        names_in_file = obs_names
        file_values = generated
        if hash_ordered:
            # Same observations, written in a different column order.
            order = sorted(
                range(n_obs), key=lambda i: hashlib.sha256(obs_names[i].encode()).hexdigest()
            )
            names_in_file = [obs_names[i] for i in order]
            file_values = generated[:, order]
        path = root / f"{case}.{iteration}.obs.{ext}"
        writer(path, file_values, real_names, names_in_file)
        obs_ens[iteration] = path
    for iteration in par_iterations:
        path = root / f"{case}.{iteration}.par.{ext}"
        writer(path, sample_values(n_real, n_par, seed=iteration), real_names, par_names)
        par_ens[iteration] = path

    grid_path = root / "coarse.disv.grb"
    grid_path.write_bytes(b"synthetic grid file placeholder, not a real .grb")

    return ObsRun(
        root=root,
        case=case,
        pst_path=pst_path,
        obs_data_path=obs_data_path,
        grid_path=grid_path,
        obs_names=obs_names,
        real_names=real_names,
        par_ens=par_ens,
        obs_ens=obs_ens,
        values=values,
        rows=rows,
    )
