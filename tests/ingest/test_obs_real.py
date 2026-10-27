"""A whole benchmark run ingested end to end, every observation artifact accounted for.

Every test here is slow and runs against whichever benchmark runs are present;
each skips when its folder is absent. The cache goes under ``tmp_path`` and a
snapshot of the run folder is compared before and after, because a run folder
is a scientist's finished output and must never be written.

Nothing below asserts how many sites, groups or realizations a folder holds.
The checks are relationships that hold for any run: an artifact is ok or says
why not under its own name, and a capability is available exactly when the
artifacts behind it are ok.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from pesto.api.app import create_app
from pesto.cache.layout import CacheLayout
from pesto.cache.manifest import Manifest
from pesto.ingest.discover import discover
from pesto.ingest.runner import ingest_run, plan_artifacts

pytestmark = pytest.mark.slow

OBS_KINDS = ("obs_index", "obs_cell", "obs_ens", "obs_agg", "noise_agg", "pdc", "phi_check")
RUN_FIXTURES = ("hm_run", "pl253_run", "forecast_run", "restarted_run")


_INGESTED: dict[str, tuple[Path, Path, Manifest, dict]] = {}


def _snapshot(root: Path) -> dict[str, tuple[int, int]]:
    return {
        str(path.relative_to(root)): (path.stat().st_size, path.stat().st_mtime_ns)
        for path in sorted(root.rglob("*"))
        if path.is_file()
    }


def _state(run_dir: Path, cache_root: Path) -> dict:
    app, token = create_app()
    app.state.initial_run_dir = str(run_dir)
    app.state.cache_root = str(cache_root)
    client = TestClient(app, base_url="http://127.0.0.1")
    response = client.get("/api/run/ingest/state", headers={"x-pesto-token": token})
    assert response.status_code == 200, response.text
    return response.json()


def _is_ok(manifest: Manifest, name: str) -> bool:
    artifact = manifest.artifacts.get(name)
    return artifact is not None and artifact.state == "ok"


@pytest.fixture
def ingested(request: pytest.FixtureRequest, tmp_path_factory: pytest.TempPathFactory, run_fixture: str):
    """The run, its manifest, the run folder's snapshot from before, and the cache root.
    Ingested once per run for the whole module; later tests reuse it."""
    if run_fixture not in _INGESTED:
        run_dir = request.getfixturevalue(run_fixture)
        cache_root = tmp_path_factory.mktemp(f"obs-real-{run_fixture}") / "cache"
        before = _snapshot(run_dir)
        manifest = ingest_run(run_dir, cache_root=cache_root)
        _INGESTED[run_fixture] = (run_dir, cache_root, manifest, before)
    return _INGESTED[run_fixture]


@pytest.mark.parametrize("run_fixture", RUN_FIXTURES)
def test_a_whole_run_ingests_and_every_observation_artifact_accounts_for_itself(
    ingested, run_fixture: str
):
    run_dir, cache_root, manifest, before = ingested

    assert _snapshot(run_dir) == before, "ingesting changed the run folder"

    layout = CacheLayout(root=cache_root)
    run = discover(run_dir)
    planned = plan_artifacts(run, layout)
    observation = [pa for pa in planned if pa.kind in OBS_KINDS]
    assert any(pa.kind == "obs_index" for pa in observation), "no obs_index was planned"

    for pa in observation:
        artifact = manifest.artifacts.get(pa.name)
        assert artifact is not None, f"{pa.name} was planned but the manifest holds no record of it"
        if artifact.state != "ok":
            assert artifact.reason, f"{pa.name} is {artifact.state} with no reason"
            assert artifact.reason.startswith(pa.name), (
                f"{pa.name} failed with a reason that does not start with its own name: "
                f"{artifact.reason!r}"
            )


@pytest.mark.parametrize("run_fixture", RUN_FIXTURES)
def test_capabilities_are_available_exactly_when_their_artifacts_are_ok(
    ingested, run_fixture: str
):
    run_dir, cache_root, manifest, _before = ingested
    layout = CacheLayout(root=cache_root)
    run = discover(run_dir)
    planned = plan_artifacts(run, layout)
    names = {kind: [pa.name for pa in planned if pa.kind == kind] for kind in OBS_KINDS}

    capabilities = _state(run_dir, cache_root)["capabilities"]

    index_ok = all(_is_ok(manifest, n) for n in names["obs_index"])
    expected = {
        "obs": index_ok and any(_is_ok(manifest, n) for n in names["obs_ens"]),
        "obs_stats": any(_is_ok(manifest, n) for n in names["obs_agg"]),
        "noise": bool(names["noise_agg"]) and all(_is_ok(manifest, n) for n in names["noise_agg"]),
        "pdc": bool(names["pdc"]) and all(_is_ok(manifest, n) for n in names["pdc"]),
        "phi_check": bool(names["phi_check"]) and all(_is_ok(manifest, n) for n in names["phi_check"]),
    }
    for capability, should_be_available in expected.items():
        got = capabilities[capability]
        assert got["available"] is should_be_available, (
            f"{capability}: available={got['available']} but the artifacts say {should_be_available}; "
            f"blocked_by={got['blocked_by']}"
        )
        if not got["available"]:
            assert got["blocked_by"], f"{capability} is unavailable and gives no reason"
            for fact in got["blocked_by"]:
                assert fact["reason"], f"{capability} is blocked by {fact['artifact']} with no reason"


@pytest.mark.parametrize("run_fixture", RUN_FIXTURES)
def test_a_run_with_no_observation_ensemble_file_says_so_and_a_pdc_file_is_still_read(
    ingested, run_fixture: str
):
    run_dir, cache_root, manifest, _before = ingested
    layout = CacheLayout(root=cache_root)
    run = discover(run_dir)

    if not run.obs_ens:
        capabilities = _state(run_dir, cache_root)["capabilities"]
        assert capabilities["obs"]["available"] is False
        reasons = " ".join(fact["reason"] or "" for fact in capabilities["obs"]["blocked_by"])
        assert "no observation ensemble file" in reasons

    for key, path in run.pdc.items():
        name = f"pdc/{key}"
        artifact = manifest.artifacts.get(name)
        if artifact is None or artifact.state != "ok":
            continue
        assert path.is_file()
        sidecar = json.loads(layout.pdc_meta(key).read_text())
        assert sidecar["source"] == "file", f"{name} has a pestpp pdc file but says {sidecar['source']!r}"


# ---------------------------------------------------------------------------
# where each site sits: reasons, the model's own input, and the placement gate
# ---------------------------------------------------------------------------

LIST_PACKAGE_TAGS = ("CHD", "DRN", "GHB", "RIV", "WEL", "RCH", "EVT", "CNC", "SRC")
MODEL_OBSERVATION_TYPES = ("HEAD", "DRAWDOWN", "CONCENTRATION")


def _obs_cell_plan(run_dir: Path, cache_root: Path, manifest: Manifest):
    """The layout and the planned obs_cell artifact. Skips when none was
    planned; fails with the manifest's reason when it was planned and is not ok,
    because a failed obs_cell places nothing."""
    layout = CacheLayout(root=cache_root)
    planned = [pa for pa in plan_artifacts(discover(run_dir), layout) if pa.kind == "obs_cell"]
    if not planned:
        pytest.skip("obs_cell was not planned for this run")
    artifact = manifest.artifacts.get(planned[0].name)
    if artifact is None or artifact.state != "ok":
        reason = None if artifact is None else artifact.reason
        pytest.fail(f"{planned[0].name} was planned but is not ok: {reason}")
    return layout, planned[0], artifact


def _loaded_obs_cell(layout: CacheLayout):
    from pesto.ingest.obscell import ObsCellTable, load_obs_cell

    table = load_obs_cell(layout)
    assert isinstance(table, ObsCellTable), getattr(table, "reason", table)
    return table


def _grid_file_name(plan) -> str:
    grids = [Path(s).name for s in plan.sources if s.endswith(".grb")]
    assert grids, f"{plan.name} records no .grb among its sources: {plan.sources}"
    return grids[0]


@pytest.mark.parametrize("run_fixture", RUN_FIXTURES)
def test_every_unplaced_site_says_why_and_every_site_from_the_model_input_sits_in_the_grid(
    ingested, run_fixture: str
):
    from pesto.model import GridShape
    from pesto.model.mf6 import Mf6Adapter

    run_dir, cache_root, manifest, _before = ingested
    layout, plan, _artifact = _obs_cell_plan(run_dir, cache_root, manifest)
    table = _loaded_obs_cell(layout)
    assert table.note is not None, "obs_cell has no per-site notes"

    for i, cell in enumerate(table.cell):
        if cell == -1:
            assert table.note[i], f"unplaced site {table.site[i]!r} has no note"

    shape = Mf6Adapter(run_dir / _grid_file_name(plan)).grid_shape()
    assert isinstance(shape, GridShape), shape
    for i, rule in enumerate(table.rule):
        if rule != "mf6-obs":
            continue
        assert 0 <= table.cell[i] < shape.ncpl, f"{table.site[i]!r} has cell {table.cell[i]} outside the grid"
        if table.layer[i] == -1:
            assert "spans layers" in table.note[i] or "layer unknown" in table.note[i], (
                f"{table.site[i]!r} has no layer and its note does not say why: {table.note[i]!r}"
            )
        else:
            assert 0 <= table.layer[i] < shape.nlay, f"{table.site[i]!r} has layer {table.layer[i]} outside the grid"


@pytest.mark.parametrize("run_fixture", RUN_FIXTURES)
def test_a_run_with_a_simulation_file_lists_it_among_obs_cell_sources(ingested, run_fixture: str):
    run_dir, cache_root, manifest, _before = ingested
    _layout, plan, artifact = _obs_cell_plan(run_dir, cache_root, manifest)

    if not (run_dir / "mfsim.nam").is_file():
        pytest.skip("this run has no mfsim.nam")

    recorded = {Path(s.path).name for s in artifact.sources}
    assert "mfsim.nam" in recorded, f"{plan.name} records no mfsim.nam among its sources"


@pytest.mark.parametrize("run_fixture", RUN_FIXTURES)
def test_listing_the_model_observation_files_takes_under_a_second(ingested, run_fixture: str):
    import time

    from pesto.model.mf6 import observation_input_files

    run_dir, _cache_root, _manifest, _before = ingested

    started = time.perf_counter()
    observation_input_files(run_dir)
    elapsed = time.perf_counter() - started

    assert elapsed < 1.0, f"listing the observation input files took {elapsed:.2f} s"


def _usecol_token(site: str) -> str:
    """The text after the last ``usecol:`` up to the next ``_word:`` or the end, case-folded."""
    _head, found, rest = site.rpartition("usecol:")
    if not found:
        return ""
    return re.split(r"_[A-Za-z][A-Za-z0-9]*:", rest, maxsplit=1)[0].strip().casefold()


def _block_first_tokens(path: Path) -> set[str]:
    """A crude scan of an OBS6 file: the first word of each line inside a
    continuous or single block, lower-cased, quotes stripped, no OPEN/CLOSE followed."""
    found: set[str] = set()
    inside = False
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeDecodeError):
        return found
    for line in lines:
        words = line.split()
        if not words:
            continue
        head = words[0].lower()
        if head == "begin" and len(words) > 1 and words[1].lower() in ("continuous", "single"):
            inside = True
        elif head == "end":
            inside = False
        elif inside:
            found.add(words[0].strip("'\"").lower())
    return found


def _show(candidates, table, at: dict[str, int]) -> str:
    return "; ".join(f"{name!r}: {table.note[at[name]]!r}" for name in candidates[:3])


@pytest.mark.parametrize("run_fixture", RUN_FIXTURES)
def test_sites_named_in_the_model_observation_input_are_placed(ingested, run_fixture: str):
    from pesto.ingest.failures import ReadFailure
    from pesto.ingest.obsindex import load_obs_index
    from pesto.model._mf6obs import observation_input_files, read_observation_input

    run_dir, cache_root, manifest, _before = ingested
    layout, plan, _artifact = _obs_cell_plan(run_dir, cache_root, manifest)
    table = _loaded_obs_cell(layout)
    assert table.note is not None, "obs_cell has no per-site notes"
    index = load_obs_index(layout)
    assert not isinstance(index, ReadFailure), index

    at = {name: i for i, name in enumerate(table.site)}
    if "id" in index.sites.columns:
        raw_ids = dict(zip(index.sites["site"].astype(str), index.sites["id"]))
    else:
        raw_ids = {}
    ids = {name: ("" if value is None or value != value else str(value).strip()) for name, value in raw_ids.items()}

    is_open = [table.cell[i] == -1 or table.rule[i] == "mf6-obs" for i in range(len(table.site))]
    open_sites = [name for i, name in enumerate(table.site) if is_open[i]]

    observations = read_observation_input(run_dir, _grid_file_name(plan))
    model_names = {
        entry.name.casefold()
        for entries in observations.entries.values()
        for entry in entries
        if not entry.package and entry.type in MODEL_OBSERVATION_TYPES
    }
    package_names = {
        entry.name.casefold()
        for entries in observations.entries.values()
        for entry in entries
        if entry.package in LIST_PACKAGE_TAGS
    }

    id_candidates = [name for name in open_sites if ids.get(name) and ids[name].casefold() in model_names]
    usecol_candidates = [
        name
        for name in open_sites
        if not ids.get(name) and _usecol_token(name) and _usecol_token(name) in package_names
    ]
    from_input = {name for name in table.site if table.rule[at[name]] == "mf6-obs"}
    usecol_placed = [name for name in usecol_candidates if name in from_input]

    print(
        f"placement {run_fixture}: {int((table.cell >= 0).sum())} of {len(table.site)} sites placed, "
        f"{len(from_input)} with rule mf6-obs, {len(id_candidates)} id candidates, "
        f"{len(usecol_candidates)} usecol candidates of which {len(usecol_placed)} placed"
    )

    notes = " | ".join(table.notes)[:1500]
    if id_candidates:
        assert from_input, (
            f"{len(id_candidates)} open site(s) have an id that a model-level observation names, and none "
            f"was placed from the model's observation input; e.g. {_show(id_candidates, table, at)}; "
            f"obs_cell notes: {notes}"
        )
    if usecol_candidates:
        assert usecol_placed, (
            f"{len(usecol_candidates)} open site(s) with no id have a usecol value that a list-package "
            f"observation names, and none was placed; e.g. {_show(usecol_candidates, table, at)}; "
            f"obs_cell notes: {notes}"
        )

    keys = {ids[name].casefold() for name in open_sites if ids.get(name)}
    keys |= {_usecol_token(name) for name in open_sites if _usecol_token(name)}
    read_from = {entry.file for entries in observations.entries.values() for entry in entries}
    for path in observation_input_files(run_dir):
        if path.name in read_from:
            continue
        tokens = _block_first_tokens(path)
        if not tokens & keys:
            continue
        assert any(path.name in note for note in observations.notes), (
            f"{path.name} has observation rows named like open sites, but the reader returned no entry "
            "from it and no note names it"
        )
