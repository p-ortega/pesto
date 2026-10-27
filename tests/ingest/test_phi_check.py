"""phi_check/K: phi recomputed from the cache against pestpp's phi file, by name.

The tracer ingests a generated run whose phi file was computed from the same
values and weights the cache holds, and checks every realization agrees by
name. The later tests pin each mismatch, gap and fallback.
"""

from __future__ import annotations

import json

import numpy as np
import pytest

from pesto.cache.layout import CacheLayout
from pesto.cache.manifest import Manifest
from pesto.ingest.failures import ReadFailure
from pesto.ingest.phicheck import PHI_TOLERANCE, load_phi_check
from pesto.ingest.runner import ingest_run

from .obs_fixtures import make_obs_run
from .test_control_first import in_process  # noqa: F401  (a fixture, used by name)


def _ingest(tmp_path, **kwargs):
    run_dir = tmp_path / "run"
    run = make_obs_run(run_dir, **kwargs)
    cache_root = tmp_path / "cache"
    manifest = ingest_run(run_dir, cache_root=cache_root)
    return run, CacheLayout(root=cache_root), manifest


def _tree_snapshot(root):
    return {
        str(p.relative_to(root)): (p.stat().st_size, p.stat().st_mtime_ns)
        for p in sorted(root.rglob("*"))
    }


def _capabilities(run, layout):
    from fastapi.testclient import TestClient

    from pesto.api.app import create_app

    app, token = create_app()
    app.state.initial_run_dir = str(run.root)
    app.state.cache_root = str(layout.root)
    client = TestClient(app, base_url="http://127.0.0.1")
    response = client.get("/api/run/ingest/state", headers={"x-pesto-token": token})
    assert response.status_code == 200, response.text
    return response.json()["capabilities"]


# ---------------------------------------------------------------------------
# the tracer
# ---------------------------------------------------------------------------


def test_phi_recomputed_from_the_cache_matches_pestpps_file_by_realization_name(
    tmp_path, in_process
):
    run, layout, _ = _ingest(tmp_path, with_phi=True)

    manifest = Manifest.load(layout)
    assert manifest.artifacts["phi_check/0"].state == "ok"
    check = load_phi_check(0, layout)
    assert not isinstance(check, ReadFailure), check

    assert check.status == "checked"
    assert check.n_compared == len(run.real_names)
    assert check.n_mismatch == 0
    assert check.n_only_in_cache == 0 and check.n_only_in_file == 0
    assert check.max_rel_diff is not None and check.max_rel_diff < 1e-5
    assert check.tolerance == PHI_TOLERANCE
    assert check.weights_source == "case.adjusted.weights.jcb"
    # The file's columns run in the reverse of the run's realization order.
    assert run.phi_path.read_text().splitlines()[0].split(",")[6:] == list(reversed(run.real_names))
    for row in check.rows:
        assert row.match
        assert row.file == run.phi_values[0][row.realization]
        assert row.recomputed == pytest.approx(run.phi_values[0][row.realization], rel=1e-5)


def test_the_state_route_reports_phi_check_available(tmp_path, in_process):
    run, layout, _ = _ingest(tmp_path, with_phi=True)

    capability = _capabilities(run, layout)["phi_check"]
    assert capability == {"available": True, "blocked_by": []}


def test_phi_is_never_joined_by_position(tmp_path, in_process):
    # The file's columns are reversed; reading them by position would pair the wrong ones.
    run, layout, _ = _ingest(tmp_path, with_phi=True)

    check = load_phi_check(1, layout)
    assert not isinstance(check, ReadFailure), check
    by_name = {row.realization: row for row in check.rows}
    assert set(by_name) == set(run.real_names)
    assert len({round(v, 3) for v in run.phi_values[1].values()}) == len(run.real_names)
    for name, row in by_name.items():
        assert row.file == run.phi_values[1][name]
        assert row.match


def test_the_run_folder_is_untouched_by_the_phi_check(tmp_path, in_process):
    run_dir = tmp_path / "run"
    make_obs_run(run_dir, with_phi=True)
    before = _tree_snapshot(run_dir)
    ingest_run(run_dir, cache_root=tmp_path / "cache")
    assert _tree_snapshot(run_dir) == before


