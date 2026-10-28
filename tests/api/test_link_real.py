"""The link and overlay routes checked against the real benchmark runs.

Every test here is slow and runs against whichever benchmark runs are present; each skips
when its folder is absent. Each run is ingested once for this module into a cache under
``tmp_path_factory``, never into the run folder or its .pesto, and the run folder's
snapshot is compared before and after in every test.

Nothing below asserts what a local folder happens to hold. Each check is a relationship
that holds for any run, and a run that cannot show the relationship skips with the reason.
Timings and sizes are printed for the record and never asserted.
"""

from __future__ import annotations

import time
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient
from starlette.responses import Response

from pesto.api import linkcache
from pesto.api.app import create_app
from pesto.api.fields import contributors
from pesto.api.pp import _shape
from pesto.cache.layout import CacheLayout
from pesto.cache.manifest import Manifest
from pesto.ingest.failures import ReadFailure
from pesto.ingest.mesh import load_mesh
from pesto.ingest.obsagg import load_obs_agg
from pesto.ingest.obscell import load_obs_cell
from pesto.ingest.obsindex import FLAG_HAS_TARGET, load_obs_index, usable_mask
from pesto.ingest.obspdc import load_pdc
from pesto.ingest.parview import load_par_change
from pesto.ingest.ppfactors import load_pp_index
from pesto.ingest.runner import ingest_run

pytestmark = pytest.mark.slow

# Case ids are the run folder names, so -k picks one run by its folder.
RUNS = {
    "forecast_run": "forecast_20250618105403",
    "hm_run": "hm_20250406221554",
    "pl253_run": "hm_20251104154614",
    "restarted_run": "hm_20250406221554_restarted",
}
PER_RUN = pytest.mark.parametrize("run_fixture", list(RUNS), ids=list(RUNS.values()))

NEIGHBOUR_SAMPLE = 50
FACTOR_SAMPLE = 20
SEED = 1117


def _snapshot(root: Path) -> dict[str, tuple[int, int]]:
    """Every file and folder under ``root`` with its size and modified time."""
    return {
        str(path.relative_to(root)): (path.stat().st_size, path.stat().st_mtime_ns)
        for path in sorted(root.rglob("*"))
    }


@dataclass(frozen=True)
class Ingested:
    run_dir: Path
    cache_root: Path
    layout: CacheLayout
    manifest: Manifest
    before: dict[str, tuple[int, int]]


_INGESTED: dict[str, Ingested] = {}


@pytest.fixture
def report(capsys):
    """Print a figure for the summary even when pytest captures output."""

    def say(text: str) -> None:
        with capsys.disabled():
            print(f"\n[11-17] {text}")

    return say


@pytest.fixture
def ingested(
    request: pytest.FixtureRequest, tmp_path_factory: pytest.TempPathFactory, run_fixture: str, report
) -> Ingested:
    """The run ingested once for the whole module, with the run folder's snapshot taken
    before the ingest. The cache is always under tmp_path."""
    if run_fixture not in _INGESTED:
        run_dir = request.getfixturevalue(run_fixture)
        cache_root = tmp_path_factory.mktemp(f"link-real-{run_fixture}") / "cache"
        before = _snapshot(run_dir)
        started = time.perf_counter()
        manifest = ingest_run(run_dir, cache_root=cache_root)
        report(f"{RUNS[run_fixture]}: ingest took {time.perf_counter() - started:.1f} s")
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
    """A fresh app on the cache with the run folder open, as the launcher opens it, so
    nothing is held from an earlier test."""
    app, token = create_app()
    app.state.cache_root = str(ing.cache_root)
    app.state.initial_run_dir = str(ing.run_dir)
    client = TestClient(app, base_url="http://127.0.0.1")
    client.headers["x-pesto-token"] = token
    return client


def _get(client: TestClient, path: str, **params):
    response = client.get(path, params=params)
    assert response.status_code == 200, f"{path} {params}: {response.status_code} {response.text}"
    return response


def _ok(ing: Ingested, name: str) -> bool:
    artifact = ing.manifest.artifacts.get(name)
    return artifact is not None and artifact.state == "ok"


def _why_not(ing: Ingested, name: str) -> str:
    artifact = ing.manifest.artifacts.get(name)
    if artifact is None:
        return f"{name} was not ingested for this run"
    return f"{name} is {artifact.state}: {artifact.reason}"


