"""pdc/K: prior-data conflict, read from pestpp's file or computed and labelled.

The tracer ingests a generated run that has a ``case.0.pdc.csv`` and checks
the rows come from the file, by name, labelled ``file``. The later tests pin
the computed rule, the label on every row, and every absence and refusal.
"""

from __future__ import annotations

import json

import numpy as np
import pytest

from pesto.cache.layout import CacheLayout
from pesto.cache.manifest import Manifest
from pesto.ingest.failures import ReadFailure
from pesto.ingest.obsindex import load_obs_index
from pesto.ingest.obspdc import (
    NUMERIC_COLUMNS,
    PDC_FILE_COLUMNS,
    load_pdc,
)
from pesto.ingest.runner import ingest_run

from .obs_fixtures import PDC_NUMBER_COLUMNS, make_obs_run
from .test_control_first import in_process  # noqa: F401  (a fixture, used by name)


def _ingest(tmp_path, **kwargs):
    run_dir = tmp_path / "run"
    run = make_obs_run(run_dir, **kwargs)
    cache_root = tmp_path / "cache"
    manifest = ingest_run(run_dir, cache_root=cache_root)
    return run, CacheLayout(root=cache_root), manifest


def _sidecar(layout, iteration=0):
    return json.loads(layout.pdc_meta(iteration).read_text())


def _pdc_capability(run, layout):
    from fastapi.testclient import TestClient

    from pesto.api.app import create_app

    app, token = create_app()
    app.state.initial_run_dir = str(run.root)
    app.state.cache_root = str(layout.root)
    client = TestClient(app, base_url="http://127.0.0.1")
    response = client.get("/api/run/ingest/state", headers={"x-pesto-token": token})
    assert response.status_code == 200, response.text
    return response.json()["capabilities"]["pdc"]


# ---------------------------------------------------------------------------
# the tracer
# ---------------------------------------------------------------------------


def test_pestpps_pdc_file_is_read_by_name_into_pdc_0_and_labelled_file(tmp_path, in_process):
    run, layout, _ = _ingest(tmp_path, with_noise=True, with_pdc=True)

    manifest = Manifest.load(layout)
    assert manifest.artifacts["pdc/0"].state == "ok"
    table = load_pdc(0, layout)
    assert not isinstance(table, ReadFailure), table

    frame = table.frame
    assert len(frame) == 2
    # The first file name was upper case; the stored name is the control name.
    assert list(frame["obsnme"]) == [run.obs_names[0], run.obs_names[1]]
    index = load_obs_index(layout)
    inverse = {int(row): position for position, row in enumerate(index.order)}
    assert list(frame["position"]) == [inverse[0], inverse[1]]
    for column in NUMERIC_COLUMNS:
        assert frame[column].dtype == np.float64
    for stored, written in zip(frame.to_dict("records"), run.pdc_rows):
        for column in PDC_NUMBER_COLUMNS:
            assert stored[column] == written[column]
    assert set(frame["source"]) == {"file"}
    assert table.source == "file"

    sidecar = _sidecar(layout)
    assert sidecar["source"] == "file"
    assert sidecar["source_file"] == "case.0.pdc.csv"
    assert sidecar["n_conflict"] == 2
    assert sidecar["n_unmatched"] == 0
    assert sidecar["order_digest"] == index.order_digest
    assert any("lower-casing" in note for note in sidecar["notes"])


def test_the_state_route_says_pdc_is_available(tmp_path, in_process):
    run, layout, _ = _ingest(tmp_path, with_noise=True, with_pdc=True)

    assert _pdc_capability(run, layout) == {"available": True, "blocked_by": []}


def test_the_stored_columns_are_the_ones_pestpp_writes(tmp_path, in_process):
    run, layout, _ = _ingest(tmp_path, with_noise=True, with_pdc=True)

    frame = load_pdc(0, layout).frame
    assert list(frame.columns) == ["obsnme", "position", *PDC_FILE_COLUMNS[1:], "source"]


# ---------------------------------------------------------------------------
# the computed rule, with stored statistics set by hand
# ---------------------------------------------------------------------------

import pesto.ingest.obspdc as obspdc  # noqa: E402
import pesto.ingest.runner as runner  # noqa: E402
from pesto.ingest.discover import discover  # noqa: E402
from pesto.ingest.obsagg import NOISE_STATS, OBS_STATS  # noqa: E402
from pesto.ingest.obspdc import compute_pdc, read_pdc_file, write_pdc  # noqa: E402
from pesto.ingest.obsweights import read_adjusted_weights  # noqa: E402

