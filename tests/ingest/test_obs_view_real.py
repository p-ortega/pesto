"""The observation view's server side, checked against the real benchmark runs.

Every test here is slow and runs against whichever benchmark runs are present;
each skips when its folder is absent. Every ingest writes to a cache under
``tmp_path``, and a snapshot of the run folder is compared before and after,
because a run folder is a scientist's finished output and must never be written.

Nothing below asserts what a local folder happens to hold. Each check is a
relationship that holds for any run, and a run that cannot show the
relationship skips with the reason.
"""

from __future__ import annotations

import io
import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient

from pesto.api.app import create_app
from pesto.api.obsmap import STATS
from pesto.cache.layout import CacheLayout
from pesto.cache.manifest import Manifest
from pesto.ingest.discover import discover
from pesto.ingest.failures import ReadFailure
from pesto.ingest.obs1to1 import load_obs_1to1
from pesto.ingest.obsagg import load_obs_agg
from pesto.ingest.obscell import load_obs_cell
from pesto.ingest.obsens import load_obs_ensemble
from pesto.ingest.obsindex import FLAG_HAS_TARGET, load_obs_index
from pesto.ingest.runner import ingest_run, plan_artifacts

pytestmark = pytest.mark.slow

RUN_FIXTURES = ("hm_run", "pl253_run", "forecast_run", "restarted_run")


def _snapshot(root: Path) -> dict[str, tuple[int, int]]:
    return {
        str(path.relative_to(root)): (path.stat().st_size, path.stat().st_mtime_ns)
        for path in sorted(root.rglob("*"))
        if path.is_file()
    }


# ---------------------------------------------------------------------------
# planning only: no ingest, so seconds
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("run_fixture", RUN_FIXTURES)
def test_obs_1to1_plans_exactly_when_an_observation_ensemble_plans_and_planning_leaves_the_run_untouched(
    request: pytest.FixtureRequest, tmp_path: Path, run_fixture: str
):
    run_dir = request.getfixturevalue(run_fixture)
    before = _snapshot(run_dir)

    planned = plan_artifacts(discover(run_dir), CacheLayout(root=tmp_path / "cache"))

    ensembles = sorted(
        (int(pa.name.split("/", 1)[1]), pa.name) for pa in planned if pa.kind == "obs_ens"
    )
    one_to_one = [pa for pa in planned if pa.kind == "obs_1to1"]
    if not ensembles:
        assert one_to_one == [], "obs_1to1 was planned with no observation ensemble planned"
    else:
        assert len(one_to_one) == 1, f"expected one obs_1to1, found {len(one_to_one)}"
        needs = one_to_one[0].needs
        first, last = ensembles[0][1], ensembles[-1][1]
        assert first in needs and last in needs, f"needs {needs} do not name {first} and {last}"
        named = {n for n in needs if n.startswith("obs_ens/")}
        assert named == {first, last}, f"needs name obs_ens entries {sorted(named)}, not just {first} and {last}"
        assert "obs_index" in needs
        for end in {first, last}:
            assert f"obs_agg/{end.split('/', 1)[1]}" in needs, f"needs hold no obs_agg for {end}"
    assert _snapshot(run_dir) == before, "planning changed the run folder"
    if not ensembles:
        pytest.skip(f"{run_fixture} plans no observation ensemble, so obs_1to1 correctly plans none")


# ---------------------------------------------------------------------------
# whole runs ingested into a cache under tmp_path
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Ingested:
    run_dir: Path
    cache_root: Path
    layout: CacheLayout
    manifest: Manifest
    before: dict[str, tuple[int, int]]


_INGESTED: dict[str, Ingested] = {}

# This many observation rows are read at a time, so a 500-realization group stays small.
_ROWS_PER_READ = 20_000


