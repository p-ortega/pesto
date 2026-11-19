"""A made-up pestpp-ies run, written as files so a first-time user has something to open.

``write_example_run`` writes a run folder that pesto's normal ingest reads end
to end: a control file, a run record, a structured grid file, parameter and
observation ensembles for four iterations, the noise and weights files, phi
and conflict tables, and pilot-point factor files.

Nothing here comes from a real study. The grid, the wells and every number
are invented. The "model" is a small formula that turns parameters into
heads, and the later iterations come from a real ensemble-smoother update
against that formula, so the posterior is narrower than the prior and has
moved for a reason. The folder holds what pesto reads; it is not a PEST
setup anyone could run.

pyemu loads inside functions only (see ``pesto.warm``), and every random
draw has its own seeded generator.
"""

from __future__ import annotations

import contextlib
import io
import os
import shutil
from dataclasses import dataclass
from pathlib import Path

import numpy as np

CASE = "example"
GRID_FILE = "gwf.dis.grb"

NLAY, NROW, NCOL = 3, 40, 60
CELL_SIZE = 50.0
N_REAL = 100  # 99 numbered realizations and base
ITERATIONS = (0, 1, 2, 3)
N_TIMES = 24
PP_SPACING = 5
PESTPP_VERSION = "5.2.16"

# Realizations whose model run "failed" at each iteration; they are gone from then on.
DROPPED = {1: ("17", "42"), 2: ("63",), 3: ("8",)}

WELL_LAYERS = (0, 1, 0, 2, 1, 0, 2, 0, 1, 2, 0, 1, 0, 2, 1)
WELL_SD = (0.20, 0.25, 0.30, 0.40)
UNWEIGHTED_WELL = 12  # kept as a model output only
CONFLICT_WELL = 6  # its last readings fall away in a way the formula cannot follow
CONFLICT_MONTHS = 6
CONFLICT_DROP = 5.0  # metres, reached in the last month

_SEED_PRIOR = 20260101
_SEED_TRUTH = 20260102
_SEED_WELLS = 20260103
_SEED_MEASURED = 20260104
_SEED_NOISE = 20260105

_GR_BOUNDS = (0.2, 5.0)
_PP_BOUNDS = (0.1, 10.0)
_CN = (
    # group, prior sd in log10, lower, upper
    ("rchmult", 0.08, 0.5, 2.0),
    ("ghbcondmult", 0.25, 0.1, 10.0),
    ("npfk33mult", 0.25, 0.1, 10.0),
    ("stossmult", 0.20, 0.1, 10.0),
)
_PP_PROPERTIES = (
    # group, layer index, prior sd in log10
    ("npfklayer1pp", 0, 0.30),
    ("npfklayer2pp", 1, 0.30),
    ("npfklayer3pp", 2, 0.30),
    ("stosylayer1pp", 0, 0.20),
)
_GR_SD = 0.12

PDC_HEADER = (
    "name,obs_mean,obs_std,obs_min,obs_max,obs_stat_min,obs_stat_max,"
    "sim_mean,sim_std,sim_min,sim_max,sim_stat_min,sim_stat_max,distance"
)
_REC_GROUP_HEADER = (
    "group                                   count  mean chg  std chg  n at ubnd  "
    "% at ubnd  n at lbnd  % at lbnd  n std decr"
)


# ---------------------------------------------------------------------------
# Grid
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class _Grid:
    idomain: np.ndarray  # (nlay, nrow, ncol), 1 inside the model
    top: np.ndarray  # (nrow, ncol)
    botm: np.ndarray  # (nlay, nrow, ncol)
    x: np.ndarray  # (nrow, ncol) cell centres
    y: np.ndarray
    u: np.ndarray  # (nrow, ncol) centred position, -1 to 1 across the grid
    v: np.ndarray


def _grid() -> _Grid:
    jj, ii = np.meshgrid(np.arange(NCOL, dtype=np.float64), np.arange(NROW, dtype=np.float64))
    x = (jj + 0.5) * CELL_SIZE
    y = (NROW - ii - 0.5) * CELL_SIZE  # row 0 is the top row
    u = (jj + 0.5 - NCOL / 2) / (NCOL / 2)
    v = (NROW / 2 - ii - 0.5) / (NROW / 2)
    theta = np.arctan2(v, u)
    edge = 0.88 + 0.09 * np.sin(3 * theta + 0.6) + 0.06 * np.sin(5 * theta + 2.0) + 0.03 * np.sin(9 * theta + 1.0)
    inside = np.hypot(u, v) < edge
    idomain = np.zeros((NLAY, NROW, NCOL), dtype=np.int32)
    idomain[0] = inside
    idomain[1] = inside
    # The deepest layer pinches out along one side.
    idomain[2] = inside & (u + 0.5 * v < 0.55)

    top = 40.0 - 6.0 * (u + 1.0) + 1.5 * np.sin(ii / 7.0) * np.cos(jj / 9.0)
    botm = np.empty((NLAY, NROW, NCOL), dtype=np.float64)
    botm[0] = top - 12.0
    botm[1] = botm[0] - 8.0
    botm[2] = botm[1] - 20.0 + 3.0 * np.sin(jj / 11.0)
    return _Grid(idomain=idomain, top=top, botm=botm, x=x, y=y, u=u, v=v)