from .obs_fixtures import PDC_HEADER, SiteSpec, rows_for, write_pdc_csv  # noqa: E402

RULE_SITES = (
    SiteSpec("gw_two", "a_two_conflict", (None,), "none"),
    SiteSpec("gw_two", "b_two_zero", (None,), "none"),
    SiteSpec("gw_two", "c_two_below", (None,), "none"),
    SiteSpec("g_greater", "d_gt_in", (None,), "none"),
    SiteSpec("g_greater", "e_gt_not", (None,), "none"),
    SiteSpec("l_less", "f_lt_in", (None,), "none"),
    SiteSpec("l_less", "g_lt_not", (None,), "none"),
    SiteSpec("gw_two", "h_zero_adj", (None,), "none"),
    SiteSpec("gw_two", "i_sentinel", (None,), "none", obsval=1e30),
    SiteSpec("gw_two", "j_control_zero", (None,), "none", weight=0.0),
)
# (sim_min, sim_max, noise_min, noise_max) for each observation above.
RULE_RANGES = {
    "a_two_conflict": (0, 10, 12, 20),  # noise above: 2
    "b_two_zero": (0, 10, 10, 20),  # ranges touch: 0
    "c_two_below": (30, 40, 10, 26),  # simulated above: 4
    "d_gt_in": (0, 10, 11, 20),  # greater-than, noise above: 1
    "e_gt_not": (30, 40, 10, 20),  # greater-than, only the other side: not
    "f_lt_in": (30, 40, 10, 27),  # less-than, simulated above: 3
    "g_lt_not": (0, 10, 30, 40),  # less-than, only the other side: not
    "h_zero_adj": (0, 10, 20, 30),  # conflict by value, adjusted weight 0 everywhere
    "i_sentinel": (0, 10, 20, 30),  # conflict by value, no real target
    "j_control_zero": (0, 10, 20, 30),  # control weight 0, adjusted weight above 0
}


def _rule_weights(names):
    weights = np.ones((4, len(names)))
    weights[:, names.index("h_zero_adj")] = 0.0
    weights[:, names.index("j_control_zero")] = [0.0, 0.0, 1.0, 0.0]
    return weights


def _set_ranges(layout, run, ranges, iteration):
    """Overwrite min and max of the stored statistics for the observations
    named in ``ranges``. The cache files keep their size, so the sidecars
    stay valid."""
    index = load_obs_index(layout)
    position = {int(row): p for p, row in enumerate(index.order)}
    sim = np.memmap(layout.obs_agg(iteration), dtype="<f4", mode="r+", shape=(len(OBS_STATS), index.n_obs))
    noise = np.memmap(
        layout.noise_agg, dtype="<f4", mode="r+", shape=(len(NOISE_STATS), index.n_obs)
    )
    for name, (sim_min, sim_max, noise_min, noise_max) in ranges.items():
        p = position[run.obs_names.index(name)]
        sim[OBS_STATS.index("min"), p], sim[OBS_STATS.index("max"), p] = sim_min, sim_max
        noise[NOISE_STATS.index("min"), p] = noise_min
        noise[NOISE_STATS.index("max"), p] = noise_max
    sim.flush()
    noise.flush()


def _rule_run(tmp_path, with_weights=True):
    names = [row["obsnme"] for row in rows_for(RULE_SITES)]
    run_dir = tmp_path / "run"
    run = make_obs_run(
        run_dir,
        sites=RULE_SITES,
        with_noise=True,
        adjusted_weights=_rule_weights(names) if with_weights else None,
    )
    cache_root = tmp_path / "cache"
    ingest_run(run_dir, cache_root=cache_root)
    layout = CacheLayout(root=cache_root)
    for iteration in (0, 1):
        _set_ranges(layout, run, RULE_RANGES, iteration)
    return run, layout


def _build_computed(run, layout, iteration=1):
    """Build pdc for ``iteration`` the way the runner does: handing the worker
    the adjusted weights file only when the plan would."""
    _, weights_file = runner._pdc_inputs(discover(run.root), iteration)
    result = runner._write_pdc_artifact(str(layout.root), iteration, None, weights_file)
    assert not isinstance(result, ReadFailure), result
    table = load_pdc(iteration, layout)
    assert not isinstance(table, ReadFailure), table
    return table