@pytest.fixture
def ingested(
    request: pytest.FixtureRequest, tmp_path_factory: pytest.TempPathFactory, run_fixture: str
) -> Ingested:
    """The run ingested once for the whole module, with the run folder's snapshot
    taken before the ingest. The cache is always under tmp_path."""
    if run_fixture not in _INGESTED:
        run_dir = request.getfixturevalue(run_fixture)
        cache_root = tmp_path_factory.mktemp(f"obsview-real-{run_fixture}") / "cache"
        before = _snapshot(run_dir)
        manifest = ingest_run(run_dir, cache_root=cache_root)
        _INGESTED[run_fixture] = Ingested(
            run_dir=run_dir,
            cache_root=cache_root,
            layout=CacheLayout(root=cache_root),
            manifest=manifest,
            before=before,
        )
    return _INGESTED[run_fixture]


def _untouched(ing: Ingested) -> None:
    assert _snapshot(ing.run_dir) == ing.before, "ingesting or reading the cache changed the run folder"
    assert not str(ing.cache_root).startswith(str(ing.run_dir)), "the cache sits inside the run folder"


def _client(ing: Ingested) -> TestClient:
    app, token = create_app()
    app.state.cache_root = str(ing.cache_root)
    client = TestClient(app, base_url="http://127.0.0.1")
    client.headers["x-pesto-token"] = token
    return client


def _get(client: TestClient, path: str, **params):
    response = client.get(path, params=params)
    assert response.status_code == 200, f"{path} {params}: {response.status_code} {response.text}"
    return response


def _table(response) -> pd.DataFrame:
    import pyarrow as pa

    return pa.ipc.open_stream(io.BytesIO(response.content)).read_all().to_pandas()


def _obs_ensemble_iterations(ing: Ingested) -> list[int]:
    found = sorted(
        int(name.split("/", 1)[1])
        for name, artifact in ing.manifest.artifacts.items()
        if name.startswith("obs_ens/") and artifact.state == "ok"
    )
    if not found:
        pytest.skip("this run has no observation ensemble ingested")
    return found


def _index(ing: Ingested):
    index = load_obs_index(ing.layout)
    assert not isinstance(index, ReadFailure), index
    return index


def _group_rows(index) -> dict[str, tuple[int, int]]:
    sizes = [int(n) for n in index.groups["n_obs"]]
    stops = np.cumsum(sizes)
    return {
        str(g): (int(stop - size), int(stop)) for g, size, stop in zip(index.groups["group"], sizes, stops)
    }


def _finite_target_values(stored, start: int, stop: int, target: np.ndarray) -> int:
    """How many simulated values of the group's observations with a target are finite,
    read straight from the cached ensemble in blocks."""
    total = 0
    for begin in range(start, stop, _ROWS_PER_READ):
        end = min(begin + _ROWS_PER_READ, stop)
        block = np.asarray(stored.values[begin:end])
        total += int(np.isfinite(block[target[begin - start : end - start]]).sum())
    return total


@pytest.mark.parametrize("run_fixture", RUN_FIXTURES)
def test_a_whole_ingest_leaves_the_run_folder_untouched_and_the_cache_outside_it(
    ingested: Ingested, run_fixture: str
):
    _untouched(ingested)


