"""The residual-histogram brush: the sites of one group with a residual inside a closed range at
one end, what was left out, and where the same sites fall at the other end.

The run has a group ahead of the brushed one, so a site's id is never its row number inside the
group, and the brushed group holds a site with no target.
"""

from __future__ import annotations

import dataclasses
import hashlib
from pathlib import Path

import numpy as np
import pytest

import pesto.api.obs as obs_routes
from ingest.obs_fixtures import SiteSpec
from ingest.test_control_first import in_process  # noqa: F401  (a fixture, used by name)
from pesto.cache.layout import CacheLayout
from pesto.ingest.obsagg import OBS_STATS, load_obs_agg
from pesto.ingest.obsindex import FLAG_HAS_TARGET, SENTINEL_LIMIT, load_obs_index

from .obs_helpers import open_cache, open_obs_run

RESID = OBS_STATS.index("resid_mean")
REALS = ("base", "34", "35", "176")
GROUP = "gw_multi"
SITES = (
    SiteSpec("gw_first", "oname:first:a", (1.0, 2.0), "time-token"),
    SiteSpec(GROUP, "oname:multi:a", (1.0, 2.0, 3.0), "time-token"),
    SiteSpec(GROUP, "oname:multi:b", (1.0, 2.0), "time-token"),
    SiteSpec(GROUP, "oname:multi:c", (1.0, 2.0), "time-token"),
    SiteSpec(GROUP, "oname:multi:d", (1.0,), "time-token", obsval=1e30),
)


def _root(client) -> str:
    return client.pesto_app.state.cache_root


def _layout(client) -> CacheLayout:
    return CacheLayout(root=Path(_root(client)))


def _brush(client, iteration: int, lo, hi, group: str = GROUP):
    return client.get(
        "/api/run/obs/brush", params={"group": group, "iteration": iteration, "lo": lo, "hi": hi}
    )


def _hist(client, group: str = GROUP) -> dict:
    return client.get("/api/run/obs/resid_hist", params={"group": group}).json()


def _site_windows(client, group: str):
    """Each site of ``group`` as (site_id, its rows, which have a target), read from the cached index."""
    index = load_obs_index(_layout(client))
    out = []
    for _, site in index.sites[index.sites["group"] == group].iterrows():
        window = slice(int(site["start"]), int(site["start"]) + int(site["count"]))
        target = (index.flags[window] & FLAG_HAS_TARGET) != 0
        out.append((int(site["site_id"]), window, target))
    return out


def _resid(client, iteration: int) -> np.ndarray:
    return np.asarray(load_obs_agg(iteration, _layout(client)).values[RESID], dtype=np.float64)


def _usable(client, iteration: int, group: str = GROUP) -> list[tuple[float, int]]:
    """Every residual the histogram counts at ``iteration``, with its site id, smallest first."""
    resid = _resid(client, iteration)
    found = []
    for site_id, window, target in _site_windows(client, group):
        r = resid[window]
        ok = target & np.isfinite(r) & (np.abs(r) < SENTINEL_LIMIT)
        found.extend((float(v), site_id) for v in r[ok])
    return sorted(found)


def _expected(client, iteration: int, lo: float, hi: float, group: str = GROUP) -> tuple[list[int], int]:
    """The sites with a counted residual in [lo, hi], and how many residuals that is, worked out site by site."""
    sites, n = [], 0
    for value, site_id in _usable(client, iteration, group):
        if lo <= value <= hi:
            n += 1
            sites.append(site_id)
    return sorted(set(sites)), n


def _snapshot(*roots: Path) -> dict:
    seen = {}
    for root in roots:
        for path in sorted(Path(root).rglob("*")):
            if path.is_file():
                stat = path.stat()
                seen[str(path)] = (stat.st_size, stat.st_mtime_ns, hashlib.sha256(path.read_bytes()).hexdigest())
            else:
                seen[str(path)] = "dir"
    return seen


@pytest.fixture
def run(tmp_path, in_process):  # noqa: F811
    return open_obs_run(tmp_path, iterations=(0, 1), n_real=4, sites=SITES)


# ---------------------------------------------------------------------------
# the brushed sites
# ---------------------------------------------------------------------------


def test_the_brush_returns_the_sites_with_a_residual_in_the_range_ascending(run):
    client, _run = run
    values = _usable(client, 1)
    lo, hi = values[1][0], values[-2][0]

    response = _brush(client, 1, lo, hi)

    assert response.status_code == 200, response.text
    body = response.json()
    sites, n = _expected(client, 1, lo, hi)
    assert body["sites"] == sites == sorted(body["sites"])
    assert body["n_obs_in_range"] == n
    assert (body["group"], body["iteration"], body["lo"], body["hi"]) == (GROUP, 1, lo, hi)