def _write_grb(path: Path, grid: _Grid) -> None:
    """A MODFLOW 6 binary grid file for a DIS grid: four 50-character header
    lines, one 100-character line per record, then the records' bytes."""
    ncells = NLAY * NROW * NCOL
    records = [
        ("NCELLS", "INTEGER", (), ncells),
        ("NLAY", "INTEGER", (), NLAY),
        ("NROW", "INTEGER", (), NROW),
        ("NCOL", "INTEGER", (), NCOL),
        ("NJA", "INTEGER", (), ncells),
        ("XORIGIN", "DOUBLE", (), 0.0),
        ("YORIGIN", "DOUBLE", (), 0.0),
        ("ANGROT", "DOUBLE", (), 0.0),
        ("DELR", "DOUBLE", (NCOL,), np.full(NCOL, CELL_SIZE)),
        ("DELC", "DOUBLE", (NROW,), np.full(NROW, CELL_SIZE)),
        ("TOP", "DOUBLE", (NROW * NCOL,), grid.top),
        ("BOTM", "DOUBLE", (ncells,), grid.botm),
        # pesto never reads the connections, so each cell lists only itself.
        ("IA", "INTEGER", (ncells + 1,), np.arange(1, ncells + 2)),
        ("JA", "INTEGER", (ncells,), np.arange(1, ncells + 1)),
        ("IDOMAIN", "INTEGER", (ncells,), grid.idomain),
    ]
    dtypes = {"INTEGER": np.int32, "DOUBLE": np.float64}
    with open(path, "wb") as f:
        for line in ("GRID DIS", "VERSION 1", f"NTXT {len(records)}", "LENTXT 100"):
            f.write(line.ljust(50).encode("ascii"))
        for key, kind, shape, _payload in records:
            text = " ".join([key, kind, "NDIM", str(len(shape)), *(str(d) for d in shape)])
            f.write(text.ljust(100).encode("ascii"))
        for _key, kind, _shape, payload in records:
            f.write(np.asarray(payload, dtype=dtypes[kind]).reshape(-1).tobytes())


# ---------------------------------------------------------------------------
# Parameters
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class _Group:
    name: str
    ptype: str  # "gr" | "pp" | "cn"
    layer: int | None
    start: int  # first column of this group in the parameter vector
    count: int
    sd: float  # prior sd in log10
    lower: float
    upper: float
    rows: np.ndarray | None = None  # grid row of each parameter
    cols: np.ndarray | None = None


