"""The section route checked against the real meshes (D-29).

Each run is ingested once into a cache under ``tmp_path``, never into the run
folder or its ``.pesto``, and HOME points at a fresh scratch folder in every
test. The run folder is compared with its snapshot from before the ingest at
the end of every test, and the scratch cache with its snapshot from before the
section calls, because a run folder is a scientist's finished output and the
route answers from the cache without writing.

The lines are built from the cache's own extent and ring vertices. Every check
is a relationship that holds for any run; nothing asserts what a local folder
happens to hold, and no timing is asserted.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

import pesto.api.section as section_route
from pesto.api.app import create_app
from pesto.cache.layout import CacheLayout
from pesto.ingest.discover import discover
from pesto.ingest.elev import ElevArrays, load_elev
from pesto.ingest.failures import ReadFailure
from pesto.ingest.mesh import load_idomain, load_mesh_extent
from pesto.ingest.runner import ingest_run, plan_artifacts
from pesto.section.assemble import (
    ACTIVE,
    BOTTOM_ABOVE_TOP,
    INACTIVE,
    NON_FINITE,
    PASS_THROUGH,
    PINCHED,
    STATUS_TEXT,
)
from pesto.section.walk import walk

pytestmark = pytest.mark.slow

RUNS = [
    pytest.param("hm_run", id="hm_20250406221554"),
    pytest.param("pl253_run", id="hm_20251104154614"),
    pytest.param("forecast_run", id="forecast_20250618105403"),
    pytest.param("restarted_run", id="hm_20250406221554_restarted"),
    pytest.param("single_layer_structured_run", id="lheg_ies"),
]

BASE_URL = "http://127.0.0.1"
SECTION = "/api/run/grid/section"
N_SAMPLES = 8001
N_RANDOM_LINES = 20
SEED = 1310
TOO_MANY = "the section would hold too many cells"
CROSSES_NONE = "the line crosses no model cell"


def _snapshot(root: Path) -> dict[str, tuple[int, int]]:
    """Every entry under ``root``, folders included, by relative name, size and modified time."""
    out = {}
    for path in sorted(root.rglob("*")):
        st = path.lstat()
        out[str(path.relative_to(root))] = (st.st_size, st.st_mtime_ns)
    return out


@dataclass(frozen=True)
class Ingested:
    run_dir: Path
    cache_root: Path
    before: dict[str, tuple[int, int]]
    grid_names: tuple[str, ...]
    # None when the grid or elev artifact is not there to read; the reason says why.
    arrays: ElevArrays | None
    idomain: np.ndarray | None
    extent: tuple[float, float, float, float] | None
    unreadable: str | None


_INGESTED: dict[str, Ingested] = {}


def _load(cache_root: Path):
    layout = CacheLayout(root=cache_root)
    arrays = load_elev(layout)
    if isinstance(arrays, ReadFailure):
        return None, None, None, f"the cached elevations cannot be read: {arrays.reason}"
    idomain = load_idomain(layout)
    if isinstance(idomain, ReadFailure):
        return None, None, None, f"the cached idomain cannot be read: {idomain.reason}"
    extent = load_mesh_extent(layout)
    if isinstance(extent, ReadFailure):
        return None, None, None, f"the cached extent cannot be read: {extent.reason}"
    return arrays, idomain, tuple(float(v) for v in extent), None


@pytest.fixture
def ingested(request: pytest.FixtureRequest, tmp_path_factory: pytest.TempPathFactory, run_fixture: str) -> Ingested:
    """The run ingested once for the module into a cache under tmp_path, with
    the run folder's snapshot taken before the ingest."""
    if run_fixture not in _INGESTED:
        run_dir = request.getfixturevalue(run_fixture).resolve()
        cache_root = tmp_path_factory.mktemp(f"section-real-{run_fixture}") / "cache"
        assert not cache_root.resolve().is_relative_to(run_dir)
        before = _snapshot(run_dir)
        started = time.perf_counter()
        ingest_run(run_dir, cache_root=cache_root)
        print(f"\n{run_dir.name}: ingest took {time.perf_counter() - started:.1f} s")
        planned = plan_artifacts(discover(run_dir), CacheLayout(root=cache_root))
        grid_names = tuple(pa.name for pa in planned if pa.kind == "grid")
        arrays, idomain, extent, unreadable = _load(cache_root)
        _INGESTED[run_fixture] = Ingested(
            run_dir, cache_root, before, grid_names, arrays, idomain, extent, unreadable
        )
    return _INGESTED[run_fixture]


