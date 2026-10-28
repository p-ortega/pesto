"""Which site and time each observation has, and the order they are stored in.

Every later observation artifact is written in the order this module gives,
so one site is one unbroken read. The order is: group (first appearance in
the control table), then site (first appearance), then time value, then
control position. Times sort by value, never as text, and ties keep control
order, so the same control table always gives the same order.

``build_obs_index`` works on the cached observation table only, never on the
control file. ``write_obs_index`` puts seven files under ``control/``; the
JSON sidecar goes last, so a reader never finds a sidecar naming a file that
is not there yet. ``load_obs_index`` checks sizes and the order digest before
it believes anything.

Numeric times stay model time exactly as written: no ``sim.tdis`` is read and
no number becomes a date. An observation with no time has an ordinal axis,
its position inside its site, and every file says so.

pyarrow is imported inside functions; this module never imports pyemu, flopy
or ``pesto.model``.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

import numpy as np
import pandas as pd

from pesto.cache._atomic import write_atomic_bytes, write_atomic_text
from pesto.cache.layout import CACHE_VERSION, CacheLayout
from pesto.cache.manifest import CacheFile, WrittenArtifact
from pesto.ingest.failures import ReadFailure
from pesto.ingest.tables import _write_parquet_atomic

if TYPE_CHECKING:
    import pyarrow as pa

# Linear: a literal, then a run that cannot contain "_". One match per name.
TIME_TOKEN_PATTERN = r"_(?:datetime|time):[^_]*"
_TOKEN_CAPTURE_PATTERN = r"_(?P<kind>datetime|time):(?P<value>[^_]*)"

SENTINEL_LIMIT = 1e20
# Raise when the rule for simulated sentinels changes; a statistics or 1:1 sidecar with a lower
# number (or none) was built before it and is read again on the next ingest.
SENTINEL_RULE_VERSION = 1


def sentinel_rule_outdated(sidecar_path: Path) -> bool:
    """Whether the sidecar at ``sidecar_path`` was written before the current sentinel rule:
    missing, unreadable, or carrying no ``sentinel_rule_version`` of the current number."""
    try:
        data = json.loads(sidecar_path.read_text())
    except (OSError, ValueError):
        return True
    return not isinstance(data, dict) or data.get("sentinel_rule_version") != SENTINEL_RULE_VERSION


def sentinel_mask(values) -> np.ndarray:
    """True where a value is a placeholder, not a number: MODFLOW's 1e30 for a dry or
    no-flow cell, or any obsval of ``SENTINEL_LIMIT`` or more. Infinity counts too."""
    with np.errstate(invalid="ignore"):
        return np.abs(values) >= SENTINEL_LIMIT


def usable_mask(values) -> np.ndarray:
    """True where a value may feed a range, a statistic, a frame or a bin: finite and not a sentinel."""
    return np.isfinite(values) & ~sentinel_mask(values)


def blank_sentinels(values: np.ndarray) -> tuple[np.ndarray, int]:
    """``values`` with each finite sentinel set to NaN, and how many there were; the input is
    returned as it is when it holds none. Infinity is left for the non-finite counts."""
    hit = sentinel_mask(values) & np.isfinite(values)
    n = int(np.count_nonzero(hit))
    if n == 0:
        return values, 0
    out = np.array(values, copy=True)
    out[hit] = np.nan
    return out, n


# The same tags pyemu applies to the lower-cased group name.
LESS_TAGS = ("l_", "less", ">@")
GREATER_TAGS = ("g_", "greater", "<@")
IDENTITY_COLUMNS = ("id", "x", "y", "z", "icpl", "layer", "k", "i", "j")
# The parts the digest is taken over, in the order they are hashed.
DIGEST_PARTS = ("order", "time", "value", "flags", "sites")
OLD_DIGEST_NOTE = (
    "obs_index.json was written before its digest covered times, values, flags and sites, "
    "so dependents are checked against the order only until obs_index is rebuilt"
)

FLAG_HAS_TARGET = 1
FLAG_WEIGHTED = 2
FLAG_GREATER = 4
FLAG_LESS = 8

KIND_DATETIME = "datetime"
KIND_NUMERIC = "numeric"
KIND_NO_TIME = "ordinal (no time found)"
KIND_MIXED = "ordinal (mixed time kinds)"

RULE_TOKEN = "name-token"
RULE_IDENTITY = "identity-columns"
RULE_GROUP = "group"
RULE_OWN = "own-site"
_RULES = (RULE_TOKEN, RULE_IDENTITY, RULE_GROUP, RULE_OWN)

MAPPING_NOTE = "none supplied"
DATETIME_ORIGIN = "1970-01-01"
RULE_CHAIN = (
    "time comes from the datetime column, then the time column, then the mapping "
    "(none supplied), then the _datetime: or _time: token in the name; an observation "
    "with no time is ordinal, its position inside its site in control order"
)
ZERO_ROWS_NOTE = "observation table has zero rows"

_NO_TIME, _DATE, _NUM = 0, 1, 2  # per-observation time kind
_EPOCH = pd.Timestamp(DATETIME_ORIGIN, tz="UTC")
_SEP = "\x1f"  # joins the parts of an identity key
_NULL = "\x00"  # stands for a blank part, which is not the same as the text "NA"
_EXAMPLES = 3

_SITE_COLUMNS = ("site_id", "site", "group", "start", "count", "time_kind", "site_rule")
_GROUP_COLUMNS = (
    "group",
    "n_obs",
    "n_sites",
    "time_kind",
    "site_rule",
    "n_weighted",
    "n_sentinel",
    "n_no_value",
    "inequality",
)


@dataclass(frozen=True, eq=False)
class ObsIndex:
    """The observation index: arrays are per sorted position, ``order`` maps a
    sorted position to its control-table row."""

    order: np.ndarray  # int32
    time: np.ndarray  # float64; model time, days since 1970-01-01, or ordinal position
    value: np.ndarray  # float64 obsval, NaN when not a number
    flags: np.ndarray  # uint8, FLAG_* bits
    sites: pd.DataFrame
    groups: pd.DataFrame
    control_rows: int
    order_digest: str
    notes: tuple[str, ...]

    @property
    def n_obs(self) -> int:
        return int(self.order.shape[0])


def _failure(path: Path | str, reason: str) -> ReadFailure:
    return ReadFailure(name="obs_index", path=str(path), reason=reason)


def inequality_flag(group: str) -> int:
    """The FLAG_GREATER or FLAG_LESS bit for a group name, or 0."""
    lowered = str(group).lower()
    if lowered.startswith(GREATER_TAGS):
        return FLAG_GREATER
    if lowered.startswith(LESS_TAGS):
        return FLAG_LESS
    return 0


def _examples(names, rows: np.ndarray) -> str:
    """Up to three observation names, earliest control rows first."""
    import pyarrow as pa

    picked = np.sort(rows)[:_EXAMPLES]
    listed = ", ".join(names.take(pa.array(picked)).to_pylist())
    return f"for example {listed}"


def _as_large_string(column) -> "pa.Array":
    import pyarrow as pa

    if pa.types.is_dictionary(column.type):
        column = column.cast(column.type.value_type)
    return column.cast(pa.large_string()).combine_chunks()


def _has_text(text: pd.Series) -> pd.Series:
    """Cells that hold something other than blank text."""
    return text.notna() & (text.astype(str).str.strip() != "")


def _to_float(column) -> tuple[np.ndarray, int]:
    """A column as float64, NaN where blank. The second value counts cells
    that held text which is not a number."""
    import pyarrow as pa

    if pa.types.is_string(column.type) or pa.types.is_large_string(column.type):
        text = column.to_pandas()
        parsed = pd.to_numeric(text, errors="coerce")
        bad = int((_has_text(text) & parsed.isna()).sum())
        return parsed.to_numpy(dtype=np.float64, na_value=np.nan), bad
    if pa.types.is_dictionary(column.type):
        return _to_float(column.cast(column.type.value_type))
    return column.cast(pa.float64()).to_numpy(zero_copy_only=False), 0


def _first_appearance_codes(values: np.ndarray) -> tuple[np.ndarray, int]:
    """Number the distinct values by where each first appears."""
    unique, first, inverse = np.unique(values, return_index=True, return_inverse=True)
    rank = np.empty(unique.shape[0], dtype=np.int64)
    rank[np.argsort(first, kind="stable")] = np.arange(unique.shape[0])
    return rank[inverse.ravel()], int(unique.shape[0])


def _empty_index(notes: tuple[str, ...]) -> ObsIndex:
    sites = pd.DataFrame(
        {
            "site_id": pd.Series([], dtype="int64"),
            "site": pd.Series([], dtype="object"),
            "group": pd.Series([], dtype="object"),
            "start": pd.Series([], dtype="int64"),
            "count": pd.Series([], dtype="int64"),
            "time_kind": pd.Series([], dtype="object"),
            "site_rule": pd.Series([], dtype="object"),
        }
    )
    groups = pd.DataFrame(
        {
            "group": pd.Series([], dtype="object"),
            "n_obs": pd.Series([], dtype="int64"),
            "n_sites": pd.Series([], dtype="int64"),
            "time_kind": pd.Series([], dtype="object"),
            "site_rule": pd.Series([], dtype="object"),
            "n_weighted": pd.Series([], dtype="int64"),
            "n_sentinel": pd.Series([], dtype="int64"),
            "n_no_value": pd.Series([], dtype="int64"),
            "inequality": pd.Series([], dtype="object"),
        }
    )
    order = np.zeros(0, dtype=np.int32)
    time = np.zeros(0, dtype=np.float64)
    value = np.zeros(0, dtype=np.float64)
    flags = np.zeros(0, dtype=np.uint8)
    return ObsIndex(
        order=order,
        time=time,
        value=value,
        flags=flags,
        sites=sites,
        groups=groups,
        control_rows=0,
        order_digest=_content_digest(order, time, value, flags, sites),
        notes=notes + (ZERO_ROWS_NOTE,),
    )


def _text_series(column) -> pd.Series:
    import pyarrow as pa

    if pa.types.is_dictionary(column.type):
        column = column.cast(column.type.value_type)
    return column.to_pandas()


def _parse_dates(text: pd.Series) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Days since 1970-01-01 (NaN when not a date), which cells were only a
    year and month, and which cells held text that is not a date."""
    parsed = pd.to_datetime(text, format="ISO8601", errors="coerce", utc=True)
    days = ((parsed - _EPOCH).dt.total_seconds() / 86400.0).to_numpy(
        dtype=np.float64, na_value=np.nan
    )
    stripped = text.astype(str).str.strip()
    partial = stripped.str.fullmatch(r"\d{4}-\d{2}").to_numpy(dtype=bool) & parsed.notna().to_numpy()
    bad = (_has_text(text) & parsed.isna()).to_numpy(dtype=bool)
    return days, partial, bad