def _distances(table):
    return dict(zip(table.frame["obsnme"], table.frame["distance"]))


def test_computed_conflict_follows_the_rule_and_labels_every_row_computed(tmp_path, in_process):
    run, layout = _rule_run(tmp_path)

    table = _build_computed(run, layout)

    # Not in: b (distance exactly 0), e and g (wrong side for the group),
    # h (adjusted weight 0 everywhere), i (sentinel obsval).
    assert _distances(table) == {
        "a_two_conflict": 2.0,
        "c_two_below": 4.0,
        "d_gt_in": 1.0,
        "f_lt_in": 3.0,
        "j_control_zero": 10.0,
    }
    assert set(table.frame["source"]) == {"computed"}
    assert table.source == "computed"
    sidecar = _sidecar(layout, 1)
    assert sidecar["source"] == "computed"
    assert sidecar["n_conflict"] == 5
    assert "case.adjusted.weights.jcb" in sidecar["weights_source"]
    assert "distance" in sidecar["rule"] and "> 0" in sidecar["rule"]


def test_iteration_zero_ignores_the_adjusted_weights_because_pestpp_checks_it_first(
    tmp_path, in_process
):
    run, layout = _rule_run(tmp_path)

    table = _build_computed(run, layout, iteration=0)

    # The control weights decide: h (control weight 1) is in, j (control weight 0) is out,
    # although the adjusted weights say the opposite.
    assert set(_distances(table)) == {
        "a_two_conflict",
        "c_two_below",
        "d_gt_in",
        "f_lt_in",
        "h_zero_adj",
    }
    assert "control file weights" in table.weights_source
    assert any("iteration 0 is checked before pestpp adjusts" in n for n in table.notes)
    assert set(table.frame["source"]) == {"computed"}


def test_a_distance_of_exactly_zero_is_not_a_conflict(tmp_path, in_process):
    run, layout = _rule_run(tmp_path)

    table = _build_computed(run, layout)

    assert "b_two_zero" not in set(table.frame["obsnme"])


def test_a_zero_adjusted_weight_drops_an_observation_that_conflicts_by_value(tmp_path, in_process):
    run, layout = _rule_run(tmp_path)

    table = _build_computed(run, layout)

    assert "h_zero_adj" not in set(table.frame["obsnme"])
    # One realization with a weight above 0 is enough to be a candidate.
    assert "j_control_zero" in set(table.frame["obsnme"])


def test_a_sentinel_obsval_is_never_a_candidate(tmp_path, in_process):
    run, layout = _rule_run(tmp_path)

    table = _build_computed(run, layout)

    assert "i_sentinel" not in set(table.frame["obsnme"])


def test_without_an_adjusted_weights_file_control_weights_decide_and_a_note_says_so(
    tmp_path, in_process
):
    run, layout = _rule_run(tmp_path, with_weights=False)

    table = _build_computed(run, layout)

    assert set(_distances(table)) == {
        "a_two_conflict",
        "c_two_below",
        "d_gt_in",
        "f_lt_in",
        "h_zero_adj",
    }
    assert any("no adjusted weights file" in note for note in table.notes)
    assert "control file weights" in table.weights_source
    assert any("no adjusted weights file" in note for note in _sidecar(layout, 1)["notes"])


def test_the_distance_and_range_columns_come_from_the_noise_and_simulated_statistics(
    tmp_path, in_process
):
    run, layout = _rule_run(tmp_path)

    table = _build_computed(run, layout)

    row = table.frame.set_index("obsnme").loc["a_two_conflict"]
    assert (row["obs_min"], row["obs_max"]) == (12.0, 20.0)
    assert (row["sim_min"], row["sim_max"]) == (0.0, 10.0)
    assert row["obs_stat_min"] == pytest.approx(row["obs_mean"] - row["obs_std"])
    assert row["obs_stat_max"] == pytest.approx(row["obs_mean"] + row["obs_std"])
    assert row["sim_stat_min"] == pytest.approx(row["sim_mean"] - row["sim_std"])
    assert row["sim_stat_max"] == pytest.approx(row["sim_mean"] + row["sim_std"])


# ---------------------------------------------------------------------------
# the file is read whenever it exists; computed only when it does not
# ---------------------------------------------------------------------------


