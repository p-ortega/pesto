"""par_groups' sigma ratio: how much each group's spread shrank between the
first and the last iteration, and when it is refused.

Each test ingests a generated run whose values the test knows, then compares
what the cache holds with numpy on those values. Reinflation evidence is
written as run-record text, file names and a control-file setting.
"""

from __future__ import annotations

import json

import numpy as np

from pesto.cache.layout import CacheLayout
from pesto.ingest import parview
from pesto.ingest.discover import discover
from pesto.ingest.failures import ReadFailure
from pesto.ingest.parview import group_sigma_ratio, load_par_groups
from pesto.ingest.runner import Progress, ingest_run, plan_artifacts

from .par_fixtures import DEFAULT_GROUPS, make_par_view_run, numeric_space, parameter_names
from .test_control_first import in_process  # noqa: F401  (a fixture, used by name)

REINFLATED = dict(
    iterations=(0, 4),
    noptmax=5,
    pestpp_options={"ies_n_iter_reinflate": "3,999"},
    rec={"reinflations": (4,)},
    reinflate_pcs=(4,),
)


def _ingest(tmp_path, **kwargs):
    run = make_par_view_run(tmp_path / "run", **kwargs)
    cache = tmp_path / "cache"
    ingest_run(run.root, cache_root=cache)
    return run, CacheLayout(root=cache)


def _groups(layout):
    loaded = load_par_groups(layout)
    assert not isinstance(loaded, ReadFailure), loaded
    return {g["group"]: g for g in loaded["groups"]}, loaded


def _expected_ratios(run, group):
    """sd_last / sd_first per adjustable parameter of ``group``, from the values."""
    common = [n for n in run.real_names[0] if n in run.real_names[1]]
    first, last = sorted(run.real_names)[0], sorted(run.real_names)[-1]
    ratios = []
    for name in run.groups[group]:
        if run.trans[name] in ("fixed", "tied"):
            continue
        sd_first = np.std(numeric_space(run, first, name, common))
        sd_last = np.std(numeric_space(run, last, name, common))
        if sd_first > 0:
            ratios.append(sd_last / sd_first)
    return np.array(ratios)


def test_a_clean_run_shows_each_groups_sigma_ratio_as_numpy_computes_it(tmp_path, in_process):  # noqa: F811
    run, layout = _ingest(tmp_path, rec=True)
    groups, top = _groups(layout)

    assert top["reinflation"]["verdict"] == "none_found"
    for group in ("hk_pp", "rch_gr", "mix"):
        ratio = groups[group]["sigma_ratio"]
        expected = _expected_ratios(run, group)
        assert ratio["state"] == "shown", ratio
        assert ratio["reason"] is None
        assert ratio["n_used"] == len(expected)
        assert abs(ratio["median"] - float(np.median(expected))) < 1e-12
        assert abs(ratio["p10"] - float(np.percentile(expected, 10))) < 1e-12
        assert abs(ratio["p90"] - float(np.percentile(expected, 90))) < 1e-12


def test_a_reinflated_run_refuses_every_ratio_and_names_the_iteration_and_each_source(
    tmp_path, in_process  # noqa: F811
):
    _run, layout = _ingest(tmp_path, **REINFLATED)
    groups, top = _groups(layout)

    ratio = groups["hk_pp"]["sigma_ratio"]
    assert ratio["state"] == "refused"
    assert ratio["median"] is None and ratio["p10"] is None and ratio["p90"] is None
    for text in ("iteration 4", "case.rec", "case.4.reinflate.pcs.csv", "ies_n_iter_reinflate"):
        assert text in ratio["reason"], (text, ratio["reason"])
    assert ratio["reason"].startswith("Not shown: the ensemble was reinflated at iteration 4")
    assert "realization names" in ratio["reason"]
    for group in ("hk_pp", "rch_gr", "mix"):
        assert groups[group]["sigma_ratio"]["state"] == "refused"
    # The change figures are not taken away.
    assert groups["hk_pp"]["change"]["pesto"] is not None


def test_the_reinflation_entry_lists_the_run_record_then_the_files_then_the_setting(
    tmp_path, in_process  # noqa: F811
):
    _run, layout = _ingest(tmp_path, **REINFLATED)
    _groups_by_name, top = _groups(layout)

    reinflation = top["reinflation"]
    assert reinflation["verdict"] == "found"
    assert [f["iteration"] for f in reinflation["findings"]] == [4]
    sources = [e["source"] for e in reinflation["findings"][0]["evidence"]]
    assert sources == ["run record", "files present", "control file"]
    assert all(e["in_range"] for e in reinflation["findings"][0]["evidence"])
    json.loads(layout.par_groups.read_text(), parse_constant=_no_constant)


