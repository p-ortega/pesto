"""Work out what a pestpp-ies run directory holds.

Every test here proves a matching rule or a refusal, never opens an ensemble,
grid or data file, and asserts against a directory built by
``tests/ingest/fixtures.py`` -- never a hand-rolled generator of its own.
"""

from __future__ import annotations

import pytest

from pesto.ingest.discover import NoRunFound, discover

from .fixtures import MISSING_FILE, make_run, write_control_file


def _touch(path):
    path.write_bytes(b"placeholder -- discover never opens this file")
    return path


def _all_layout_paths(layout):
    """Every path a :class:`RunLayout` reports, across every category."""
    paths = []
    paths.extend(layout.par_ens.values())
    paths.extend(layout.obs_ens.values())
    paths.extend(layout.rejected_par_ens.values())
    paths.extend(layout.rejected_obs_ens.values())
    paths.extend(layout.phi.values())
    paths.extend(layout.pdc.values())
    paths.extend(layout.pcs.values())
    if layout.grid is not None:
        paths.append(layout.grid)
    if layout.noise is not None:
        paths.append(layout.noise)
    if layout.starting_par_ens is not None:
        paths.append(layout.starting_par_ens)
    if layout.starting_obs_ens is not None:
        paths.append(layout.starting_obs_ens)
    return paths


def _layout_shape(layout):
    """The set of populated fields and mapping keys, independent of the
    actual paths -- what the noptmax<=0 equivalence test compares."""
    return {
        "par_ens_keys": set(layout.par_ens),
        "obs_ens_keys": set(layout.obs_ens),
        "rejected_par_ens_keys": set(layout.rejected_par_ens),
        "rejected_obs_ens_keys": set(layout.rejected_obs_ens),
        "phi_keys": set(layout.phi),
        "pdc_keys": set(layout.pdc),
        "pcs_keys": set(layout.pcs),
        "grid_present": layout.grid is not None,
        "noise_present": layout.noise is not None,
        "starting_par_ens_present": layout.starting_par_ens is not None,
        "starting_obs_ens_present": layout.starting_obs_ens is not None,
    }


def _write_minimal_control_file(path, noptmax=3, extra_lines=()):
    """A hand-written keyword-format control file, deliberately not routed
    through ``pyemu.Pst.write`` -- ``discover``'s control-file scan is a
    plain line-scan, and these tests exercise that scan's own key-matching
    rules directly, independent of whatever whitespace/casing a real pyemu
    write happens to produce."""
    lines = [
        "pcf version=2\n",
        "* control data keyword\n",
        f"noptmax                                {noptmax}\n",
        *extra_lines,
    ]
    path.write_text("".join(lines))
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


def test_two_grid_files_keep_the_sorted_first_and_name_the_other(tmp_path):
    run = make_run(tmp_path, case="escondida", iterations=(0,))
    # "coarse.disv.grb" (run.grid_path) sorts before this second candidate.
    second_grid = _touch(tmp_path / "zzz_other.grb")

    layout = discover(tmp_path)

    assert layout.grid == run.grid_path
    grid_ambiguities = [a for a in layout.ambiguities if a.slot == "grid file"]
    assert len(grid_ambiguities) == 1
    ambiguity = grid_ambiguities[0]
    assert ambiguity.chosen == run.grid_path.name
    assert second_grid.name in ambiguity.rejected
    assert ambiguity.note() in layout.notes


@pytest.mark.slow
def test_pl253_run_names_the_grid_file_it_did_not_keep(pl253_run):
    """The real gap 02-06-SUMMARY.md recorded: two .grb files exist, and the
    caller must be told about the one that was not kept."""
    layout = discover(pl253_run)

    assert layout.grid is not None
    assert layout.grid.name == "org.grb"
    grid_ambiguities = [a for a in layout.ambiguities if a.slot == "grid file"]
    assert len(grid_ambiguities) == 1
    ambiguity = grid_ambiguities[0]
    assert "pl253.disv.grb" in ambiguity.rejected
    assert ambiguity.note() in layout.notes


