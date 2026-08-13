"""Work out what a pestpp-ies run directory holds.

Every test here proves a matching rule or a refusal, never opens an ensemble,
grid or data file, and asserts against a directory built by
``tests/ingest/fixtures.py`` -- never a hand-rolled generator of its own.
"""

from __future__ import annotations

import pytest

from pesto.ingest.discover import NoRunFound, discover

from .fixtures import make_run, write_control_file


def _touch(path):
    path.write_bytes(b"placeholder -- discover never opens this file")
    return path


# ---------------------------------------------------------------------------
# Task 1: recognise every artifact category, and nothing else
# ---------------------------------------------------------------------------


def test_par_and_obs_ensembles_found_across_all_extensions_keyed_by_iteration(tmp_path):
    pst_path, _ = write_control_file(
        tmp_path / "case.pst", par_names=["p0", "p1"], obs_names=["o0", "o1"]
    )
    expected = {}
    for ext_index, ext in enumerate(("jcb", "jco", "bin", "csv")):
        par_path = _touch(tmp_path / f"case.{ext_index}.par.{ext}")
        obs_path = _touch(tmp_path / f"case.{ext_index}.obs.{ext}")
        expected[ext_index] = (par_path, obs_path)

    layout = discover(tmp_path)

    for iteration, (par_path, obs_path) in expected.items():
        assert layout.par_ens[iteration] == par_path
        assert layout.obs_ens[iteration] == obs_path
        assert layout.par_ensemble(iteration) == par_path
        assert layout.obs_ensemble(iteration) == obs_path


def test_make_run_directory_reports_par_and_obs_ensembles_keyed_by_iteration(tmp_path):
    run = make_run(tmp_path, iterations=(0, 1))

    layout = discover(tmp_path)

    assert set(layout.par_ens) == {0, 1}
    assert set(layout.obs_ens) == {0, 1}
    assert layout.par_ens[0] == run.par_ens[0]
    assert layout.par_ens[1] == run.par_ens[1]
    assert layout.obs_ens[0] == run.obs_ens[0]
    assert layout.obs_ens[1] == run.obs_ens[1]


def test_six_phi_files_found_and_reported_by_kind(tmp_path):
    run = make_run(tmp_path, iterations=(0,))

    layout = discover(tmp_path)

    assert set(layout.phi) == {"actual", "meas", "regul", "composite", "group", "lambda"}
    for kind, path in run.phi_paths.items():
        assert layout.phi[kind] == path
        assert layout.phi_file(kind) == path


def test_grid_file_found_despite_no_case_prefix(tmp_path):
    run = make_run(tmp_path, case="escondida", iterations=(0,))

    layout = discover(tmp_path)

    assert layout.grid == run.grid_path
    assert layout.grid.name == "coarse.disv.grb"
    assert not layout.grid.name.startswith("escondida")


def test_pdc_and_pcs_files_found_per_iteration_including_reinflate_variant(tmp_path):
    run = make_run(tmp_path, iterations=(0, 1))

    layout = discover(tmp_path)

    for iteration in (0, 1):
        assert layout.pdc[iteration] == run.pdc_paths[iteration]
        assert layout.pdc_file(iteration) == run.pdc_paths[iteration]
        assert layout.pcs[(iteration, "")] == run.pcs_paths[iteration]
        assert layout.pcs_file(iteration) == run.pcs_paths[iteration]
        assert layout.pcs[(iteration, "reinflate")] == run.reinflate_pcs_paths[iteration]
        assert layout.pcs_file(iteration, infix="reinflate") == run.reinflate_pcs_paths[iteration]
        # The two pcs entries are distinguishable, not aliases of one path.
        assert layout.pcs_file(iteration) != layout.pcs_file(iteration, infix="reinflate")


def test_rejected_ensemble_recognised_as_distinct_artifact(tmp_path):
    write_control_file(tmp_path / "case.pst", par_names=["p0", "p1"], obs_names=["o0"])
    rejected_par = _touch(tmp_path / "case.0.rejected.par.jcb")
    rejected_obs = _touch(tmp_path / "case.0.rejected.obs.jcb")
    ordinary_par = _touch(tmp_path / "case.0.par.jcb")

    layout = discover(tmp_path)

    assert layout.rejected_par_ens[0] == rejected_par
    assert layout.rejected_obs_ens[0] == rejected_obs
    assert layout.rejected_par_ensemble(0) == rejected_par
    assert layout.par_ens[0] == ordinary_par
    # The rejected save is not folded into the ordinary per-iteration mapping.
    assert rejected_par not in layout.par_ens.values()


