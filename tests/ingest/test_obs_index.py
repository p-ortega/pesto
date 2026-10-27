"""obs_index: a site, a time and a sort order for every observation.

The tracer test ingests a generated run end to end. The rest build the index
straight from an in-memory observation table so each rule is pinned alone.
"""

from __future__ import annotations

import re

import numpy as np
import pytest

import pesto.ingest.runner as runner
from pesto.cache.layout import CacheLayout
from pesto.cache.manifest import Manifest
from pesto.ingest.discover import discover
from pesto.ingest.failures import ReadFailure
from pesto.ingest.obsindex import (
    TIME_TOKEN_PATTERN,
    load_obs_index,
)
from pesto.ingest.runner import ingest_run, plan_artifacts

from .obs_fixtures import make_obs_run
from .test_control_first import in_process  # noqa: F401  (a fixture, used by name)


def _ingest(tmp_path, **kwargs):
    run_dir = tmp_path / "run"
    run = make_obs_run(run_dir, **kwargs)
    cache_root = tmp_path / "cache"
    ingest_run(run_dir, cache_root=cache_root)
    return run, CacheLayout(root=cache_root)


def _site_of(name: str) -> str:
    return re.sub(TIME_TOKEN_PATTERN, "", name, count=1)


# ---------------------------------------------------------------------------
# the tracer
# ---------------------------------------------------------------------------


def test_a_generated_runs_sites_come_out_one_unbroken_run_of_rows_sorted_by_time(
    tmp_path, in_process
):
    run, layout = _ingest(tmp_path)

    manifest = Manifest.load(layout)
    assert manifest.artifacts["obs_index"].state == "ok"

    index = load_obs_index(layout)
    assert not isinstance(index, ReadFailure), index
    names = [run.obs_names[i] for i in index.order]

    # Every control row appears exactly once.
    assert sorted(index.order.tolist()) == list(range(len(run.obs_names)))

    seen_sites: list[str] = []
    for site in index.sites.itertuples():
        rows = names[site.start : site.start + site.count]
        keys = {_site_of(n) for n in rows}
        assert keys == {site.site}
        assert site.site not in seen_sites, "a site must be one unbroken run"
        seen_sites.append(site.site)
        times = index.time[site.start : site.start + site.count]
        assert list(times) == sorted(times)

    head = index.sites[index.sites["site"].str.endswith("trgw-0-1")].iloc[0]
    assert list(index.time[head["start"] : head["start"] + head["count"]]) == [1.0, 9.0, 10.0]
    assert head.time_kind == "numeric"


def test_the_order_file_holds_every_control_row_exactly_once(tmp_path, in_process):
    run, layout = _ingest(tmp_path)

    raw = np.fromfile(layout.obs_order, dtype="<i4")

    assert raw.dtype.itemsize * raw.size == layout.obs_order.stat().st_size
    assert sorted(raw.tolist()) == list(range(len(run.obs_names)))


def test_obs_index_is_planned_right_after_par_cell_with_the_control_sources(tmp_path):
    run_dir = tmp_path / "run"
    run = make_obs_run(run_dir)
    layout = CacheLayout(root=tmp_path / "cache")

    planned = plan_artifacts(discover(run_dir), layout)

    names = [a.name for a in planned]
    assert names[: names.index("obs_index") + 1][-2:] == ["par_cell", "obs_index"]
    by_name = {a.name: a for a in planned}
    assert by_name["obs_index"].sources == by_name["control"].sources
    assert by_name["obs_index"].kind == "obs_index"
    assert str(layout.obs_order) in by_name["obs_index"].outputs
    assert str(layout.obs_index_meta) in by_name["obs_index"].outputs
    assert run.pst_path.name in by_name["obs_index"].sources[0]


def test_obs_index_follows_control_when_the_run_has_no_grid(tmp_path):
    run_dir = tmp_path / "run"
    run = make_obs_run(run_dir)
    run.grid_path.unlink()

    names = [a.name for a in plan_artifacts(discover(run_dir), CacheLayout(root=tmp_path / "c"))]

    assert names[:2] == ["control", "obs_index"]


