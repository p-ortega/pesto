"""A synthetic run for the parameter view: groups mixing log, none, fixed and
tied parameters, PstFrom-style names, realization sets that differ between
iterations, and a row order that differs too.

Every value is an integer divided by 256, so it survives the float32 cache
exactly and a test can compute the expected number with numpy on the values
returned here. Nothing in this module writes outside the directory it is given.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd

from .fixtures import _ENSEMBLE_WRITERS, write_control_file

LOG_BOUNDS = (0.01, 1000.0)
NONE_BOUNDS = (-1000.0, 1000.0)
FIXED_VALUE = 5.0


@dataclass(frozen=True)
class ParGroupSpec:
    """One parameter group. ``tag`` is the ptype token written into the
    parameter names (None writes none); ``column`` is the value of the ptype
    column (None leaves it blank). The last ``n_tied`` parameters are tied to
    the group's first parameter."""

    name: str
    count: int
    trans: str = "log"
    tag: str | None = "gr"
    column: str | None = "gr"
    n_tied: int = 0


DEFAULT_GROUPS = (
    ParGroupSpec("hk_pp", 4, "log", tag="pp", column="pp"),
    ParGroupSpec("rch_gr", 3, "none", tag="gr", column="gr"),
    ParGroupSpec("fixed_gr", 2, "fixed", tag="gr", column="gr"),
    ParGroupSpec("mix", 3, "log", tag="gr", column="gr", n_tied=1),
)


@dataclass(frozen=True)
class ParViewRun:
    """What :func:`make_par_view_run` wrote. ``values[k]`` is the array in the
    file's own row order, columns in control order; ``real_names[k]`` names
    those rows in that same order."""

    root: Path
    case: str
    pst_path: Path
    par_names: list[str]
    groups: dict[str, list[str]]
    trans: dict[str, str]
    par_ens: dict[int, Path]
    real_names: dict[int, list[str]]
    values: dict[int, np.ndarray]
    dropped: list[str]
    pcs_path: Path | None
    lower: dict[str, float] = field(default_factory=dict)
    upper: dict[str, float] = field(default_factory=dict)

    def table(self, iteration: int) -> pd.DataFrame:
        """The iteration's values indexed by realization name, columns by parameter name."""
        return pd.DataFrame(
            self.values[iteration], index=self.real_names[iteration], columns=self.par_names
        )


def parameter_names(spec: ParGroupSpec) -> list[str]:
    tag = f"_ptype:{spec.tag}" if spec.tag else ""
    return [
        f"pname:{spec.name}_inst:0{tag}_usecol:3_pstyle:m_idx0:{i}_idx1:{i + 7}"
        for i in range(spec.count)
    ]


def _draw(rng: np.random.Generator, low: int, high: int, n_real: int) -> np.ndarray:
    return rng.integers(low * 256, high * 256, size=n_real, dtype=np.int64) / 256.0


def write_pcs(path: Path, rows: list[dict]) -> Path:
    """A pestpp-style group change summary. Each row holds ``group`` and any of
    the other pestpp column names; a column no row mentions is still written."""
    header = [
        "group",
        "mean_change",
        "std_change",
        "num_at_near_lbound",
        "percent_at_near_lbound",
        "num_at_near_ubound",
        "percent_at_near_ubound",
        "initial_cv",
        "current_cv",
    ]
    lines = [",".join(header)]
    for row in rows:
        lines.append(",".join(str(row.get(name, 0)) for name in header))
    path.write_text("\n".join(lines) + "\n")
    return path