def _token_times(names, has_token: np.ndarray, token, notes: list[str]):
    """The time each name's token carries: float64 (NaN when none), the
    per-observation time kind, and which dates were only a year and month."""
    import pyarrow as pa
    import pyarrow.compute as pc

    n = len(has_token)
    time = np.full(n, np.nan)
    kind = np.zeros(n, dtype=np.int8)
    partial = np.zeros(n, dtype=bool)
    token_kind = token.field("kind")
    value = token.field("value")
    is_time = pc.fill_null(pc.equal(token_kind, "time"), False).to_numpy(zero_copy_only=False)
    is_date = pc.fill_null(pc.equal(token_kind, "datetime"), False).to_numpy(zero_copy_only=False)
    unusable: list[np.ndarray] = []

    rows = np.flatnonzero(has_token & is_time)
    if rows.size:
        text = pc.take(value, pa.array(rows)).to_pandas()
        parsed = pd.to_numeric(text, errors="coerce").to_numpy(dtype=np.float64, na_value=np.nan)
        good = np.isfinite(parsed)
        time[rows[good]] = parsed[good]
        kind[rows[good]] = _NUM
        unusable.append(rows[~good])

    rows = np.flatnonzero(has_token & is_date)
    if rows.size:
        text = pc.take(value, pa.array(rows)).to_pandas()
        days, part, _bad = _parse_dates(text)
        good = np.isfinite(days)
        time[rows[good]] = days[good]
        kind[rows[good]] = _DATE
        partial[rows[good]] = part[good]
        unusable.append(rows[~good])

    bad_rows = np.concatenate(unusable) if unusable else np.zeros(0, dtype=np.int64)
    if bad_rows.size:
        notes.append(
            f"{bad_rows.size} name(s) have a _time: or _datetime: token that is not a valid "
            f"time, so it was not used as a time; {_examples(names, bad_rows)}"
        )
    return time, kind, partial