def _vertex_keys(positions: np.ndarray) -> np.ndarray:
    # Adding 0.0 folds -0.0 into 0.0; a corner is its exact float32 x and y bits.
    pos = np.ascontiguousarray(np.asarray(positions, dtype=np.float32).reshape(-1, 2) + np.float32(0.0))
    bits = pos.view(np.uint32).astype(np.uint64)
    return (bits[:, 0] << np.uint64(32)) | bits[:, 1]


# ---------------------------------------------------------------------------
# the neighbour table
# ---------------------------------------------------------------------------


@PER_RUN
def test_the_neighbour_ring_is_symmetric_never_holds_the_cell_and_every_ring_cell_shares_a_corner(
    ingested: Ingested, run_fixture: str, report
):
    if not _ok(ingested, "grid"):
        pytest.skip(f"no grid to build neighbours from: {_why_not(ingested, 'grid')}")
    mesh = load_mesh(ingested.layout)
    assert not isinstance(mesh, ReadFailure), mesh
    n_cells = int(mesh.n_cells)
    if n_cells == 0:
        pytest.skip("the cached grid has no cell")

    client = _client(ingested)
    state = client.app.state
    started = time.perf_counter()
    table = linkcache.cell_neighbours(state, state.cache_root)
    built = time.perf_counter() - started
    assert not isinstance(table, ReadFailure), table
    assert table.n_cells == n_cells, f"the table holds {table.n_cells} cells for a grid of {n_cells}"
    report(f"{RUNS[run_fixture]}: neighbour table for {n_cells} cells built in {built:.3f} s")

    cell = np.asarray(mesh.cell_index, dtype=np.int64)
    keys = _vertex_keys(mesh.positions)
    order = np.argsort(cell, kind="stable")
    bounds = np.searchsorted(cell[order], np.arange(n_cells + 1))

    def corners(c: int) -> set[int]:
        return set(keys[order[bounds[c] : bounds[c + 1]]].tolist())

    rng = np.random.default_rng(SEED)
    sample = rng.choice(n_cells, size=min(NEIGHBOUR_SAMPLE, n_cells), replace=False)
    for c in (int(v) for v in sample):
        ring = table.ring([c]).tolist()
        assert c not in ring, f"cell {c} is its own neighbour"
        mine = corners(c)
        for b in ring:
            assert c in table.ring([b]).tolist(), f"cell {b} is in cell {c}'s ring but not the other way round"
            assert mine & corners(b), f"cell {b} is in cell {c}'s ring but shares no corner with it"

    # The route answers with the same ring; time a cold and then a warm click.
    for position, c in enumerate(int(v) for v in sample[:5]):
        started = time.perf_counter()
        body = _get(client, "/api/run/link/cell", layer=0, cells=str(c)).json()
        took = time.perf_counter() - started
        assert body["ring"] == table.ring([c]).tolist(), f"cell {c}: the route's ring differs from the table's"
        if position == 0:
            started = time.perf_counter()
            _get(client, "/api/run/link/cell", layer=0, cells=str(c))
            warm = time.perf_counter() - started
            report(f"{RUNS[run_fixture]}: /link/cell on cell {c} took {took:.3f} s cold, {warm:.3f} s warm")
    _untouched(ingested)


# ---------------------------------------------------------------------------
# pilot-point weights against fields.contributors
# ---------------------------------------------------------------------------