def _no_constant(name):
    raise AssertionError(f"the file holds {name}")


def test_par_groups_lists_the_run_record_and_the_reinflate_file_among_its_sources(
    tmp_path, in_process  # noqa: F811
):
    run = make_par_view_run(tmp_path / "run", **REINFLATED)
    planned = {
        a.name: a
        for a in plan_artifacts(discover(run.root), CacheLayout(root=tmp_path / "cache"))
    }

    sources = planned["par_groups"].sources
    assert str(run.rec_path) in sources
    assert str(run.reinflate_paths[0]) in sources
    assert str(run.rec_path) not in planned["par_change"].sources


def test_touching_the_run_record_makes_par_groups_stale_and_leaves_par_change_fresh(
    tmp_path, in_process  # noqa: F811
):
    run, _layout = _ingest(tmp_path, **REINFLATED)
    with run.rec_path.open("a") as handle:
        handle.write("a line added after the run\n")

    rows: list[Progress] = []
    manifest = ingest_run(run.root, cache_root=tmp_path / "cache", on_progress=rows.append)

    # The setup facts read the run record too, so config is read again with par_groups.
    touched = {r.artifact for r in rows if r.state != "skipped"}
    assert touched == {"par_groups", "config"}
    assert manifest.artifacts["par_change"].state == "ok"


# ---------------------------------------------------------------------------
# Unchecked, outside the range, disagreeing sources, one iteration, no spread
# ---------------------------------------------------------------------------


def test_a_run_with_nothing_to_check_shows_the_ratio_with_a_warning_naming_what_was_looked_for(
    tmp_path, in_process  # noqa: F811
):
    run, layout = _ingest(tmp_path)
    groups, top = _groups(layout)

    ratio = groups["hk_pp"]["sigma_ratio"]
    expected = _expected_ratios(run, "hk_pp")
    assert top["reinflation"]["verdict"] == "unchecked"
    assert ratio["state"] == "unchecked"
    assert abs(ratio["median"] - float(np.median(expected))) < 1e-12
    assert ratio["reason"].startswith("Reinflation could not be checked")
    for text in ("run record", "case.N.reinflate.pcs.csv", "ies_n_iter_reinflate"):
        assert text in ratio["reason"], (text, ratio["reason"])


def test_a_reinflation_before_the_first_ingested_iteration_is_listed_but_does_not_refuse(
    tmp_path, in_process  # noqa: F811
):
    _run, layout = _ingest(tmp_path, iterations=(4, 6), noptmax=6, rec={"reinflations": (4,)})
    groups, top = _groups(layout)

    assert groups["hk_pp"]["sigma_ratio"]["state"] == "shown"
    assert top["reinflation"]["verdict"] == "none_found"
    finding = top["reinflation"]["findings"][0]
    assert finding["iteration"] == 4
    assert finding["in_range"] is False
    assert any("outside" in note and "iteration 4" in note for note in top["reinflation"]["notes"])


def test_sources_that_place_the_reinflation_differently_refuse_and_name_both_iterations(
    tmp_path, in_process  # noqa: F811
):
    _run, layout = _ingest(
        tmp_path,
        iterations=(0, 4),
        noptmax=5,
        pestpp_options={"ies_n_iter_reinflate": "3,999"},
        rec={"reinflations": (3,)},
    )
    groups, _top = _groups(layout)

    ratio = groups["hk_pp"]["sigma_ratio"]
    assert ratio["state"] == "refused"
    assert "sources disagree" in ratio["reason"]
    assert "iteration 3" in ratio["reason"] and "iteration 4" in ratio["reason"]
    assert "case.rec" in ratio["reason"] and "ies_n_iter_reinflate" in ratio["reason"]


def test_one_ingested_iteration_refuses_the_ratio_because_there_is_no_after(tmp_path, in_process):  # noqa: F811
    _run, layout = _ingest(tmp_path, iterations=(0,), rec=True)
    groups, _top = _groups(layout)

    ratio = groups["hk_pp"]["sigma_ratio"]
    assert ratio["state"] == "refused"
    assert ratio["reason"] == "only iteration 0 was ingested, so there is no before and after"
    assert ratio["median"] is None


def test_a_group_where_no_parameter_had_spread_is_refused_with_that_reason(tmp_path, in_process):  # noqa: F811
    spec = next(g for g in DEFAULT_GROUPS if g.name == "rch_gr")
    constant = {(0, name): np.full(6, 17.0) for name in parameter_names(spec)}
    _run, layout = _ingest(tmp_path, rec=True, overrides=constant)
    groups, _top = _groups(layout)

    ratio = groups["rch_gr"]["sigma_ratio"]
    assert ratio["state"] == "refused"
    assert ratio["reason"] == "no parameter in this group had any spread at the first iteration"
    assert ratio["n_used"] == 0 and ratio["n_no_spread"] == 3
    assert groups["hk_pp"]["sigma_ratio"]["state"] == "shown"