def _column_times(table, names, notes: list[str]):
    """The time the ``datetime`` column, then the ``time`` column, gives:
    float64 (NaN when none), the per-observation time kind, and which dates
    were only a year and month."""
    n = table.num_rows
    time = np.full(n, np.nan)
    kind = np.zeros(n, dtype=np.int8)
    partial = np.zeros(n, dtype=bool)
    if "datetime" in table.column_names:
        days, part, bad = _parse_dates(_text_series(table["datetime"]))
        got = np.isfinite(days)
        time[got] = days[got]
        kind[got] = _DATE
        partial = part
        if bad.any():
            notes.append(
                f"{int(bad.sum())} cell(s) in the datetime column are text that is not a date, "
                f"so they were not used as a time; {_examples(names, np.flatnonzero(bad))}"
            )
    if "time" in table.column_names:
        values, bad_count = _to_float(table["time"])
        got = np.isfinite(values)
        both = got & (kind == _DATE)
        use = got & (kind == _NO_TIME)
        time[use] = values[use]
        kind[use] = _NUM
        if bad_count:
            notes.append(
                f"{bad_count} cell(s) in the time column are text that is not a number and "
                "were not used as a time"
            )
        if both.any():
            notes.append(
                f"{int(both.sum())} observation(s) have both a datetime and a time in their "
                f"columns; the datetime was used; {_examples(names, np.flatnonzero(both))}"
            )
    return time, kind, partial