def _groups(grid: _Grid) -> list[_Group]:
    groups: list[_Group] = []
    start = 0
    for layer in range(NLAY):
        rows, cols = np.nonzero(grid.idomain[layer] > 0)
        groups.append(
            _Group(f"npfklayer{layer + 1}gr", "gr", layer, start, rows.size, _GR_SD, *_GR_BOUNDS, rows, cols)
        )
        start += rows.size
    for name, layer, sd in _PP_PROPERTIES:
        ii, jj = np.meshgrid(
            np.arange(PP_SPACING // 2, NROW, PP_SPACING), np.arange(PP_SPACING // 2, NCOL, PP_SPACING), indexing="ij"
        )
        keep = grid.idomain[layer][ii, jj] > 0
        rows, cols = ii[keep], jj[keep]
        groups.append(_Group(name, "pp", layer, start, rows.size, sd, *_PP_BOUNDS, rows, cols))
        start += rows.size
    for name, sd, lower, upper in _CN:
        groups.append(_Group(name, "cn", None, start, 1, sd, lower, upper))
        start += 1
    return groups


def _par_names(group: _Group, grid: _Grid) -> list[str]:
    stem = f"pname:{group.name}_inst:0_ptype:{group.ptype}_pstyle:m"
    if group.ptype == "cn":
        return [stem]
    names = []
    for i, j in zip(group.rows.tolist(), group.cols.tolist()):
        where = f"_x:{grid.x[i, j]:.2f}_y:{grid.y[i, j]:.2f}"
        if group.ptype == "gr":
            where = f"_i:{i}_j:{j}" + where
        names.append(stem + where)
    return names


def _smooth_fields(rng: np.random.Generator, n: int, range_cells: float) -> np.ndarray:
    """``n`` smooth random fields of shape (nrow, ncol) with unit spread."""
    pad = int(4 * range_cells) + 1
    shape = (NROW + 2 * pad, NCOL + 2 * pad)
    noise = rng.standard_normal((n, *shape))
    ky = np.fft.fftfreq(shape[0])[:, None]
    kx = np.fft.rfftfreq(shape[1])[None, :]
    keep = np.exp(-2.0 * np.pi**2 * range_cells**2 * (kx**2 + ky**2))
    fields = np.fft.irfft2(np.fft.rfft2(noise) * keep, s=shape)[:, pad:-pad, pad:-pad]
    return fields / fields.std()


def _draw(groups: list[_Group], rng: np.random.Generator, n: int) -> np.ndarray:
    """``n`` draws of every parameter in log10, shape (n, n_par)."""
    n_par = groups[-1].start + groups[-1].count
    out = np.empty((n, n_par), dtype=np.float64)
    for group in groups:
        span = slice(group.start, group.start + group.count)
        if group.ptype == "cn":
            out[:, span] = group.sd * rng.standard_normal((n, 1))
        else:
            fields = _smooth_fields(rng, n, 2.5 if group.ptype == "gr" else 9.0)
            out[:, span] = group.sd * fields[:, group.rows, group.cols]
    return out


def _clip(log_values: np.ndarray, groups: list[_Group]) -> np.ndarray:
    for group in groups:
        span = slice(group.start, group.start + group.count)
        np.clip(log_values[:, span], np.log10(group.lower), np.log10(group.upper), out=log_values[:, span])
    return log_values


def _truth(groups: list[_Group], grid: _Grid) -> np.ndarray:
    """The parameters the "measurements" come from: one more draw, plus a
    winding high-K band in layer 1 and a low-K patch in layer 2, so the
    posterior has a shape to find."""
    truth = _draw(groups, np.random.default_rng(_SEED_TRUTH), 1)
    for group in groups:
        span = slice(group.start, group.start + group.count)
        if group.name == "npfklayer1pp":
            u, v = grid.u[group.rows, group.cols], grid.v[group.rows, group.cols]
            truth[0, span] += 0.4 * np.exp(-(((v - 0.35 * np.sin(3.0 * u)) / 0.3) ** 2))
        elif group.name == "npfklayer2pp":
            u, v = grid.u[group.rows, group.cols], grid.v[group.rows, group.cols]
            truth[0, span] -= 0.4 * np.exp(-(((u + 0.3) / 0.35) ** 2 + ((v + 0.2) / 0.45) ** 2))
        elif group.name == "rchmult":
            truth[0, span] += 0.06
    return _clip(truth, groups)


def _pp_weights(group: _Group, grid: _Grid) -> tuple[np.ndarray, np.ndarray]:
    """For each cell of the group's layer that is in the model, the weight of
    each pilot point. Distance weights over the nearest points stand in for
    kriging factors. Returns the flat cell numbers and a (cells, points) array."""
    rows, cols = np.nonzero(grid.idomain[group.layer] > 0)
    distance2 = (rows[:, None] - group.rows[None, :]) ** 2.0 + (cols[:, None] - group.cols[None, :]) ** 2.0
    weights = np.exp(-distance2 / (2.0 * (0.7 * PP_SPACING) ** 2))
    # Keep the eight nearest points of each cell.
    cut = np.sort(weights, axis=1)[:, -8][:, None]
    weights = np.where(weights >= cut, weights, 0.0)
    weights = np.round(weights / weights.sum(axis=1, keepdims=True), 6)
    return rows * NCOL + cols, weights


# ---------------------------------------------------------------------------
# Wells and the head formula
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class _Well:
    name: str
    layer: int
    row: int
    col: int
    sd: float
    weight: float


def _wells(grid: _Grid) -> list[_Well]:
    rng = np.random.default_rng(_SEED_WELLS)
    # Stay a few cells in from the model edge.
    core = np.hypot(grid.u, grid.v) < 0.62
    chosen: list[tuple[int, int]] = []
    wells: list[_Well] = []
    for number, layer in enumerate(WELL_LAYERS):
        rows, cols = np.nonzero(core & (grid.idomain[layer] > 0))
        for pick in rng.permutation(rows.size):
            row, col = int(rows[pick]), int(cols[pick])
            if all((row - r) ** 2 + (col - c) ** 2 >= 49 for r, c in chosen):
                break
        chosen.append((row, col))
        sd = WELL_SD[number % len(WELL_SD)]
        weight = 0.0 if number == UNWEIGHTED_WELL else 1.0 / sd
        wells.append(_Well(f"well-{number + 1:02d}", layer, row, col, sd, weight))
    return wells


def _months() -> list[str]:
    """Month ends over two years, as text."""
    out = []
    for month in range(N_TIMES):
        first_of_next = np.datetime64(f"{2021 + (month + 1) // 12}-{(month + 1) % 12 + 1:02d}-01")
        out.append(str(first_of_next - np.timedelta64(1, "D")))
    return out


class _HeadModel:
    """The stand-in for a groundwater model: heads at the wells as a formula
    of the log10 parameters. Local and regional K lower the head, recharge
    raises it, and specific yield damps the seasonal swing and a slow decline."""

    def __init__(self, groups: list[_Group], grid: _Grid, wells: list[_Well]):
        n_par = groups[-1].start + groups[-1].count
        by_name = {g.name: g for g in groups}
        self.local = np.zeros((len(wells), n_par))
        self.regional = np.zeros((len(wells), n_par))
        self.yield_ = np.zeros((len(wells), n_par))
        self.cn = {g.name: g.start for g in groups if g.ptype == "cn"}
        weights = {g.name: _pp_weights(g, grid) for g in groups if g.ptype == "pp"}

        def add(target: np.ndarray, w: int, layer: int, reach: float, share: float, names: tuple[str, ...]) -> None:
            """Add ``share`` of the average, within ``reach`` cells of well ``w``,
            of the fields named in ``names`` on ``layer``."""
            well = wells[w]
            rows, cols = np.nonzero(grid.idomain[layer] > 0)
            kernel = np.exp(-((rows - well.row) ** 2.0 + (cols - well.col) ** 2.0) / (2.0 * reach**2))
            kernel /= kernel.sum()
            for name in names:
                group = by_name[name]
                span = slice(group.start, group.start + group.count)
                if group.ptype == "gr":
                    target[w, span] += share * kernel
                else:
                    target[w, span] += share * (kernel @ weights[name][1])

        def k_fields(layer: int) -> tuple[str, str]:
            return f"npfklayer{layer + 1}gr", f"npfklayer{layer + 1}pp"

        for w, well in enumerate(wells):
            add(self.local, w, well.layer, 3.0, 1.0, k_fields(well.layer))
            for layer in range(NLAY):
                add(self.regional, w, layer, 10.0, 0.5 if layer == well.layer else 0.25, k_fields(layer))
            add(self.yield_, w, 0, 4.0, 1.0, ("stosylayer1pp",))

        self.east = np.array([(grid.u[w.row, w.col] + 1.0) / 2.0 for w in wells])
        self.depth = np.array([float(w.layer) for w in wells])
        self.month = np.arange(N_TIMES, dtype=np.float64)

    def heads(self, log_par: np.ndarray) -> np.ndarray:
        """Heads for each row of ``log_par``, shape (n, wells * times), well by well."""
        local = log_par @ self.local.T
        regional = log_par @ self.regional.T
        storage = log_par @ self.yield_.T
        rch = log_par[:, [self.cn["rchmult"]]]
        ghb = log_par[:, [self.cn["ghbcondmult"]]]
        k33 = log_par[:, [self.cn["npfk33mult"]]]
        ss = log_par[:, [self.cn["stossmult"]]]

        steady = (
            31.0
            - 13.0 * self.east
            - 0.6 * self.depth
            - 2.0 * local
            - 4.0 * regional
            + 7.0 * rch * (1.0 - 0.4 * self.east)
            + 1.2 * ghb * self.east
            - 0.5 * k33 * self.depth
        )
        damping = 10.0 ** (-(storage + 0.4 * ss * (self.depth > 0)))
        swing = 0.9 * 0.65**self.depth * damping * 10.0 ** (0.5 * rch)
        phase = 2.0 * np.pi * (self.month[None, None, :] - 2.0 - self.depth[None, :, None]) / 12.0
        decline = -0.7 * damping * 10.0 ** (-0.3 * local)
        out = (
            steady[:, :, None]
            + swing[:, :, None] * np.sin(phase)
            + decline[:, :, None] * (self.month[None, None, :] / N_TIMES)
        )
        return out.reshape(log_par.shape[0], -1)


def _smoother_step(
    par: np.ndarray, sim: np.ndarray, target: np.ndarray, sd: np.ndarray, inflate: float
) -> np.ndarray:
    """One ensemble-smoother update of ``par`` (reals, n_par) towards ``target``
    (reals, n_obs), with the noise variance inflated by ``inflate``."""
    n = par.shape[0]
    par_dev = par - par.mean(axis=0)
    sim_dev = sim - sim.mean(axis=0)
    cov = sim_dev.T @ sim_dev / (n - 1) + inflate * np.diag(sd**2)
    pull = np.linalg.solve(cov, (target - sim).T)
    return par + (par_dev.T @ (sim_dev @ pull)).T / (n - 1)


# ---------------------------------------------------------------------------
# File writers
# ---------------------------------------------------------------------------


def _write_matrix(path: Path, values: np.ndarray, real_names: list[str], col_names: list[str]) -> None:
    """Write realizations by columns in pestpp's dense binary format."""
    from pesto.warm import load_pyemu

    pyemu = load_pyemu()
    pyemu.Matrix.write_dense(
        str(path),
        row_names=list(real_names),
        col_names=list(col_names),
        data=np.asarray(values, dtype=np.float64),
        close=True,
    )


def _write_control(
    run_dir: Path,
    groups: list[_Group],
    par_names: list[str],
    grid: _Grid,
    wells: list[_Well],
    obs_names: list[str],
    obsval: np.ndarray,
) -> None:
    from pesto.warm import load_pyemu

    pyemu = load_pyemu()
    pst = pyemu.Pst.from_par_obs_names(par_names=par_names, obs_names=obs_names)
    pst.control_data.noptmax = max(ITERATIONS)
    pst.pestpp_options.update(
        {"ies_num_reals": N_REAL, "ies_drop_conflicts": True, "ies_save_binary": True, "save_dense": True}
    )
    pst.model_command = ["python forward_run.py"]

    def text(value) -> str | None:
        return None if value is None else str(value)

    par_columns: dict[str, list] = {
        key: [] for key in ("pargp", "parlbnd", "parubnd", "pname", "inst", "ptype", "pstyle", "i", "j", "x", "y")
    }
    for group in groups:
        for n in range(group.count):
            placed = group.ptype != "cn"
            i = int(group.rows[n]) if placed else None
            j = int(group.cols[n]) if placed else None
            par_columns["pargp"].append(group.name)
            par_columns["parlbnd"].append(group.lower)
            par_columns["parubnd"].append(group.upper)
            par_columns["pname"].append(group.name)
            par_columns["inst"].append("0")
            par_columns["ptype"].append(group.ptype)
            par_columns["pstyle"].append("m")
            # A pilot point is placed by x and y; only a grid parameter names its cell.
            par_columns["i"].append(text(i) if group.ptype == "gr" else None)
            par_columns["j"].append(text(j) if group.ptype == "gr" else None)
            par_columns["x"].append(f"{grid.x[i, j]:.2f}" if placed else None)
            par_columns["y"].append(f"{grid.y[i, j]:.2f}" if placed else None)
    # from_par_obs_names sorts the names; the control file keeps the order built here.
    pst.parameter_data = pst.parameter_data.loc[par_names].copy()
    par = pst.parameter_data
    par["parval1"] = 1.0
    par["partrans"] = "log"
    for column, values in par_columns.items():
        par[column] = values

    months = _months()
    obs_columns: dict[str, list] = {
        key: []
        for key in (
            "obsval", "weight", "obgnme", "oname", "otype", "usecol", "datetime", "k", "i", "j", "x", "y",
            "standard_deviation",
        )
    }
    for w, well in enumerate(wells):
        for t in range(N_TIMES):
            obs_columns["obsval"].append(float(obsval[w * N_TIMES + t]))
            obs_columns["weight"].append(well.weight)
            obs_columns["obgnme"].append(f"hds_layer{well.layer + 1}")
            obs_columns["oname"].append("hds")
            obs_columns["otype"].append("lst")
            obs_columns["usecol"].append(well.name)
            obs_columns["datetime"].append(months[t])
            obs_columns["k"].append(str(well.layer))
            obs_columns["i"].append(str(well.row))
            obs_columns["j"].append(str(well.col))
            obs_columns["x"].append(f"{grid.x[well.row, well.col]:.2f}")
            obs_columns["y"].append(f"{grid.y[well.row, well.col]:.2f}")
            obs_columns["standard_deviation"].append(well.sd)
    pst.observation_data = pst.observation_data.loc[obs_names].copy()
    for column, values in obs_columns.items():
        pst.observation_data[column] = values

    # pyemu prints a summary line when it writes.
    with contextlib.redirect_stdout(io.StringIO()):
        pst.write(str(run_dir / f"{CASE}.pst"), version=2)


def _write_pilot_points(run_dir: Path, groups: list[_Group], par_names: list[str], grid: _Grid) -> None:
    """The pilot-point file, its template and its factor file for each
    pilot-point group, and the table that links them."""
    link_rows = []
    for group in groups:
        if group.ptype == "gr":
            link_rows.append((f"org/{group.name[:-2]}.txt", f"{group.name[:-2]}.txt", f"mult/{group.name}_inst0_grid.csv", "", ""))
            continue
        if group.ptype != "pp":
            continue
        pp_file = f"{group.name}_inst0pp.dat"
        fac_file = f"{group.name}_inst0pp.fac"
        points = [f"pp_{n:04d}" for n in range(group.count)]
        data_lines, tpl_lines = [], ["ptf ~"]
        for n, point in enumerate(points):
            i, j = int(group.rows[n]), int(group.cols[n])
            where = f"{point} {grid.x[i, j]:.2f} {grid.y[i, j]:.2f} 1"
            data_lines.append(f"{where} 1.0")
            tpl_lines.append(f"{where} ~   {par_names[group.start + n]}   ~")
        (run_dir / pp_file).write_text("\n".join(data_lines) + "\n", encoding="utf-8", newline="\n")
        (run_dir / f"{pp_file}.tpl").write_text("\n".join(tpl_lines) + "\n", encoding="utf-8", newline="\n")

        cells, weights = _pp_weights(group, grid)
        lines = [pp_file, "zone.junk", f"{NCOL} {NROW}", str(group.count), *points]
        for cell, row in zip(cells.tolist(), weights):
            used = np.flatnonzero(row > 0)
            pairs = " ".join(f"{p + 1} {row[p]:.6f}" for p in used.tolist())
            # node, 1 for interpolation in log space, point count, offset, then point and weight pairs
            lines.append(f"{cell + 1} 1 {used.size} 0.0 {pairs}")
        (run_dir / fac_file).write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
        link_rows.append(
            (f"org/{group.name[:-2]}.txt", f"{group.name[:-2]}.txt", f"mult/{group.name}_inst0_pp.csv", fac_file, pp_file)
        )
    lines = [",org_file,model_file,mlt_file,fac_file,pp_file"]
    lines.extend(f"{n},{','.join(row)}" for n, row in enumerate(link_rows))
    (run_dir / "mult2model_info.csv").write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")


def _phi(sim: np.ndarray, target: np.ndarray, weights: np.ndarray) -> np.ndarray:
    return (((sim - target) * weights) ** 2).sum(axis=1)


def _write_phi(path: Path, real_names: list[str], rows: dict[int, dict[str, float]]) -> None:
    """A phi file in pestpp's shape. A realization that left the run has an empty cell."""
    lines = [",".join(["iteration", "total_runs", "mean", "standard_deviation", "min", "max", *real_names])]
    total_runs = 0
    for iteration, phi in rows.items():
        numbers = np.array(list(phi.values()))
        total_runs += N_REAL if iteration == 0 else len(phi) + len(DROPPED.get(iteration, ()))
        cells = [iteration, total_runs, numbers.mean(), numbers.std(ddof=1), numbers.min(), numbers.max()]
        cells.extend(phi.get(name, "") for name in real_names)
        lines.append(",".join(repr(float(c)) if isinstance(c, float) else str(c) for c in cells))
    path.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")


def _write_pdc(path: Path, names: list[str], sim: np.ndarray, noisy: np.ndarray) -> np.ndarray:
    """Prior-data conflict: every observation whose simulated range and
    observation-plus-noise range do not overlap. Returns which columns those are."""
    distance = np.maximum(noisy.min(axis=0) - sim.max(axis=0), sim.min(axis=0) - noisy.max(axis=0))
    conflicts = np.flatnonzero(distance > 0)
    lines = [PDC_HEADER]
    for column in conflicts.tolist():
        cells = [names[column]]
        for values in (noisy[:, column], sim[:, column]):
            mean, std = values.mean(), values.std(ddof=1)
            cells.extend(repr(float(v)) for v in (mean, std, values.min(), values.max(), mean - std, mean + std))
        cells.append(repr(float(distance[column])))
        lines.append(",".join(cells))
    path.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
    return conflicts


def _group_changes(groups: list[_Group], prior: np.ndarray, current: np.ndarray) -> list[tuple]:
    """Per group, how the ensemble changed from the prior, in log10: the
    average percent change of each parameter's mean and spread, how many
    parameter means sit at a bound, and how many spreads fell. An
    approximation of pestpp's own table."""
    rows = []
    for group in groups:
        span = slice(group.start, group.start + group.count)
        mean0, mean1 = prior[:, span].mean(axis=0), current[:, span].mean(axis=0)
        sd0, sd1 = prior[:, span].std(axis=0, ddof=1), current[:, span].std(axis=0, ddof=1)
        mean_change = float(np.mean(100.0 * np.abs(mean1 - mean0) / np.abs(mean0)))
        sd_change = float(np.mean(100.0 * np.abs(sd1 - sd0) / sd0))
        lower, upper = np.log10(group.lower), np.log10(group.upper)
        near = 0.01 * (upper - lower)
        at_upper = int((mean1 >= upper - near).sum())
        at_lower = int((mean1 <= lower + near).sum())
        rows.append(
            (
                group.name, group.count, mean_change, sd_change,
                at_upper, 100.0 * at_upper / group.count, at_lower, 100.0 * at_lower / group.count,
                int((sd1 < sd0).sum()),
            )
        )
    return rows


def _write_pcs(path: Path, rows: list[tuple]) -> None:
    lines = [
        "group,count,mean_change,std_change,num_at_near_ubound,percent_at_near_ubound,"
        "num_at_near_lbound,percent_at_near_lbound,num_std_decrease"
    ]
    lines.extend(",".join(repr(v) if isinstance(v, float) else str(v) for v in row) for row in rows)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")


def _write_rec(path: Path, active: dict[int, int], changes: dict[int, list[tuple]]) -> None:
    """A short run record holding the lines pesto reads: the version, the
    options, what pestpp did about noise, and each iteration's group table."""
    lines = [
        "             pestpp-ies: a GLM iterative ensemble smoother",
        "",
        f"version: {PESTPP_VERSION}",
        "",
        f"using control file: \"{CASE}.pst\"",
        "",
        "...shared pestpp-ies/pestpp-da options:",
        "(note: 'da' args override 'ies' args when using pestpp-da)",
        "ies_parameter_ensemble: ",
        "ies_observation_ensemble: ",
        "ies_weights_ensemble: ",
        f"ies_num_reals: {N_REAL}",
        "ies_include_base: 1",
        "ies_no_noise: 0",
        "ies_reg_factor: 0",
        "ies_save_binary: 1",
        "ies_localizer: ",
        "ies_drop_conflicts: 1",
        "ies_n_iter_reinflate: ",
        "0,",
        "ies_reinflate_factor: ",
        "1,",
        "",
        "pestpp-sen options: ",
        "",
        "Note: the following observations have 'standard_deviation' defined - this will be used",
        f"drawing observation noise realizations: {N_REAL}",
        "...not using localization",
        "...using reg_factor:  0",
    ]
    for iteration, rows in changes.items():
        lines.extend(
            [
                "",
                f"  ---  EnsembleMethod iteration {iteration} report  ---  ",
                f"   number of active realizations:  {active[iteration]}",
                "",
                "",
                "   ---  parameter group change summary  ---    ",
                _REC_GROUP_HEADER,
            ]
        )
        for group, count, mean_chg, std_chg, n_ub, pct_ub, n_lb, pct_lb, n_dec in rows:
            lines.append(
                f"{group:<38}{count:>5} {mean_chg:>9.4g} {std_chg:>8.4g} {n_ub:>10} {pct_ub:>10.4g}"
                f" {n_lb:>10} {pct_lb:>10.4g} {n_dec:>11}"
            )
        lines.extend(["", f"...saved parameter change summary to {CASE}.{iteration}.pcs.csv"])
    path.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")


# ---------------------------------------------------------------------------
# The whole run
# ---------------------------------------------------------------------------


def write_example_run(dest: Path) -> Path:
    """Write the example run into ``dest`` and return ``dest``.

    The same call always writes the same bytes. Files already in ``dest``
    with the same names are replaced.
    """
    run_dir = Path(dest)
    run_dir.mkdir(parents=True, exist_ok=True)

    grid = _grid()
    groups = _groups(grid)
    wells = _wells(grid)
    model = _HeadModel(groups, grid, wells)
    par_names = [name for group in groups for name in _par_names(group, grid)]
    months = _months()
    obs_names = [f"oname:hds_otype:lst_usecol:{well.name}_datetime:{month}" for well in wells for month in months]
    obs_sd = np.repeat([well.sd for well in wells], N_TIMES)
    obs_weight = np.repeat([well.weight for well in wells], N_TIMES)
    weighted = np.flatnonzero(obs_weight > 0)

    # The "measurements": the formula at the truth, a reading error, and the conflict well's drop.
    measured = model.heads(_truth(groups, grid))[0]
    measured = measured + obs_sd * np.random.default_rng(_SEED_MEASURED).standard_normal(measured.size)
    last = slice((CONFLICT_WELL + 1) * N_TIMES - CONFLICT_MONTHS, (CONFLICT_WELL + 1) * N_TIMES)
    measured[last] -= CONFLICT_DROP * np.arange(1, CONFLICT_MONTHS + 1) / CONFLICT_MONTHS
    obsval = np.round(measured, 3)

    real_names = [str(n) for n in range(N_REAL - 1)] + ["base"]
    prior = _draw(groups, np.random.default_rng(_SEED_PRIOR), N_REAL)
    prior[-1] = 0.0  # base is every multiplier at 1
    prior = _clip(prior, groups)
    noise = obs_sd * np.random.default_rng(_SEED_NOISE).standard_normal((N_REAL, obsval.size))
    noise[-1] = 0.0  # base is compared with the measurements as they are
    noise[:, obs_weight == 0] = 0.0  # no noise is drawn for an observation with no weight
    noisy = obsval + noise

    _write_grb(run_dir / GRID_FILE, grid)
    _write_control(run_dir, groups, par_names, grid, wells, obs_names, obsval)
    _write_pilot_points(run_dir, groups, par_names, grid)
    weighted_names = [obs_names[c] for c in weighted.tolist()]
    _write_matrix(run_dir / f"{CASE}.obs+noise.bin", noisy, real_names, obs_names)

    alive = list(range(N_REAL))
    par = prior
    phi_actual: dict[int, dict[str, float]] = {}
    phi_meas: dict[int, dict[str, float]] = {}
    active: dict[int, int] = {}
    changes: dict[int, list[tuple]] = {}
    for iteration in ITERATIONS:
        if iteration > 0:
            step = _smoother_step(par, sim[:, used], noisy[alive][:, used], obs_sd[used], float(max(ITERATIONS)))
            par = _clip(step, groups)
            gone = set(DROPPED.get(iteration, ()))
            keep = [n for n, real in enumerate(alive) if real_names[real] not in gone]
            par, alive = par[keep], [alive[n] for n in keep]
        sim = model.heads(par)
        names = [real_names[real] for real in alive]
        _write_matrix(run_dir / f"{CASE}.{iteration}.par.bin", 10.0**par, names, par_names)
        _write_matrix(run_dir / f"{CASE}.{iteration}.obs.bin", sim, names, obs_names)
        if iteration == 0:
            conflicts = _write_pdc(
                run_dir / f"{CASE}.0.pdc.csv", weighted_names, sim[:, weighted], noisy[:, weighted]
            )
            # pestpp was told to drop conflicts: they keep a column and get weight 0.
            used_weight = obs_weight.copy()
            used_weight[weighted[conflicts]] = 0.0
            used = np.flatnonzero(used_weight > 0)
            _write_matrix(
                run_dir / f"{CASE}.adjusted.weights.bin",
                np.tile(used_weight[weighted], (N_REAL, 1)),
                real_names,
                weighted_names,
            )
        else:
            active[iteration] = len(alive)
            changes[iteration] = _group_changes(groups, prior, par)
            _write_pcs(run_dir / f"{CASE}.{iteration}.pcs.csv", changes[iteration])
        phi_actual[iteration] = dict(zip(names, _phi(sim, obsval, used_weight).tolist()))
        phi_meas[iteration] = dict(zip(names, _phi(sim, noisy[alive], used_weight).tolist()))

    _write_phi(run_dir / f"{CASE}.phi.actual.csv", real_names, phi_actual)
    _write_phi(run_dir / f"{CASE}.phi.meas.csv", real_names, phi_meas)
    _write_rec(run_dir / f"{CASE}.rec", active, changes)
    return run_dir


def example_run_dir() -> Path:
    """Where ``pesto --example`` keeps its run: one folder per pesto version,
    under the same cache folder pesto falls back to for a read-only run."""
    from pesto import __version__
    from pesto.cache.layout import cache_base

    return cache_base() / f"example-{__version__}" / "run"


def ensure_example_run() -> Path:
    """The example run's folder, written first when it is not there yet.

    The run is written beside its final place and renamed in one step, so a
    folder under the final name is always complete.
    """
    final = example_run_dir()
    if final.is_dir():
        return final
    final.parent.mkdir(parents=True, exist_ok=True)
    building = final.with_name(f"{final.name}.building-{os.getpid()}")
    shutil.rmtree(building, ignore_errors=True)
    write_example_run(building)
    try:
        building.rename(final)
    except OSError:
        # Another pesto finished the same folder first.
        shutil.rmtree(building, ignore_errors=True)
        if not final.is_dir():
            raise
    return final
