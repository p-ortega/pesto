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


# ---------------------------------------------------------------------------
# Control file generation
# ---------------------------------------------------------------------------

_DEFAULT_PAR_META = ("i", "j", "idx0", "idx1", "idx2", "x", "y", "zone", "pname", "pstyle")
_DEFAULT_OBS_META = ("i", "j", "k", "id", "oname", "otype", "kper", "kstp", "standard_deviation")

_INT_META_COLUMNS = {"i", "j", "idx0", "idx1", "idx2", "idx3", "zone", "k", "kper", "kstp", "id"}
_FLOAT_META_COLUMNS = {"x", "y", "standard_deviation", "time"}


def _default_meta_value(column: str, n: int) -> list:
    """A plausible, reloadable default value for a PstFrom-style metadata
    column, chosen by a small name-based heuristic rather than a single
    dtype for every column."""
    if column in _INT_META_COLUMNS:
        return list(range(n))
    if column in _FLOAT_META_COLUMNS:
        return [round(i * 0.1, 4) for i in range(n)]
    return [f"{column}{i}" for i in range(n)]


def _rewrite_header_with_prefix(csv_path: Path, column: str, prefix: str) -> None:
    """Rewrite only the header line of ``csv_path`` so ``column`` is
    preceded by ``prefix`` -- every data row is left untouched."""
    text = csv_path.read_text()
    lines = text.splitlines(keepends=True)
    header, *rest = lines
    line_ending = "\n"
    stripped_header = header.rstrip("\r\n")
    fields = stripped_header.split(",")
    fields = [f"{prefix}{field}" if field == column else field for field in fields]
    new_header = ",".join(fields) + line_ending
    csv_path.write_text(new_header + "".join(rest))


def write_control_file(
    path: Path,
    par_names: list[str],
    obs_names: list[str],
    noptmax: int = 3,
    pestpp_options: dict | None = None,
    par_meta: tuple[str, ...] | None = None,
    obs_meta: tuple[str, ...] | None = None,
    standard_deviation_header: str | None = None,
) -> tuple[Path, Path]:
    """Write a real ``pcf version=2`` keyword-format control file with
    external parameter and observation data sections -- the ``PstFrom``
    shape READ-03 names explicitly, exercising the external-file merge path
    rather than the inline one.

    ``par_meta``/``obs_meta`` default to the PstFrom-shaped metadata real
    fixtures carry; every column named there is added to
    ``.parameter_data``/``.observation_data`` before writing, so it
    survives into the external CSVs and reloads. The default ``obs_meta``
    includes ``id`` deliberately: it is present in a real ``PstFrom``
    observation file and absent from the reference implementation's fixed
    column allowlist (RESEARCH.md Pitfall 3).

    ``standard_deviation_header`` synthesises RESEARCH.md's Assumption A1:
    when given, only the header line of the generated observation-data CSV
    is rewritten so the ``standard_deviation`` column name is preceded by
    that string -- every data row is left untouched.

    Returns ``(control_file_path, observation_data_csv_path)`` so a caller
    can inspect the header the observation-data CSV produced.
    """
    from pesto.warm import load_pyemu

    pyemu = load_pyemu()
    path = Path(path)

    if par_meta is None:
        par_meta = _DEFAULT_PAR_META
    if obs_meta is None:
        obs_meta = _DEFAULT_OBS_META

    pst = pyemu.Pst.from_par_obs_names(par_names=list(par_names), obs_names=list(obs_names))
    pst.control_data.noptmax = noptmax
    if pestpp_options:
        pst.pestpp_options.update(pestpp_options)

    n_par = len(par_names)
    n_obs = len(obs_names)
    for column in par_meta:
        pst.parameter_data[column] = _default_meta_value(column, n_par)
    for column in obs_meta:
        pst.observation_data[column] = _default_meta_value(column, n_obs)

    pst.write(str(path), version=2)

    obs_data_path = path.with_name(f"{path.stem}.obs_data.csv")
    if standard_deviation_header is not None:
        _rewrite_header_with_prefix(obs_data_path, "standard_deviation", standard_deviation_header)

    return path, obs_data_path