# ---------------------------------------------------------------------------
# Every slot resolves through the same call, and says what it rejected --
# one policy, one direction, at every ambiguity site discover() has.
# ---------------------------------------------------------------------------


def test_two_files_matching_one_ensemble_slot_produce_an_ambiguity_naming_both(tmp_path):
    write_control_file(tmp_path / "case.pst", par_names=["p0"], obs_names=["o0"])
    bin_path = _touch(tmp_path / "case.0.par.bin")
    jcb_path = _touch(tmp_path / "case.0.par.jcb")

    layout = discover(tmp_path)

    assert layout.par_ens[0] == bin_path  # "bin" sorts before "jcb"
    ambiguities = [
        a for a in layout.ambiguities if a.slot == "parameter ensemble for iteration 0"
    ]
    assert len(ambiguities) == 1
    assert ambiguities[0].chosen == bin_path.name
    assert jcb_path.name in ambiguities[0].rejected
    assert ambiguities[0].note() in layout.notes


def test_two_files_matching_a_rejected_ensemble_slot_produce_an_ambiguity(tmp_path):
    write_control_file(tmp_path / "case.pst", par_names=["p0"], obs_names=["o0"])
    jcb_path = _touch(tmp_path / "case.0.rejected.par.jcb")
    jco_path = _touch(tmp_path / "case.0.rejected.par.jco")

    layout = discover(tmp_path)

    assert layout.rejected_par_ens[0] == jcb_path  # "jcb" sorts before "jco"
    ambiguities = [
        a for a in layout.ambiguities if a.slot == "rejected parameter ensemble for iteration 0"
    ]
    assert len(ambiguities) == 1
    assert ambiguities[0].chosen == jcb_path.name
    assert jco_path.name in ambiguities[0].rejected
    assert ambiguities[0].note() in layout.notes


def test_two_files_matching_the_noise_ensemble_slot_produce_an_ambiguity(tmp_path):
    write_control_file(tmp_path / "case.pst", par_names=["p0"], obs_names=["o0"])
    bin_path = _touch(tmp_path / "case.obs+noise.bin")
    jcb_path = _touch(tmp_path / "case.obs+noise.jcb")

    layout = discover(tmp_path)

    assert layout.noise == bin_path  # "bin" sorts before "jcb"
    ambiguities = [a for a in layout.ambiguities if a.slot == "measurement-noise ensemble"]
    assert len(ambiguities) == 1
    assert ambiguities[0].chosen == bin_path.name
    assert jcb_path.name in ambiguities[0].rejected
    assert ambiguities[0].note() in layout.notes


def test_two_control_files_produce_an_ambiguity_and_case_comes_from_the_chosen_one(tmp_path):
    write_control_file(tmp_path / "aaa.pst", par_names=["p0"], obs_names=["o0"])
    write_control_file(tmp_path / "zzz.pst", par_names=["p0"], obs_names=["o0"])

    layout = discover(tmp_path)

    assert layout.case == "aaa"
    control_ambiguities = [a for a in layout.ambiguities if a.slot == "control file"]
    assert len(control_ambiguities) == 1
    assert control_ambiguities[0].chosen == "aaa.pst"
    assert "zzz.pst" in control_ambiguities[0].rejected
    assert control_ambiguities[0].note() in layout.notes