def test_the_stored_file_is_valid_json_with_every_realization_in_it(tmp_path, in_process):
    run, layout, _ = _ingest(tmp_path, with_phi=True)

    stored = json.loads(layout.phi_check(0).read_text())
    assert stored["status"] == "checked"
    assert {r["realization"] for r in stored["rows"]} == set(run.real_names)
    assert all(set(r) == {"realization", "recomputed", "file", "rel_diff", "match"} for r in stored["rows"])
    assert np.isfinite(stored["max_rel_diff"])


# ---------------------------------------------------------------------------
# mismatches, gaps and the tolerance edge
# ---------------------------------------------------------------------------

PHI_HEAD = ["iteration", "total_runs", "mean", "standard_deviation", "min", "max"]


def _rewrite_phi(run, columns, rows):
    """Write the run's phi file again. ``columns`` are the realization column
    names; ``rows`` maps an iteration to one cell per column (text or number)."""
    lines = [",".join([*PHI_HEAD, *columns])]
    for iteration, cells in rows.items():
        lines.append(",".join([str(iteration), "4", "0", "0", "0", "0", *(str(c) for c in cells)]))
    run.phi_path.write_text("\n".join(lines) + "\n")


def _columns(run):
    return list(reversed(run.real_names))


def _phi_row(run, iteration, change=None):
    """One iteration's cells in the file's column order, with ``change``
    mapping a realization name to a function of its phi."""
    change = change or {}
    values = run.phi_values[iteration]
    return [repr(change.get(n, lambda v: v)(values[n])) for n in _columns(run)]


def _run_with_phi(tmp_path, rewrite=None, iterations=(0,), **kwargs):
    run_dir = tmp_path / "run"
    run = make_obs_run(run_dir, with_phi=True, iterations=iterations, **kwargs)
    if rewrite is not None:
        rewrite(run)
    cache_root = tmp_path / "cache"
    manifest = ingest_run(run_dir, cache_root=cache_root)
    return run, CacheLayout(root=cache_root), manifest


def test_a_planted_mismatch_is_reported_by_name_and_the_artifact_is_still_ok(
    tmp_path, in_process
):
    def plant(run):
        cells = _phi_row(run, 0, {"34": lambda v: v * 1.5})
        _rewrite_phi(run, _columns(run), {0: cells})

    run, layout, manifest = _run_with_phi(tmp_path, plant)

    assert manifest.artifacts["phi_check/0"].state == "ok"
    check = load_phi_check(0, layout)
    assert check.status == "checked"
    assert check.n_mismatch == 1
    bad = [r for r in check.rows if not r.match]
    assert [r.realization for r in bad] == ["34"]
    assert bad[0].file == pytest.approx(run.phi_values[0]["34"] * 1.5)
    assert bad[0].recomputed == pytest.approx(run.phi_values[0]["34"])
    assert bad[0].rel_diff == pytest.approx(1 / 3, rel=1e-6)
    assert "'34'" in check.summary and "1 of 4" in check.summary
    notes = manifest.artifacts["phi_check/0"].notes
    assert any("'34'" in n and "1 of 4" in n for n in notes)
    # The other three still agree.
    assert all(r.match for r in check.rows if r.realization != "34")


def test_a_mismatch_with_many_realizations_names_at_most_three(tmp_path, in_process):
    def plant(run):
        everything = {n: (lambda v: v * 2.0) for n in run.real_names}
        _rewrite_phi(run, _columns(run), {0: _phi_row(run, 0, everything)})

    _run, layout, _ = _run_with_phi(tmp_path, plant)

    check = load_phi_check(0, layout)
    assert check.n_mismatch == 4
    assert check.summary.count("'") == 6  # three names, each quoted on both sides


def test_a_mismatch_is_visible_on_the_capability_while_it_stays_available(tmp_path, in_process):
    def plant(run):
        _rewrite_phi(run, _columns(run), {0: _phi_row(run, 0, {"base": lambda v: v * 3.0})})

    run, layout, _ = _run_with_phi(tmp_path, plant)

    capability = _capabilities(run, layout)["phi_check"]
    assert capability["available"] is True
    assert capability["blocked_by"] == []
    assert len(capability["notes"]) == 1 and "'base'" in capability["notes"][0]