# ---------------------------------------------------------------------------
# Whole synthetic run directory
# ---------------------------------------------------------------------------

_ENSEMBLE_WRITERS = {
    "jcb": (write_jcb_ensemble, "jcb"),
    "legacy_jcb": (write_legacy_jcb_ensemble, "jcb"),
    "dense": (write_dense_ensemble, "bin"),
    "csv": (write_csv_ensemble, "csv"),
    "variable_major_csv": (write_variable_major_csv_ensemble, "csv"),
}

_PHI_SUFFIXES = ("actual", "meas", "regul", "composite", "group", "lambda")

_STARTING_PAR_EN_DEFAULT_NAME = "prior_pe.jcb"
_STARTING_OBS_EN_DEFAULT_NAME = "noise_oe.jcb"


@dataclass(frozen=True)
class SyntheticRun:
    """What one call to :func:`make_run` wrote, so a test can assert
    against the generator's own intent rather than re-deriving filenames."""

    root: Path
    case: str
    pst_path: Path
    par_names: list[str]
    obs_names: list[str]
    real_names: list[str]
    par_ens: dict[int, Path]
    obs_ens: dict[int, Path]
    phi_paths: dict[str, Path]
    pdc_paths: dict[int, Path]
    pcs_paths: dict[int, Path]
    reinflate_pcs_paths: dict[int, Path]
    grid_path: Path
    starting_par_en: Path | None
    starting_obs_en: Path | None
    decoy_paths: tuple[Path, ...]
    tpl_path: Path
    ins_path: Path


def _write_phi_csv(path: Path) -> Path:
    path.write_text("iteration,total_runs,phi\n0,1,1.0\n")
    return path


def _write_small_csv(path: Path) -> Path:
    path.write_text("real_name,value\nbase,0.0\n")
    return path


def _resolve_starting_ensemble(value: str | None, default_name: str) -> tuple[str | None, bool]:
    """Decide the effective on-disk name for a starting ensemble option and
    whether the file itself should be written.

    ``None`` means the option is not used at all. The :data:`MISSING_FILE`
    sentinel means the control file still names ``default_name`` but the
    file is never created -- the real, not contrived, shape of
    ``hm_20250406221554``. Any other value is written as given.
    """
    if value is None:
        return None, False
    if value is MISSING_FILE:
        return default_name, False
    return value, True