def test_a_failed_control_makes_obs_index_fail_by_name(tmp_path, in_process, monkeypatch):
    run_dir = tmp_path / "run"
    make_obs_run(run_dir)
    monkeypatch.setattr(
        runner, "read_control", lambda p: ReadFailure("control", str(p), "the file is broken")
    )
    cache_root = tmp_path / "cache"

    manifest = ingest_run(run_dir, cache_root=cache_root)

    artifact = manifest.artifacts["obs_index"]
    assert artifact.state == "failed"
    assert artifact.reason.startswith("obs_index depends on control, which failed: ")


def test_the_worker_reads_named_observation_columns_never_the_whole_table(
    tmp_path, in_process, monkeypatch
):
    run_dir = tmp_path / "run"
    make_obs_run(run_dir)
    full_reads: list[object] = []
    column_reads: list[tuple] = []
    real_tables = runner.load_control_tables
    real_table = runner.load_control_table

    def _tables(layout, obs="full"):
        full_reads.append(obs)
        return real_tables(layout, obs=obs)

    def _table(layout, kind, columns=None, optional_columns=None):
        column_reads.append((kind, tuple(columns or ())))
        return real_table(layout, kind, columns=columns, optional_columns=optional_columns)

    monkeypatch.setattr(runner, "load_control_tables", _tables)
    monkeypatch.setattr(runner, "load_control_table", _table)

    ingest_run(run_dir, cache_root=tmp_path / "cache")

    assert "full" not in full_reads
    assert ("obs", ("obsnme", "obgnme")) in column_reads


# ---------------------------------------------------------------------------
# the rule chain, one rule at a time
# ---------------------------------------------------------------------------

import datetime as _dt  # noqa: E402
import json  # noqa: E402

from pesto.ingest.obsindex import (  # noqa: E402
    FLAG_GREATER,
    FLAG_HAS_TARGET,
    FLAG_LESS,
    FLAG_WEIGHTED,
    GREATER_TAGS,
    KIND_DATETIME,
    KIND_NO_TIME,
    KIND_NUMERIC,
    LESS_TAGS,
    SENTINEL_LIMIT,
    build_obs_index,
    write_obs_index,
)

from .obs_fixtures import obs_arrow  # noqa: E402


def _row(name, group="g", obsval=1.0, weight=1.0, **extra):
    return {"obsnme": name, "obgnme": group, "obsval": obsval, "weight": weight, **extra}


def _build(rows, columns=None):
    index = build_obs_index(obs_arrow(rows, columns))
    assert not isinstance(index, ReadFailure), index
    return index


def _names(index, rows):
    return [rows[i]["obsnme"] for i in index.order]


def _days(text: str) -> float:
    return float((_dt.date.fromisoformat(text) - _dt.date(1970, 1, 1)).days)


def _notes_with(index, fragment):
    return [n for n in index.notes if fragment in n]


def test_a_datetime_column_sorts_by_value_and_is_stored_as_days_since_1970():
    rows = [
        _row("h1", datetime="2020-03-01"),
        _row("h2", datetime="2020-01-15"),
        _row("h3", datetime="2020-02-10"),
    ]

    index = _build(rows)

    assert _names(index, rows) == ["h2", "h3", "h1"]
    assert list(index.time) == [_days("2020-01-15"), _days("2020-02-10"), _days("2020-03-01")]
    assert index.sites["time_kind"].tolist() == [KIND_DATETIME]
    assert index.groups["time_kind"].tolist() == [KIND_DATETIME]


def test_a_year_and_month_is_read_as_the_first_and_counted_once():
    rows = [
        _row("h1", datetime="2024-04"),
        _row("h2", datetime="2024-05-10"),
        _row("h3", datetime="2024-06"),
    ]

    index = _build(rows)

    assert list(index.time) == [_days("2024-04-01"), _days("2024-05-10"), _days("2024-06-01")]
    (note,) = _notes_with(index, "year and month")
    assert note.startswith("2 ")
    assert "h1" in note and "h3" in note