@PER_RUN
def test_link_cell_pilot_point_weights_equal_contributors_on_sampled_cells_of_every_text_group(
    ingested: Ingested, run_fixture: str, report
):
    if not _ok(ingested, "pp_factors"):
        pytest.skip(f"no pilot points: {_why_not(ingested, 'pp_factors')}")
    index = load_pp_index(ingested.layout)
    assert not isinstance(index, ReadFailure), index
    text = [g for g in index.groups if g.format == "text"]
    binary = [g.group for g in index.groups if g.format != "text"]
    if binary:
        report(f"{RUNS[run_fixture]}: {len(binary)} binary factor group(s) left out: {', '.join(binary)}")
    if not text:
        pytest.skip("no pilot-point group of this run has a text factor file")

    shape = _shape(ingested.layout)
    assert not isinstance(shape, Response), shape.body
    ncpl = int(shape.ncpl)

    client = _client(ingested)
    state = client.app.state
    rng = np.random.default_rng(SEED)
    checked = 0
    for group in text:
        path = ingested.run_dir / group.factor_file
        started = time.perf_counter()
        scanned = linkcache.pp_factor_index(state, state.cache_root, str(ingested.run_dir), group)
        took = time.perf_counter() - started
        assert not isinstance(scanned, ReadFailure), scanned
        report(
            f"{RUNS[run_fixture]}: group {group.group}: first scan of {group.factor_file} "
            f"({path.stat().st_size} bytes) took {took:.3f} s"
        )

        # Half the cells from those with a factor, half from anywhere on the layer.
        with_factor = np.flatnonzero(np.diff(scanned.cell_ptr) > 0)
        half = FACTOR_SAMPLE // 2
        picked: set[int] = set()
        if with_factor.size:
            picked |= {int(v) for v in rng.choice(with_factor, size=min(half, with_factor.size), replace=False)}
        for v in rng.choice(ncpl, size=min(2 * FACTOR_SAMPLE, ncpl), replace=False):
            if len(picked) >= FACTOR_SAMPLE:
                break
            picked.add(int(v))
        names = set(group.parnames)

        for c in sorted(picked):
            expected = contributors(ingested.run_dir, group, c)
            assert not isinstance(expected, ReadFailure), expected
            want = Counter((name, float(str(np.float32(w)))) for name, w in expected if w != 0)

            body = _get(client, "/api/run/link/cell", layer=group.layer, cells=str(c)).json()
            assert not any(n.startswith(f"group {group.group}:") for n in body["par_notes"]), body["par_notes"]
            got = Counter(
                (row["parnme"], w["weight"])
                for row in body["pars"]
                if row["parnme"] in names
                for w in row["weights"]
                if w["cell"] == c
            )
            if body["pars_total"] > len(body["pars"]):
                assert not (got - want), f"group {group.group} cell {c}: listed weights not in the factor file"
            else:
                assert got == want, f"group {group.group} cell {c}: /link/cell weights differ from contributors"
            checked += 1
    _untouched(ingested)
    assert checked > 0


# ---------------------------------------------------------------------------
# at-bounds counts against par_change
# ---------------------------------------------------------------------------


@PER_RUN
def test_at_bounds_counts_agree_with_par_change_at_the_first_and_last_iteration(
    ingested: Ingested, run_fixture: str, report
):
    if not _ok(ingested, "par_change"):
        pytest.skip(f"no parameter change table: {_why_not(ingested, 'par_change')}")
    loaded = load_par_change(ingested.layout)
    assert not isinstance(loaded, ReadFailure), loaded
    frame, meta = loaded
    first, last = int(meta["first_iteration"]), int(meta["last_iteration"])
    ends = [("first", first)] if bool(meta["single_iteration"]) else [("first", first), ("last", last)]

    client = _client(ingested)
    for suffix, k in ends:
        body = _get(client, "/api/run/par/at_bounds", iteration=k).json()
        assert body["available"], f"iteration {k}: {body['reason']}"
        for row in body["groups"]:
            assert 0 <= row["n_at_bounds"] <= row["n_counted"] <= row["n_par"], f"iteration {k}: {row}"
        assert sum(row["n_par"] for row in body["groups"]) == len(frame)

        lower = frame[f"near_lower_{suffix}"].astype("Float64")
        upper = frame[f"near_upper_{suffix}"].astype("Float64")
        both = (lower.notna() & upper.notna()).to_numpy(dtype=bool)
        total = (lower.fillna(0) + upper.fillna(0)).to_numpy(dtype=np.float64)
        expected = int((both & (total >= 1)).sum())
        assert sum(row["n_at_bounds"] for row in body["groups"]) == expected, (
            f"iteration {k}: the at-bounds counts do not add up to the par_change rows near a bound"
        )

    # The names list is unbounded by design, so its size is recorded, not asserted.
    k = ends[-1][1]
    groups = _get(client, "/api/run/par/at_bounds", iteration=k).json()["groups"]
    if groups:
        largest = max(groups, key=lambda row: (row["n_par"], row["group"]))
        response = _get(client, "/api/run/par/at_bounds", iteration=k, group=largest["group"])
        names = response.json()["names"]
        assert len(names) == largest["n_at_bounds"]
        report(
            f"{RUNS[run_fixture]}: /par/at_bounds names for group {largest['group']} "
            f"({largest['n_par']} parameters, {len(names)} at bounds) at iteration {k}: "
            f"{len(response.content)} bytes"
        )
    _untouched(ingested)


# ---------------------------------------------------------------------------
# prior-data conflict
# ---------------------------------------------------------------------------