@dataclass
class Session:
    ing: Ingested
    client: TestClient
    cache_before: dict[str, tuple[int, int]]

    def check_untouched(self) -> None:
        assert _snapshot(self.ing.run_dir) == self.ing.before, "the run folder changed since before the ingest"
        assert _snapshot(self.ing.cache_root) == self.cache_before, "the section calls changed the scratch cache"

    def capability(self) -> dict:
        response = self.client.get("/api/run/ingest/state")
        assert response.status_code == 200, response.text
        return response.json()["capabilities"]["section"]

    def require_section(self) -> ElevArrays:
        """The cached arrays, or a skip carrying the capability's own reason."""
        found = self.capability()
        if not found["available"]:
            pytest.skip("; ".join(f"{f['artifact']}: {f['reason']}" for f in found["blocked_by"]))
        assert self.ing.unreadable is None, f"the section is available but {self.ing.unreadable}"
        return self.ing.arrays


@pytest.fixture
def session(ingested: Ingested, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Session:
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    cache_before = _snapshot(ingested.cache_root)

    app, token = create_app()
    app.state.cache_root = str(ingested.cache_root)
    app.state.initial_run_dir = str(ingested.run_dir)
    client = TestClient(app, base_url=BASE_URL)
    client.headers["x-pesto-token"] = token
    opened = Session(ingested, client, cache_before)
    yield opened
    opened.check_untouched()


# --- lines from the cache's own extent and ring vertices -----------------------------------


def _world_vertices(arrays: ElevArrays) -> np.ndarray:
    return arrays.ring + np.array(arrays.origin, dtype=np.float64)


def _diagonal(extent) -> tuple[np.ndarray, np.ndarray]:
    xmin, xmax, ymin, ymax = extent
    return np.array([xmin, ymin]), np.array([xmax, ymax])


def _lines(arrays: ElevArrays, extent) -> list[tuple[str, np.ndarray, np.ndarray]]:
    xmin, xmax, ymin, ymax = extent
    span = max(xmax - xmin, ymax - ymin)
    pad = 0.1 * span
    world = _world_vertices(arrays)
    rng = np.random.default_rng(SEED)
    lines = [("diagonal", *_diagonal(extent))]

    # The vertex nearest the middle, so the line runs along real edges on a structured grid.
    centre = np.array([(xmin + xmax) / 2.0, (ymin + ymax) / 2.0])
    mid = world[np.argmin(np.hypot(*(world - centre).T))]
    lines.append(("along a vertex's y", np.array([xmin - pad, mid[1]]), np.array([xmax + pad, mid[1]])))

    while True:
        i, j = rng.integers(world.shape[0], size=2)
        if np.hypot(*(world[j] - world[i])) > 1e-3 * span:
            break
    lines.append(("vertex to vertex", world[i].copy(), world[j].copy()))

    lo = np.array([xmin - pad, ymin - pad])
    hi = np.array([xmax + pad, ymax + pad])
    for n in range(N_RANDOM_LINES):
        lines.append((f"random {n}", rng.uniform(lo, hi), rng.uniform(lo, hi)))
    return lines


def _tol(extent) -> float:
    # The route's own tolerance: 1e-9 of the larger side of the mesh extent.
    xmin, xmax, ymin, ymax = extent
    return 1e-9 * max(xmax - xmin, ymax - ymin)


def _ask(s: Session, a: np.ndarray, b: np.ndarray):
    params = {"ax": float(a[0]), "ay": float(a[1]), "bx": float(b[0]), "by": float(b[1])}
    return s.client.get(SECTION, params=params)


# --- an independent dense-sampling reference on the cached float64 rings ------------------


def _boxes(arrays: ElevArrays, grow: float):
    ring, start = arrays.ring, arrays.ring_start[:-1]
    return (
        np.minimum.reduceat(ring[:, 0], start) - grow,
        np.maximum.reduceat(ring[:, 0], start) + grow,
        np.minimum.reduceat(ring[:, 1], start) - grow,
        np.maximum.reduceat(ring[:, 1], start) + grow,
    )


def _clip(a, d, xlo, xhi, ylo, yhi):
    """The stretch of t in [0, 1] where the line meets each box, empty when t_lo > t_hi."""
    t_lo = np.zeros(xlo.size)
    t_hi = np.ones(xlo.size)
    for p, dp, lo, hi in ((a[0], d[0], xlo, xhi), (a[1], d[1], ylo, yhi)):
        if dp == 0.0:
            t_hi = np.where((p < lo) | (p > hi), -1.0, t_hi)
        else:
            t1, t2 = (lo - p) / dp, (hi - p) / dp
            t_lo = np.maximum(t_lo, np.minimum(t1, t2))
            t_hi = np.minimum(t_hi, np.maximum(t1, t2))
    return t_lo, t_hi


def _reference(arrays: ElevArrays, a, b, tol):
    """Each sample's cell by an even-odd test (-1 for none), how many cells hold it,
    and whether it lies within 2 * tol of any cell edge, where the walk may differ.

    Only the cells whose box (grown by 2 * tol) the line meets are tested, and only
    on the samples inside that box, so a whole real mesh stays quick to sample."""
    ring, start = arrays.ring, arrays.ring_start
    d = b - a
    ts = np.linspace(0.0, 1.0, N_SAMPLES)
    qx = a[0] + ts * d[0]
    qy = a[1] + ts * d[1]
    owner = np.full(N_SAMPLES, -1, dtype=np.int64)
    n_owners = np.zeros(N_SAMPLES, dtype=np.int64)
    near_edge = np.zeros(N_SAMPLES, dtype=bool)

    t_lo, t_hi = _clip(a, d, *_boxes(arrays, 2.0 * tol))
    hit = np.nonzero(t_lo <= t_hi)[0]
    # One sample of slack each side, because the box test is only a filter.
    k_lo = np.clip(np.floor(t_lo[hit] * (N_SAMPLES - 1)).astype(np.int64) - 1, 0, N_SAMPLES - 1)
    k_hi = np.clip(np.ceil(t_hi[hit] * (N_SAMPLES - 1)).astype(np.int64) + 1, 0, N_SAMPLES - 1)
    for c, k0, k1 in zip(hit.tolist(), k_lo.tolist(), k_hi.tolist()):
        px, py = qx[k0 : k1 + 1], qy[k0 : k1 + 1]
        x, y = ring[start[c] : start[c + 1], 0], ring[start[c] : start[c + 1], 1]
        x1, y1 = np.roll(x, -1), np.roll(y, -1)
        crossings = np.zeros(px.size, dtype=np.int64)
        near = np.zeros(px.size, dtype=bool)
        with np.errstate(divide="ignore", invalid="ignore"):
            for i in range(x.size):
                straddle = (y[i] > py) != (y1[i] > py)
                xc = x[i] + (py - y[i]) * (x1[i] - x[i]) / (y1[i] - y[i])
                crossings += straddle & (px < xc)
                ex, ey = x1[i] - x[i], y1[i] - y[i]
                u = np.clip(((px - x[i]) * ex + (py - y[i]) * ey) / (ex * ex + ey * ey), 0.0, 1.0)
                near |= np.hypot(px - (x[i] + u * ex), py - (y[i] + u * ey)) <= 2.0 * tol
        inside = crossings % 2 == 1
        owner[k0 : k1 + 1][inside] = c
        n_owners[k0 : k1 + 1] += inside
        near_edge[k0 : k1 + 1] |= near
    return ts * float(np.hypot(*d)), owner, n_owners, near_edge


def _check_walk(label: str, arrays: ElevArrays, body: dict | None, a, b, tol) -> None:
    """The answer's pieces against the reference; ``body`` None means the route
    said the line crosses no model cell."""
    s, owner, n_owners, near_edge = _reference(arrays, a, b, tol)
    clear = ~near_edge
    doubled = np.nonzero(clear & (n_owners > 1))[0]
    assert doubled.size == 0, f"{label}: the mesh has overlapping cells at s = {s[doubled[:3]].tolist()}"
    if body is None:
        inside = np.nonzero(clear & (owner >= 0))[0]
        assert inside.size == 0, f"{label}: refused as crossing no cell, but s = {s[inside[:3]].tolist()} is inside one"
        return

    cell = np.asarray(body["cell"], dtype=np.int64)
    s0 = np.asarray(body["s0"], dtype=np.float64)
    s1 = np.asarray(body["s1"], dtype=np.float64)
    assert (np.diff(s0) >= 0).all(), f"{label}: the pieces are not ordered by s0"
    assert (s0[1:] >= s1[:-1] - tol).all(), f"{label}: two pieces overlap by more than the tolerance"
    assert ((s1 - s0) > tol).all(), f"{label}: a piece is no longer than the tolerance"

    mismatches = []
    for k in np.nonzero(clear)[0].tolist():
        covering = cell[(s0 - tol <= s[k]) & (s[k] <= s1 + tol)]
        expected = [] if owner[k] < 0 else [int(owner[k])]
        if covering.tolist() != expected:
            mismatches.append((float(s[k]), expected, covering.tolist()))
    assert mismatches == [], f"{label} {a.tolist()} -> {b.tolist()}: first mismatches {mismatches[:3]}"


def _answered(label: str, s: Session, arrays: ElevArrays, a, b, tol) -> tuple[str, dict | None]:
    """``("ok", body)``, ``("none", None)`` when the route says the line crosses no
    cell, or ``("too many", None)``. A refusal for size must agree with the walk's
    own piece count."""
    response = _ask(s, a, b)
    if response.status_code == 200:
        return "ok", response.json()
    assert response.status_code == 422, f"{label}: {response.status_code} {response.text}"
    title = response.json()["title"]
    if title == TOO_MANY:
        origin = np.array(arrays.origin, dtype=np.float64)
        cell, *_ = walk(arrays.ring[:, 0], arrays.ring[:, 1], arrays.ring_start, a - origin, b - origin, tol)
        assert cell.size * arrays.nlay > section_route.MAX_SECTION_QUADS, (
            f"{label}: refused for size with {cell.size} pieces over {arrays.nlay} layers"
        )
        print(f"{s.ing.run_dir.name}: {label} is refused for size, {cell.size * arrays.nlay} section cells")
        return "too many", None
    assert title == CROSSES_NONE, f"{label}: {response.text}"
    return "none", None


# --- the checks ----------------------------------------------------------------------------


@pytest.mark.parametrize("run_fixture", RUNS)
def test_the_section_is_available_or_names_the_grid_or_elev_artifact_that_blocks_it(session: Session, run_fixture: str):
    found = session.capability()
    if found["available"]:
        assert found["blocked_by"] == []
        assert session.ing.unreadable is None, f"the section is available but {session.ing.unreadable}"
    else:
        assert found["blocked_by"], "the section is unavailable with no reason"
        for fact in found["blocked_by"]:
            assert fact["artifact"] in {"elev", *session.ing.grid_names}, fact
            assert fact["reason"], f"{fact['artifact']} blocks the section with an empty reason"
        if any(fact["artifact"] == "elev" for fact in found["blocked_by"]):
            # The route refuses on the elev record before it reads the line, so any line will do.
            refused = _ask(session, np.zeros(2), np.ones(2))
            assert refused.status_code == 409, refused.text
    session.check_untouched()


@pytest.mark.parametrize("run_fixture", RUNS)
def test_every_line_gives_ordered_pieces_that_agree_with_a_dense_sampling_reference(session: Session, run_fixture: str):
    arrays = session.require_section()
    extent = session.ing.extent
    tol = _tol(extent)
    origin = np.array(arrays.origin, dtype=np.float64)
    checked = 0
    for label, a, b in _lines(arrays, extent):
        said, body = _answered(label, session, arrays, a, b, tol)
        if said == "too many":
            continue
        # The reference samples in the rings' own frame, as the route walks.
        _check_walk(label, arrays, body, a - origin, b - origin, tol)
        checked += 1
    print(f"{session.ing.run_dir.name}: {checked} lines checked against the reference")
    assert checked > 0, "every line was refused for size"
    session.check_untouched()


@pytest.mark.parametrize("run_fixture", RUNS)
def test_every_quad_takes_its_cell_elevations_and_the_status_rule_from_the_cache(session: Session, run_fixture: str):
    arrays = session.require_section()
    idomain = session.ing.idomain
    tol = _tol(session.ing.extent)
    nlay, ncpl = arrays.nlay, arrays.ncpl
    for label, a, b in _lines(arrays, session.ing.extent):
        said, body = _answered(label, session, arrays, a, b, tol)
        if said != "ok":
            continue
        n = body["n_pieces"]
        cell = np.asarray(body["cell"], dtype=np.int64)
        assert body["nlay"] == nlay and cell.size == n
        assert n * nlay <= section_route.MAX_SECTION_QUADS, f"{label}: {n * nlay} section cells were answered"
        assert len(body["z"]) == n * (nlay + 1) and len(body["status"]) == n * nlay
        assert body["has_idomain"] is (idomain is not None)
        assert body["status_text"] == {str(k): v for k, v in STATUS_TEXT.items()}

        gathered = arrays.elev[:, cell].T
        want_z = np.where(np.isfinite(gathered), gathered, np.nan)
        got_z = np.array([np.nan if v is None else v for v in body["z"]], dtype=np.float64).reshape(n, nlay + 1)
        assert np.array_equal(got_z, want_z, equal_nan=True), f"{label}: a quad's z is not its cell's cached elevation"

        top, bot = gathered[:, :-1], gathered[:, 1:]
        finite = np.isfinite(top) & np.isfinite(bot)
        with np.errstate(invalid="ignore"):
            above = finite & (bot > top)
            pinched = finite & (bot == top)
        want = np.select([~finite, above, pinched], [NON_FINITE, BOTTOM_ABOVE_TOP, PINCHED], default=ACTIVE)
        below_minus_1 = 0
        if idomain is not None:
            ido = np.asarray(idomain).reshape(nlay, ncpl)[:, cell].T
            want = np.where(ido == 0, INACTIVE, np.where(ido < 0, PASS_THROUGH, want))
            below_minus_1 = int((ido < -1).sum())
        got = np.asarray(body["status"], dtype=np.int64).reshape(n, nlay)
        wrong = np.argwhere(got != want)
        assert wrong.size == 0, (
            f"{label}: piece {wrong[0][0]} (cell {cell[wrong[0][0]]}) layer {wrong[0][1]} has status "
            f"{got[tuple(wrong[0])]}, the cache says {want[tuple(wrong[0])]}"
        )
        counts = body["counts"]
        assert counts["non_finite"] == int((~finite).sum())
        assert counts["bottom_above_top"] == int(above.sum())
        assert counts["pinched"] == int(pinched.sum())
        assert counts["idomain_below_minus_1"] == below_minus_1
    session.check_untouched()


@pytest.mark.parametrize("run_fixture", RUNS)
def test_the_diagonal_time_counts_and_size_are_printed(session: Session, run_fixture: str):
    arrays = session.require_section()
    a, b = _diagonal(session.ing.extent)
    times = []
    for _ in range(5):
        started = time.perf_counter()
        response = _ask(session, a, b)
        times.append(time.perf_counter() - started)
    name = session.ing.run_dir.name
    median_ms = float(np.median(times)) * 1000
    if response.status_code == 200:
        body = response.json()
        print(
            f"\n{name}: diagonal median {median_ms:.1f} ms over 5, {body['n_pieces']} pieces, "
            f"{body['n_pieces'] * arrays.nlay} quads over {arrays.nlay} layers, {len(response.content)} bytes"
        )
    else:
        print(f"\n{name}: diagonal median {median_ms:.1f} ms over 5, refused {response.status_code}: {response.text}")
        assert response.status_code == 422, response.text
    session.check_untouched()