def _mapping_tier(n: int) -> tuple[np.ndarray, np.ndarray]:
    """The site and time mapping tier. No mapping file format exists yet, so
    it supplies no time for anyone; ``obs_index.json`` records "none supplied"."""
    return np.full(n, np.nan), np.zeros(n, dtype=np.int8)


def _identity_parts(table) -> tuple[list[str], list]:
    import pyarrow as pa

    columns = [c for c in IDENTITY_COLUMNS if c in table.column_names]
    parts = []
    for column in columns:
        values = table[column]
        if pa.types.is_dictionary(values.type):
            values = values.cast(values.type.value_type)
        # Text is kept exactly as it is, so "NA" and "null" stay values.
        parts.append(values.cast(pa.large_string()).combine_chunks())
    return columns, parts


def _build(table: "pa.Table", notes: tuple[str, ...]) -> ObsIndex | ReadFailure:
    import pyarrow as pa
    import pyarrow.compute as pc

    path = "control/obs.parquet"
    for required in ("obsnme", "obgnme"):
        if required not in table.column_names:
            return _failure(path, f"the observation table has no {required!r} column")
    n = table.num_rows
    if n == 0:
        return _empty_index(notes)

    names_col = table["obsnme"]
    if names_col.null_count:
        return _failure(
            path,
            f"{names_col.null_count} observation name(s) are missing; refusing to number "
            "them by row position",
        )
    names = _as_large_string(names_col)
    new_notes: list[str] = []

    group_text = _as_large_string(table["obgnme"])
    if group_text.null_count:
        new_notes.append(
            f"{group_text.null_count} observation(s) have no group name; they share the group "
            "named '' (empty)"
        )
        group_text = pc.fill_null(group_text, "")
    group_enc = pc.dictionary_encode(group_text)
    group_code = group_enc.indices.to_numpy(zero_copy_only=False).astype(np.int64)
    group_names = [str(g) for g in group_enc.dictionary.to_pylist()]

    # Values and flags come straight from obsval and weight.
    if "obsval" in table.column_names:
        value, bad_value = _to_float(table["obsval"])
        if bad_value:
            new_notes.append(f"{bad_value} obsval cell(s) are text that is not a number")
    else:
        value = np.full(n, np.nan)
        new_notes.append(
            "the observation table has no obsval column, so no observation has a target"
        )
    if "weight" in table.column_names:
        weight, bad_weight = _to_float(table["weight"])
        if bad_weight:
            new_notes.append(f"{bad_weight} weight cell(s) are text that is not a number")
    else:
        weight = np.zeros(n)
        new_notes.append(
            "the observation table has no weight column, so no observation is weighted"
        )
    no_value = np.isnan(value)
    sentinel = np.abs(value) >= SENTINEL_LIMIT
    has_target = ~no_value & ~sentinel
    weighted = weight > 0
    if int(sentinel.sum()):
        new_notes.append(
            f"{int(sentinel.sum())} observation(s) have an obsval of {SENTINEL_LIMIT:g} or "
            "more (a placeholder, not a target)"
        )
    if int(no_value.sum()):
        new_notes.append(f"{int(no_value.sum())} observation(s) have no numeric obsval")

    token = pc.extract_regex(names, _TOKEN_CAPTURE_PATTERN)
    has_token = pc.is_valid(token).to_numpy(zero_copy_only=False)
    site_name = pc.replace_substring_regex(names, TIME_TOKEN_PATTERN, "", max_replacements=1)

    # Time, in order: the datetime and time columns, the mapping, the name token.
    col_time, col_kind, col_partial = _column_times(table, names, new_notes)
    map_time, map_kind = _mapping_tier(n)
    tok_time, tok_kind, tok_partial = _token_times(names, has_token, token, new_notes)
    time = col_time.copy()
    kind = col_kind.copy()
    source = np.where(kind != _NO_TIME, 1, 0)
    for tier, (tier_time, tier_kind) in ((2, (map_time, map_kind)), (3, (tok_time, tok_kind))):
        take = (kind == _NO_TIME) & (tier_kind != _NO_TIME)
        time[take] = tier_time[take]
        kind[take] = tier_kind[take]
        source[take] = tier
    partial_used = ((source == 1) & col_partial) | ((source == 3) & tok_partial)
    if partial_used.any():
        new_notes.append(
            f"{int(partial_used.sum())} datetime(s) written as year and month only were read "
            f"as the first of the month; {_examples(names, np.flatnonzero(partial_used))}"
        )
    disagree = (
        (col_kind != _NO_TIME)
        & (tok_kind != _NO_TIME)
        & ((col_kind != tok_kind) | (col_time != tok_time))
    )
    if disagree.any():
        new_notes.append(
            f"{int(disagree.sum())} observation(s) have a time in a column and a different "
            f"time in the name token; the column was used; "
            f"{_examples(names, np.flatnonzero(disagree))}"
        )

    # Site key: the token-free name; else the group and identity values when a
    # column gave a time; else the observation itself.
    identity_columns, parts = _identity_parts(table)
    any_identity = np.zeros(n, dtype=bool)
    for part in parts:
        any_identity |= pc.is_valid(part).to_numpy(zero_copy_only=False)
    if parts:
        identity_key = pc.binary_join_element_wise(
            group_text,
            *parts,
            pa.scalar(_SEP, pa.large_string()),
            null_handling="replace",
            null_replacement=_NULL,
        )
    else:
        identity_key = group_text
    has_column_time = col_kind != _NO_TIME
    rule = np.where(
        has_token, 0, np.where(has_column_time, np.where(any_identity, 1, 2), 3)
    ).astype(np.int8)
    key = pc.if_else(
        pa.array(has_token),
        site_name,
        pc.if_else(
            pa.array(rule == 1),
            identity_key,
            pc.if_else(pa.array(rule == 2), group_text, names),
        ),
    )
    key_enc = pc.dictionary_encode(key)
    key_code = key_enc.indices.to_numpy(zero_copy_only=False).astype(np.int64)
    n_keys = len(key_enc.dictionary)
    # The group is part of the site, so a site is never split across groups.
    pair = (group_code * n_keys + key_code) * len(_RULES) + rule
    site_code, n_sites = _first_appearance_codes(pair)

    # Each site's kind of time.
    count = np.bincount(site_code, minlength=n_sites)
    n_date = np.bincount(site_code, weights=(kind == _DATE), minlength=n_sites)
    n_num = np.bincount(site_code, weights=(kind == _NUM), minlength=n_sites)
    site_kind = np.full(n_sites, -1, dtype=np.int8)  # -1: mixed or partly timed
    site_kind[n_date == count] = _DATE
    site_kind[n_num == count] = _NUM
    site_kind[(n_date + n_num) == 0] = _NO_TIME
    ordinal_site = (site_kind == _NO_TIME) | (site_kind == -1)

    # Ordinal time is the position inside the site, in control order.
    by_site = np.argsort(site_code, kind="stable")
    sorted_codes = site_code[by_site]
    run_start = np.searchsorted(sorted_codes, np.arange(n_sites))
    position = np.empty(n, dtype=np.float64)
    position[by_site] = np.arange(n) - run_start[sorted_codes]
    row_time = np.where(ordinal_site[site_code], position, time)

    control_position = np.arange(n)
    order = np.lexsort((control_position, row_time, site_code, group_code))
    s_site = site_code[order]
    s_time = row_time[order]
    starts = np.concatenate(([0], np.flatnonzero(np.diff(s_site)) + 1))
    if starts.shape[0] != n_sites:
        raise RuntimeError(f"a site was split across {starts.shape[0]} runs instead of {n_sites}")
    counts = np.diff(np.concatenate((starts, [n])))
    first = order[starts]

    same = (s_site[1:] == s_site[:-1]) & (s_time[1:] == s_time[:-1])
    if int(same.sum()):
        new_notes.append(
            f"{int(same.sum())} observation(s) share a site and time with an earlier one; all "
            f"were kept in control order and none were merged; {_examples(names, order[1:][same])}"
        )
    no_time = kind == _NO_TIME
    if no_time.any():
        new_notes.append(
            f"{int(no_time.sum())} observation(s) have no time from any source; their axis is "
            f"{KIND_NO_TIME}, their position inside the site in control order; "
            f"{_examples(names, np.flatnonzero(no_time))}"
        )
    sorted_site_kind = site_kind[s_site[starts]]
    mixed = sorted_site_kind == -1
    if mixed.any():
        new_notes.append(
            f"{int(mixed.sum())} site(s) mix kinds of time or have times on only some rows, so "
            f"each is ordinal as a whole; {_examples(names, first[mixed])}"
        )

    shared = key_code[first] * len(_RULES) + rule[first]
    _, shared_inverse, shared_count = np.unique(shared, return_inverse=True, return_counts=True)
    shared_site = shared_count[shared_inverse.ravel()] > 1
    if shared_site.any():
        new_notes.append(
            f"{int(np.unique(shared[shared_site]).shape[0])} site name(s) appear in more than "
            "one group; each group's rows are kept as a separate site so the sort never splits "
            f"a site; {_examples(names, first[shared_site])}"
        )

    group_flag = np.array([inequality_flag(g) for g in group_names], dtype=np.uint8)
    flags = (
        has_target.astype(np.uint8) * FLAG_HAS_TARGET
        + weighted.astype(np.uint8) * FLAG_WEIGHTED
        + group_flag[group_code]
    ).astype(np.uint8)

    site_group = group_code[first]
    kind_text = {_DATE: KIND_DATETIME, _NUM: KIND_NUMERIC, _NO_TIME: KIND_NO_TIME, -1: KIND_MIXED}
    site_rule = rule[first]
    site_text = key.take(pa.array(first)).to_pylist()
    if (site_rule == 1).any():
        site_text = [
            text.replace(_SEP, "|").replace(_NULL, "") if r == 1 else text
            for text, r in zip(site_text, site_rule)
        ]
    columns = {
        "site_id": np.arange(n_sites, dtype=np.int64),
        "site": pd.Series(site_text, dtype="object"),
        "group": pd.Series([group_names[g] for g in site_group], dtype="object"),
        "start": starts.astype(np.int64),
        "count": counts.astype(np.int64),
        "time_kind": pd.Series([kind_text[int(k)] for k in sorted_site_kind], dtype="object"),
        "site_rule": pd.Series([_RULES[int(r)] for r in site_rule], dtype="object"),
    }
    # Identity columns as read, from each site's first observation.
    for column, part in zip(identity_columns, parts):
        raw = table[column]
        if pa.types.is_dictionary(raw.type):
            raw = raw.cast(raw.type.value_type)
        columns[column] = raw.take(pa.array(first)).to_pandas().reset_index(drop=True)
        codes = pc.fill_null(pc.dictionary_encode(part).indices, -1).to_numpy(zero_copy_only=False)
        in_order = codes[order]
        varies = np.minimum.reduceat(in_order, starts) != np.maximum.reduceat(in_order, starts)
        if varies.any():
            new_notes.append(
                f"{int(varies.sum())} site(s) have more than one value in the {column} column; "
                f"the site row shows the value on its first observation; "
                f"{_examples(names, first[varies])}"
            )
    sites = pd.DataFrame(columns)

    groups = _group_table(
        group_names, group_code, site_group, sites, weighted, sentinel, no_value, group_flag
    )

    out_order = order.astype(np.int32)
    out_time = s_time.astype(np.float64)
    out_value = value[order].astype(np.float64)
    out_flags = flags[order]
    return ObsIndex(
        order=out_order,
        time=out_time,
        value=out_value,
        flags=out_flags,
        sites=sites,
        groups=groups,
        control_rows=n,
        order_digest=_content_digest(out_order, out_time, out_value, out_flags, sites),
        notes=notes + tuple(new_notes),
    )