def test_decoy_files_sharing_an_ensemble_extension_are_not_reported_as_ensembles(tmp_path):
    run = make_run(tmp_path, case="case", iterations=(0,))

    layout = discover(tmp_path)

    all_paths = (
        list(layout.par_ens.values())
        + list(layout.obs_ens.values())
        + list(layout.rejected_par_ens.values())
        + list(layout.rejected_obs_ens.values())
        + list(layout.phi.values())
        + list(layout.pdc.values())
        + list(layout.pcs.values())
        + ([layout.grid] if layout.grid else [])
        + ([layout.noise] if layout.noise else [])
    )
    for decoy in run.decoy_paths:
        assert decoy not in all_paths


def test_template_and_instruction_files_are_not_listed(tmp_path):
    run = make_run(tmp_path, iterations=(0,))

    layout = discover(tmp_path)

    all_paths = (
        list(layout.par_ens.values())
        + list(layout.obs_ens.values())
        + list(layout.rejected_par_ens.values())
        + list(layout.rejected_obs_ens.values())
        + list(layout.phi.values())
        + list(layout.pdc.values())
        + list(layout.pcs.values())
        + ([layout.grid] if layout.grid else [])
        + ([layout.noise] if layout.noise else [])
    )
    assert run.tpl_path not in all_paths
    assert run.ins_path not in all_paths


def test_iteration_numbers_larger_than_noptmax_are_accepted(tmp_path):
    write_control_file(tmp_path / "case.pst", par_names=["p0"], obs_names=["o0"], noptmax=3)
    high_iter_path = _touch(tmp_path / "case.999.par.jcb")

    layout = discover(tmp_path)

    assert layout.noptmax == 3
    assert 999 in layout.iterations
    assert layout.par_ens[999] == high_iter_path


def test_prior_and_mean_iteration_tags_are_accepted_under_named_keys(tmp_path):
    write_control_file(tmp_path / "case.pst", par_names=["p0"], obs_names=["o0"])
    prior_path = _touch(tmp_path / "case.prior.par.jcb")
    mean_path = _touch(tmp_path / "case.mean.par.jcb")

    layout = discover(tmp_path)

    assert layout.par_ens["prior"] == prior_path
    assert layout.par_ens["mean"] == mean_path
    # These are named tags, not folded into the numbered iterations tuple.
    assert "prior" not in layout.iterations
    assert "mean" not in layout.iterations


def test_matching_is_case_insensitive(tmp_path):
    write_control_file(tmp_path / "case.pst", par_names=["p0"], obs_names=["o0"])
    upper_path = _touch(tmp_path / "case.0.PAR.JCB")

    layout = discover(tmp_path)

    assert layout.par_ens[0] == upper_path


def test_macos_resource_fork_files_are_skipped(tmp_path):
    write_control_file(tmp_path / "case.pst", par_names=["p0"], obs_names=["o0"])
    _touch(tmp_path / "case.0.par.jcb")
    _touch(tmp_path / "._case.0.par.jcb")

    layout = discover(tmp_path)

    assert len(layout.par_ens) == 1


def test_directory_with_control_file_and_no_ensembles_returns_empty_mappings(tmp_path):
    write_control_file(tmp_path / "case.pst", par_names=["p0"], obs_names=["o0"])

    layout = discover(tmp_path)

    assert layout.par_ens == {}
    assert layout.obs_ens == {}
    assert layout.iterations == ()


def test_no_control_file_raises_no_run_found(tmp_path):
    with pytest.raises(NoRunFound):
        discover(tmp_path)


def test_non_directory_raises_not_a_directory_error(tmp_path):
    a_file = tmp_path / "not_a_dir.txt"
    a_file.write_text("not a directory")

    with pytest.raises(NotADirectoryError):
        discover(a_file)


def test_discover_docstring_names_the_read_promise():
    assert "matched" in discover.__doc__
    assert "readable" in discover.__doc__
