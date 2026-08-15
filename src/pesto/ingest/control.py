"""Control file into parameter and observation tables.

``read_control`` turns a PEST control file -- including a ``PstFrom`` control
file whose parameter and observation sections are references to external
CSVs -- into typed tables the rest of pesto can trust. pyemu owns the parsing
and already resolves the external sections, merging in every column those
CSVs carry; this module's job is what happens to the result afterwards:

* Column names are normalised by stripping *and* lowering, not just
  lowering. pyemu's own external-file merge lowercases column names and
  never strips them (RESEARCH.md Pitfall 2), so a header written with a
  leading space survives as a distinct column that an exact-match lookup
  misses silently. Every raw name that differed from its normalised name is
  named in ``notes``.
* When normalising creates a collision -- two raw names that reduce to the
  same identifier -- the column that was already correctly named is kept
  and the one that needed repairing is dropped, with both names recorded in
  ``notes``. A stripped duplicate silently overwriting the correctly named
  column would leave a caller with no way to tell which values it was
  looking at, which is worse than either column being merely absent.
* Every column the source frame carried is kept, not just a fixed core
  allowlist (``PAR_CORE`` / ``OBS_CORE``). RESEARCH.md Pitfall 3 documents a
  real ``PstFrom`` column (``id``) a fixed allowlist would silently drop;
  D-04's narrowing exists to bound memory against parameter *count*, not
  column *count*, so keeping every column costs nothing it was designed to
  save.
* ``pargp``, ``partrans`` and ``obgnme`` are tightened to pandas
  ``category`` dtype, and the bound columns to a float dtype, as the last
  step (D-04) -- at a million rows this is the difference between a
  compact table and a gigabyte of repeated strings.

A core column absent from the control file entirely is noted as absent,
never fabricated with a default -- an absent bound or transform is reported
as absent, and a fabricated one would be worse. Following ``Manifest.load``'s
style: any exception raised while parsing -- a missing control file, a
dangling external-data reference, or anything else pyemu can raise --
resolves to a ``ReadFailure`` named for ``pst_path.name``, never propagated
to the caller.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import pandas as pd

from pesto.ingest.choices import Ambiguity
from pesto.ingest.failures import ReadFailure

PAR_CORE = ("parnme", "pargp", "parlbnd", "parubnd", "partrans")
OBS_CORE = ("obsnme", "obgnme", "weight")

_PAR_CATEGORY_COLUMNS = ("pargp", "partrans")
_OBS_CATEGORY_COLUMNS = ("obgnme",)
_PAR_FLOAT_COLUMNS = ("parlbnd", "parubnd")
_OBS_FLOAT_COLUMNS = ("weight",)

COLUMN_COLLISION_POLICY = (
    "when two raw column names normalise to the same identifier, the column "
    "that was already correctly named is kept; when neither was already "
    "correct, the first one encountered is kept"
)
"""The column-collision tie-break, stated once. Deliberately a separate
constant from ``choices.AMBIGUITY_POLICY``, not the same rule reworded: for
two *files* competing for one slot there is no discriminator between them, so
sorted order is the only honest tie-break available. For two *columns*
competing for one name there is a real discriminator -- one of them did not
need repairing -- and the order their filenames happen to sort in has no
bearing on which column is correct. Stating two named policies, each at the
site that needs it, is the fix for 02-REVIEW.md WR-03; the defect was two
*implied* policies pointing in opposite, undocumented directions, not the
existence of two policies."""


@dataclass(frozen=True)
class ControlTables:
    """Parameter and observation tables read from one control file, plus
    provenance. Column order matches the control file; nothing is sorted.

    ``par_groups`` and ``obs_groups`` list the distinct group names each
    table carries, in first-appearance order -- not sorted, because ordering
    in this project comes from the file rather than from a comparison.

    ``ambiguities`` carries the choices this read made among competing
    columns -- currently just the column-collision case ``_normalize_columns``
    resolves -- each also rendered into ``notes`` so the two channels cannot
    drift apart.
    """

    par: pd.DataFrame
    obs: pd.DataFrame
    par_groups: tuple[str, ...]
    obs_groups: tuple[str, ...]
    source_path: Path
    notes: tuple[str, ...]
    ambiguities: tuple[Ambiguity, ...]


def _normalize_columns(
    df: pd.DataFrame, notes: list[str], label: str, ambiguities: list[Ambiguity]
) -> pd.DataFrame:
    """Strip and lower every column name, keeping control-file column order
    and resolving any collision the normalisation creates.

    pyemu's external-file merge lowercases column names and never strips
    them, so a header written with a leading space survives as a distinct
    column an exact-match lookup misses silently (RESEARCH.md Pitfall 2). A
    note is appended naming every column whose raw name differed from its
    normalised name -- but a repaired name that did not collide with
    anything is not a choice among candidates, so it becomes a note only,
    never an ``Ambiguity``.

    When two raw names normalise to the same identifier, the column that was
    already correctly named is kept and the one that needed repairing is
    dropped; the choice is recorded as an ``Ambiguity`` (``policy``
    ``COLUMN_COLLISION_POLICY``), and its ``note()`` is what appears in
    ``notes`` -- the two channels cannot drift apart because one renders the
    other. A stripped duplicate silently overwriting the correctly named
    column would be a worse outcome than either column being absent, because
    the caller would have no way to tell which values it was looking at.
    When neither raw name is already correctly named, the first one
    encountered is kept -- the second half of ``COLUMN_COLLISION_POLICY``.
    """
    columns = list(df.columns)
    cleaned_names = [str(raw).strip().lower() for raw in columns]

    keep_index: dict[str, int] = {}
    for idx, (raw, cleaned) in enumerate(zip(columns, cleaned_names)):
        if raw != cleaned:
            notes.append(f"{label} column {raw!r} was stripped/lowered to {cleaned!r}")

        if cleaned not in keep_index:
            keep_index[cleaned] = idx
            continue

        existing_idx = keep_index[cleaned]
        existing_raw = columns[existing_idx]
        existing_is_clean = existing_raw == cleaned
        this_is_clean = raw == cleaned
        if this_is_clean and not existing_is_clean:
            keep_index[cleaned] = idx
            kept_raw = raw
            rejected_raw = existing_raw
        else:
            kept_raw = existing_raw
            rejected_raw = raw
        ambiguity = Ambiguity(
            slot=f"{label} column {cleaned!r}",
            chosen=kept_raw,
            rejected=(rejected_raw,),
            policy=COLUMN_COLLISION_POLICY,
        )
        ambiguities.append(ambiguity)
        notes.append(ambiguity.note())

    kept_indices = sorted(keep_index.values())
    kept_columns = [columns[i] for i in kept_indices]
    result = df.loc[:, kept_columns].copy()
    result.columns = [cleaned_names[i] for i in kept_indices]
    return result


def _note_missing_core_columns(
    df: pd.DataFrame, core_columns: tuple[str, ...], notes: list[str], label: str
) -> None:
    """Note, rather than fabricate, any core column the control file did not
    carry at all. A fabricated bound or transform is worse than a stated
    absence."""
    for column in core_columns:
        if column not in df.columns:
            notes.append(f"{label} column {column!r} is absent from the control file")


def _distinct_in_order(df: pd.DataFrame, column: str) -> tuple[str, ...]:
    """The distinct values ``column`` carries, in first-appearance order.
    Empty when the column is absent -- there is nothing to fabricate a group
    list from."""
    if column not in df.columns:
        return ()
    return tuple(str(value) for value in df[column].unique())


def _tighten_dtypes(
    df: pd.DataFrame,
    category_columns: tuple[str, ...],
    float_columns: tuple[str, ...],
    notes: list[str],
    label: str,
) -> pd.DataFrame:
    """Tighten dtypes per D-04, as the last step: category for group/
    transform columns, float for bounds and weight. Columns absent from the
    frame are left alone -- there is nothing to tighten. Every other
    column's dtype is left exactly as pandas inferred it.

    A value ``pandas`` cannot read as a number is reported, not blanked: the
    null mask is compared before and after ``pd.to_numeric``, and every
    conversion that created a new null appends a note naming ``label``, the
    column and the number of rows affected, saying the values could not be
    read as a number and are recorded as absent. ``errors="coerce"`` still
    turns the unreadable value into ``NaN`` -- one bad value costs a note,
    not the whole control file -- but the note is what makes that NaN an
    honest, traceable absence instead of a fabricated one.
    """
    df = df.copy()
    for column in category_columns:
        if column in df.columns:
            df[column] = df[column].astype("category")
    for column in float_columns:
        if column in df.columns:
            before_null = df[column].isna()
            converted = pd.to_numeric(df[column], errors="coerce").astype("float64")
            new_nulls = int((converted.isna() & ~before_null).sum())
            if new_nulls:
                notes.append(
                    f"{label} column {column!r} had {new_nulls} value(s) that could not be "
                    f"read as a number; recorded as absent"
                )
            df[column] = converted
    return df


def read_control(pst_path: Path) -> "ControlTables | ReadFailure":
    """Read ``pst_path`` into parameter and observation tables.

    Loads pyemu through ``pesto.warm.load_pyemu`` (never at module scope)
    and constructs ``pyemu.Pst(str(pst_path))``, which already resolves any
    ``PstFrom``-style external parameter/observation sections against their
    CSVs and merges in every column they carry -- this function does not
    reimplement any part of that parsing.

    Any exception raised while parsing -- a missing control file, a
    dangling external-data reference, or any other pyemu failure -- returns
    a ``ReadFailure`` named for ``pst_path.name`` with a reason naming the
    control file and what failed. ``read_control`` never propagates a pyemu
    exception to its caller.
    """
    from pesto.warm import load_pyemu

    path = Path(pst_path)
    try:
        pyemu = load_pyemu()
        pst = pyemu.Pst(str(path))

        notes: list[str] = []
        ambiguities: list[Ambiguity] = []
        par = _normalize_columns(pst.parameter_data, notes, "parameter", ambiguities)
        obs = _normalize_columns(pst.observation_data, notes, "observation", ambiguities)

        _note_missing_core_columns(par, PAR_CORE, notes, "parameter")
        _note_missing_core_columns(obs, OBS_CORE, notes, "observation")

        par_groups = _distinct_in_order(par, "pargp")
        obs_groups = _distinct_in_order(obs, "obgnme")

        par = _tighten_dtypes(par, _PAR_CATEGORY_COLUMNS, _PAR_FLOAT_COLUMNS, notes, "parameter")
        obs = _tighten_dtypes(obs, _OBS_CATEGORY_COLUMNS, _OBS_FLOAT_COLUMNS, notes, "observation")

        return ControlTables(
            par=par,
            obs=obs,
            par_groups=par_groups,
            obs_groups=obs_groups,
            source_path=path,
            notes=tuple(notes),
            ambiguities=tuple(ambiguities),
        )
    except Exception as exc:
        return ReadFailure(
            name=path.name,
            path=str(path),
            reason=f"failed to parse control file {path.name}: {exc}",
        )