def _content_digest(order, time, value, flags, sites, covers=DIGEST_PARTS) -> str:
    """sha256 over the parts named in ``covers``, hashed in ``DIGEST_PARTS`` order.
    ``("order",)`` alone gives the digest older sidecars recorded."""
    h = hashlib.sha256()
    if "order" in covers:
        h.update(np.ascontiguousarray(order, dtype="<i4").tobytes())
    if "time" in covers:
        h.update(np.ascontiguousarray(time, dtype="<f8").tobytes())
    if "value" in covers:
        h.update(np.ascontiguousarray(value, dtype="<f8").tobytes())
    if "flags" in covers:
        h.update(np.ascontiguousarray(flags, dtype="u1").tobytes())
    if "sites" in covers:
        for column in ("site", "group", "start", "count", *IDENTITY_COLUMNS):
            if column not in sites.columns:
                continue
            # A blank is not the text "NA", so it gets its own marker.
            values = sites[column]
            text = _SEP.join(map(str, values.astype(object).where(values.notna(), _NULL).tolist()))
            h.update(column.encode("utf-8") + b"\x1e" + text.encode("utf-8") + b"\x1d")
    return h.hexdigest()


def _joined(values: pd.Series) -> str:
    unique = list(dict.fromkeys(values))
    return unique[0] if len(unique) == 1 else "mixed"


