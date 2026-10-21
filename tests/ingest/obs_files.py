"""Observation-ensemble file helpers shared by the obs read and guard tests.

Everything writes only to a caller-supplied path (in practice ``tmp_path``).
"""

from __future__ import annotations

from pathlib import Path

import numpy as np

from . import fixtures

_WRITERS = {
    "jcb": fixtures.write_jcb_ensemble,
    "legacy_jcb": fixtures.write_legacy_jcb_ensemble,
    "dense": fixtures.write_dense_ensemble,
    "csv": fixtures.write_csv_ensemble,
    "variable_major_csv": fixtures.write_variable_major_csv_ensemble,
}

DIALECTS = tuple(_WRITERS)


def obs_names(n: int, prefix: str = "obs") -> list[str]:
    """PstFrom-like observation names in control order, all lower case.
    Too long for the legacy dialect's 12-character field; use
    ``short_obs_names`` there."""
    return [f"{prefix}_oname:head_k:0_i:{i}_datetime:2020-01-{1 + i % 28:02d}" for i in range(n)]


def short_obs_names(n: int) -> list[str]:
    """Names that fit the legacy dialect's 12-character column field."""
    return [f"o{i:03d}" for i in range(n)]


def hash_ordered(names: list[str]) -> list[str]:
    """The same names in a stable, non-control order (SHA-256 of each name)."""
    import hashlib

    return sorted(names, key=lambda name: hashlib.sha256(name.encode()).hexdigest())


def write_obs_ensemble_file(
    path: Path,
    dialect: str,
    values: np.ndarray,
    real_names: list[str],
    names: list[str],
) -> Path:
    """Write ``values`` (realizations by observations) in one of the five dialects."""
    return _WRITERS[dialect](Path(path), values, list(real_names), list(names))


def write_header_only_coo(path: Path, nrow: int, ncol: int, icount: int = 0) -> Path:
    """A modern COO file whose header claims ``nrow`` by ``ncol`` with
    ``icount`` records, sized exactly as that header implies but left
    sparse (NUL bytes), so a test can ask the guard about a huge read
    without writing a huge file. It is never meant to be read."""
    path = Path(path)
    header = np.array([(ncol, nrow, icount)], dtype="<i4,<i4,<i4")
    with open(path, "wb") as f:
        f.write(header.tobytes())
        f.truncate(12 + 16 * icount + 200 * (ncol + nrow))
    return path