@pytest.mark.parametrize("difference, matches", [(0.9e-3, True), (1.1e-3, False)])
def test_a_relative_difference_either_side_of_the_tolerance(
    tmp_path, in_process, difference, matches
):
    def plant(run):
        cells = _phi_row(run, 0, {"base": lambda v: v / (1.0 + difference)})
        _rewrite_phi(run, _columns(run), {0: cells})

    _run, layout, _ = _run_with_phi(tmp_path, plant)

    row = next(r for r in load_phi_check(0, layout).rows if r.realization == "base")
    assert row.rel_diff == pytest.approx(difference, rel=1e-4)
    assert row.match is matches


def test_the_tolerance_edge_is_a_match_and_just_over_it_is_not():
    from pesto.ingest.phicheck import compare_phi

    assert compare_phi(1001.0, 1000.0) == (pytest.approx(1e-3), True)
    assert compare_phi(1001.1, 1000.0)[1] is False
    assert compare_phi(1000.0, 1001.0)[1] is True  # measured against the file's value


def test_zero_against_zero_matches_and_zero_in_the_file_against_a_value_does_not():
    from pesto.ingest.phicheck import compare_phi

    assert compare_phi(0.0, 0.0) == (0.0, True)
    assert compare_phi(4.0, 0.0) == (None, False)
    assert compare_phi(float("nan"), 5.0) == (None, False)
    assert compare_phi(5.0, float("inf")) == (None, False)


def test_a_realization_with_no_value_in_the_file_and_a_file_column_not_in_the_cache_are_counted(
    tmp_path, in_process
):
    def plant(run):
        columns = [*_columns(run), "ghost"]
        cells = _phi_row(run, 0, {})
        cells[columns.index("34")] = ""  # empty: not part of this iteration's phi
        _rewrite_phi(run, columns, {0: [*cells, "123.5"]})

    run, layout, manifest = _run_with_phi(tmp_path, plant)

    check = load_phi_check(0, layout)
    assert manifest.artifacts["phi_check/0"].state == "ok"
    assert check.n_only_in_cache == 1
    assert check.n_only_in_file == 1
    assert check.n_compared == 3
    assert sorted(r.realization for r in check.rows) == ["176", "35", "base"]
    assert any("'34'" in n for n in check.notes)
    assert any("'ghost'" in n for n in check.notes)


def test_an_unreadable_cell_is_counted_and_that_realization_is_not_compared(tmp_path, in_process):
    def plant(run):
        cells = _phi_row(run, 0, {})
        cells[_columns(run).index("35")] = "n/a"
        _rewrite_phi(run, _columns(run), {0: cells})

    _run, layout, _ = _run_with_phi(tmp_path, plant)

    check = load_phi_check(0, layout)
    assert check.n_compared == 3 and check.n_only_in_cache == 1
    assert any("1 value(s)" in n and "could not be read as a number" in n for n in check.notes)


def test_a_name_listed_twice_in_the_file_is_matched_to_neither_column(tmp_path, in_process):
    def plant(run):
        columns = [*_columns(run), "base"]
        _rewrite_phi(run, columns, {0: [*_phi_row(run, 0, {}), "1.0"]})

    _run, layout, _ = _run_with_phi(tmp_path, plant)

    check = load_phi_check(0, layout)
    assert sorted(r.realization for r in check.rows) == ["176", "34", "35"]
    assert check.n_only_in_cache == 1 and check.n_only_in_file == 2
    assert any("more than once" in n and "'base'" in n for n in check.notes)


def test_a_name_that_matches_only_after_trimming_and_lower_casing_is_compared_with_a_note(
    tmp_path, in_process
):
    run_dir = tmp_path / "run"
    run = make_obs_run(
        run_dir, with_phi=True, iterations=(0,), real_names=["r1", "r2", "r3", "r4"]
    )
    columns = [c.upper() if c == "r1" else c for c in _columns(run)]
    _rewrite_phi(run, columns, {0: _phi_row(run, 0)})
    ingest_run(run_dir, cache_root=tmp_path / "cache")

    check = load_phi_check(0, CacheLayout(root=tmp_path / "cache"))
    assert check.n_compared == 4 and check.n_mismatch == 0
    assert check.n_only_in_cache == 0 and check.n_only_in_file == 0
    assert any("'r1' for 'R1'" in n and "lower-casing" in n for n in check.notes)