def test_a_residual_exactly_at_lo_or_at_hi_is_brushed(run):
    client, _run = run
    values = _usable(client, 1)
    (lo, lo_site), (hi, hi_site) = values[2], values[4]

    body = _brush(client, 1, lo, hi).json()

    assert lo_site in body["sites"] and hi_site in body["sites"]
    assert body["n_obs_in_range"] == 3
    just_inside = _brush(client, 1, float(np.nextafter(lo, np.inf)), float(np.nextafter(hi, -np.inf))).json()
    assert just_inside["n_obs_in_range"] == 1


def test_lo_equal_to_hi_brushes_that_one_value(run):
    client, _run = run
    value, site = _usable(client, 1)[3]

    body = _brush(client, 1, value, value).json()

    assert body["sites"] == [site]
    assert body["n_obs_in_range"] == 1


def test_a_reversed_range_is_refused_naming_both_ends(run):
    client, _run = run

    response = _brush(client, 1, 2.5, -1.25)

    assert response.status_code == 422
    detail = response.json()["detail"]
    assert "lo" in detail and "hi" in detail
    assert "2.5" in detail and "-1.25" in detail


@pytest.mark.parametrize("bad", ["inf", "-inf", "nan"])
def test_a_range_end_that_is_not_finite_is_refused(run, bad):
    client, _run = run

    assert _brush(client, 1, bad, 1.0).status_code == 422
    assert _brush(client, 1, -1.0, bad).status_code == 422


def test_a_range_catching_nothing_gives_no_sites_and_still_counts_what_was_left_out(run):
    client, _run = run
    top = _usable(client, 1)[-1][0]

    body = _brush(client, 1, top + 1.0, top + 2.0).json()

    assert body["sites"] == []
    assert body["n_obs_in_range"] == 0
    assert body["left_out"] == {"no_target": 1, "sentinel": 0, "no_valid_realization": 0}


def test_sites_are_named_by_their_id_not_by_their_row(run, monkeypatch):
    client, _run = run
    real = obs_routes.obscache.get_index

    def shifted(state, cache_root):
        index = real(state, cache_root)
        sites = index.sites.copy()
        sites["site_id"] = sites["site_id"] + 100
        return dataclasses.replace(index, sites=sites)

    expected, _n = _expected(client, 1, -SENTINEL_LIMIT / 10, SENTINEL_LIMIT / 10)
    monkeypatch.setattr(obs_routes.obscache, "get_index", shifted)

    body = _brush(client, 1, -SENTINEL_LIMIT / 10, SENTINEL_LIMIT / 10).json()

    assert expected and min(expected) > 0
    assert body["sites"] == [s + 100 for s in expected]


# ---------------------------------------------------------------------------
# what the brush leaves out
# ---------------------------------------------------------------------------


def test_an_observation_without_a_target_is_counted_and_never_brushed(run):
    client, _run = run
    no_target_site = next(s for s, _w, target in _site_windows(client, GROUP) if not target.any())

    body = _brush(client, 1, -SENTINEL_LIMIT / 10, SENTINEL_LIMIT / 10).json()

    assert body["left_out"]["no_target"] == 1
    assert no_target_site not in body["sites"]


def test_a_residual_with_no_valid_realization_is_counted_and_never_brushed(tmp_path, in_process):  # noqa: F811
    hit = "oname:multi:c_time:2.0"
    client, _run = open_obs_run(
        tmp_path, iterations=(0, 1), n_real=4, sites=SITES, nan_values={1: [(hit, r) for r in REALS]}
    )

    body = _brush(client, 1, -SENTINEL_LIMIT / 10, SENTINEL_LIMIT / 10).json()

    assert body["left_out"]["no_valid_realization"] == 1
    assert body["n_obs_in_range"] == len(_usable(client, 1))
    assert body["n_obs_in_range"] == _hist(client)["last"]["n"]


def test_a_sentinel_residual_inside_the_range_is_counted_and_not_brushed(run):
    client, _run = run
    layout = _layout(client)
    stored = np.fromfile(layout.obs_agg(1), dtype="<f4")
    agg = load_obs_agg(1, layout)
    grid = stored.reshape(np.asarray(agg.values).shape)
    assert np.array_equal(grid, np.asarray(agg.values, dtype="<f4"), equal_nan=True)
    # Make every residual of site b a 1e30, as a statistics file cut before the sentinel rule kept it.
    site_b = next(
        (s, w) for s, w, t in _site_windows(client, GROUP)
        if load_obs_index(layout).sites.set_index("site_id").loc[s, "site"] == "oname:multi:b"
    )
    grid[RESID, site_b[1]] = 1e30
    grid.tofile(layout.obs_agg(1))
    stale = open_cache(layout.root)

    body = _brush(stale, 1, -1e31, 1e31).json()

    assert body["left_out"]["sentinel"] == 2
    assert site_b[0] not in body["sites"]
    assert body["n_obs_in_range"] == _hist(stale)["last"]["n"]