def _group_table(
    group_names, group_code, site_group, sites, weighted, sentinel, no_value, group_flag
) -> pd.DataFrame:
    g = len(group_names)

    def per_group(mask) -> np.ndarray:
        return np.bincount(group_code, weights=mask, minlength=g).astype(np.int64)

    kinds = sites.groupby(site_group, sort=True)["time_kind"].agg(_joined)
    rules = sites.groupby(site_group, sort=True)["site_rule"].agg(_joined)
    n_sites = np.bincount(site_group, minlength=g).astype(np.int64)
    inequality = np.where(
        group_flag == FLAG_GREATER, "greater", np.where(group_flag == FLAG_LESS, "less", "none")
    )
    return pd.DataFrame(
        {
            "group": pd.Series(group_names, dtype="object"),
            "n_obs": np.bincount(group_code, minlength=g).astype(np.int64),
            "n_sites": n_sites,
            "time_kind": pd.Series([kinds[i] for i in range(g)], dtype="object"),
            "site_rule": pd.Series([rules[i] for i in range(g)], dtype="object"),
            "n_weighted": per_group(weighted),
            "n_sentinel": per_group(sentinel),
            "n_no_value": per_group(no_value),
            "inequality": pd.Series(inequality, dtype="object"),
        }
    )


def build_obs_index(table: "pa.Table", notes=()) -> ObsIndex | ReadFailure:
    """Build the index from the cached observation table. Never raises: any
    failure comes back as a ``ReadFailure`` naming ``obs_index``."""
    try:
        return _build(table, tuple(notes))
    except Exception as exc:
        return _failure(
            "control/obs.parquet",
            f"failed to build obs_index from the observation table: {type(exc).__name__}: {exc}",
        )