def make_run(
    root: Path,
    case: str = "case",
    noptmax: int = 3,
    iterations: tuple[int, ...] = (0, 1),
    ensemble_format: str = "jcb",
    n_real: int = 4,
    n_par: int = 6,
    n_obs: int = 3,
    starting_par_en: str | None = _STARTING_PAR_EN_DEFAULT_NAME,
    starting_obs_en: str | None = None,
    hash_ordered: bool = False,
    extras: bool = True,
) -> SyntheticRun:
    """Compose a whole synthetic pestpp-ies working directory under
    ``root`` and return a record describing what it wrote.

    Everything lands under ``root`` -- this function never touches a
    benchmark directory. ``root`` is a caller-supplied directory, in
    practice a test's ``tmp_path``.
    """
    root = Path(root)
    writer, ext = _ENSEMBLE_WRITERS[ensemble_format]

    par_control_names = control_ordered_names("par", n_par)
    obs_control_names = control_ordered_names("obs", n_obs)
    par_entity_names = hash_ordered_names("par", n_par) if hash_ordered else par_control_names
    obs_entity_names = hash_ordered_names("obs", n_obs) if hash_ordered else obs_control_names
    real_names = survivor_names() if n_real == 4 else control_ordered_names("real", n_real)

    par_en_name, write_par_en = _resolve_starting_ensemble(
        starting_par_en, _STARTING_PAR_EN_DEFAULT_NAME
    )
    obs_en_name, write_obs_en = _resolve_starting_ensemble(
        starting_obs_en, _STARTING_OBS_EN_DEFAULT_NAME
    )

    pestpp_options: dict[str, str] = {}
    if par_en_name is not None:
        pestpp_options["ies_parameter_ensemble"] = par_en_name
    if obs_en_name is not None:
        pestpp_options["ies_obs_en"] = obs_en_name

    pst_path = root / f"{case}.pst"
    write_control_file(
        pst_path,
        par_names=par_control_names,
        obs_names=obs_control_names,
        noptmax=noptmax,
        pestpp_options=pestpp_options,
    )

    par_ens: dict[int, Path] = {}
    obs_ens: dict[int, Path] = {}
    for iteration in iterations:
        par_values = sample_values(n_real, n_par, seed=iteration)
        par_path = root / f"{case}.{iteration}.par.{ext}"
        writer(par_path, par_values, real_names, par_entity_names)
        par_ens[iteration] = par_path

        obs_values = sample_values(n_real, n_obs, seed=iteration + 1000)
        obs_path = root / f"{case}.{iteration}.obs.{ext}"
        writer(obs_path, obs_values, real_names, obs_entity_names)
        obs_ens[iteration] = obs_path

    phi_paths = {
        suffix: _write_phi_csv(root / f"{case}.phi.{suffix}.csv") for suffix in _PHI_SUFFIXES
    }

    pdc_paths: dict[int, Path] = {}
    pcs_paths: dict[int, Path] = {}
    reinflate_pcs_paths: dict[int, Path] = {}
    for iteration in iterations:
        pdc_paths[iteration] = _write_small_csv(root / f"{case}.{iteration}.pdc.csv")
        pcs_paths[iteration] = _write_small_csv(root / f"{case}.{iteration}.pcs.csv")
        reinflate_pcs_paths[iteration] = _write_small_csv(
            root / f"{case}.{iteration}.reinflate.pcs.csv"
        )

    # Deliberately not case-prefixed: real benchmark runs name the grid
    # file after the model, not the case, so a case-matching filter would
    # find nothing on a real run.
    grid_path = root / "coarse.disv.grb"
    grid_path.write_bytes(b"synthetic grid file placeholder, not a real .grb")

    starting_par_path: Path | None = None
    if par_en_name is not None:
        starting_par_path = root / par_en_name
        if write_par_en:
            writer(
                starting_par_path,
                sample_values(n_real, n_par, seed=9001),
                real_names,
                par_entity_names,
            )

    starting_obs_path: Path | None = None
    if obs_en_name is not None:
        starting_obs_path = root / obs_en_name
        if write_obs_en:
            writer(
                starting_obs_path,
                sample_values(n_real, n_obs, seed=9002),
                real_names,
                obs_entity_names,
            )

    decoy_paths: tuple[Path, ...] = ()
    if extras:
        # Both end in a real ensemble extension and neither is an
        # ensemble -- present in the real benchmark directories, and what
        # makes discovery's filename matching honest rather than a loose
        # glob on extension alone.
        decoy1 = root / "factors.coarse.boundary.layer10.bin"
        decoy1.write_bytes(b"decoy, not an ensemble")
        decoy2 = root / f"{case}.adjusted.weights.bin"
        decoy2.write_bytes(b"decoy, not an ensemble")
        decoy_paths = (decoy1, decoy2)

    tpl_path = root / f"{case}.tpl"
    tpl_path.write_text("ptf ~\n~par0~\n")
    ins_path = root / f"{case}.ins"
    ins_path.write_text("pif ~\nl1\n")

    return SyntheticRun(
        root=root,
        case=case,
        pst_path=pst_path,
        par_names=par_control_names,
        obs_names=obs_control_names,
        real_names=real_names,
        par_ens=par_ens,
        obs_ens=obs_ens,
        phi_paths=phi_paths,
        pdc_paths=pdc_paths,
        pcs_paths=pcs_paths,
        reinflate_pcs_paths=reinflate_pcs_paths,
        grid_path=grid_path,
        starting_par_en=starting_par_path,
        starting_obs_en=starting_obs_path,
        decoy_paths=decoy_paths,
        tpl_path=tpl_path,
        ins_path=ins_path,
    )