@pytest.mark.parametrize(
    "build_candidates",
    [
        lambda root: (
            _touch(root / "case.0.par.bin"),
            _touch(root / "case.0.par.jcb"),
            "parameter ensemble for iteration 0",
        ),
        lambda root: (
            _touch(root / "case.0.rejected.obs.jcb"),
            _touch(root / "case.0.rejected.obs.jco"),
            "rejected observation ensemble for iteration 0",
        ),
        lambda root: (
            _touch(root / "case.obs+noise.bin"),
            _touch(root / "case.obs+noise.jcb"),
            "measurement-noise ensemble",
        ),
    ],
)
def test_every_ambiguous_slot_keeps_the_sorted_first_candidate_never_the_sorted_last(
    tmp_path, build_candidates
):
    """The single-policy claim, directly: for every one of these categories
    the kept file is the sorted-first candidate, never the sorted-last, so
    no site tie-breaks in the opposite direction."""
    write_control_file(tmp_path / "case.pst", par_names=["p0"], obs_names=["o0"])
    first, second, slot = build_candidates(tmp_path)

    layout = discover(tmp_path)

    ambiguities = [a for a in layout.ambiguities if a.slot == slot]
    assert len(ambiguities) == 1
    assert ambiguities[0].chosen == first.name
    assert second.name in ambiguities[0].rejected


def test_every_ambiguity_note_appears_in_layout_notes(tmp_path):
    write_control_file(tmp_path / "case.pst", par_names=["p0"], obs_names=["o0"])
    _touch(tmp_path / "case.0.par.bin")
    _touch(tmp_path / "case.0.par.jcb")
    _touch(tmp_path / "zzz_other.grb")
    _touch(tmp_path / "coarse.disv.grb")

    layout = discover(tmp_path)

    assert len(layout.ambiguities) >= 1
    assert len(layout.ambiguities) <= len(layout.notes)
    for ambiguity in layout.ambiguities:
        assert ambiguity.note() in layout.notes


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


# ---------------------------------------------------------------------------
# Task 2: find the starting ensembles the filesystem does not advertise
# ---------------------------------------------------------------------------


def test_starting_parameter_ensemble_named_by_control_file_is_found(tmp_path):
    write_control_file(
        tmp_path / "case.pst",
        par_names=["p0", "p1"],
        obs_names=["o0"],
        pestpp_options={"ies_parameter_ensemble": "prior_pe.jcb"},
    )
    _touch(tmp_path / "prior_pe.jcb")

    layout = discover(tmp_path)

    assert layout.starting_par_ens == tmp_path / "prior_pe.jcb"


def test_abbreviated_option_spellings_resolve_identically_to_long_forms(tmp_path):
    write_control_file(
        tmp_path / "case.pst",
        par_names=["p0"],
        obs_names=["o0"],
        pestpp_options={"ies_par_en": "myprior.jcb", "ies_obs_en": "mynoise.jcb"},
    )
    _touch(tmp_path / "myprior.jcb")
    _touch(tmp_path / "mynoise.jcb")

    layout = discover(tmp_path)

    assert layout.starting_par_ens == tmp_path / "myprior.jcb"
    assert layout.starting_obs_ens == tmp_path / "mynoise.jcb"


def test_option_key_matches_after_lower_casing_and_stripping(tmp_path):
    _write_minimal_control_file(
        tmp_path / "case.pst",
        extra_lines=["   IES_PAR_EN      myprior.jcb\n"],
    )
    _touch(tmp_path / "myprior.jcb")

    layout = discover(tmp_path)

    assert layout.starting_par_ens == tmp_path / "myprior.jcb"


def test_starting_ensemble_named_but_absent_is_named_and_missing(tmp_path):
    run = make_run(tmp_path, starting_par_en=MISSING_FILE, iterations=(0,))

    layout = discover(tmp_path)

    assert layout.starting_par_ens is None
    assert not run.starting_par_en.exists()
    assert any(
        "ies_parameter_ensemble" in note and "prior_pe.jcb" in note for note in layout.notes
    )


def test_no_starting_ensemble_named_yields_absent_fields_and_no_note(tmp_path):
    write_control_file(tmp_path / "case.pst", par_names=["p0"], obs_names=["o0"])

    layout = discover(tmp_path)

    assert layout.starting_par_ens is None
    assert layout.starting_obs_ens is None
    assert layout.notes == ()