@pytest.mark.parametrize("run_fixture", RUN_FIXTURES)
def test_every_1to1_group_counts_every_finite_simulated_value_of_a_target_and_every_refusal_has_a_reason(
    ingested: Ingested, run_fixture: str
):
    ends = _obs_ensemble_iterations(ingested)
    artifact = ingested.manifest.artifacts.get("obs_1to1")
    assert artifact is not None, "obs_1to1 was not planned though an observation ensemble was ingested"
    assert artifact.state == "ok", f"obs_1to1 is {artifact.state}: {artifact.reason}"

    loaded = load_obs_1to1(ingested.layout)
    assert not isinstance(loaded, ReadFailure), loaded
    counts, sidecar = loaded
    assert sidecar["first_iteration"] == ends[0] and sidecar["last_iteration"] == ends[-1]
    index = _index(ingested)
    rows = _group_rows(index)
    assert [entry["group"] for entry in sidecar["groups"]] == list(rows), "the sidecar's groups are not the index's"

    iterations = [ends[0]] if ends[0] == ends[-1] else [ends[0], ends[-1]]
    stored = {k: load_obs_ensemble(k, ingested.layout) for k in iterations}
    for k, value in stored.items():
        assert not isinstance(value, ReadFailure), f"iteration {k}: {value}"

    summed = counts.groupby(["group", "iteration"])["count"].sum()
    grouped = set(counts["group"])
    drawn = 0
    for entry in sidecar["groups"]:
        group = entry["group"]
        start, stop = rows[group]
        has_target = (index.flags[start:stop] & FLAG_HAS_TARGET) != 0
        assert entry["n_with_target"] == int(has_target.sum()), f"{group}: n_with_target"
        if entry["refused"] is not None:
            assert str(entry["refused"]).strip(), f"{group} is refused with no reason"
            assert entry["iterations"] == [], f"{group} is refused yet holds iteration counts"
            assert group not in grouped, f"{group} is refused yet has grid rows"
            continue
        assert [item["iteration"] for item in entry["iterations"]] == iterations, f"{group}: iterations"
        for item in entry["iterations"]:
            k = item["iteration"]
            finite = _finite_target_values(stored[k], start, stop, has_target)
            binned = int(summed.get((group, k), 0))
            assert binned + item["n_outside"] == finite, (
                f"{group} iteration {k}: {binned} binned + {item['n_outside']} outside is not "
                f"the {finite} finite simulated values of its observations with a target"
            )
            assert item["n_points"] == finite, f"{group} iteration {k}: n_points {item['n_points']} != {finite}"
            drawn += 1
    _untouched(ingested)
    if drawn == 0:
        pytest.skip("every group of this run is refused, so no grid count could be checked")


def _largest_placed_group(client: TestClient) -> str:
    groups = _table(_get(client, "/api/run/obs/groups"))
    placed = groups[groups["n_placed"].notna() & (groups["n_placed"] > 0)]
    if placed.empty:
        pytest.skip("no observation group has a placed site on this run")
    return str(placed.sort_values("n_placed", ascending=False, kind="stable").iloc[0]["group"])


@pytest.mark.parametrize("run_fixture", RUN_FIXTURES)
def test_obs_sites_placed_count_equals_the_cached_placement(ingested: Ingested, run_fixture: str):
    _obs_ensemble_iterations(ingested)
    client = _client(ingested)
    group = _largest_placed_group(client)

    sites = _table(_get(client, "/api/run/obs/sites", group=group))
    cells = load_obs_cell(ingested.layout)
    assert not isinstance(cells, ReadFailure), cells
    index = _index(ingested)
    ids = {int(v) for v in index.sites.loc[index.sites["group"] == group, "site_id"]}
    assert {int(v) for v in sites["site_id"]} == ids, "the sites route does not list the group's sites by id"

    cached = pd.Series(cells.cell, index=cells.site_id)
    expected = sum(1 for site in ids if site in cached.index and cached.loc[site] != -1)
    placed = int((sites["cell"] >= 0).sum())
    assert placed == expected, f"{group}: placed sites differ from obs_cell"
    stated = [entry["mapped"] for entry in cells.groups if entry["group"] == group]
    if stated:
        assert placed == stated[0], f"{group}: placed sites differ from obs_cell's own count"

    groups = _table(_get(client, "/api/run/obs/groups"))
    row = groups.loc[groups["group"] == group].iloc[0]
    assert int(row["n_placed"]) == expected
    _untouched(ingested)