@pytest.mark.parametrize("cell", ["inf", "-inf", "1e400"])
def test_a_value_in_the_phi_file_that_is_not_finite_keeps_the_check_and_is_named(
    tmp_path, in_process, cell
):
    def plant(run):
        cells = _phi_row(run, 0, {})
        cells[_columns(run).index("34")] = cell
        _rewrite_phi(run, _columns(run), {0: cells})

    _run, layout, manifest = _run_with_phi(tmp_path, plant)

    assert manifest.artifacts["phi_check/0"].state == "ok"
    stored = json.loads(layout.phi_check(0).read_text())
    by_name = {r["realization"]: r for r in stored["rows"]}
    assert set(by_name) == {"base", "34", "35", "176"}
    assert by_name["34"]["file"] is None
    assert by_name["34"]["rel_diff"] is None
    assert by_name["34"]["match"] is False
    for name in ("base", "35", "176"):
        assert isinstance(by_name[name]["file"], float) and by_name[name]["match"] is True
    assert stored["n_mismatch"] == 1
    notes = manifest.artifacts["phi_check/0"].notes
    assert any("'34'" in n and "not a finite number" in n for n in notes)


def test_a_phi_row_whose_only_value_is_not_finite_is_checked_with_one_named_mismatch(
    tmp_path, in_process
):
    def plant(run):
        _rewrite_phi(run, ["34"], {0: ["inf"]})

    _run, layout, manifest = _run_with_phi(tmp_path, plant)

    assert manifest.artifacts["phi_check/0"].state == "ok"
    check = load_phi_check(0, layout)
    assert check.status == "checked"
    assert check.n_compared == 1 and check.n_mismatch == 1
    assert check.rows[0].realization == "34" and check.rows[0].file is None
    assert check.max_rel_diff is None


def test_writing_a_check_with_values_that_are_not_finite_stores_them_as_null_and_says_so(
    tmp_path,
):
    from pesto.ingest.phicheck import PhiCheck, PhiRow, write_phi_check

    layout = CacheLayout(root=tmp_path / "cache")
    rows = (
        PhiRow("a", float("inf"), 1.0, float("nan"), False),
        PhiRow("b", 1.0, 1.0, 0.0, True),
    )
    check = PhiCheck(
        iteration=0,
        tolerance=PHI_TOLERANCE,
        weights_source="w",
        phi_file="p.csv",
        status="checked",
        reason="",
        n_compared=2,
        n_mismatch=1,
        n_only_in_cache=0,
        n_only_in_file=0,
        max_rel_diff=float("inf"),
        median_rel_diff=None,
        rows=rows,
        summary="s",
        notes=(),
    )

    written = write_phi_check(check, 0, layout)

    assert not isinstance(written, ReadFailure), written
    stored = json.loads(layout.phi_check(0).read_text())
    assert stored["max_rel_diff"] is None
    assert stored["rows"][0]["recomputed"] is None and stored["rows"][0]["rel_diff"] is None
    assert stored["rows"][1]["recomputed"] == 1.0
    assert sum("stored as null" in n for n in stored["notes"]) == 1
    assert "3 value(s)" in stored["notes"][-1]


def test_greater_and_less_than_groups_count_one_sided(tmp_path, in_process):
    from .obs_fixtures import SiteSpec

    sites = (
        SiteSpec("greater_a", "oname:g", (None,), "none", obsval=0.0, weight=1.0),
        SiteSpec("less_b", "oname:l", (None,), "none", obsval=0.0, weight=1.0),
        SiteSpec("plain", "oname:p", (None,), "none", obsval=0.0, weight=1.0),
    )
    run, layout, _ = _run_with_phi(tmp_path, sites=sites)

    check = load_phi_check(0, layout)
    assert check.n_mismatch == 0
    weights = run.phi_weights
    values = run.values[0]
    by_name = {r.realization: r.recomputed for r in check.rows}
    skipped = {"greater": 0, "less": 0}
    for r, name in enumerate(run.real_names):
        expected = 0.0
        # greater-than counts only below its value, less-than only above it
        g, l, p = values[r, 0], values[r, 1], values[r, 2]
        if g < 0:
            expected += (weights[r, 0] * g) ** 2
        else:
            skipped["greater"] += 1
        if l > 0:
            expected += (weights[r, 1] * l) ** 2
        else:
            skipped["less"] += 1
        expected += (weights[r, 2] * p) ** 2
        assert by_name[name] == pytest.approx(expected, rel=1e-6), name
    assert skipped["greater"] and skipped["less"]


