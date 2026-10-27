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
from pesto.ingest.obsindex import FLAG_GREATER, FLAG_LESS, SENTINEL_LIMIT, inequality_flag

from .fixtures import (
    _ENSEMBLE_WRITERS,
    PDC_HEADER,
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


# Three sites for a real vertex grid: icpl with a layer, icpl with a blank layer,
# and x, y alone (inside cell 1). The grid is single-layer because the xyz rule
# needs a layer from z or from the name, and obs_index carries neither.
GRID_SITES = (
    SiteSpec(
        "gw_icpl", "oname:hds_otype:lst_usecol:icpl-a", (None,), "none",
        extras={"icpl": "0", "layer": "0"},
    ),
    SiteSpec(
        "gw_icpl", "oname:hds_otype:lst_usecol:icpl-b", (None,), "none",
        extras={"icpl": "2", "layer": None},
    ),
    SiteSpec(
        "gw_xy", "oname:hds_otype:lst_usecol:xy-c", (None,), "none",
        extras={"x": "1.5", "y": "0.6"},
    ),
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
    noise_path: Path | None = None
    noise_real_names: list[str] | None = None
    noise_values: np.ndarray | None = None
    pdc_path: Path | None = None
    pdc_rows: list[dict] | None = None
    adjusted_weights_path: Path | None = None
    phi_path: Path | None = None
    phi_values: dict[int, dict[str, float]] | None = None
    phi_weights: np.ndarray | None = None


PDC_NUMBER_COLUMNS = PDC_HEADER.split(",")[1:]


def write_pdc_csv(path: Path, rows: list[dict], header: str = PDC_HEADER) -> Path:
    """Write a pestpp-shaped pdc file. Each row maps ``name`` and any of the
    thirteen number columns to text or numbers; a missing number is blank."""
    columns = header.split(",")
    lines = [header]
    for row in rows:
        lines.append(",".join(str(row.get(column, "")) for column in columns))
    path.write_text("\n".join(lines) + "\n")
    return path


def phi_columns(real_names: list[str]) -> list[str]:
    """The realization columns of a generated phi file: the reverse of the
    run's order, so no test can pass by reading them by position."""
    return list(reversed(real_names))


def phi_weight_factors(n_real: int, n_obs: int) -> np.ndarray:
    """Per realization and observation multipliers (all multiples of 1/2), some
    zero, so adjusted weights differ from the control weights."""
    cycle = np.array([1.0, 0.5, 2.0, 0.0, 1.5])
    return cycle[(np.add.outer(np.arange(n_real), np.arange(n_obs)) % cycle.size)]


def phi_from(
    values: np.ndarray, rows: list[dict], weights: np.ndarray
) -> np.ndarray:
    """phi per realization in float64: sum of (weight times residual) squared
    over observations with a real obsval and a weight above 0, one-sided for
    inequality groups. ``values`` and ``weights`` are (n_real, n_obs) in
    control order."""
    n_real = values.shape[0]
    phi = np.zeros(n_real, dtype=np.float64)
    for j, row in enumerate(rows):
        obsval = float(row["obsval"])
        if not np.isfinite(obsval) or abs(obsval) >= SENTINEL_LIMIT:
            continue
        resid = np.asarray(values[:, j], dtype=np.float64) - obsval
        flag = inequality_flag(row["obgnme"])
        if flag == FLAG_GREATER:
            resid = np.minimum(resid, 0.0)
        elif flag == FLAG_LESS:
            resid = np.maximum(resid, 0.0)
        w = np.asarray(weights[:, j], dtype=np.float64)
        phi += np.where(w > 0, (w * resid) ** 2, 0.0)
    return phi


def write_phi_actual(
    path: Path, real_names: list[str], phi_by_iteration: dict[int, dict[str, float]]
) -> Path:
    """Write a phi file in pestpp's shape: the six leading columns, then one
    column per realization in ``phi_columns`` order, one row per iteration."""
    columns = phi_columns(real_names)
    lines = [",".join(["iteration", "total_runs", "mean", "standard_deviation", "min", "max", *columns])]
    for iteration, phi in phi_by_iteration.items():
        numbers = [phi[name] for name in columns]
        cells = [
            iteration,
            len(columns),
            float(np.mean(numbers)),
            float(np.std(numbers)),
            min(numbers),
            max(numbers),
            *numbers,
        ]
        lines.append(",".join(repr(c) if isinstance(c, float) else str(c) for c in cells))
    path.write_text("\n".join(lines) + "\n")
    return path


def make_obs_run(
    root: Path,
    *,
    case: str = "case",
    sites=None,
    iterations: tuple[int, ...] = (0, 1),
    par_iterations: tuple[int, ...] | None = None,
    n_real: int = 4,
    ensemble_format: str = "jcb",
    hash_ordered: bool = False,
    real_names: list[str] | None = None,
    n_par: int = 6,
    grid: bool = False,
    with_noise: bool = False,
    noise_real_names: list[str] | None = None,
    noise_format: str = "jcb",
    pestpp_options: dict | None = None,
    noise_shift: float = 0.0,
    with_pdc: bool = False,
    adjusted_weights: np.ndarray | None = None,
    with_phi: bool = False,
    nan_values: dict[int, list[tuple[str, str]]] | None = None,
) -> ObsRun:
    """Write a run with a real control file whose observations come from
    ``sites``, parameter ensembles for ``par_iterations`` (the same as
    ``iterations`` by default; pass ``()`` for an observation-only run) and
    observation ensembles for ``iterations``. Everything lands under
    ``root``. Values come from ``np.random.default_rng``, never the global
    generator.

    ``grid=True`` writes a real single-layer vertex grid file instead of the
    placeholder and, unless ``sites`` is given, uses ``GRID_SITES``.

    ``with_noise=True`` also writes ``<case>.obs+noise.<ext>`` in the
    ``noise_format`` ensemble format, realizations named ``noise_real_names``
    (``r1, base, r2, r3`` by default), observation columns hash-ordered.
    ``ObsRun.noise_values`` holds every row of it in control order.
    ``pestpp_options`` go into the control file, for example
    ``{"ies_obs_en": "noise_oe.jcb"}``. ``noise_shift`` is added to every
    noise value (a multiple of 1/256 keeps them exact in float32), so a test
    can make the noise band sit away from the simulated one.

    ``with_pdc=True`` writes ``<case>.0.pdc.csv`` as pestpp does, with two
    rows: the first observation's name in upper case (so it matches the
    control name only after case folding) and the second as written.
    ``adjusted_weights`` is an ``(n_real, n_obs)`` array in control order,
    written as ``<case>.adjusted.weights.jcb`` with the run's realization
    names.

    ``with_phi=True`` writes ``<case>.phi.actual.csv`` with, for each iteration, the phi
    of every realization computed in float64 from the generated values and the adjusted
    weights, in reversed column order. Unless ``adjusted_weights`` is given it also writes
    ``<case>.adjusted.weights.jcb`` for the observations that have a weight and a real
    obsval, with weights that differ from the control weights and some zero.
    ``ObsRun.phi_values`` holds the phi per iteration and realization name.

    ``nan_values`` maps an iteration to ``(observation name, realization name)`` pairs whose
    cell in that iteration's observation ensemble is written as NaN."""
    from pesto.warm import load_pyemu
    from model.fixtures import write_disv_grb

    if sites is None:
        sites = GRID_SITES if grid else DEFAULT_SITES

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
    if pestpp_options:
        pst.pestpp_options.update(pestpp_options)
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
        for obs_name, real_name in (nan_values or {}).get(iteration, ()):
            generated[real_names.index(real_name), obs_names.index(obs_name)] = np.nan
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

    noise_path = None
    noise_values = None
    if with_noise:
        if noise_real_names is None:
            noise_real_names = ["r1", "base", "r2", "r3"]
        noise_writer, noise_ext = _ENSEMBLE_WRITERS[noise_format]
        noise_values = sample_values(len(noise_real_names), n_obs, seed=4242) + noise_shift
        noise_order = sorted(
            range(n_obs), key=lambda i: hashlib.sha256(obs_names[i].encode()).hexdigest()
        )
        noise_path = root / f"{case}.obs+noise.{noise_ext}"
        noise_writer(
            noise_path,
            noise_values[:, noise_order],
            noise_real_names,
            [obs_names[i] for i in noise_order],
        )

    pdc_path = None
    pdc_rows = None
    if with_pdc and len(obs_names) >= 2:
        pdc_rows = [
            {
                "name": obs_names[0].upper(),
                **{c: 10.0 + i for i, c in enumerate(PDC_NUMBER_COLUMNS)},
            },
            {
                "name": obs_names[1],
                **{c: 20.5 + i for i, c in enumerate(PDC_NUMBER_COLUMNS)},
            },
        ]
        pdc_path = write_pdc_csv(root / f"{case}.0.pdc.csv", pdc_rows)

    weights_path = None
    phi_weights = None
    if adjusted_weights is not None:
        weights_array = np.asarray(adjusted_weights, dtype=np.float64)
        weights_path = root / f"{case}.adjusted.weights.jcb"
        _ENSEMBLE_WRITERS["jcb"][0](weights_path, weights_array, real_names, obs_names)
        phi_weights = weights_array
    elif with_phi:
        has_value = [
            float(row["obsval"]) < SENTINEL_LIMIT and float(row["weight"]) > 0 for row in rows
        ]
        phi_weights = np.zeros((n_real, n_obs), dtype=np.float64)
        factors = phi_weight_factors(n_real, n_obs)
        for j, row in enumerate(rows):
            if has_value[j]:
                phi_weights[:, j] = float(row["weight"]) * factors[:, j]
        columns = [j for j in reversed(range(n_obs)) if has_value[j]]
        weights_path = root / f"{case}.adjusted.weights.jcb"
        _ENSEMBLE_WRITERS["jcb"][0](
            weights_path, phi_weights[:, columns], real_names, [obs_names[j] for j in columns]
        )

    phi_path = None
    phi_values = None
    if with_phi:
        phi_values = {}
        for iteration in iterations:
            phi = phi_from(values[iteration], rows, phi_weights)
            phi_values[iteration] = {name: float(phi[r]) for r, name in enumerate(real_names)}
        phi_path = write_phi_actual(root / f"{case}.phi.actual.csv", real_names, phi_values)

    grid_path = root / "coarse.disv.grb"
    if grid:
        write_disv_grb(grid_path, nlay=1, inactive_layer=0, inactive_cell=1)
    else:
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
        noise_path=noise_path,
        noise_real_names=noise_real_names if with_noise else None,
        noise_values=noise_values,
        pdc_path=pdc_path,
        pdc_rows=pdc_rows,
        adjusted_weights_path=weights_path,
        phi_path=phi_path,
        phi_values=phi_values,
        phi_weights=phi_weights,
    )
