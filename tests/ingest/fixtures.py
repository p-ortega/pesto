"""Synthetic pestpp-ies run directory and ensemble file generator.

This module resolves the phase's one genuinely open question -- how its
tests get data (02-CONTEXT.md's Deferred Ideas, 02-02-PLAN.md's P-01): every
ensemble shape and control-file variant this phase reads is produced here,
synthetically, from pyemu's own writers, so the whole suite is green on a
fresh clone with no benchmark data and no network access.

A plain module of helper functions -- not a pytest plugin and not a
conftest, so callers import from it explicitly and a reader can see where a
fixture came from. Every writer takes an explicit ``pathlib.Path`` and
writes only to it; nothing here ever reaches outside a caller-supplied
directory (in practice a test's ``tmp_path``), and nothing here references
a real benchmark or archive run directory.
"""

from __future__ import annotations

import csv
import hashlib
from dataclasses import dataclass
from pathlib import Path

import numpy as np

MISSING_FILE = "__pesto_fixtures_missing_file__"
"""Sentinel for ``make_run``'s ``starting_par_en``/``starting_obs_en``
arguments: passing this value gets a control file that names a starting
ensemble file which is never actually created on disk -- the real shape of
``hm_20250406221554``, whose control file names ``prior_pe.jcb`` and whose
working copy on disk does not contain it."""


# ---------------------------------------------------------------------------
# Value and name generators
# ---------------------------------------------------------------------------


def sample_values(n_real: int, n_entity: int, seed: int = 0) -> np.ndarray:
    """Return an ``(n_real, n_entity)`` float64 array of distinct,
    non-degenerate values.

    Built from this function's own ``numpy.random.default_rng(seed)``,
    never numpy's global RNG -- importing pyemu has historically seeded the
    global one (PROJECT.md section Constraints), so nothing in this module
    may rely on it.

    Values are integers drawn from a wide range and then divided by a power
    of two (256), so the float64-to-float32 round trip is exact: dividing
    by a power of two only shifts the binary exponent, and integers in this
    range sit comfortably inside float32's 24-bit mantissa. Downstream
    equality assertions can therefore use exact equality, never a
    tolerance.
    """
    rng = np.random.default_rng(seed)
    integers = rng.integers(-1_000_000, 1_000_000, size=(n_real, n_entity), dtype=np.int64)
    return integers.astype(np.float64) / 256.0


def control_ordered_names(prefix: str, count: int) -> list[str]:
    """Names in the order a control file would list them."""
    return [f"{prefix}{i}" for i in range(count)]


def hash_ordered_names(prefix: str, count: int) -> list[str]:
    """The same set of names as :func:`control_ordered_names`, permuted
    into a stable, non-sorted, non-control-file order.

    The permutation is driven by each name's SHA-256 digest, so it is
    deterministic across processes -- a test can recompute the expected
    order by calling this function again rather than hard-coding it.
    """
    names = control_ordered_names(prefix, count)
    return sorted(names, key=lambda name: hashlib.sha256(name.encode()).hexdigest())


def survivor_names() -> list[str]:
    """The four realizations the design spec names explicitly: row 1 is
    realization ``"34"``, not ``"1"`` (READ-04)."""
    return ["base", "34", "35", "176"]


# ---------------------------------------------------------------------------
# Ensemble writers -- one array of values, five on-disk shapes
# ---------------------------------------------------------------------------


def write_dense_ensemble(
    path: Path, values: np.ndarray, real_names: list[str], entity_names: list[str]
) -> Path:
    """Write ``values`` as pestpp's dense row-stream ``.bin`` format via
    ``pyemu.Matrix.write_dense`` (RESEARCH.md Pattern 2)."""
    from pesto.warm import load_pyemu

    pyemu = load_pyemu()
    path = Path(path)
    pyemu.Matrix.write_dense(
        str(path),
        row_names=list(real_names),
        col_names=list(entity_names),
        data=np.asarray(values, dtype=np.float64),
        close=True,
    )
    return path


def write_jcb_ensemble(
    path: Path, values: np.ndarray, real_names: list[str], entity_names: list[str]
) -> Path:
    """Write ``values`` as the modern sparse-COO ``.jcb`` dialect via
    ``Matrix.to_coo`` -- 200-byte name fields, the dialect real pestpp
    writes for large models."""
    from pesto.warm import load_pyemu

    pyemu = load_pyemu()
    path = Path(path)
    matrix = pyemu.Matrix(
        x=np.asarray(values, dtype=np.float64),
        row_names=list(real_names),
        col_names=list(entity_names),
    )
    matrix.to_coo(str(path))
    return path


def write_legacy_jcb_ensemble(
    path: Path, values: np.ndarray, real_names: list[str], entity_names: list[str]
) -> Path:
    """Write ``values`` as the legacy sparse-COO dialect via
    ``Matrix.to_binary`` -- 12-byte column-name and 20-byte row-name
    fields.

    Names longer than those widths are silently truncated by pyemu with
    only a ``UserWarning`` (a 38-character parameter name came back as 12
    characters during this phase's research session). This function raises
    a clear ``ValueError`` naming the offending name instead of letting
    that truncation happen silently.
    """
    from pesto.warm import load_pyemu

    for name in entity_names:
        if len(name) > 12:
            raise ValueError(
                f"column name too long for the legacy dialect (max 12 characters): {name!r}"
            )
    for name in real_names:
        if len(name) > 20:
            raise ValueError(
                f"row name too long for the legacy dialect (max 20 characters): {name!r}"
            )

    pyemu = load_pyemu()
    path = Path(path)
    matrix = pyemu.Matrix(
        x=np.asarray(values, dtype=np.float64),
        row_names=list(real_names),
        col_names=list(entity_names),
    )
    matrix.to_binary(str(path))
    return path


def write_csv_ensemble(
    path: Path,
    values: np.ndarray,
    real_names: list[str],
    entity_names: list[str],
    header_prefix: str = "",
) -> Path:
    """Write ``values`` as realization-major CSV: a header row of entity
    names with a leading index column, one row per realization named by
    its realization name.

    ``header_prefix`` defaults to the empty string; a test reproduces the
    documented leading-space ``" standard_deviation"`` header case by
    passing a single space, which is prefixed onto the first entity name in
    the header row only -- every data row is untouched.
    """
    path = Path(path)
    values = np.asarray(values)
    header_names = list(entity_names)
    if header_prefix and header_names:
        header_names[0] = f"{header_prefix}{header_names[0]}"

    with open(path, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["real_name", *header_names])
        for name, row in zip(real_names, values):
            writer.writerow([name, *row.tolist()])
    return path


def write_variable_major_csv_ensemble(
    path: Path, values: np.ndarray, real_names: list[str], entity_names: list[str]
) -> Path:
    """Write the transposed layout ``ies_csv_by_reals(false)`` produces --
    rows are entities, columns are realizations -- from the same
    realization-major ``values`` array, transposing on the way out rather
    than asking the caller to transpose first.

    The file's first data column header is a realization name, proving the
    file is genuinely variable-major on disk rather than merely
    relabelled.
    """
    path = Path(path)
    values = np.asarray(values)
    transposed = values.T

    with open(path, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["entity_name", *real_names])
        for name, row in zip(entity_names, transposed):
            writer.writerow([name, *row.tolist()])
    return path
