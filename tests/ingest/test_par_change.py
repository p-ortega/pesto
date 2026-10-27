"""par_change and par_groups' change figures: how far each parameter moved
between the first and the last iteration, over the realizations present in
both, in pestpp's numeric space, with every refusal counted and explained.

Each test ingests a generated run whose values are known to the test, then
compares what the cache holds with numpy on those values.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from pesto.cache.layout import CacheLayout
from pesto.ingest.failures import ReadFailure
from pesto.ingest.parview import (
    NEAR_ZERO_FACTOR,
    load_par_change,
    load_par_groups,
    parameter_change,
    write_par_change,
    write_par_groups,
)
from pesto.ingest.runner import ingest_run

from .par_fixtures import make_par_view_run, numeric_space
from .test_control_first import in_process  # noqa: F401  (a fixture, used by name)


def _ingest(tmp_path, **kwargs):
    run = make_par_view_run(tmp_path / "run", **kwargs)
    cache = tmp_path / "cache"
    manifest = ingest_run(run.root, cache_root=cache)
    return run, CacheLayout(root=cache), manifest


def _change(layout):
    loaded = load_par_change(layout)
    assert not isinstance(loaded, ReadFailure), loaded
    frame, meta = loaded
    return frame.set_index("parnme"), meta


def _groups(layout):
    loaded = load_par_groups(layout)
    assert not isinstance(loaded, ReadFailure), loaded
    return {g["group"]: g for g in loaded["groups"]}, loaded


def _common(run):
    return [n for n in run.real_names[0] if n in run.real_names[1]]


def _rename_groups(run, layout, mapping):
    """Rename groups in the cached control table, then build both tables again."""
    path = layout.control / "par.parquet"
    frame = pd.read_parquet(path)
    frame["pargp"] = frame["pargp"].astype(str).map(lambda g: mapping.get(g, g))
    frame.to_parquet(path, index=False)
    first, last = min(run.par_ens), max(run.par_ens)
    assert not isinstance(write_par_change(first, last, layout), ReadFailure)
    assert not isinstance(write_par_groups(run.root, layout), ReadFailure)


# ---------------------------------------------------------------------------
# The join and the numeric space
# ---------------------------------------------------------------------------


def test_realizations_join_by_name_when_the_last_file_is_reordered_and_one_is_dropped(
    tmp_path, in_process  # noqa: F811
):
    run, layout, _ = _ingest(tmp_path)
    change, meta = _change(layout)
    common = _common(run)

    assert meta["n_common"] == 5
    assert meta["only_first"] == {"count": 1, "names": run.dropped}
    assert meta["only_last"] == {"count": 0, "names": []}
    for name in run.groups["hk_pp"] + run.groups["rch_gr"]:
        assert change.loc[name, "mean_first"] == pytest.approx(
            numeric_space(run, 0, name, common).mean(), rel=1e-6
        )
        assert change.loc[name, "mean_last"] == pytest.approx(
            numeric_space(run, 1, name, common).mean(), rel=1e-6
        )
    # The first five rows, which a join by position would use, give another mean.
    probe = run.groups["hk_pp"][0]
    by_position = numeric_space(run, 0, probe, run.real_names[0][:5]).mean()
    assert by_position != pytest.approx(change.loc[probe, "mean_first"], rel=1e-6)


def test_a_log_parameter_is_measured_in_log10_a_none_parameter_natively_and_sd_has_ddof_zero(
    tmp_path, in_process  # noqa: F811
):
    run, layout, _ = _ingest(tmp_path)
    change, _meta = _change(layout)
    common = _common(run)
    log_name, none_name = run.groups["hk_pp"][0], run.groups["rch_gr"][0]

    log_values = np.log10(run.table(0).loc[common, log_name].to_numpy())
    none_values = run.table(0).loc[common, none_name].to_numpy()
    assert change.loc[log_name, "space"] == "log10"
    assert change.loc[none_name, "space"] == "native"
    assert change.loc[log_name, "mean_first"] == pytest.approx(log_values.mean(), rel=1e-6)
    assert change.loc[none_name, "mean_first"] == pytest.approx(none_values.mean(), rel=1e-6)
    assert change.loc[none_name, "sd_first"] == pytest.approx(none_values.std(ddof=0), rel=1e-6)
    assert change.loc[none_name, "sd_first"] != pytest.approx(none_values.std(ddof=1), rel=1e-6)


def test_the_group_figure_matches_pestpps_formula_when_no_realization_is_lost(
    tmp_path, in_process  # noqa: F811
):
    run, layout, _ = _ingest(tmp_path, drop_in_last=None)
    groups, _top = _groups(layout)
    names = run.real_names[0]

    for group in ("hk_pp", "rch_gr"):
        mean_pct, sd_pct = [], []
        for parameter in run.groups[group]:
            first = numeric_space(run, 0, parameter, names)
            last = numeric_space(run, 1, parameter, names)
            mean_pct.append(100.0 * abs(last.mean() - first.mean()) / abs(first.mean()))
            sd_pct.append(100.0 * abs(last.std() - first.std()) / first.std())
        figure = groups[group]["change"]["pesto"]
        assert figure["mean_change_pct"] == pytest.approx(np.mean(mean_pct), rel=1e-9)
        assert figure["sd_change_pct"] == pytest.approx(np.mean(sd_pct), rel=1e-9)
        assert figure["n_used"] == len(run.groups[group])


# ---------------------------------------------------------------------------
# parameter_change, pure
# ---------------------------------------------------------------------------


def test_parameter_change_with_a_zero_factor_refuses_only_an_exactly_zero_first_mean():
    mean_first = np.array([0.0, 0.004, 2.0])
    sd_first = np.array([1.0, 1.0, 1.0])
    mean_last = np.array([1.0, 1.0, 3.0])
    sd_last = np.array([2.0, 2.0, 2.0])

    strict = parameter_change(mean_first, sd_first, mean_last, sd_last, near_zero_factor=0.0)
    default = parameter_change(mean_first, sd_first, mean_last, sd_last)

    assert [r is not None for r in strict.mean_change_refused] == [True, False, False]
    assert [r is not None for r in default.mean_change_refused] == [True, True, False]
    assert strict.mean_change_pct[2] == pytest.approx(50.0)
    assert NEAR_ZERO_FACTOR == 0.01


def test_parameter_change_gives_the_shift_and_ratio_in_first_sd_units():
    result = parameter_change(
        np.array([10.0]), np.array([2.0]), np.array([13.0]), np.array([1.0])
    )

    assert result.mean_shift_sd[0] == pytest.approx(1.5)
    assert result.sd_ratio[0] == pytest.approx(0.5)
    assert result.sd_change_pct[0] == pytest.approx(50.0)
    assert result.mean_change_pct[0] == pytest.approx(30.0)


def test_parameter_change_leaves_sd_figures_out_when_the_first_sd_is_zero():
    result = parameter_change(
        np.array([5.0]), np.array([0.0]), np.array([6.0]), np.array([1.0])
    )

    assert np.isnan(result.sd_change_pct[0])
    assert np.isnan(result.sd_ratio[0])
    assert np.isnan(result.mean_shift_sd[0])
    assert result.sd_change_refused[0]
    assert result.mean_change_pct[0] == pytest.approx(20.0)


# ---------------------------------------------------------------------------
# Refusals and exclusions, each counted
# ---------------------------------------------------------------------------


def test_a_mean_near_zero_has_no_percent_change_but_keeps_its_shift_and_the_group_counts_it(
    tmp_path, in_process  # noqa: F811
):
    run, layout, _ = _ingest(tmp_path, near_zero=True)
    change, _meta = _change(layout)
    groups, _top = _groups(layout)
    target = run.groups["rch_gr"][0]

    assert pd.isna(change.loc[target, "mean_change_pct"])
    assert "0.01" in change.loc[target, "mean_change_refused"]
    assert not pd.isna(change.loc[target, "mean_shift_sd"])
    figure = groups["rch_gr"]["change"]["pesto"]
    assert figure["n_refused_near_zero"] == 1
    assert figure["n_used"] == len(run.groups["rch_gr"]) - 1


def test_a_parameter_with_no_spread_in_the_first_iteration_gets_no_sd_figures_and_a_reason(
    tmp_path, in_process  # noqa: F811
):
    run, layout, _ = _ingest(tmp_path, zero_sd=True)
    change, _meta = _change(layout)
    groups, _top = _groups(layout)
    target = run.groups["rch_gr"][1]

    assert change.loc[target, "sd_first"] == 0.0
    for column in ("sd_change_pct", "sd_ratio", "mean_shift_sd"):
        assert pd.isna(change.loc[target, column])
    assert "no spread" in change.loc[target, "sd_change_refused"]
    assert groups["rch_gr"]["change"]["pesto"]["n_no_spread"] == 1


def test_fixed_and_tied_parameters_are_left_out_and_each_group_counts_them(
    tmp_path, in_process  # noqa: F811
):
    run, layout, _ = _ingest(tmp_path)
    change, _meta = _change(layout)
    groups, _top = _groups(layout)

    fixed = run.groups["fixed_gr"]
    tied = [n for n in run.groups["mix"] if run.trans[n] == "tied"]
    assert len(tied) == 1
    for name in fixed:
        assert not change.loc[name, "included"]
        assert change.loc[name, "excluded_kind"] == "fixed"
        assert pd.isna(change.loc[name, "mean_change_pct"])
    assert change.loc[tied[0], "excluded_kind"] == "tied"
    assert groups["fixed_gr"]["excluded"]["fixed"] == 2
    assert groups["fixed_gr"]["n_included"] == 0
    assert groups["mix"]["excluded"]["tied"] == 1
    assert groups["mix"]["n_included"] == 2


def test_a_group_of_fixed_parameters_is_listed_and_says_it_has_nothing_to_adjust(
    tmp_path, in_process  # noqa: F811
):
    run, layout, _ = _ingest(tmp_path)
    groups, _top = _groups(layout)

    group = groups["fixed_gr"]
    assert group["n_par"] == len(run.groups["fixed_gr"])
    assert group["change"]["pesto"] is None
    assert "no adjustable parameters" in group["change"]["reason"]


def test_a_log_parameter_with_a_non_positive_value_is_left_out_and_named(
    tmp_path, in_process  # noqa: F811
):
    run, layout, _ = _ingest(tmp_path, nonpositive_log=True)
    change, meta = _change(layout)
    groups, _top = _groups(layout)
    target = next(n for n in run.par_names if run.trans[n] == "log")
    other = next(n for n in run.par_names if run.trans[n] == "log" and n != target)

    assert not change.loc[target, "included"]
    assert change.loc[target, "excluded_kind"] == "nonpositive_log"
    assert "iteration 0" in change.loc[target, "excluded_reason"]
    assert "1 non-positive" in change.loc[target, "excluded_reason"]
    assert any(target in note for note in meta["notes"])
    group = groups[change.loc[target, "pargp"]]
    assert group["excluded"]["nonpositive_log"] == 1
    # Not counted as "not near a bound": missing, where a healthy parameter holds a count.
    assert pd.isna(change.loc[target, "near_lower_first"])
    assert not pd.isna(change.loc[other, "near_lower_first"])


def test_a_non_positive_value_in_the_last_iteration_names_that_iteration(
    tmp_path, in_process  # noqa: F811
):
    probe = make_par_view_run(tmp_path / "probe")
    target = next(n for n in probe.par_names if probe.trans[n] == "log")
    column = np.array([5.0, 5.0, 5.0, 0.0, 5.0])
    run, layout, _ = _ingest(tmp_path, overrides={(1, target): column})
    change, _meta = _change(layout)

    assert not change.loc[target, "included"]
    assert "iteration 1" in change.loc[target, "excluded_reason"]
    assert run.real_names[1]


def test_two_iterations_that_share_no_realization_name_refuse_the_change(
    tmp_path, in_process  # noqa: F811
):
    _run, _layout, manifest = _ingest(tmp_path, shared_names=False)

    assert manifest.artifacts["par_change"].state == "failed"
    assert (
        "no realization name is shared between iteration 0 and iteration 1"
        in manifest.artifacts["par_change"].reason
    )


def test_names_that_differ_only_by_case_do_not_join_and_both_count_as_left_out(
    tmp_path, in_process  # noqa: F811
):
    # A csv ensemble keeps the names as written; pyemu's binary reader would fold them.
    run, layout, _ = _ingest(tmp_path, rename_in_last={"r1": "R1"}, ensemble_format="csv")
    change, meta = _change(layout)

    assert meta["n_common"] == 4
    assert meta["only_first"]["count"] == 2
    assert set(meta["only_first"]["names"]) == {"r1", run.dropped[0]}
    assert meta["only_last"] == {"count": 1, "names": ["R1"]}
    probe = run.groups["hk_pp"][0]
    names = [n for n in run.real_names[0] if n not in ("r1", run.dropped[0])]
    assert change.loc[probe, "mean_first"] == pytest.approx(
        numeric_space(run, 0, probe, names).mean(), rel=1e-6
    )


def test_the_group_summary_says_how_many_realizations_were_left_out_with_up_to_three_names(
    tmp_path, in_process  # noqa: F811
):
    run, layout, _ = _ingest(tmp_path)
    _groups_by_name, top = _groups(layout)

    assert top["n_common"] == 5
    assert top["left_out"]["count"] == 1
    assert top["left_out"]["only_first"] == run.dropped
    assert top["left_out"]["only_last"] == []
    assert top["left_out"]["reason"]
    assert top["first_iteration"] == 0
    assert top["last_iteration"] == 1
    assert top["single_iteration"] is False


# ---------------------------------------------------------------------------
# Near-bound counts
# ---------------------------------------------------------------------------


def test_near_bound_counts_use_each_iterations_own_realizations_and_split_lower_from_upper(
    tmp_path, in_process  # noqa: F811
):
    probe = make_par_view_run(tmp_path / "probe")
    a, b = probe.groups["hk_pp"][0], probe.groups["hk_pp"][1]
    # r2 holds the value near the upper bound in the first file and is absent from the last.
    first_a = np.array([5.0, 5.0, 999.0, 5.0, 5.0, 5.0])
    # In the last file r0 is the fifth row.
    last_b = np.array([5.0, 5.0, 5.0, 5.0, 0.0101])
    run, layout, _ = _ingest(tmp_path, overrides={(0, a): first_a, (1, b): last_b})
    change, meta = _change(layout)

    assert change.loc[a, "near_upper_first"] == 1
    assert change.loc[a, "near_lower_first"] == 0
    assert change.loc[a, "near_upper_last"] == 0
    assert change.loc[b, "near_lower_last"] == 1
    assert change.loc[b, "near_upper_last"] == 0
    assert "parameter-by-realization pairs" in meta["near_bound_note"]
    assert run.dropped == ["r2"]


def test_fixed_and_tied_parameters_have_no_near_bound_count(tmp_path, in_process):  # noqa: F811
    run, layout, _ = _ingest(tmp_path)
    change, _meta = _change(layout)

    for name in run.par_names:
        if run.trans[name] in ("fixed", "tied"):
            assert pd.isna(change.loc[name, "near_lower_first"]), name
            assert pd.isna(change.loc[name, "near_upper_last"]), name


# ---------------------------------------------------------------------------
# One iteration, ordering
# ---------------------------------------------------------------------------


def test_a_single_ingested_iteration_still_gets_its_tables_and_says_there_is_no_change(
    tmp_path, in_process  # noqa: F811
):
    run, layout, manifest = _ingest(tmp_path, iterations=(0,), drop_in_last=None)
    change, meta = _change(layout)
    groups, top = _groups(layout)

    assert manifest.artifacts["par_change"].state == "ok"
    assert manifest.artifacts["par_groups"].state == "ok"
    reason = "only iteration 0 was ingested, so there is no before and after"
    assert meta["single_iteration"] is True
    assert meta["reason"] == reason
    probe = run.groups["hk_pp"][0]
    assert change.loc[probe, "mean_first"] == pytest.approx(
        numeric_space(run, 0, probe, run.real_names[0]).mean(), rel=1e-6
    )
    assert pd.isna(change.loc[probe, "mean_last"])
    assert top["single_iteration"] is True
    assert groups["hk_pp"]["change"]["pesto"] is None
    assert groups["hk_pp"]["change"]["reason"] == reason
    assert groups["hk_pp"]["n_par"] == len(run.groups["hk_pp"])


def test_groups_come_in_first_appearance_order_and_parameters_keep_control_order(
    tmp_path, in_process  # noqa: F811
):
    run, layout, _ = _ingest(tmp_path)
    change = load_par_change(layout)[0]
    groups, _top = _groups(layout)

    assert list(groups) == list(dict.fromkeys(change["pargp"]))
    for name, members in run.groups.items():
        assert list(change.loc[change["pargp"] == name, "parnme"]) == members


# ---------------------------------------------------------------------------
# pestpp's own figure beside pesto's
# ---------------------------------------------------------------------------

PCS = [
    {
        "group": "hk_pp",
        "mean_change": 12.5,
        "std_change": 3.25,
        "num_at_near_lbound": 2,
        "num_at_near_ubound": 1,
    }
]


def test_pestpps_figure_is_labelled_with_the_file_it_came_from_and_pestos_with_its_realizations(
    tmp_path, in_process  # noqa: F811
):
    run, layout, _ = _ingest(tmp_path, pcs_rows=PCS)
    groups, _top = _groups(layout)

    change = groups["hk_pp"]["change"]
    assert change["pestpp"]["mean_change"] == 12.5
    assert change["pestpp"]["std_change"] == 3.25
    assert change["pestpp"]["num_at_near_lbound"] == 2
    assert change["pestpp"]["num_at_near_ubound"] == 1
    assert change["pestpp"]["source"] == f"pestpp, {run.pcs_path.name}"
    assert change["pesto"]["label"] == "pesto, over the 5 realizations present in both iterations"


def test_a_group_pestpp_lower_cased_joins_on_the_lower_case_name_with_a_note(
    tmp_path, in_process  # noqa: F811
):
    run, layout, _ = _ingest(tmp_path, pcs_rows=PCS)
    _rename_groups(run, layout, {"hk_pp": "HK_PP"})
    groups, _top = _groups(layout)

    pestpp = groups["HK_PP"]["change"]["pestpp"]
    assert pestpp["mean_change"] == 12.5
    assert "lower case" in pestpp["note"]
    assert groups["rch_gr"]["change"]["pestpp"]["mean_change"] is None


def test_two_groups_that_differ_only_by_case_are_two_rows_and_only_the_changed_one_has_the_note(
    tmp_path, in_process  # noqa: F811
):
    rows = [{**PCS[0], "group": "grp_a"}]
    run, layout, _ = _ingest(tmp_path, pcs_rows=rows)
    _rename_groups(run, layout, {"hk_pp": "GRP_A", "rch_gr": "grp_a"})
    groups, _top = _groups(layout)

    assert "GRP_A" in groups and "grp_a" in groups
    assert groups["GRP_A"]["n_par"] == len(run.groups["hk_pp"])
    assert groups["grp_a"]["n_par"] == len(run.groups["rch_gr"])
    assert "lower case" in groups["GRP_A"]["change"]["pestpp"]["note"]
    assert "lower case" not in (groups["grp_a"]["change"]["pestpp"]["note"] or "")


def test_a_run_without_a_pcs_file_says_so_in_each_groups_pestpp_entry(
    tmp_path, in_process  # noqa: F811
):
    _run, layout, _ = _ingest(tmp_path)
    groups, _top = _groups(layout)

    for group in groups.values():
        pestpp = group["change"]["pestpp"]
        assert pestpp["mean_change"] is None
        assert "not found" in pestpp["note"]


def test_a_group_the_pcs_file_does_not_name_says_it_was_not_joined(
    tmp_path, in_process  # noqa: F811
):
    _run, layout, _ = _ingest(tmp_path, pcs_rows=PCS)
    groups, _top = _groups(layout)

    pestpp = groups["mix"]["change"]["pestpp"]
    assert pestpp["mean_change"] is None
    assert "not joined" in pestpp["note"]


def test_a_pcs_file_that_is_not_pestpps_shape_is_a_note_not_a_failure(
    tmp_path, in_process  # noqa: F811
):
    run, layout, manifest = _ingest(tmp_path, pcs_rows=PCS)
    run.pcs_path.write_text("real_name,value\nbase,0.0\n")
    assert not isinstance(write_par_groups(run.root, layout), ReadFailure)
    groups, _top = _groups(layout)

    assert manifest.artifacts["par_groups"].state == "ok"
    assert "group" in groups["hk_pp"]["change"]["pestpp"]["note"]