def test_conflict_is_never_computed_when_pestpps_file_exists(tmp_path, in_process, monkeypatch):
    def boom(*args, **kwargs):
        raise AssertionError("compute_pdc was called although pestpp wrote the file")

    monkeypatch.setattr(runner, "compute_pdc", boom)
    run, layout, manifest = _ingest(tmp_path, with_noise=True, with_pdc=True)

    assert manifest.artifacts["pdc/0"].state == "ok"
    assert load_pdc(0, layout).source == "file"
    planned = {a.name: a for a in runner.plan_artifacts(discover(run.root), layout)}
    assert planned["pdc/0"].needs == ("obs_index",)
    assert planned["pdc/0"].sources[0] == str(run.pdc_path)


def test_a_run_with_an_obs_noise_file_and_no_pdc_file_computes_every_iteration(
    tmp_path, in_process
):
    run, layout, manifest = _ingest(tmp_path, with_noise=True)

    for k in (0, 1):
        assert manifest.artifacts[f"pdc/{k}"].state == "ok"
        table = load_pdc(k, layout)
        assert table.source == "computed"
        assert set(table.frame["source"]) <= {"computed"}
        assert _sidecar(layout, k)["source"] == "computed"
    planned = {a.name: a for a in runner.plan_artifacts(discover(run.root), layout)}
    assert planned["pdc/0"].needs == ("obs_index", "obs_agg/0", "noise_agg")
    assert planned["pdc/0"].sources[0] == str(run.obs_ens[0])


def test_the_computed_set_equals_the_set_an_independent_computation_wrote_to_a_file(
    tmp_path, in_process
):
    sites = (
        SiteSpec("gw_two", "s", tuple(range(120)), "time-token"),
        SiteSpec("g_up", "u", tuple(range(40)), "time-token"),
        SiteSpec("l_lo", "l", tuple(range(40)), "time-token"),
    )
    run_dir = tmp_path / "run"
    run = make_obs_run(run_dir, sites=sites, with_noise=True, noise_shift=1000.0)
    rows = rows_for(sites)

    sim = run.values[0]
    keep = [i for i, n in enumerate(run.noise_real_names) if n != "base"]
    noise = run.noise_values[keep]
    above = noise.min(axis=0) - sim.max(axis=0)
    below = sim.min(axis=0) - noise.max(axis=0)
    expected = {}
    for i, row in enumerate(rows):
        group = row["obgnme"]
        if group.startswith("g_"):
            distance = above[i]
        elif group.startswith("l_"):
            distance = below[i]
        else:
            distance = max(above[i], below[i])
        if distance > 0:
            expected[row["obsnme"]] = distance
    assert len(expected) >= 5, "the generated run must hold conflicts for this test to mean anything"
    write_pdc_csv(
        run_dir / "case.0.pdc.csv",
        [{"name": name, "distance": distance} for name, distance in expected.items()],
    )

    cache_root = tmp_path / "cache"
    ingest_run(run_dir, cache_root=cache_root)
    layout = CacheLayout(root=cache_root)
    from_file = load_pdc(0, layout)
    assert from_file.source == "file"
    assert _distances(from_file) == pytest.approx(expected)

    (run_dir / "case.0.pdc.csv").unlink()
    manifest = ingest_run(run_dir, cache_root=cache_root)
    assert manifest.artifacts["pdc/0"].state == "ok"
    computed = load_pdc(0, layout)
    assert computed.source == "computed"
    assert set(_distances(computed)) == set(expected)
    np.testing.assert_allclose(
        [_distances(computed)[n] for n in expected], list(expected.values()), rtol=1e-6
    )


# ---------------------------------------------------------------------------
# every absence and refusal is stated
# ---------------------------------------------------------------------------

NEITHER = "no pestpp pdc file and no obs+noise file to compute one from, for iteration(s) 0, 1"


def test_a_run_with_neither_a_pdc_file_nor_an_obs_noise_file_plans_no_pdc_and_says_why(tmp_path):
    run_dir = tmp_path / "run"
    run = make_obs_run(run_dir)
    layout = CacheLayout(root=tmp_path / "cache")

    names = [a.name for a in runner.plan_artifacts(discover(run_dir), layout)]

    assert not any(name.startswith("pdc/") for name in names)
    assert _pdc_capability(run, layout) == {
        "available": False,
        "blocked_by": [{"artifact": "pdc", "reason": NEITHER}],
    }