def test_a_parameter_with_no_spread_is_counted_and_the_rest_still_give_a_ratio(tmp_path, in_process):  # noqa: F811
    run, layout = _ingest(tmp_path, rec=True, zero_sd=True)
    groups, _top = _groups(layout)

    ratio = groups["rch_gr"]["sigma_ratio"]
    assert ratio["state"] == "shown"
    assert (ratio["n_used"], ratio["n_no_spread"]) == (2, 1)
    assert abs(ratio["median"] - float(np.median(_expected_ratios(run, "rch_gr")))) < 1e-12


def test_a_log_group_takes_its_ratios_in_log10_space(tmp_path, in_process):  # noqa: F811
    spec = next(g for g in DEFAULT_GROUPS if g.name == "hk_pp")
    names = parameter_names(spec)
    first_names = [f"r{i}" for i in range(6)]
    last_names = [n for n in reversed(first_names) if n != "r2"]
    # Multiples of a quarter, so the float32 cache holds every value exactly.
    first = {n: np.array([2.0, 4.0, 8.0, 16.0, 32.0, 64.0]) * (i + 1) / 4.0 for i, n in enumerate(names)}
    last = {n: first[n] * (1.0 + 0.5 * i) for i, n in enumerate(names)}
    overrides = {}
    for name in names:
        overrides[(0, name)] = first[name]
        overrides[(1, name)] = np.array([last[name][first_names.index(r)] for r in last_names])
    _run, layout = _ingest(tmp_path, rec=True, overrides=overrides)
    groups, _top = _groups(layout)

    keep = [first_names.index(r) for r in first_names if r != "r2"]
    log_ratios = np.array(
        [np.std(np.log10(last[n][keep])) / np.std(np.log10(first[n][keep])) for n in names]
    )
    native_ratios = np.array([np.std(last[n][keep]) / np.std(first[n][keep]) for n in names])
    ratio = groups["hk_pp"]["sigma_ratio"]
    assert abs(ratio["median"] - float(np.median(log_ratios))) < 1e-12
    assert abs(ratio["p10"] - float(np.percentile(log_ratios, 10))) < 1e-12
    assert abs(ratio["p90"] - float(np.percentile(log_ratios, 90))) < 1e-12
    assert abs(ratio["median"] - float(np.median(native_ratios))) > 1e-3


def test_missing_numbers_are_null_in_the_file_and_never_nan(tmp_path, in_process):  # noqa: F811
    _run, layout = _ingest(tmp_path, iterations=(0,), rec=True)

    parsed = json.loads(layout.par_groups.read_text(), parse_constant=_no_constant)
    assert all(g["sigma_ratio"]["median"] is None for g in parsed["groups"])


def test_a_stray_nan_makes_the_write_fail_loudly(tmp_path, in_process, monkeypatch):  # noqa: F811
    run, layout = _ingest(tmp_path, rec=True)
    real = parview.group_sigma_ratio

    def with_nan(*args):
        return {**real(*args), "median": float("nan")}

    monkeypatch.setattr(parview, "group_sigma_ratio", with_nan)
    result = parview.write_par_groups(run.root, layout)

    assert isinstance(result, ReadFailure)
    assert "failed to write the group summary" in result.reason


def test_a_group_with_no_spread_anywhere_gives_no_numbers_and_says_why():
    result = group_sigma_ratio([0.0, 0.0], [1.0, 2.0], [True, True])

    assert result["median"] is None
    assert result["n_no_spread"] == 2
    assert result["reason"] == "no parameter in this group had any spread at the first iteration"


def test_group_sigma_ratio_is_numpys_median_and_linear_percentiles_over_parameters_with_spread():
    sd_first = np.array([0.5, 1.0, 0.0, 2.0, 4.0, 3.0])
    sd_last = np.array([0.25, 0.5, 9.0, 1.0, 4.0, 1.0])
    included = np.array([True, True, True, True, True, False])
    ratios = np.array([0.5, 0.5, 0.5, 1.0])

    result = group_sigma_ratio(sd_first, sd_last, included)

    assert result["n_used"] == 4 and result["n_no_spread"] == 1
    assert abs(result["median"] - float(np.median(ratios))) < 1e-12
    assert abs(result["p10"] - float(np.percentile(ratios, 10))) < 1e-12
    assert abs(result["p90"] - float(np.percentile(ratios, 90))) < 1e-12