def test_text_that_is_not_a_date_is_not_a_time_and_the_token_is_tried_next():
    rows = [
        _row("s_time:5.0", datetime="not a date"),
        _row("s_time:2.0", datetime=None),
    ]

    index = _build(rows)

    assert list(index.time) == [2.0, 5.0]
    assert index.sites["time_kind"].tolist() == [KIND_NUMERIC]
    (note,) = _notes_with(index, "not a date")
    assert note.startswith("1 ")


def test_a_column_time_wins_over_the_token_and_every_disagreement_is_counted():
    rows = [
        _row("s_time:6.0", time="5.0"),
        _row("s_time:7.0", time="7.0"),
        _row("s_time:9.0", time="8.0"),
    ]

    index = _build(rows)

    assert list(index.time) == [5.0, 7.0, 8.0]
    (note,) = _notes_with(index, "name token")
    assert note.startswith("2 ")


def test_with_no_token_but_a_time_column_the_site_is_the_group_and_its_identity_values():
    rows = [
        _row("a1", group="gA", time="2.0", id="A"),
        _row("a2", group="gA", time="1.0", id="A"),
        _row("b1", group="gA", time="1.0", id="B"),
    ]

    index = _build(rows)

    assert index.sites["site_rule"].tolist() == ["identity-columns", "identity-columns"]
    assert index.sites["count"].tolist() == [2, 1]
    assert _names(index, rows) == ["a2", "a1", "b1"]


def test_with_a_time_column_and_no_identity_value_the_group_is_the_site():
    rows = [
        _row("a1", group="gA", time="2.0", id=None),
        _row("a2", group="gA", time="1.0", id=None),
    ]

    index = _build(rows)

    assert index.sites["site_rule"].tolist() == ["group"]
    assert index.sites["count"].tolist() == [2]
    assert list(index.time) == [1.0, 2.0]


def test_an_id_written_as_NA_or_null_is_a_real_value_part_of_the_site_key():
    rows = [
        _row("a1", time="1.0", id="NA"),
        _row("a2", time="2.0", id="NA"),
        _row("b1", time="1.0", id="null"),
        _row("c1", time="1.0", id=None),
    ]

    index = _build(rows)

    assert index.sites["count"].tolist() == [2, 1, 1]
    assert index.sites["site_rule"].tolist() == ["identity-columns", "identity-columns", "group"]


def test_no_token_and_no_time_makes_every_observation_its_own_ordinal_site():
    rows = [_row("p1"), _row("p2"), _row("p3")]

    index = _build(rows)

    assert index.sites["count"].tolist() == [1, 1, 1]
    assert set(index.sites["site_rule"]) == {"own-site"}
    assert set(index.sites["time_kind"]) == {KIND_NO_TIME}
    assert set(index.groups["time_kind"]) == {KIND_NO_TIME}
    assert list(index.time) == [0.0, 0.0, 0.0]
    assert _names(index, rows) == ["p1", "p2", "p3"]
    (note,) = _notes_with(index, "no time from any source")
    assert note.startswith("3 ")


def test_a_site_mixing_kinds_of_time_is_ordinal_as_a_whole_and_counted():
    rows = [
        _row("s_time:9.0"),
        _row("s_datetime:2020-01-01"),
        _row("s_time:1.0"),
        _row("t_time:4.0"),
    ]

    index = _build(rows)

    mixed = index.sites[index.sites["site"] == "s"].iloc[0]
    assert mixed["time_kind"].startswith("ordinal")
    assert list(index.time[mixed["start"] : mixed["start"] + mixed["count"]]) == [0.0, 1.0, 2.0]
    assert _names(index, rows)[:3] == ["s_time:9.0", "s_datetime:2020-01-01", "s_time:1.0"]
    (note,) = _notes_with(index, "times on only some rows")
    assert note.startswith("1 ")