def make_par_view_run(
    root: Path,
    *,
    case: str = "case",
    groups: tuple[ParGroupSpec, ...] = DEFAULT_GROUPS,
    iterations: tuple[int, ...] = (0, 1),
    n_real: int = 6,
    drop_in_last: int | None = 2,
    reverse_last: bool = True,
    shared_names: bool = True,
    ptype_column: bool = True,
    near_zero: bool = False,
    zero_sd: bool = False,
    nonpositive_log: bool = False,
    overrides: dict[tuple[int, str], np.ndarray] | None = None,
    rename_in_last: dict[str, str] | None = None,
    ensemble_format: str = "jcb",
    pcs_rows: list[dict] | None = None,
    seed: int = 0,
) -> ParViewRun:
    """Write a control file, one jcb parameter ensemble per iteration and,
    when ``pcs_rows`` is given, the last iteration's pcs file.

    ``drop_in_last`` is the position of the realization left out of every
    iteration but the first; ``reverse_last`` writes the last iteration's
    rows in the opposite order, so a join by position would pair the wrong
    rows. ``shared_names=False`` renames every realization of the last
    iteration so the two share none, and ``rename_in_last`` renames only the
    realizations it names (for example ``{"r1": "R1"}``). ``near_zero`` gives the first ``none``
    parameter a first-iteration mean of 0.005 standard deviations, ``zero_sd``
    makes the second ``none`` parameter constant in the first iteration, and
    ``nonpositive_log`` puts -19.0 into the first log parameter of the first
    iteration. ``overrides`` maps ``(iteration, parameter name)`` to the whole
    column, in the order of that iteration's realizations.
    """
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(seed)

    par_names: list[str] = []
    group_names: dict[str, list[str]] = {}
    trans: dict[str, str] = {}
    lower: dict[str, float] = {}
    upper: dict[str, float] = {}
    csv_rows: list[dict] = []
    for spec in groups:
        names = parameter_names(spec)
        group_names[spec.name] = names
        for position, name in enumerate(names):
            tied = position >= spec.count - spec.n_tied
            kind = "tied" if tied else spec.trans
            trans[name] = kind
            bounds = NONE_BOUNDS if spec.trans == "none" else LOG_BOUNDS
            lower[name], upper[name] = bounds
            csv_rows.append(
                {
                    "parnme": name,
                    "pargp": spec.name,
                    "partrans": kind,
                    "parlbnd": bounds[0],
                    "parubnd": bounds[1],
                    "partied": names[0] if tied else "",
                    "ptype": spec.column,
                }
            )
        par_names.extend(names)

    pst_path = root / f"{case}.pst"
    write_control_file(
        pst_path,
        par_names=par_names,
        obs_names=["obs0", "obs1"],
        noptmax=max(iterations),
        par_meta=("pname", "pstyle"),
    )
    csv_path = root / f"{case}.par_data.csv"
    frame = pd.read_csv(csv_path, keep_default_na=False)
    by_name = {row["parnme"]: row for row in csv_rows}
    # pyemu writes the table in its own order, so the run's order is read back.
    par_names = [str(n) for n in frame["parnme"]]
    group_names = {}
    for pname in par_names:
        group_names.setdefault(by_name[pname]["pargp"], []).append(pname)
    for column in ("pargp", "partrans", "parlbnd", "parubnd", "partied"):
        frame[column] = [by_name[n][column] for n in frame["parnme"]]
    if ptype_column:
        frame["ptype"] = ["" if by_name[n]["ptype"] is None else by_name[n]["ptype"] for n in frame["parnme"]]
    frame.to_csv(csv_path, index=False)

    first_names = [f"r{i}" for i in range(n_real)]
    dropped: list[str] = []
    last_source = list(first_names)
    if drop_in_last is not None:
        dropped = [first_names[drop_in_last]]
        last_source = [n for n in first_names if n not in dropped]
    if reverse_last:
        last_source = last_source[::-1]
    last_names = [(rename_in_last or {}).get(n, n) for n in last_source]
    if not shared_names:
        last_names = [f"other_{n}" for n in last_names]
    ordered = sorted(iterations)

    log_cols = [i for i, n in enumerate(par_names) if trans[n] == "log"]
    none_cols = [i for i, n in enumerate(par_names) if trans[n] == "none"]
    base_values: dict[int, dict[str, np.ndarray]] = {}
    for iteration in ordered:
        later = iteration != ordered[0]
        per_name: dict[str, np.ndarray] = {}
        for name in first_names:
            row = np.empty(len(par_names))
            for col, pname in enumerate(par_names):
                kind = trans[pname]
                if kind == "log":
                    row[col] = _draw(rng, 6, 60, 1)[0] if later else _draw(rng, 4, 40, 1)[0]
                elif kind == "none":
                    row[col] = _draw(rng, 12, 36, 1)[0] if later else _draw(rng, 10, 30, 1)[0]
                elif kind == "fixed":
                    row[col] = FIXED_VALUE
                else:
                    row[col] = 0.0
            per_name[name] = row
        base_values[iteration] = per_name
    # Tied columns carry the value of the parameter they are tied to.
    for per_name in base_values.values():
        for row in per_name.values():
            for col, pname in enumerate(par_names):
                if trans[pname] == "tied":
                    row[col] = row[par_names.index(by_name[pname]["partied"])]

    real_names: dict[int, list[str]] = {}
    values: dict[int, np.ndarray] = {}
    par_ens: dict[int, Path] = {}
    for iteration in ordered:
        later = iteration != ordered[0]
        names = last_names if later else first_names
        # The names written may be reordered or renamed; the values follow
        # the original realization either way.
        source = last_source if later else first_names
        array = np.vstack([base_values[iteration][s] for s in source])
        real_names[iteration] = list(names)
        values[iteration] = array

    first = ordered[0]
    if near_zero and none_cols:
        col = none_cols[0]
        column = values[first][:, col]
        # The mean that matters is the one over the realizations both files share.
        shared = {n for n in last_names} if len(ordered) > 1 else set(real_names[first])
        use = [i for i, n in enumerate(real_names[first]) if n in shared]
        centred = column - column[use].mean()
        sd = centred[use].std()
        values[first][:, col] = np.round((centred + 0.005 * sd) * 256.0) / 256.0
        # Rounding to 1/256 must leave the mean below one percent of the sd.
        assert abs(values[first][use, col].mean()) < 0.01 * values[first][use, col].std()
    if zero_sd and len(none_cols) > 1:
        values[first][:, none_cols[1]] = 17.0
    if nonpositive_log and log_cols:
        values[first][0, log_cols[0]] = -19.0
    for (iteration, pname), column in (overrides or {}).items():
        values[iteration][:, par_names.index(pname)] = np.asarray(column, dtype=np.float64)

    for iteration in ordered:
        writer, extension = _ENSEMBLE_WRITERS[ensemble_format]
        path = root / f"{case}.{iteration}.par.{extension}"
        writer(path, values[iteration], real_names[iteration], par_names)
        par_ens[iteration] = path

    pcs_path = None
    if pcs_rows is not None:
        pcs_path = write_pcs(root / f"{case}.{ordered[-1]}.pcs.csv", pcs_rows)

    return ParViewRun(
        root=root,
        case=case,
        pst_path=pst_path,
        par_names=par_names,
        groups=group_names,
        trans=trans,
        par_ens=par_ens,
        real_names=real_names,
        values=values,
        dropped=dropped,
        pcs_path=pcs_path,
        lower=lower,
        upper=upper,
    )


def numeric_space(run: ParViewRun, iteration: int, parname: str, names: list[str]) -> np.ndarray:
    """The parameter's values over ``names`` (realization names), in pestpp's
    numeric space: log10 for a log parameter, native otherwise."""
    column = run.table(iteration).loc[names, parname].to_numpy(dtype=np.float64)
    return np.log10(column) if run.trans[parname] == "log" else column