def test_without_an_adjusted_weights_file_control_weights_are_used_and_the_result_says_so(
    tmp_path, in_process
):
    run_dir = tmp_path / "run"
    # Phi in the file is computed from the control weights, so it agrees.
    probe = make_obs_run(tmp_path / "probe")
    control = np.tile([float(r["weight"]) for r in probe.rows], (4, 1))
    run = make_obs_run(run_dir, with_phi=True, iterations=(0,), adjusted_weights=control)
    run.adjusted_weights_path.unlink()
    ingest_run(run_dir, cache_root=tmp_path / "cache")

    check = load_phi_check(0, CacheLayout(root=tmp_path / "cache"))
    assert check.status == "checked"
    assert check.n_mismatch == 0
    assert check.weights_source == "control file weights"
    assert any("pestpp's phi may differ" in n for n in check.notes)


def test_a_file_with_no_row_for_the_iteration_says_not_checked(tmp_path, in_process):
    def keep_iteration_zero(run):
        _rewrite_phi(run, _columns(run), {0: _phi_row(run, 0)})

    run, layout, manifest = _run_with_phi(tmp_path, keep_iteration_zero, iterations=(0, 1))

    assert manifest.artifacts["phi_check/1"].state == "ok"
    check = load_phi_check(1, layout)
    assert check.status == "not checked"
    assert check.n_compared == 0 and check.rows == ()
    assert "case.phi.actual.csv" in check.reason and "iteration 1" in check.reason
    assert load_phi_check(0, layout).status == "checked"


def test_no_realization_in_common_says_not_checked(tmp_path, in_process):
    def other_names(run):
        _rewrite_phi(run, ["x1", "x2", "x3", "x4"], {0: ["1.0", "2.0", "3.0", "4.0"]})

    _run, layout, manifest = _run_with_phi(tmp_path, other_names)

    check = load_phi_check(0, layout)
    assert manifest.artifacts["phi_check/0"].state == "ok"
    assert check.status == "not checked"
    assert "no realization is in both" in check.reason
    assert check.n_compared == 0
    assert check.n_only_in_cache == 4 and check.n_only_in_file == 4


def test_a_phi_file_that_does_not_start_with_the_pestpp_columns_fails_with_a_reason(
    tmp_path, in_process
):
    def old_shape(run):
        run.phi_path.write_text("iteration,total_runs,phi\n0,1,1.0\n")

    _run, layout, manifest = _run_with_phi(tmp_path, old_shape)

    phi = manifest.artifacts["phi_check/0"]
    assert phi.state == "failed"
    assert phi.reason.startswith("phi_check/0: ")
    assert "does not start with the columns" in phi.reason
    assert not layout.phi_check(0).exists()


def test_phi_check_fails_with_the_depends_on_wording_when_obs_ens_failed(tmp_path, in_process):
    run_dir = tmp_path / "run"
    run = make_obs_run(run_dir, with_phi=True, iterations=(0,))
    run.obs_ens[0].write_bytes(b"this is not an observation file")

    manifest = ingest_run(run_dir, cache_root=tmp_path / "cache")

    assert manifest.artifacts["obs_ens/0"].state == "failed"
    phi = manifest.artifacts["phi_check/0"]
    assert phi.state == "failed"
    assert phi.reason.startswith("phi_check/0 depends on obs_ens/0, which failed: ")


def test_a_run_without_a_phi_file_plans_no_phi_check_and_the_capability_says_so(
    tmp_path, in_process
):
    run_dir = tmp_path / "run"
    run = make_obs_run(run_dir)
    ingest_run(run_dir, cache_root=tmp_path / "cache")

    manifest = Manifest.load(CacheLayout(root=tmp_path / "cache"))
    assert not any(name.startswith("phi_check/") for name in manifest.artifacts)
    capability = _capabilities(run, CacheLayout(root=tmp_path / "cache"))["phi_check"]
    assert capability == {
        "available": False,
        "blocked_by": [
            {"artifact": "phi_check", "reason": "no case.phi.actual.csv was found for this run"}
        ],
    }