def test_a_site_where_only_some_rows_have_a_time_is_ordinal_too():
    rows = [_row("s_time:3.0"), _row("s_time:abc"), _row("s_time:1.0")]

    index = _build(rows)

    assert index.sites["time_kind"].iloc[0].startswith("ordinal")
    assert _names(index, rows) == [r["obsnme"] for r in rows]
    assert _notes_with(index, "times on only some rows")


def test_two_observations_with_the_same_site_and_time_are_both_kept_in_control_order():
    rows = [
        _row("s_time:2.0", obsval=5.0),
        _row("s_time:1.0", obsval=1.0),
        _row("s_time:2.0", obsval=7.0),
    ]

    index = _build(rows)

    assert index.n_obs == 3
    assert list(index.time) == [1.0, 2.0, 2.0]
    assert list(index.value) == [1.0, 5.0, 7.0]
    (note,) = _notes_with(index, "share a site and time")
    assert note.startswith("1 ")


def test_times_sort_by_value_never_as_text():
    rows = [_row("s_time:10"), _row("s_time:9"), _row("s_time:100"), _row("s_time:2")]

    index = _build(rows)

    assert _names(index, rows) == ["s_time:2", "s_time:9", "s_time:10", "s_time:100"]


def test_an_underscore_inside_a_value_stays_in_the_site_key():
    rows = [_row("usecol:trgw_0_1_time:3.0"), _row("usecol:trgw_0_1_time:1.0")]

    index = _build(rows)

    assert index.sites["site"].tolist() == ["usecol:trgw_0_1"]
    assert index.sites["site_rule"].tolist() == ["name-token"]


def test_site_keys_compare_by_code_point_with_no_case_folding():
    rows = [
        _row("Abc_time:1.0"),
        _row("abc_time:1.0"),
        _row("é_time:1.0"),
        _row("é_time:1.0"),
    ]

    index = _build(rows)

    assert index.sites.shape[0] == 4


def test_a_sentinel_is_not_a_target_and_nan_is_counted_apart_from_it():
    rows = [
        _row("a", obsval=SENTINEL_LIMIT),
        _row("b", obsval=9.99e19),
        _row("c", obsval=float("nan")),
        _row("d", obsval=-2.0, weight=0.0),
    ]

    index = _build(rows)
    flags = dict(zip(_names(index, rows), index.flags))

    assert not flags["a"] & FLAG_HAS_TARGET
    assert flags["b"] & FLAG_HAS_TARGET
    assert not flags["c"] & FLAG_HAS_TARGET
    assert flags["d"] & FLAG_HAS_TARGET and not flags["d"] & FLAG_WEIGHTED
    assert flags["a"] & FLAG_WEIGHTED
    group = index.groups.iloc[0]
    assert group["n_sentinel"] == 1
    assert group["n_no_value"] == 1
    assert group["n_weighted"] == 3


def test_a_text_obsval_is_counted_as_no_value_not_as_a_sentinel():
    import pyarrow as pa

    table = pa.table(
        {
            "obsnme": ["a", "b"],
            "obgnme": ["g", "g"],
            "obsval": ["abc", "2.5"],
            "weight": [1.0, 1.0],
        }
    )

    index = build_obs_index(table)

    assert not isinstance(index, ReadFailure)
    assert index.groups["n_no_value"].tolist() == [1]
    assert index.groups["n_sentinel"].tolist() == [0]
    assert _notes_with(index, "not a number")


def test_inequality_groups_are_flagged_by_the_same_tags_pyemu_uses():
    from pyemu.pst.pst_handler import get_constraint_tags

    assert LESS_TAGS == tuple(get_constraint_tags("lt"))
    assert GREATER_TAGS == tuple(get_constraint_tags("gt"))

    rows = [_row("a", group="less_gwt_ic"), _row("b", group="G_head"), _row("c", group="plain")]
    index = _build(rows)
    flags = dict(zip(_names(index, rows), index.flags))

    assert flags["a"] & FLAG_LESS and not flags["a"] & FLAG_GREATER
    assert flags["b"] & FLAG_GREATER and not flags["b"] & FLAG_LESS
    assert not flags["c"] & (FLAG_LESS | FLAG_GREATER)
    assert dict(zip(index.groups["group"], index.groups["inequality"])) == {
        "less_gwt_ic": "less",
        "G_head": "greater",
        "plain": "none",
    }