def _expected_frame(index, agg, stat: str, start: int, stop: int, time: float, site_order: pd.Index):
    """What a frame must hold at ``time``, worked out from the index and the statistics alone.
    A site with two observations at that time shows the later one."""
    row_stat = agg.values[agg.stats.index(stat)]
    rows = start + np.flatnonzero(index.time[start:stop] == time)
    site_starts = index.sites["start"].to_numpy(dtype=np.int64)
    owner = np.searchsorted(site_starts, rows, side="right") - 1
    site_ids = index.sites["site_id"].to_numpy(dtype=np.int64)[owner]
    _unique, first_seen = np.unique(site_ids[::-1], return_index=True)
    keep = len(rows) - 1 - first_seen
    slots = site_order.get_indexer(site_ids[keep])
    assert (slots >= 0).all(), "an observation at that time belongs to a site the sites route does not list"
    out = np.full(len(site_order), np.nan, dtype=np.float32)
    out[slots] = np.asarray(row_stat[rows[keep]], dtype=np.float32)
    return out, int(keep.size)


@pytest.mark.parametrize("run_fixture", RUN_FIXTURES)
def test_obs_frame_at_every_time_equals_the_statistics_at_the_exact_rows_for_that_time(
    ingested: Ingested, run_fixture: str
):
    ends = _obs_ensemble_iterations(ingested)
    client = _client(ingested)
    group = _largest_placed_group(client)

    axis = _get(client, "/api/run/obs/times", group=group).json()
    if axis["refused"] is not None:
        pytest.skip(f"the largest placed group has no time axis: {axis['refused']}")
    assert axis["times"], "the time axis lists no time"
    sites = _table(_get(client, "/api/run/obs/sites", group=group))
    site_order = pd.Index(sites["site_id"].to_numpy(dtype=np.int64))
    index = _index(ingested)
    start, stop = _group_rows(index)[group]
    aggs = {}
    for k in dict.fromkeys((ends[0], ends[-1])):
        loaded = load_obs_agg(k, ingested.layout)
        assert not isinstance(loaded, ReadFailure), loaded
        aggs[k] = loaded

    times = axis["times"]
    every_stat = {0, len(times) // 2, len(times) - 1}
    for position, time in enumerate(times):
        if position in every_stat:
            pairs = [(k, s) for k in aggs for s in STATS]
        else:
            pairs = [(ends[-1], STATS[position % len(STATS)])]
        for k, stat in pairs:
            response = _get(client, "/api/run/obs/frame", group=group, iteration=k, time=repr(time), stat=stat)
            frame = np.frombuffer(response.content, dtype="<f4")
            expected, n_here = _expected_frame(index, aggs[k], stat, start, stop, time, site_order)
            assert frame.shape == (len(site_order),), f"time {time}: {frame.shape[0]} entries for {len(site_order)} sites"
            assert np.array_equal(frame, expected, equal_nan=True), (
                f"{group} iteration {k} {stat} at time {time}: the frame differs from the statistics"
            )
            meta = json.loads(response.headers["x-pesto-meta"])
            assert meta["n_at_time"] == n_here == axis["n_at_time"][position], f"time {time}: sites at that time"
    _untouched(ingested)


@pytest.mark.parametrize("run_fixture", RUN_FIXTURES)
def test_resid_hist_counts_plus_everything_left_out_equal_the_groups_observations(
    ingested: Ingested, run_fixture: str
):
    _obs_ensemble_iterations(ingested)
    client = _client(ingested)
    index = _index(ingested)
    checked = 0
    for group, (start, stop) in _group_rows(index).items():
        body = _get(client, "/api/run/obs/resid_hist", group=group).json()
        if body["refused"] is not None:
            assert str(body["refused"]).strip(), f"{group} is refused with no reason"
            continue
        left = body["left_out"]
        for slot in ("first", "last"):
            series = body[slot]
            if series is None:
                continue
            no_valid = left["no_valid_realization"][slot]
            total = series["n"] + left["no_value"] + left["sentinel"] + no_valid
            assert total == stop - start, (
                f"{group} {slot}: n {series['n']} + no value {left['no_value']} + sentinel "
                f"{left['sentinel']} + no valid realization {no_valid} is not the {stop - start} observations"
            )
            assert sum(series["counts"]) + body["n_outside"][slot] == series["n"], f"{group} {slot}: bins"
        checked += 1
    _untouched(ingested)
    if checked == 0:
        pytest.skip("every group is refused, so no histogram count could be checked")
