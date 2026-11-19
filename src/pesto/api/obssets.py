"""Group sets: observation groups that belong together because every one of their
observations holds the same value in one text column of the cached observation table.

On a run that names one group per site, a set (say every group whose ``oname`` is
``coarse.hds``) is what the map draws at once. Sets are worked out here from
``control/obs.parquet`` and ``obs_index``; a client never sends a list of groups.
Values are compared and returned exactly as written, and every group left out of a
set of a column that makes sets is counted in a note.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np

from pesto.api import obscache
from pesto.cache.layout import CacheLayout
from pesto.ingest.failures import ReadFailure
from pesto.ingest.obsindex import IDENTITY_COLUMNS

OBS_TABLE = "control/obs.parquet"
EXCLUDED_COLUMNS = ("obsnme", "obgnme", "datetime", "time", *IDENTITY_COLUMNS)
EXAMPLES = 3
RULE = (
    "a set is every observation group whose observations all hold the same value, exactly as "
    "written, in one text column of the observation data; obsnme, obgnme, the time columns "
    "(datetime, time) and the site columns (" + ", ".join(IDENTITY_COLUMNS) + ") are never "
    "used, and a value held by only one group makes no set"
)


@dataclass(frozen=True)
class GroupSet:
    """One set: the column, the value as written, its member groups in obs_index order."""

    by: str
    value: str
    groups: tuple[str, ...]
    n_sites: int

    @property
    def n_groups(self) -> int:
        return len(self.groups)

    def to_json(self) -> dict:
        return {
            "by": self.by,
            "value": self.value,
            "groups": list(self.groups),
            "n_groups": self.n_groups,
            "n_sites": self.n_sites,
        }


@dataclass(frozen=True)
class GroupSets:
    sets: tuple[GroupSet, ...]
    rule: str
    notes: tuple[str, ...]

    def find(self, by: str, value: str) -> GroupSet | None:
        for item in self.sets:
            if item.by == by and item.value == value:
                return item
        return None


def _is_text(data_type) -> bool:
    import pyarrow as pa

    if pa.types.is_dictionary(data_type):
        data_type = data_type.value_type
    return pa.types.is_string(data_type) or pa.types.is_large_string(data_type)


def candidate_columns(schema) -> list[str]:
    """The text columns a set may come from, in file order."""
    return [
        field.name
        for field in schema
        if field.name not in EXCLUDED_COLUMNS and _is_text(field.type)
    ]


def _names(values) -> str:
    """Up to three quoted names, then how many more there are."""
    listed = ", ".join(repr(v) for v in values[:EXAMPLES])
    more = len(values) - EXAMPLES
    return listed + (f" and {more} more" if more > 0 else "")


def _groups_word(n: int) -> str:
    return "1 group" if n == 1 else f"{n} groups"


def build_group_sets(obs_table, index) -> GroupSets | ReadFailure:
    """The sets of ``obs_table`` (the cached observation table, in control order) for the
    groups of ``index``. Never raises on content it cannot use; it says so instead."""
    import pyarrow as pa
    import pyarrow.compute as pc

    if obs_table.num_rows != index.control_rows:
        return ReadFailure(
            name="control",
            path="",
            reason=(
                f"{OBS_TABLE} has {obs_table.num_rows} rows but obs_index was built from "
                f"{index.control_rows}; ingest the run again"
            ),
        )
    group_names = [str(g) for g in index.groups["group"]]
    group_of = {g: i for i, g in enumerate(group_names)}
    sites = index.sites
    site_group = np.array([group_of.get(str(g), -1) for g in sites["group"]], dtype=np.int64)
    if np.any(site_group < 0):
        return ReadFailure(name="obs_index", path="", reason="a site names a group obs_index does not list")
    n_groups = len(group_names)
    sites_per_group = np.bincount(site_group, minlength=n_groups).astype(np.int64)

    # The group of every control row, through obs_index's own order, never by row position alone.
    counts = sites["count"].to_numpy(dtype=np.int64)
    group_of_position = np.repeat(site_group, counts)
    row_group = np.full(index.control_rows, -1, dtype=np.int64)
    row_group[np.asarray(index.order, dtype=np.int64)] = group_of_position
    if np.any(row_group < 0):
        return ReadFailure(
            name="obs_index", path="", reason="obs_index does not cover every row of the observation table"
        )
    # Rows walked in obs_index order, so a group's first values are its first rows there.
    walk = np.asarray(index.order, dtype=np.int64)

    sets: list[GroupSet] = []
    notes: list[str] = []
    no_set_columns: list[str] = []
    for column in candidate_columns(obs_table.schema):
        raw = obs_table[column]
        if pa.types.is_dictionary(raw.type):
            raw = raw.cast(raw.type.value_type)
        text = raw.combine_chunks()
        encoded = pc.dictionary_encode(text)
        values = encoded.dictionary.to_pylist()
        codes = pc.fill_null(encoded.indices, -1).to_numpy(zero_copy_only=False).astype(np.int64)
        # An empty text is as blank as a missing one; anything else, spaces included, is a value.
        blank_codes = [i for i, v in enumerate(values) if v == ""]
        if blank_codes:
            codes[np.isin(codes, blank_codes)] = -1

        big = np.iinfo(np.int64).max
        low = np.full(n_groups, big, dtype=np.int64)
        high = np.full(n_groups, -1, dtype=np.int64)
        present = codes >= 0
        np.minimum.at(low, row_group[present], codes[present])
        np.maximum.at(high, row_group[present], codes[present])
        has_blank = np.bincount(row_group, weights=~present, minlength=n_groups) > 0

        no_value = low == big
        several = ~no_value & (low != high)
        partial = ~no_value & (low == high) & has_blank
        clean = ~no_value & (low == high) & ~has_blank

        members: dict[int, list[int]] = {}
        for g in np.flatnonzero(clean):
            members.setdefault(int(low[g]), []).append(int(g))
        made = [(code, groups) for code, groups in members.items() if len(groups) > 1]
        if not made:
            no_set_columns.append(column)
            continue
        made.sort(key=lambda item: item[1][0])
        for code, groups in made:
            sets.append(
                GroupSet(
                    by=column,
                    value=values[code],
                    groups=tuple(group_names[g] for g in groups),
                    n_sites=int(sites_per_group[groups].sum()),
                )
            )

        walked_group = row_group[walk]
        walked_code = codes[walk]
        if several.any():
            first = int(np.flatnonzero(several)[0])
            seen = list(dict.fromkeys(int(c) for c in walked_code[(walked_group == first) & (walked_code >= 0)]))
            n = int(several.sum())
            verb = "holds" if n == 1 else "hold"
            notes.append(
                f"column {column!r}: {_groups_word(n)} {verb} more than one value, so "
                f"{'it is' if n == 1 else 'they are'} in no {column} set; first: "
                f"{group_names[first]!r} ({values[seen[0]]!r}, {values[seen[1]]!r})"
            )
        if partial.any():
            first = int(np.flatnonzero(partial)[0])
            n = int(partial.sum())
            verb = "has" if n == 1 else "have"
            notes.append(
                f"column {column!r}: {_groups_word(n)} {verb} a value on some rows and a blank on "
                f"others, so {'it is' if n == 1 else 'they are'} in no {column} set; first: "
                f"{group_names[first]!r} ({values[int(low[first])]!r} and a blank)"
            )
        if no_value.any():
            left = [group_names[g] for g in np.flatnonzero(no_value)]
            verb = "has" if len(left) == 1 else "have"
            notes.append(
                f"column {column!r}: {_groups_word(len(left))} {verb} no {column} value, so "
                f"{'it is' if len(left) == 1 else 'they are'} in no {column} set; {_names(left)}"
            )
    if no_set_columns:
        listed = ", ".join(repr(c) for c in no_set_columns)
        one = len(no_set_columns) == 1
        notes.append(
            f"text {'column' if one else 'columns'} {listed} {'gives' if one else 'give'} no set of "
            f"groups: no value in {'it' if one else 'them'} is shared by more than one whole group"
        )
    return GroupSets(sets=tuple(sets), rule=RULE, notes=tuple(notes))


def _read_obs_table(layout: CacheLayout):
    """The text columns of the cached observation table that sets may come from."""
    import pyarrow.parquet as pq

    path = Path(layout.control) / "obs.parquet"
    try:
        schema = pq.read_schema(path)
        return pq.read_table(path, columns=candidate_columns(schema))
    except Exception as exc:
        return ReadFailure(
            name="control", path=str(path), reason=f"failed to read {OBS_TABLE}: {type(exc).__name__}: {exc}"
        )


def group_sets(state, cache_root) -> GroupSets | ReadFailure:
    """The run's sets, built once until obs_index or the control table is written again."""

    def build(layout: CacheLayout):
        index = obscache.get_index(state, cache_root)
        if isinstance(index, ReadFailure):
            return index
        table = _read_obs_table(layout)
        if isinstance(table, ReadFailure):
            return table
        return build_group_sets(table, index)

    return obscache.memoised(state, cache_root, ("group_sets",), ("obs_index", "control"), build)