def test_the_group_table_adds_up_to_the_whole_table():
    rows = [
        _row("a_time:1", group="g1", weight=0.0),
        _row("a_time:2", group="g1"),
        _row("b_time:1", group="g2", obsval=1e30),
        _row("c", group="g2"),
        _row("d", group="g3", obsval=float("nan")),
    ]

    index = _build(rows)
    groups = index.groups

    assert groups["group"].tolist() == ["g1", "g2", "g3"]
    assert groups["n_obs"].sum() == len(rows) == index.n_obs
    assert groups["n_sites"].sum() == index.sites.shape[0]
    assert groups["n_weighted"].sum() == 4
    assert groups["n_sentinel"].sum() == 1
    assert groups["n_no_value"].sum() == 1
    assert groups.set_index("group")["site_rule"].to_dict()["g2"] == "mixed"


def test_a_zero_row_table_round_trips_with_its_note(tmp_path):
    table = obs_arrow([], columns=["obsnme", "obgnme", "obsval", "weight"])

    index = build_obs_index(table)

    assert not isinstance(index, ReadFailure), index
    assert index.n_obs == 0
    assert "observation table has zero rows" in index.notes
    layout = CacheLayout(root=tmp_path / "cache")
    written = write_obs_index(index, layout)
    assert not isinstance(written, ReadFailure), written
    back = load_obs_index(layout)
    assert not isinstance(back, ReadFailure), back
    assert back.n_obs == 0
    assert "observation table has zero rows" in back.notes


def test_a_one_row_table_is_one_site_holding_one_observation():
    index = _build([_row("only_time:3.0")])

    assert index.sites["count"].tolist() == [1]
    assert list(index.order) == [0]


def test_the_files_say_the_axis_is_ordinal_when_no_time_was_found(tmp_path):
    index = _build([_row("p1"), _row("p2", group="h")])
    layout = CacheLayout(root=tmp_path / "cache")

    written = write_obs_index(index, layout)
    assert not isinstance(written, ReadFailure), written

    meta = json.loads(layout.obs_index_meta.read_text())
    assert meta["ordinal"] == KIND_NO_TIME
    assert meta["mapping"] == "none supplied"
    assert meta["datetime_origin"] == "1970-01-01"
    assert meta["n_obs"] == 2
    back = load_obs_index(layout)
    assert set(back.sites["time_kind"]) == {KIND_NO_TIME}
    assert set(back.groups["time_kind"]) == {KIND_NO_TIME}


def test_identity_columns_are_kept_on_the_site_row_and_a_varying_one_is_noted():
    rows = [
        _row("s_time:1.0", icpl="7", layer="0"),
        _row("s_time:2.0", icpl="7", layer="1"),
        _row("t_time:1.0", icpl="9", layer=None),
    ]

    index = _build(rows)

    s = index.sites[index.sites["site"] == "s"].iloc[0]
    assert s["icpl"] == "7" and s["layer"] == "0"
    t = index.sites[index.sites["site"] == "t"].iloc[0]
    assert t["icpl"] == "9" and t["layer"] is None
    (note,) = _notes_with(index, "more than one value in the layer column")
    assert note.startswith("1 ")


def test_a_failed_write_removes_the_files_it_already_wrote(tmp_path, monkeypatch):
    import pesto.ingest.obsindex as module

    index = _build([_row("p1")])
    layout = CacheLayout(root=tmp_path / "cache")

    def _boom(df, target):
        raise OSError("disk full")

    monkeypatch.setattr(module, "_write_parquet_atomic", _boom)

    failure = write_obs_index(index, layout)

    assert isinstance(failure, ReadFailure)
    assert "cleaned up 4 file(s)" in failure.reason
    assert not layout.obs_order.exists()
    assert not layout.obs_index_meta.exists()