def test_editing_the_phi_file_makes_phi_check_stale_and_the_next_ingest_redoes_it(
    tmp_path, in_process
):
    run_dir = tmp_path / "run"
    run = make_obs_run(run_dir, with_phi=True, iterations=(0,))
    cache_root = tmp_path / "cache"
    ingest_run(run_dir, cache_root=cache_root)
    layout = CacheLayout(root=cache_root)
    assert load_phi_check(0, layout).n_mismatch == 0

    _rewrite_phi(run, _columns(run), {0: _phi_row(run, 0, {"base": lambda v: v * 2.0})})
    ingest_run(run_dir, cache_root=cache_root)

    assert load_phi_check(0, layout).n_mismatch == 1


def test_a_stored_file_from_another_cache_version_is_refused(tmp_path, in_process):
    _run, layout, _ = _run_with_phi(tmp_path)
    stored = json.loads(layout.phi_check(0).read_text())
    stored["cache_version"] = "0"
    layout.phi_check(0).write_text(json.dumps(stored))

    result = load_phi_check(0, layout)
    assert isinstance(result, ReadFailure)
    assert "cache_version" in result.reason


def test_the_module_imports_no_heavy_library_at_module_scope():
    import inspect

    from pesto.ingest import phicheck

    source = inspect.getsource(phicheck)
    assert "import pyemu" not in source and "import flopy" not in source
    assert "from pyemu" not in source and "from flopy" not in source


def test_the_run_folder_is_untouched_when_phi_does_not_match(tmp_path, in_process):
    run_dir = tmp_path / "run"
    run = make_obs_run(run_dir, with_phi=True, iterations=(0,))
    _rewrite_phi(run, _columns(run), {0: _phi_row(run, 0, {"base": lambda v: v * 2.0})})
    before = _tree_snapshot(run_dir)
    ingest_run(run_dir, cache_root=tmp_path / "cache")
    assert _tree_snapshot(run_dir) == before


# ---------------------------------------------------------------------------
# blocked weights reads, repeated cache names, the unused import
# ---------------------------------------------------------------------------


def _small_index(obsvals, weights=None, group="g"):
    from pesto.ingest.obsindex import build_obs_index

    from .obs_fixtures import obs_arrow

    weights = weights if weights is not None else [1.0] * len(obsvals)
    rows = [
        {"obsnme": f"o{k:03d}", "obgnme": group, "obsval": v, "weight": w}
        for k, (v, w) in enumerate(zip(obsvals, weights))
    ]
    index = build_obs_index(obs_arrow(rows))
    assert not isinstance(index, ReadFailure), index
    return index


def _adjusted(weights):
    from pathlib import Path

    from pesto.ingest.obsweights import AdjustedWeights

    n = weights.shape[1]
    return AdjustedWeights(
        weights=weights,
        real_names=tuple(f"r{k}" for k in range(weights.shape[0])),
        obs_names=tuple(f"o{k:03d}" for k in range(n)),
        control_rows=np.arange(n, dtype=np.int64),
        n_unweighted=0,
        source=Path("w.jcb"),
        notes=(),
    )


def test_weights_are_read_one_block_at_a_time(monkeypatch):
    from pesto.ingest import phicheck

    class Recording(np.ndarray):
        shapes: list = []

        def __getitem__(self, key):
            out = super().__getitem__(key)
            Recording.shapes.append(np.shape(out))
            return out

    rng = np.random.default_rng(3)
    n_obs, n_real = 7, 3
    index = _small_index(list(rng.normal(size=n_obs)))
    values = rng.normal(size=(n_obs, n_real)).astype(np.float32)
    plain = rng.uniform(0.5, 2.0, size=(n_real, n_obs))
    rows = [2, 0, 1]
    expected, _ = phicheck.recompute_phi(index, values, [0, 1, 2], _adjusted(plain), rows, None)

    monkeypatch.setattr(phicheck, "BLOCK_ROWS", 2)
    Recording.shapes = []
    got, _ = phicheck.recompute_phi(
        index, values, [0, 1, 2], _adjusted(plain.view(Recording)), rows, None
    )

    assert Recording.shapes, "the weights were never indexed"
    assert all(shape[1] <= 2 for shape in Recording.shapes)
    np.testing.assert_allclose(got, expected, rtol=1e-12)