def test_the_capability_names_only_the_iterations_that_had_neither(tmp_path, in_process):
    run, layout, _ = _ingest(tmp_path, with_pdc=True)

    capability = _pdc_capability(run, layout)

    assert capability["available"] is True
    assert capability["notes"] == [
        "no pestpp pdc file and no obs+noise file to compute one from, for iteration(s) 1"
    ]


def test_computed_conflict_fails_with_the_depends_on_wording_when_noise_agg_failed(
    tmp_path, in_process
):
    run_dir = tmp_path / "run"
    run = make_obs_run(run_dir, with_noise=True)
    run.noise_path.write_bytes(b"this is not an observation file")

    manifest = ingest_run(run_dir, cache_root=tmp_path / "cache")

    assert manifest.artifacts["noise_agg"].state == "failed"
    for k in (0, 1):
        pdc = manifest.artifacts[f"pdc/{k}"]
        assert pdc.state == "failed"
        assert pdc.reason.startswith(f"pdc/{k} depends on noise_agg, which failed: ")
    layout = CacheLayout(root=tmp_path / "cache")
    assert not layout.pdc(0).exists() and not layout.pdc_meta(0).exists()


def _index_and_names(tmp_path, **kwargs):
    run_dir = tmp_path / "run"
    run = make_obs_run(run_dir, **kwargs)
    layout = CacheLayout(root=tmp_path / "cache")
    ingest_run(run_dir, cache_root=layout.root)
    return run, layout, load_obs_index(layout)


def test_a_pdc_file_without_the_distance_column_fails_naming_it(tmp_path, in_process):
    run_dir = tmp_path / "run"
    run = make_obs_run(run_dir, with_noise=True)
    header = PDC_HEADER.replace(",distance", "")
    write_pdc_csv(run_dir / "case.0.pdc.csv", [{"name": run.obs_names[0]}], header=header)

    manifest = ingest_run(run_dir, cache_root=tmp_path / "cache")

    pdc = manifest.artifacts["pdc/0"]
    assert pdc.state == "failed"
    assert pdc.reason.startswith("pdc/0:")
    assert "'distance'" in pdc.reason


def test_a_name_listed_twice_refuses_the_file_and_names_it(tmp_path, in_process):
    run_dir = tmp_path / "run"
    run = make_obs_run(run_dir, with_noise=True)
    name = run.obs_names[0]
    write_pdc_csv(
        run_dir / "case.0.pdc.csv",
        [{"name": name, "distance": 1}, {"name": name.upper(), "distance": 2}],
    )

    manifest = ingest_run(run_dir, cache_root=tmp_path / "cache")

    pdc = manifest.artifacts["pdc/0"]
    assert pdc.state == "failed"
    assert "more than once" in pdc.reason and name in pdc.reason


def test_a_name_not_in_the_control_table_is_counted_named_and_never_matched_by_position(
    tmp_path, in_process
):
    run, layout, index = _index_and_names(tmp_path)
    path = tmp_path / "pdc.csv"
    write_pdc_csv(
        path,
        [
            {"name": "NA", "distance": 1},
            {"name": "null", "distance": 2},
            {"name": run.obs_names[2], "distance": 3},
            {"name": "ghost_a", "distance": 4},
            {"name": "ghost_b", "distance": 5},
        ],
    )

    table = read_pdc_file(path, index, run.obs_names, artifact="pdc/0")

    assert not isinstance(table, ReadFailure), table
    assert list(table.frame["obsnme"]) == [run.obs_names[2]]
    assert list(table.frame["distance"]) == [3.0]
    assert table.n_unmatched == 4
    note = next(n for n in table.notes if "not in the control table" in n)
    assert note.startswith("4 name(s)")
    assert "'NA'" in note and "'null'" in note and "'ghost_a'" in note and "'ghost_b'" not in note


def test_a_name_written_NA_stays_text_and_matches_a_control_observation_of_that_name(
    tmp_path, in_process
):
    sites = (
        SiteSpec("gw_na", "NA", (None,), "none"),
        SiteSpec("gw_na", "other", (None,), "none"),
    )
    run_dir = tmp_path / "run"
    run = make_obs_run(run_dir, sites=sites)
    layout = CacheLayout(root=tmp_path / "cache")
    ingest_run(run_dir, cache_root=layout.root)
    index = load_obs_index(layout)
    path = tmp_path / "pdc.csv"
    write_pdc_csv(path, [{"name": "NA", "distance": 7}])

    table = read_pdc_file(path, index, run.obs_names, artifact="pdc/0")

    assert not isinstance(table, ReadFailure), table
    assert table.n_unmatched == 0
    assert [n.lower() for n in table.frame["obsnme"]] == ["na"]