def test_a_binary_file_of_the_wrong_size_is_refused_by_name(tmp_path):
    index = _build([_row("p1"), _row("p2")])
    layout = CacheLayout(root=tmp_path / "cache")
    write_obs_index(index, layout)
    layout.obs_time.write_bytes(b"\x00" * 8)

    failure = load_obs_index(layout)

    assert isinstance(failure, ReadFailure)
    assert "obs_time.f64" in failure.reason


def test_a_sidecar_from_another_cache_version_is_refused(tmp_path):
    index = _build([_row("p1")])
    layout = CacheLayout(root=tmp_path / "cache")
    write_obs_index(index, layout)
    meta = json.loads(layout.obs_index_meta.read_text())
    meta["cache_version"] = 1
    layout.obs_index_meta.write_text(json.dumps(meta))

    failure = load_obs_index(layout)

    assert isinstance(failure, ReadFailure)
    assert "cache_version" in failure.reason


def test_a_missing_name_is_a_failure_not_a_row_number():
    import pyarrow as pa

    table = pa.table({"obsnme": ["a", None], "obgnme": ["g", "g"]})

    failure = build_obs_index(table)

    assert isinstance(failure, ReadFailure)
    assert "observation name" in failure.reason


# ---------------------------------------------------------------------------
# real runs (slow; skipped when the benchmark folder is absent)
# ---------------------------------------------------------------------------


@pytest.mark.slow
@pytest.mark.parametrize("run_fixture", ["forecast_run", "hm_run", "pl253_run", "restarted_run"])
def test_a_real_runs_index_keeps_every_row_one_run_per_site_and_times_in_order(
    request, tmp_path, run_fixture
):
    from pesto.ingest.control import read_control
    from pesto.ingest.obsindex import IDENTITY_COLUMNS
    from pesto.ingest.tables import load_control_table, write_control

    run_dir = request.getfixturevalue(run_fixture)
    tables = read_control(sorted(run_dir.glob("*.pst"))[0])
    assert not isinstance(tables, ReadFailure), tables
    layout = CacheLayout(root=tmp_path / "cache")
    written = write_control(tables, layout)
    assert not isinstance(written, ReadFailure), written
    loaded = load_control_table(
        layout,
        "obs",
        columns=["obsnme", "obgnme"],
        optional_columns=["obsval", "weight", "datetime", "time", *IDENTITY_COLUMNS],
    )
    assert not isinstance(loaded, ReadFailure), loaded
    table, notes = loaded

    index = build_obs_index(table, notes)

    assert not isinstance(index, ReadFailure), index
    assert index.n_obs == table.num_rows
    assert np.array_equal(np.sort(index.order), np.arange(table.num_rows))
    sites = index.sites
    assert int(sites["count"].sum()) == index.n_obs
    starts = sites["start"].to_numpy()
    assert np.array_equal(starts[1:], np.cumsum(sites["count"].to_numpy())[:-1])
    # Inside each site times never decrease.
    steps = np.diff(index.time)
    inside = np.ones(steps.shape[0], dtype=bool)
    inside[starts[1:] - 1] = False
    assert (steps[inside] >= 0).all()
    # Each group is one unbroken run of sites too.
    group_runs = int((sites["group"] != sites["group"].shift()).sum())
    assert group_runs == sites["group"].nunique()


def test_a_site_name_in_two_groups_is_two_sites_and_the_note_says_so():
    rows = [
        _row("s_time:1.0", group="less_x"),
        _row("s_time:2.0", group="greater_x"),
        _row("s_time:3.0", group="less_x"),
    ]

    index = _build(rows)

    assert index.sites["count"].tolist() == [2, 1]
    assert index.sites["group"].tolist() == ["less_x", "greater_x"]
    (note,) = _notes_with(index, "more than one group")
    assert note.startswith("1 ")