def test_a_name_that_appears_twice_in_the_cache_is_paired_with_nothing():
    from pesto.ingest.phicheck import _join_names

    pairs, cache_only, other_only, notes = _join_names(
        ("r1", "r1", "r2"), ["r2", "r1"], "case.phi.actual.csv"
    )

    assert pairs == [(2, 0)]
    assert sorted(cache_only) == [0, 1]
    assert other_only == [1]
    repeated = [n for n in notes if "more than once in the cache" in n]
    assert len(repeated) == 1 and "'r1'" in repeated[0] and "not matched" in repeated[0]


def test_a_cache_name_that_repeats_is_not_rescued_by_trimming_and_lower_casing():
    from pesto.ingest.phicheck import _join_names

    pairs, cache_only, _other_only, _notes = _join_names(("r1", "r1", "R1"), ["r1"], "p.csv")

    assert pairs == []
    assert sorted(cache_only) == [0, 1, 2]


def test_the_module_does_not_import_the_examples_helper_it_never_uses():
    import pesto.ingest.phicheck as phicheck

    source = open(phicheck.__file__).read()
    assert "from pesto.ingest.obsread import" not in source


# ---------------------------------------------------------------------------
# real runs (slow; skipped when the benchmark folder is absent)
# ---------------------------------------------------------------------------


@pytest.mark.slow
@pytest.mark.parametrize("fixture_name", ["hm_run", "pl253_run"])
def test_on_a_real_run_phi_from_the_cache_matches_pestpps_file(fixture_name, request, tmp_path):
    from pesto.ingest import runner
    from pesto.ingest.control import read_control
    from pesto.ingest.discover import discover
    from pesto.ingest.obsweights import read_adjusted_weights
    from pesto.ingest.phicheck import check_phi
    from pesto.ingest.tables import load_control_table, write_control

    run_path = request.getfixturevalue(fixture_name)
    before = _tree_snapshot(run_path)
    run = discover(run_path)
    phi_file = run.phi.get("actual")
    if phi_file is None:
        pytest.skip("this run has no case.phi.actual.csv")
    selected, _ = runner.observation_iterations(run)
    iterations = [k for k in selected if run.obs_ens.get(k) is not None]
    if not iterations:
        pytest.skip("no ingested iteration has an observation file")

    tables = read_control(run.pst_path)
    assert not isinstance(tables, ReadFailure), tables
    layout = CacheLayout(root=tmp_path / "cache")
    layout.ensure()
    assert not isinstance(write_control(tables, layout), ReadFailure)
    assert not isinstance(runner._write_obs_index_artifact(str(layout.root)), ReadFailure)
    names = load_control_table(layout, "obs", columns=["obsnme"])[0].column("obsnme").to_pylist()
    weights = None
    if run.adjusted_weights is not None:
        weights = read_adjusted_weights(run.adjusted_weights, names, artifact="phi_check")
        assert not isinstance(weights, ReadFailure), weights

    checked = 0
    for k in iterations:
        ens = runner._write_obs_ens_artifact(str(run.obs_ens[k]), str(layout.root), k)
        assert not isinstance(ens, ReadFailure), ens
        # The same worker the ingest runs.
        written = runner._write_phi_check_artifact(
            str(layout.root),
            k,
            str(phi_file),
            str(run.adjusted_weights) if run.adjusted_weights is not None else None,
        )
        assert not isinstance(written, ReadFailure), written
        check = load_phi_check(k, layout)
        assert not isinstance(check, ReadFailure), check
        if check.status != "checked":
            continue
        checked += 1
        assert check.n_compared > 0
        assert check.n_mismatch == 0, (k, check.summary)
        assert check.max_rel_diff is not None and check.max_rel_diff <= PHI_TOLERANCE
        # The check function gives the same answer as the stored one.
        again = check_phi(k, layout, phi_file, weights)
        assert not isinstance(again, ReadFailure)
        assert again.n_compared == check.n_compared
        break

    assert checked, "no ingested iteration had a row in the phi file"
    assert _tree_snapshot(run_path) == before