def test_unreadable_control_file_yields_a_layout_not_an_exception(tmp_path):
    pst_path = tmp_path / "case.pst"
    pst_path.write_bytes(b"pcf version=2\nnot valid utf-8: \xff\xfe\x80\x81\n")

    layout = discover(tmp_path)

    assert layout.noptmax is None
    assert layout.starting_par_ens is None
    assert layout.starting_obs_ens is None
    assert any("case.pst" in note for note in layout.notes)


def test_discover_is_stable_across_repeated_calls(tmp_path):
    make_run(tmp_path, iterations=(0, 1))

    assert discover(tmp_path) == discover(tmp_path)


def test_discover_writes_nothing_to_the_run_directory(tmp_path):
    make_run(tmp_path, iterations=(0, 1))

    before = {
        entry.name: (entry.stat().st_size, entry.stat().st_mtime_ns)
        for entry in tmp_path.iterdir()
    }

    discover(tmp_path)

    after = {
        entry.name: (entry.stat().st_size, entry.stat().st_mtime_ns)
        for entry in tmp_path.iterdir()
    }

    assert after == before


# ---------------------------------------------------------------------------
# Task 3: a NOPTMAX <= 0 run is a normal case, proven on a real forecast
# directory
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("noptmax", [-1, 0])
def test_noptmax_le_0_run_opens_as_a_normal_populated_layout(tmp_path, noptmax):
    """READ-05 stated as behaviour, not absence: a NOPTMAX<=0 run comes back
    with the same populated shape as an ordinary multi-iteration run, no
    fallback field and no note about noptmax at all."""
    neg_dir = tmp_path / "neg"
    pos_dir = tmp_path / "pos"
    neg_dir.mkdir()
    pos_dir.mkdir()
    make_run(neg_dir, noptmax=noptmax, iterations=(0,))
    make_run(pos_dir, noptmax=3, iterations=(0,))

    neg_layout = discover(neg_dir)
    pos_layout = discover(pos_dir)

    assert neg_layout.noptmax == noptmax
    assert 0 in neg_layout.iterations
    assert neg_layout.par_ens and neg_layout.obs_ens
    assert neg_layout.grid is not None
    assert len(neg_layout.phi) == 6
    assert not any("noptmax" in note.lower() for note in neg_layout.notes)

    # Not merely non-empty -- structurally identical to the ordinary
    # multi-iteration run generated from the same shape of directory.
    assert _layout_shape(neg_layout) == _layout_shape(pos_layout)


def test_inventory_matches_every_artifact_the_generator_wrote_in_both_directions(tmp_path):
    """Success criterion 2, as a single set-equality assertion in both
    directions: the forward direction catches a category discovery missed,
    the reverse direction catches discovery reporting a decoy."""
    run = make_run(tmp_path, iterations=(0, 1))

    layout = discover(tmp_path)
    reported = set(_all_layout_paths(layout))

    expected = set()
    expected.update(run.par_ens.values())
    expected.update(run.obs_ens.values())
    expected.update(run.phi_paths.values())
    expected.update(run.pdc_paths.values())
    expected.update(run.pcs_paths.values())
    expected.update(run.reinflate_pcs_paths.values())
    expected.add(run.grid_path)
    if run.starting_par_en is not None:
        expected.add(run.starting_par_en)
    if run.starting_obs_en is not None:
        expected.add(run.starting_obs_en)

    assert reported == expected
    # And the decoys/template/instruction files the generator also wrote
    # are genuinely absent from both sides of that equality.
    for decoy in (*run.decoy_paths, run.tpl_path, run.ins_path):
        assert decoy not in reported