# ---------------------------------------------------------------------------
# the digest covers what dependents are built from (WR-02)
# ---------------------------------------------------------------------------


def test_an_edited_obsval_gives_a_new_digest_and_an_old_obs_agg_is_refused(tmp_path, in_process):
    import dataclasses

    from pesto.ingest.obsagg import load_obs_agg

    from .obs_fixtures import DEFAULT_SITES

    run_dir = tmp_path / "run"
    cache_root = tmp_path / "cache"
    make_obs_run(run_dir, iterations=(0,))
    ingest_run(run_dir, cache_root=cache_root)
    layout = CacheLayout(root=cache_root)
    old = (layout.obs_agg(0).read_bytes(), layout.obs_agg_meta(0).read_bytes())
    old_digest = load_obs_index(layout).order_digest
    old_order = np.fromfile(layout.obs_order, dtype="<i4")

    edited = (dataclasses.replace(DEFAULT_SITES[0], obsval=2.5), *DEFAULT_SITES[1:])
    make_obs_run(run_dir, iterations=(0,), sites=edited)
    ingest_run(run_dir, cache_root=cache_root)
    new = load_obs_index(layout)
    assert not isinstance(new, ReadFailure), new
    assert new.order.tolist() == old_order.tolist()
    assert new.order_digest != old_digest
    layout.obs_agg(0).write_bytes(old[0])
    layout.obs_agg_meta(0).write_bytes(old[1])

    result = load_obs_agg(0, layout)

    assert isinstance(result, ReadFailure)
    assert "ingest the run again" in result.reason


def test_an_edited_weight_gives_a_new_digest_and_an_unchanged_table_gives_the_same():
    rows = [_row("a_time:1.0"), _row("a_time:2.0"), _row("b_time:1.0", weight=0.0)]
    base = _build(rows).order_digest

    now_weighted = [dict(r) for r in rows]
    now_weighted[2]["weight"] = 1.0

    assert _build(now_weighted).order_digest != base
    assert _build(rows).order_digest == base


def test_an_edited_placement_column_gives_a_new_digest():
    rows = [_row("a_time:1.0", icpl="1"), _row("b_time:1.0", icpl="2")]
    moved = [dict(rows[0]), dict(rows[1], icpl="3")]

    assert _build(moved).order_digest != _build(rows).order_digest


def test_the_digest_is_stable_across_builds_and_a_write_and_load(tmp_path):
    rows = [_row("a_time:2.0", icpl="1", layer=None), _row("a_time:1.0", icpl="1", layer=None)]
    first = _build(rows)
    layout = CacheLayout(root=tmp_path / "cache")
    write_obs_index(first, layout)

    assert _build(rows).order_digest == first.order_digest
    back = load_obs_index(layout)
    assert not isinstance(back, ReadFailure), back
    assert back.order_digest == first.order_digest
    assert json.loads(layout.obs_index_meta.read_text())["digest_covers"] == [
        "order",
        "time",
        "value",
        "flags",
        "sites",
    ]


def test_the_arrays_written_do_not_change_with_the_new_digest(tmp_path):
    rows = [_row("a_time:2.0", obsval=4.0), _row("a_time:1.0", obsval=5.0, weight=0.0)]
    layout = CacheLayout(root=tmp_path / "cache")
    write_obs_index(_build(rows), layout)

    assert np.fromfile(layout.obs_order, dtype="<i4").tolist() == [1, 0]
    assert np.fromfile(layout.obs_time, dtype="<f8").tolist() == [1.0, 2.0]
    assert np.fromfile(layout.obs_value, dtype="<f8").tolist() == [5.0, 4.0]


# ---------------------------------------------------------------------------
# older sidecars, count checks, unknown digest parts
# ---------------------------------------------------------------------------


def _rewrite_meta(layout, **changes):
    meta = json.loads(layout.obs_index_meta.read_text())
    meta.update(changes)
    layout.obs_index_meta.write_text(json.dumps(meta))
    return meta