def test_unreadable_numbers_are_stored_as_missing_and_counted_in_a_note(tmp_path, in_process):
    run, layout, index = _index_and_names(tmp_path)
    path = tmp_path / "pdc.csv"
    write_pdc_csv(path, [{"name": run.obs_names[0], "distance": "abc", "sim_min": 5}])

    table = read_pdc_file(path, index, run.obs_names, artifact="pdc/0")

    assert not isinstance(table, ReadFailure), table
    assert np.isnan(table.frame["distance"].iloc[0])
    assert any("column distance" in n and "1 value(s)" in n for n in table.notes)


def test_a_header_only_file_stores_zero_rows_and_says_so(tmp_path, in_process):
    run, layout, index = _index_and_names(tmp_path)
    path = tmp_path / "pdc.csv"
    write_pdc_csv(path, [])

    table = read_pdc_file(path, index, run.obs_names, artifact="pdc/0")

    assert not isinstance(table, ReadFailure), table
    assert table.n_conflict == 0
    assert any("no rows" in n for n in table.notes)
    assert not isinstance(write_pdc(table, 0, layout), ReadFailure)
    assert len(load_pdc(0, layout).frame) == 0


def test_rewriting_the_pdc_file_makes_pdc_stale_and_leaves_the_ensemble_fresh(
    tmp_path, in_process
):
    run, layout, _ = _ingest(tmp_path, with_noise=True, with_pdc=True)
    planned = {a.name: a for a in runner.plan_artifacts(discover(run.root), layout)}
    manifest = Manifest.load(layout)
    for name in ("pdc/0", "obs_ens/0"):
        assert not manifest.is_stale(name, layout, planned[name].sources)

    write_pdc_csv(run.pdc_path, run.pdc_rows[:1])

    manifest = Manifest.load(layout)
    assert manifest.is_stale("pdc/0", layout, planned["pdc/0"].sources)
    assert not manifest.is_stale("obs_ens/0", layout, planned["obs_ens/0"].sources)
    assert not manifest.is_stale("noise_agg", layout, planned["noise_agg"].sources)


def test_removing_the_pdc_file_makes_pdc_stale_so_it_is_computed_next_time(tmp_path, in_process):
    run, layout, _ = _ingest(tmp_path, with_noise=True, with_pdc=True)
    run.pdc_path.unlink()
    planned = {a.name: a for a in runner.plan_artifacts(discover(run.root), layout)}

    assert Manifest.load(layout).is_stale("pdc/0", layout, planned["pdc/0"].sources)
    ingest_run(run.root, cache_root=layout.root)
    assert load_pdc(0, layout).source == "computed"


def test_a_failed_write_leaves_neither_the_parquet_nor_the_sidecar(
    tmp_path, in_process, monkeypatch
):
    run, layout, index = _index_and_names(tmp_path)
    path = tmp_path / "pdc.csv"
    write_pdc_csv(path, [{"name": run.obs_names[0], "distance": 1}])
    table = read_pdc_file(path, index, run.obs_names, artifact="pdc/0")

    def boom(*args, **kwargs):
        raise OSError("disk full")

    monkeypatch.setattr(obspdc, "write_atomic_text", boom)
    result = write_pdc(table, 0, layout)

    assert isinstance(result, ReadFailure)
    assert "disk full" in result.reason
    assert not layout.pdc(0).exists() and not layout.pdc_meta(0).exists()
    assert not list(layout.agg.glob(".ingest-*"))


def test_rows_with_a_mixed_label_are_refused_on_write(tmp_path, in_process):
    run, layout, index = _index_and_names(tmp_path)
    path = tmp_path / "pdc.csv"
    write_pdc_csv(path, [{"name": run.obs_names[0], "distance": 1}])
    table = read_pdc_file(path, index, run.obs_names, artifact="pdc/0")
    table.frame.loc[:, "source"] = "computed"

    result = write_pdc(table, 0, layout)

    assert isinstance(result, ReadFailure)
    assert "source label" in result.reason
    assert not layout.pdc(0).exists()