@PER_RUN
def test_obs_pdc_counts_every_pdc_row_and_names_only_placed_sites(ingested: Ingested, run_fixture: str):
    iterations = sorted(
        int(name.split("/", 1)[1])
        for name, artifact in ingested.manifest.artifacts.items()
        if name.startswith("pdc/") and name.split("/", 1)[1].isdigit() and artifact.state == "ok"
    )
    if not iterations:
        pytest.skip("no prior-data conflict table was ingested for this run")
    if not _ok(ingested, "obs_cell"):
        pytest.skip(f"no observation placement to check site ids against: {_why_not(ingested, 'obs_cell')}")
    cells = load_obs_cell(ingested.layout)
    assert not isinstance(cells, ReadFailure), cells
    placed = {int(v) for v in cells.site_id}

    client = _client(ingested)
    for k in iterations:
        table = load_pdc(k, ingested.layout)
        assert not isinstance(table, ReadFailure), table
        body = _get(client, "/api/run/obs/pdc", iteration=k).json()
        assert body["available"], f"pdc/{k}: {body['reason']}"
        assert body["n_obs"] + body["n_left_out"] == table.n_conflict, (
            f"pdc/{k}: {body['n_obs']} counted + {body['n_left_out']} left out is not its {table.n_conflict} rows"
        )
        assert sum(g["n_obs"] for g in body["by_group"]) == body["n_obs"], f"pdc/{k}: by_group"
        assert sum(g["n_sites"] for g in body["by_group"]) == body["n_sites"], f"pdc/{k}: by_group sites"
        missing = set(body["sites"]["id"]) - placed
        assert not missing, f"pdc/{k}: {len(missing)} site id(s) are not in obs_cell"
    _untouched(ingested)


# ---------------------------------------------------------------------------
# a brush over the whole residual range
# ---------------------------------------------------------------------------


@PER_RUN
def test_brushing_the_whole_residual_range_returns_every_site_with_a_usable_residual_inside_the_edges(
    ingested: Ingested, run_fixture: str, report
):
    if not any(name.startswith("obs_agg/") and a.state == "ok" for name, a in ingested.manifest.artifacts.items()):
        pytest.skip("this run has no observation statistics ingested")
    index = load_obs_index(ingested.layout)
    assert not isinstance(index, ReadFailure), index
    sizes = [int(n) for n in index.groups["n_obs"]]
    stops = np.cumsum(sizes)
    spans = {str(g): (int(stop - n), int(stop)) for g, n, stop in zip(index.groups["group"], sizes, stops)}

    client = _client(ingested)
    group = hist = None
    for name in sorted(spans, key=lambda g: (-(spans[g][1] - spans[g][0]), g)):
        body = _get(client, "/api/run/obs/resid_hist", group=name).json()
        if body["refused"] is None and body["edges"]:
            group, hist = name, body
            break
    if group is None:
        pytest.skip("every observation group's residual histogram is refused")

    k = (hist["last"] or hist["first"])["iteration"]
    lo, hi = float(hist["edges"][0]), float(hist["edges"][-1])
    report(f"{RUNS[run_fixture]}: brushing group {group} at iteration {k} over [{lo!r}, {hi!r}]")
    brush = _get(client, "/api/run/obs/brush", group=group, iteration=k, lo=repr(lo), hi=repr(hi)).json()

    start, stop = spans[group]
    mine = index.sites[(index.sites["group"] == group).to_numpy()].sort_values("start")
    counts = mine["count"].to_numpy(dtype=np.int64)
    assert int(counts.sum()) == stop - start, f"{group}: its sites do not cover its observations"
    row_site = np.repeat(mine["site_id"].to_numpy(dtype=np.int64), counts)
    agg = load_obs_agg(k, ingested.layout)
    assert not isinstance(agg, ReadFailure), agg
    resid = np.asarray(agg.values[agg.stats.index("resid_mean"), start:stop], dtype=np.float64)
    target = (index.flags[start:stop] & FLAG_HAS_TARGET) != 0
    with np.errstate(invalid="ignore"):
        inside = target & usable_mask(resid) & (resid >= lo) & (resid <= hi)
    expected = sorted(int(v) for v in np.unique(row_site[inside]))

    assert brush["sites"] == expected, f"{group}: the full-range brush does not return the expected sites"
    assert brush["n_obs_in_range"] == int(inside.sum())
    _untouched(ingested)