def test_an_older_sidecar_without_digest_covers_loads_with_an_order_only_note(tmp_path):
    import hashlib

    index = _build([_row("a_time:2.0"), _row("a_time:1.0")])
    layout = CacheLayout(root=tmp_path / "cache")
    write_obs_index(index, layout)
    meta = json.loads(layout.obs_index_meta.read_text())
    del meta["digest_covers"]
    meta["order_digest"] = hashlib.sha256(index.order.astype("<i4").tobytes()).hexdigest()
    layout.obs_index_meta.write_text(json.dumps(meta))

    back = load_obs_index(layout)

    assert not isinstance(back, ReadFailure), back
    assert back.order_digest == meta["order_digest"]
    (note,) = [n for n in back.notes if "order only" in n]
    assert "before its digest covered times, values, flags and sites" in note


@pytest.mark.parametrize("key, label", [("n_sites", "sites"), ("n_groups", "groups")])
def test_a_site_or_group_count_that_disagrees_with_its_parquet_is_refused_with_both_numbers(
    tmp_path, key, label
):
    index = _build([_row("a_time:1.0"), _row("b_time:1.0", group="h")])
    layout = CacheLayout(root=tmp_path / "cache")
    write_obs_index(index, layout)
    _rewrite_meta(layout, **{key: 3})

    failure = load_obs_index(layout)

    assert isinstance(failure, ReadFailure)
    assert f"says 3 {label}" in failure.reason and "holds 2 rows" in failure.reason


def test_a_digest_that_names_a_part_this_reader_does_not_know_is_refused(tmp_path):
    index = _build([_row("p1")])
    layout = CacheLayout(root=tmp_path / "cache")
    write_obs_index(index, layout)
    _rewrite_meta(layout, digest_covers=["order", "pixels"])

    failure = load_obs_index(layout)

    assert isinstance(failure, ReadFailure)
    assert "'pixels'" in failure.reason


# ---------------------------------------------------------------------------
# z reaches the site table
# ---------------------------------------------------------------------------


def _adapter_table(index):
    """The site table as the obs_cell worker hands it to the adapter."""
    import pandas as pd

    from pesto.ingest.obsindex import IDENTITY_COLUMNS

    sites = index.sites
    table = pd.DataFrame({"obgnme": sites["group"].astype(str).to_numpy()})
    for column in IDENTITY_COLUMNS:
        if column in sites.columns:
            table[column] = sites[column].to_numpy()
    table.index = pd.Index(sites["site"].astype(str).to_numpy(), name="obsnme")
    return table


def test_z_is_kept_on_the_site_row_as_the_text_given():
    index = _build([_row("s_time:1.0", x="0.5", y="0.5", z="7.0")])

    assert index.sites.iloc[0]["z"] == "7.0"


def test_an_x_y_z_site_is_placed_on_the_layer_that_holds_z(tmp_path):
    from model.fixtures import write_disv_grb

    from pesto.model.mf6 import Mf6Adapter

    rows = [
        _row("upper", x="0.5", y="0.5", z="7.0"),
        _row("lower", x="0.5", y="0.5", z="2.0"),
    ]
    adapter = Mf6Adapter(write_disv_grb(tmp_path / "g.disv.grb", nlay=2, xorigin=0.0, yorigin=0.0))

    result = adapter.locate_obs(_adapter_table(_build(rows)))

    placed = dict(zip(result.site, zip(result.cell.tolist(), result.layer.tolist())))
    assert placed == {"upper": (0, 0), "lower": (0, 1)}


def test_an_x_y_site_with_no_z_stays_unplaced_on_a_two_layer_grid(tmp_path):
    from model.fixtures import write_disv_grb

    from pesto.model.mf6 import Mf6Adapter

    adapter = Mf6Adapter(write_disv_grb(tmp_path / "g.disv.grb", nlay=2, xorigin=0.0, yorigin=0.0))

    result = adapter.locate_obs(_adapter_table(_build([_row("flat", x="0.5", y="0.5")])))

    assert result.placed_sites == 0