def test_a_stored_pdc_built_against_another_index_is_refused_on_load(tmp_path, in_process):
    run, layout, _ = _ingest(tmp_path, with_noise=True, with_pdc=True)
    sidecar = json.loads(layout.pdc_meta(0).read_text())
    sidecar["order_digest"] = "0" * 64
    layout.pdc_meta(0).write_text(json.dumps(sidecar))

    result = load_pdc(0, layout)

    assert isinstance(result, ReadFailure)
    assert "different obs_index" in result.reason


def _tree_snapshot(root):
    return {
        str(p.relative_to(root)): (p.stat().st_size, p.stat().st_mtime_ns)
        for p in sorted(root.rglob("*"))
    }


def test_the_run_folder_is_untouched_by_either_way_of_making_pdc(tmp_path, in_process):
    run_dir = tmp_path / "run"
    run = make_obs_run(run_dir, with_noise=True, with_pdc=True)
    before = _tree_snapshot(run_dir)
    ingest_run(run_dir, cache_root=tmp_path / "cache")
    assert _tree_snapshot(run_dir) == before

    run.pdc_path.unlink()
    before = _tree_snapshot(run_dir)
    ingest_run(run_dir, cache_root=tmp_path / "cache")
    assert _tree_snapshot(run_dir) == before


def test_the_module_imports_no_heavy_library_at_module_scope():
    import inspect

    source = inspect.getsource(obspdc)
    assert "import pyemu" not in source and "import flopy" not in source
    assert "from pyemu" not in source and "from flopy" not in source


# ---------------------------------------------------------------------------
# a real run (slow; skipped when the benchmark folder is absent)
# ---------------------------------------------------------------------------


@pytest.mark.slow
def test_on_a_real_run_the_computed_set_equals_the_set_in_pestpps_files(pl253_run, tmp_path):
    from pesto.ingest.control import read_control
    from pesto.ingest.tables import load_control_table, write_control

    before = _tree_snapshot(pl253_run)
    run = discover(pl253_run)
    if run.noise is None:
        pytest.skip("this run has no obs+noise file")
    selected, _ = runner.observation_iterations(run)
    iterations = [k for k in selected if run.pdc.get(k) is not None and run.obs_ens.get(k)]
    if not iterations:
        pytest.skip("no ingested iteration has both a pdc file and an observation file")

    tables = read_control(run.pst_path)
    assert not isinstance(tables, ReadFailure), tables
    layout = CacheLayout(root=tmp_path / "cache")
    layout.ensure()
    assert not isinstance(write_control(tables, layout), ReadFailure)
    assert not isinstance(runner._write_obs_index_artifact(str(layout.root)), ReadFailure)
    built = runner._write_noise_agg_artifact(str(run.noise), str(layout.root))
    assert not isinstance(built, ReadFailure), built

    names = load_control_table(layout, "obs", columns=["obsnme"])[0].column("obsnme").to_pylist()
    index = load_obs_index(layout)
    for k in iterations:
        # The runner hands iteration 0 no adjusted weights; the file holds the weights
        # after pestpp's first check and would hide exactly what iteration 0 lists.
        weights = None
        if run.adjusted_weights is not None and k != 0:
            weights = read_adjusted_weights(run.adjusted_weights, names, artifact="pdc")
            assert not isinstance(weights, ReadFailure), weights

        ens = runner._write_obs_ens_artifact(str(run.obs_ens[k]), str(layout.root), k)
        assert not isinstance(ens, ReadFailure), ens
        agg = runner._write_obs_agg_artifact(str(layout.root), k)
        assert not isinstance(agg, ReadFailure), agg
        from_file = read_pdc_file(run.pdc[k], index, names, artifact=f"pdc/{k}")
        assert not isinstance(from_file, ReadFailure), from_file
        computed = compute_pdc(k, layout, weights)
        assert not isinstance(computed, ReadFailure), computed
        assert set(computed.frame["obsnme"]) == set(from_file.frame["obsnme"]), k
        shared = computed.frame.merge(from_file.frame, on="obsnme", suffixes=("_c", "_f"))
        np.testing.assert_allclose(
            shared["distance_c"], shared["distance_f"], rtol=1e-3, atol=1e-3, err_msg=str(k)
        )

    assert _tree_snapshot(pl253_run) == before