@pytest.mark.slow
def test_forecast_run_reports_the_real_directorys_full_inventory(forecast_run):
    """The realistic NOPTMAX<=0 case: a real forecast directory holding
    2,167,174 observations."""
    layout = discover(forecast_run)

    assert layout.case == "escondida"
    assert layout.noptmax == -1
    assert 0 in layout.par_ens
    assert layout.par_ens[0].name == "escondida.0.par.bin"
    assert layout.grid is not None
    assert layout.grid.name == "coarse.disv.grb"
    assert len(layout.phi) == 6
    assert 0 in layout.pdc
    assert layout.pdc[0].name == "escondida.0.pdc.csv"

    # Deviation from this plan's literal text, recorded in the SUMMARY: the
    # working copy on this machine currently holds pt_pe_forecast.jcb on
    # disk (verified directly this session), so the control file's named
    # starting ensemble resolves as present rather than named-and-missing.
    assert layout.starting_par_ens is not None
    assert layout.starting_par_ens.name == "pt_pe_forecast.jcb"

    all_paths = _all_layout_paths(layout)
    assert not any("factors." in str(path) for path in all_paths)
    assert not any("adjusted" in path.name for path in all_paths)


def test_a_run_holding_only_one_ensemble_kind_reports_the_other_as_empty_in_both_directions(
    tmp_path,
):
    """The reader fact the old, stale hm_run assertion was reaching for --
    proven synthetically so completing local benchmark data can never break
    it again."""
    par_only = tmp_path / "par_only"
    obs_only = tmp_path / "obs_only"
    par_only.mkdir()
    obs_only.mkdir()

    write_control_file(par_only / "case.pst", par_names=["p0"], obs_names=["o0"])
    _touch(par_only / "case.0.par.jcb")

    write_control_file(obs_only / "case.pst", par_names=["p0"], obs_names=["o0"])
    _touch(obs_only / "case.0.obs.jcb")

    par_layout = discover(par_only)
    obs_layout = discover(obs_only)

    assert 0 in par_layout.par_ens
    assert par_layout.obs_ens == {}
    assert 0 in par_layout.iterations
    assert par_layout.notes == ()

    assert 0 in obs_layout.obs_ens
    assert obs_layout.par_ens == {}
    assert 0 in obs_layout.iterations
    assert obs_layout.notes == ()


@pytest.mark.slow
def test_hm_run_names_the_stray_control_file_it_did_not_keep(hm_run):
    """What the reader is responsible for on this real directory: its own
    inventory, and -- new -- the second, 70 MB *.pst file this directory
    genuinely holds, named rather than silently discarded."""
    layout = discover(hm_run)

    assert layout.case == "escondida"
    assert layout.noptmax == 10
    assert 0 in layout.iterations
    assert 1 in layout.iterations
    assert set(layout.par_ens) <= set(layout.iterations)
    assert layout.pcs_file(1) is not None
    assert layout.pcs_file(1).name == "escondida.1.pcs.csv"

    control_ambiguities = [a for a in layout.ambiguities if a.slot == "control file"]
    assert len(control_ambiguities) == 1
    assert "tmp_d.pst" in control_ambiguities[0].rejected
    assert control_ambiguities[0].note() in layout.notes

    # Deviation from this plan's literal text, recorded in the SUMMARY: both
    # prior_pe.jcb and noise_oe.jcb currently exist on disk in this working
    # copy (verified directly this session), so both starting ensembles
    # resolve as present rather than named-and-missing.
    assert layout.starting_par_ens is not None
    assert layout.starting_par_ens.name == "prior_pe.jcb"
    assert layout.starting_obs_ens is not None
    assert layout.starting_obs_ens.name == "noise_oe.jcb"


@pytest.mark.slow
def test_discover_never_writes_to_a_real_run_directory(forecast_run):
    """The mechanical form of this plan's safety prohibition, against a
    real benchmark directory rather than a synthetic one."""
    before = {
        entry.name: (entry.stat().st_size, entry.stat().st_mtime_ns)
        for entry in forecast_run.iterdir()
    }

    discover(forecast_run)

    after = {
        entry.name: (entry.stat().st_size, entry.stat().st_mtime_ns)
        for entry in forecast_run.iterdir()
    }

    assert after == before