# ---------------------------------------------------------------------------
# the other iteration, on the histogram's own edges
# ---------------------------------------------------------------------------


def test_the_other_iteration_is_binned_on_the_histograms_edges_for_the_brushed_sites(run):
    client, _run = run
    values = _usable(client, 1)
    lo, hi = values[0][0], values[2][0]

    body = _brush(client, 1, lo, hi).json()
    hist = _hist(client)

    other = body["other"]
    assert other["iteration"] == 0
    edges = np.asarray(hist["edges"])
    brushed = set(body["sites"])
    resid0 = _resid(client, 0)
    picked = []
    for site_id, window, target in _site_windows(client, GROUP):
        if site_id in brushed:
            r = resid0[window][target]
            picked.extend(r[np.isfinite(r) & (np.abs(r) < SENTINEL_LIMIT)])
    counts, _ = np.histogram(np.asarray(picked), bins=edges)
    assert other["counts"] == [int(v) for v in counts]
    assert other["n_obs"] == len(picked) == sum(other["counts"])
    assert other["n_sites"] == len(brushed)
    expected_density = counts / (hist["first"]["n"] * np.diff(edges))
    assert other["density"] == pytest.approx(expected_density.tolist(), rel=1e-12)


def test_brushing_every_site_gives_back_the_whole_other_series(run):
    client, _run = run

    body = _brush(client, 0, -SENTINEL_LIMIT / 10, SENTINEL_LIMIT / 10).json()
    hist = _hist(client)

    assert body["other"]["iteration"] == 1
    assert body["other"]["counts"] == hist["last"]["counts"]
    assert body["other"]["density"] == pytest.approx(hist["last"]["density"], rel=1e-12)


def test_the_brush_reads_the_memoised_histogram_and_builds_no_new_one(run, monkeypatch):
    client, _run = run
    _hist(client)
    calls: list = []
    real = obs_routes.shared_edge_histogram

    def counted(*args, **kwargs):
        calls.append(args)
        return real(*args, **kwargs)

    monkeypatch.setattr(obs_routes, "shared_edge_histogram", counted)

    _brush(client, 1, -1.0, 1.0)
    _brush(client, 0, -1.0, 1.0)

    assert calls == []


def test_a_one_iteration_run_answers_other_null(tmp_path, in_process):  # noqa: F811
    client, _run = open_obs_run(tmp_path, iterations=(0,), n_real=4, sites=SITES)

    body = _brush(client, 0, -SENTINEL_LIMIT / 10, SENTINEL_LIMIT / 10).json()

    assert body["other"] is None
    assert body["sites"]


# ---------------------------------------------------------------------------
# refusals
# ---------------------------------------------------------------------------


def test_an_iteration_that_is_neither_end_is_refused_naming_both(tmp_path, in_process):  # noqa: F811
    client, _run = open_obs_run(tmp_path, iterations=(2, 5), n_real=4, sites=SITES)

    response = _brush(client, 3, -1.0, 1.0)

    assert response.status_code == 422
    detail = response.json()["detail"]
    assert "2" in detail and "5" in detail and "3" in detail
    assert _brush(client, 5, -1.0, 1.0).status_code == 200


def test_an_unknown_group_is_404_and_no_run_open_is_409(run):
    from fastapi.testclient import TestClient

    from pesto.api.app import create_app

    client, _run = run
    missing = _brush(client, 1, -1.0, 1.0, group="nope")
    assert missing.status_code == 404
    assert missing.json()["artifact"] == "obs_index"

    app, token = create_app()
    closed = TestClient(app, base_url="http://127.0.0.1")
    closed.headers["x-pesto-token"] = token
    assert closed.get(
        "/api/run/obs/brush", params={"group": "g", "iteration": 0, "lo": 0, "hi": 1}
    ).status_code == 409


def test_a_run_with_no_observation_ensemble_is_the_no_ensemble_problem(tmp_path, in_process):  # noqa: F811
    client, _run = open_obs_run(tmp_path, iterations=(), par_iterations=(0,), n_real=4, sites=SITES)

    response = _brush(client, 0, -1.0, 1.0)

    assert response.status_code == 404
    assert response.json()["artifact"] == "obs_ens", response.text


def test_the_brush_writes_nothing_to_the_run_or_the_cache(run):
    client, obs_run = run
    _hist(client)
    before = _snapshot(obs_run.root, Path(_root(client)))

    _brush(client, 1, -1.0, 1.0)
    _brush(client, 0, -SENTINEL_LIMIT / 10, SENTINEL_LIMIT / 10)
    _brush(client, 1, 2.0, 1.0)

    assert _snapshot(obs_run.root, Path(_root(client))) == before