def _paths(layout: CacheLayout) -> tuple[Path, ...]:
    return (
        layout.obs_order,
        layout.obs_time,
        layout.obs_value,
        layout.obs_flags,
        layout.obs_sites,
        layout.obs_groups,
        layout.obs_index_meta,
    )


def _array_writer(array: np.ndarray, dtype: str):
    data = np.ascontiguousarray(array, dtype=dtype).tobytes()

    def _write(fileobj) -> int:
        fileobj.write(data)
        return len(data)

    return _write


def write_obs_index(index: ObsIndex, layout: CacheLayout) -> WrittenArtifact | ReadFailure:
    """Write the seven files. The JSON sidecar goes last. On any failure the
    files this call already wrote are removed and the failure says how many."""
    written: list[Path] = []
    files: list[CacheFile] = []
    root = layout.root
    try:
        layout.ensure()

        def record(path: Path, size: int) -> None:
            written.append(path)
            files.append(CacheFile(path=str(path.relative_to(root)), bytes=size))

        record(
            layout.obs_order,
            write_atomic_bytes(layout.obs_order, _array_writer(index.order, "<i4")),
        )
        record(
            layout.obs_time,
            write_atomic_bytes(layout.obs_time, _array_writer(index.time, "<f8")),
        )
        record(
            layout.obs_value,
            write_atomic_bytes(layout.obs_value, _array_writer(index.value, "<f8")),
        )
        record(
            layout.obs_flags,
            write_atomic_bytes(layout.obs_flags, _array_writer(index.flags, "u1")),
        )
        record(layout.obs_sites, _write_parquet_atomic(index.sites, layout.obs_sites))
        record(layout.obs_groups, _write_parquet_atomic(index.groups, layout.obs_groups))

        kinds = index.sites["time_kind"].value_counts()
        payload = {
            "cache_version": CACHE_VERSION,
            "n_obs": index.n_obs,
            "n_sites": int(index.sites.shape[0]),
            "n_groups": int(index.groups.shape[0]),
            "control_rows": index.control_rows,
            "order_digest": index.order_digest,
            "digest_covers": list(DIGEST_PARTS),
            "mapping": MAPPING_NOTE,
            "datetime_origin": DATETIME_ORIGIN,
            "rule_chain": RULE_CHAIN,
            "time_kinds": {str(k): int(v) for k, v in kinds.items()},
            "ordinal": KIND_NO_TIME if (index.sites["time_kind"] == KIND_NO_TIME).any() else None,
            "notes": list(index.notes),
        }
        record(
            layout.obs_index_meta,
            write_atomic_text(layout.obs_index_meta, json.dumps(payload, indent=2)),
        )
        return WrittenArtifact(name="obs_index", files=tuple(files), notes=tuple(index.notes))
    except Exception as exc:
        # Cleanup must never hide the real failure.
        removed = 0
        for path in written:
            try:
                path.unlink(missing_ok=True)
                removed += 1
            except Exception:
                pass
        return _failure(
            layout.control,
            f"failed to write obs_index to {layout.control}: {exc} -- cleaned up {removed} "
            "file(s) already written for this artifact",
        )


