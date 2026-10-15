"""One pilot-point group's per-cell field: the point values by name, the
interpolation through the library that wrote the factor file, the memo,
and the points behind one cell for the readout.

Text factor files go through pyemu's ``fac2real`` with ``try_ppu=False``,
which is PEST's own arithmetic including the log-space case. Binary
factor files go through ``pypestutils.krige_using_file``. Neither library
is imported at module scope."""

from __future__ import annotations

import contextlib
import io
from pathlib import Path
from typing import Callable

import numpy as np

from pesto.cache._atomic import write_atomic_bytes
from pesto.cache.layout import CacheLayout
from pesto.ingest.ensembles import StoredEnsemble
from pesto.ingest.failures import ReadFailure
from pesto.ingest.ppfactors import PpGroup
from pesto.model import GridShape


def _positions(stored: StoredEnsemble, parnames: tuple[str, ...]) -> list[int] | ReadFailure:
    index = {name: i for i, name in enumerate(stored.par_names)}
    missing = [n for n in parnames if n not in index]
    if missing:
        return ReadFailure(
            name=f"par_ens/{stored.iteration}",
            path=str(stored.path),
            reason=f"parameter(s) {', '.join(missing[:5])} are not in this ensemble",
        )
    return [index[n] for n in parnames]


def point_values(stored: StoredEnsemble, parnames: tuple[str, ...], realization: str) -> np.ndarray | ReadFailure:
    """The named parameters' values for one realization, in ``parnames``
    order, from whichever block each one sits in."""
    from pesto.ingest.ensembles import read_realization_field

    control = _positions(stored, parnames)
    if isinstance(control, ReadFailure):
        return control
    full = read_realization_field(stored, realization)
    if isinstance(full, ReadFailure):
        return full
    return np.asarray(full[control], dtype=np.float64)


def stat_values(layout: CacheLayout, iteration: int, parnames: tuple[str, ...], stored: StoredEnsemble, stat: str) -> np.ndarray | ReadFailure:
    """The named parameters' statistic, from the aggregate table, which is
    in control-file order like ``stored.par_names``."""
    import pandas as pd

    control = _positions(stored, parnames)
    if isinstance(control, ReadFailure):
        return control
    path = layout.par_agg(iteration)
    try:
        column = pd.read_parquet(path, columns=[stat])[stat].to_numpy(dtype=np.float64)
    except Exception as exc:
        return ReadFailure(name=f"par_agg/{iteration}", path=str(path), reason=f"no usable column {stat!r}: {exc}")
    return column[control]


def compute_field(run_dir: Path, group: PpGroup, values: np.ndarray, shape: GridShape) -> np.ndarray | ReadFailure:
    """Weights times point values, as float32 per cell, NaN where the
    factor file names no weight for a cell."""
    path = Path(run_dir) / group.factor_file
    if not path.is_file():
        return ReadFailure(name=group.group, path=str(path), reason=f"factor file {group.factor_file} is not in the run directory")
    if group.format == "text":
        from pesto.warm import load_pyemu

        pyemu = load_pyemu()
        import pandas as pd

        points = pd.DataFrame({"name": list(group.pp_names), "parval1": np.asarray(values, dtype=np.float64)})
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                arr = pyemu.utils.geostats.fac2real(pp_file=points, factors_file=str(path), try_ppu=False, fill_value=np.nan)
        except Exception as exc:
            return ReadFailure(name=group.group, path=str(path), reason=f"fac2real failed on {group.factor_file}: {exc}")
        field = np.asarray(arr, dtype=np.float32).reshape(-1)
    elif group.format == "binary":
        field = _binary_field(path, group, values, shape)
        if isinstance(field, ReadFailure):
            return field
    else:
        return ReadFailure(name=group.group, path=str(path), reason=f"unknown factor file format {group.format!r}")
    if field.shape[0] != shape.ncpl:
        return ReadFailure(
            name=group.group,
            path=str(path),
            reason=f"{group.factor_file} describes {field.shape[0]} cells, the grid has {shape.ncpl}",
        )
    return field


def _binary_field(path: Path, group: PpGroup, values: np.ndarray, shape: GridShape) -> np.ndarray | ReadFailure:
    try:
        from pesto.warm import load_pypestutils

        load_pypestutils()
        from pypestutils.pestutilslib import PestUtilsLib
    except ImportError:
        return ReadFailure(name=group.group, path=str(path), reason="pypestutils is not installed, so a binary factor file cannot be applied")
    try:
        lib = PestUtilsLib()
        result = lib.krige_using_file(
            str(path), "binary", shape.ncpl, "ordinary", "log" if group.log_space else "none",
            np.asarray(values, dtype=np.float64), None, np.nan,
        )
    except BaseException as exc:  # PestUtilsLibError derives from BaseException
        return ReadFailure(name=group.group, path=str(path), reason=f"pypestutils refused {group.factor_file}: {exc}")
    return np.asarray(result["targval"], dtype=np.float32)


def memo_field(layout: CacheLayout, group: str, iteration: int, tag: str, key: str, n_cells: int, compute: Callable[[], np.ndarray | ReadFailure]) -> np.ndarray | ReadFailure:
    """Read the field back from the cache, or compute it once and keep it.
    An unreadable or wrong-length memo file is recomputed and rewritten,
    never served."""
    path = layout.pp_field(group, iteration, tag, key)
    if path.is_file():
        try:
            memo = np.fromfile(path, dtype="<f4")
            if memo.shape[0] == n_cells:
                return memo
        except OSError:
            pass
    field = compute()
    if isinstance(field, ReadFailure):
        return field
    data = np.ascontiguousarray(field, dtype="<f4")
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        write_atomic_bytes(path, lambda f: f.write(data.tobytes()))
    except OSError:
        pass  # a failed memo write is a convenience lost, not a wrong answer
    return field


def contributors(run_dir: Path, group: PpGroup, cell: int) -> list[tuple[str, float]] | ReadFailure:
    """The parameters behind one cell with their weights, largest first.
    Reads the factor file's own line for that cell; empty when it has none."""
    path = Path(run_dir) / group.factor_file
    if group.format != "text":
        return ReadFailure(name=group.group, path=str(path), reason=f"{group.factor_file} is a binary factor file, and pesto lists the points behind a cell only from text factor files")
    try:
        with path.open() as f:
            for _ in range(4):
                f.readline()
            npp = len(group.pp_names)
            for _ in range(npp):
                f.readline()
            while True:
                line = f.readline()
                if not line:
                    return []
                raw = line.split()
                if not raw:
                    continue
                node, nfac = int(raw[0]), int(raw[2])
                items = raw[4:]
                while len(items) < 2 * nfac:
                    items.extend(f.readline().split())
                if node - 1 != cell:
                    continue
                pairs = [(group.parnames[int(items[i]) - 1], float(items[i + 1])) for i in range(0, 2 * nfac, 2)]
                return sorted(pairs, key=lambda p: -p[1])
    except (OSError, ValueError, IndexError) as exc:
        return ReadFailure(name=group.group, path=str(path), reason=f"could not read {group.factor_file}: {exc}")