def load_obs_index(layout: CacheLayout) -> ObsIndex | ReadFailure:
    """Read the index back. The sidecar and its ``cache_version`` are checked
    first, then every binary file's size, the site and group counts, and last
    the digest over the parts ``digest_covers`` names."""
    meta_path = layout.obs_index_meta
    try:
        raw = json.loads(meta_path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        return _failure(meta_path, f"failed to read {meta_path.name}: {exc}")
    if not isinstance(raw, dict):
        return _failure(meta_path, f"{meta_path.name} is not a JSON object")
    if raw.get("cache_version") != CACHE_VERSION:
        return _failure(
            meta_path,
            f"{meta_path.name} was written at cache_version {raw.get('cache_version')!r}, "
            f"this reader expects {CACHE_VERSION}",
        )
    try:
        n_obs = int(raw["n_obs"])
        control_rows = int(raw["control_rows"])
        digest = str(raw["order_digest"])
        notes = tuple(str(v) for v in raw["notes"])
        n_sites = int(raw["n_sites"])
        n_groups = int(raw["n_groups"])
        covers_raw = raw.get("digest_covers")
        covers = ("order",) if covers_raw is None else tuple(str(v) for v in covers_raw)
    except (KeyError, TypeError, ValueError) as exc:
        return _failure(meta_path, f"{meta_path.name} has an unexpected shape: {exc}")
    unknown = [part for part in covers if part not in DIGEST_PARTS]
    if unknown:
        return _failure(
            meta_path,
            f"{meta_path.name} says its digest covers {unknown[0]!r}, which this reader does "
            "not know; ingest again",
        )
    if covers_raw is None:
        notes = notes + (OLD_DIGEST_NOTE,)

    arrays: dict[str, np.ndarray] = {}
    for label, path, dtype, width in (
        ("order", layout.obs_order, "<i4", 4),
        ("time", layout.obs_time, "<f8", 8),
        ("value", layout.obs_value, "<f8", 8),
        ("flags", layout.obs_flags, "u1", 1),
    ):
        try:
            size = path.stat().st_size
        except OSError as exc:
            return _failure(path, f"failed to read {path.name}: {exc}")
        if size != n_obs * width:
            return _failure(
                path,
                f"{path.name} holds {size} bytes but {n_obs} observations need "
                f"{n_obs * width}",
            )
        arrays[label] = np.fromfile(path, dtype=dtype)

    frames: dict[str, pd.DataFrame] = {}
    for label, path, columns in (
        ("sites", layout.obs_sites, _SITE_COLUMNS),
        ("groups", layout.obs_groups, _GROUP_COLUMNS),
    ):
        try:
            frame = pd.read_parquet(path)
        except Exception as exc:
            return _failure(path, f"failed to read {path.name}: {exc}")
        missing = [c for c in columns if c not in frame.columns]
        if missing:
            return _failure(path, f"{path.name} has no column named {missing[0]!r}")
        frames[label] = frame

    for label, path, expected in (
        ("sites", layout.obs_sites, n_sites),
        ("groups", layout.obs_groups, n_groups),
    ):
        if frames[label].shape[0] != expected:
            return _failure(
                path,
                f"{meta_path.name} says {expected} {label} but {path.name} holds "
                f"{frames[label].shape[0]} rows",
            )

    if _content_digest(
        arrays["order"], arrays["time"], arrays["value"], arrays["flags"], frames["sites"], covers
    ) != digest:
        return _failure(
            meta_path,
            f"the index files do not match the digest recorded in {meta_path.name}",
        )

    return ObsIndex(
        order=arrays["order"].astype(np.int32, copy=False),
        time=arrays["time"],
        value=arrays["value"],
        flags=arrays["flags"],
        sites=frames["sites"],
        groups=frames["groups"],
        control_rows=control_rows,
        order_digest=digest,
        notes=notes,
    )
