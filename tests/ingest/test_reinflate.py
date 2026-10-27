"""Whether the ensemble was reinflated between the first and last ingested
iteration, and which sources say so.

Runs are built in memory and the run record and control file are written
as text, so no test depends on a benchmark folder.
"""

from __future__ import annotations

from pathlib import Path

from pesto.ingest.discover import RunLayout
from pesto.ingest.failures import ReadFailure
from pesto.ingest.recfile import read_rec
from pesto.ingest.reinflate import assess_reinflation, schedule_iterations
from pesto.ingest.runopts import scan_options

from .rec_fixtures import write_rec


def _layout(tmp_path, *, noptmax=5, pcs_iterations=(), reinflate_files=()) -> RunLayout:
    pcs = {(i, ""): Path(f"case.{i}.pcs.csv") for i in pcs_iterations}
    pcs.update({(i, "reinflate"): Path(f"case.{i}.reinflate.pcs.csv") for i in reinflate_files})
    return RunLayout(
        run_dir=tmp_path,
        case="case",
        pst_path=tmp_path / "case.pst",
        noptmax=noptmax,
        iterations=(),
        par_ens={},
        obs_ens={},
        rejected_par_ens={},
        rejected_obs_ens={},
        starting_par_ens=None,
        starting_obs_ens=None,
        restart_par_ens=None,
        restart_obs_ens=None,
        phi={},
        pdc={},
        pcs=pcs,
        grid=None,
        noise=None,
        mult2model=None,
        factor_files=(),
        notes=(),
        ambiguities=(),
    )


def _rec(tmp_path, **kwargs):
    return read_rec(write_rec(tmp_path / "case.rec", **kwargs))


def _options(tmp_path, setting: str | None):
    body = "" if setting is None else f"ies_n_iter_reinflate {setting}\n"
    path = tmp_path / "case.pst"
    path.write_text("pcf version=2\n* control data keyword\nnoptmax 5\n" + body)
    return scan_options(path)


def _sources(verdict, iteration):
    for found, evidence in verdict.findings:
        if found == iteration:
            return [e.source for e in evidence]
    return None


def test_the_schedule_places_the_kth_reinflation_at_the_running_sum_plus_k():
    assert schedule_iterations("3,999", noptmax=5) == (4,)
    assert schedule_iterations("2,2,999", noptmax=6) == (3, 6)
    assert schedule_iterations("3,999,", noptmax=5) == (4,)


def test_a_reinflation_is_placed_only_while_a_solve_is_left():
    assert schedule_iterations("5,999", noptmax=5) == ()
    assert schedule_iterations("5,999", noptmax=6) == (6,)


def test_a_zero_entry_is_off_and_a_negative_entry_counts_by_its_size():
    assert schedule_iterations("0", noptmax=5) == ()
    assert schedule_iterations("0,3", noptmax=5) == ()
    assert schedule_iterations("-3,999", noptmax=5) == (4,)


def test_the_schedule_places_nothing_when_noptmax_is_not_known():
    assert schedule_iterations("3,999", noptmax=None) == ()


def test_an_unreadable_schedule_places_nothing():
    assert schedule_iterations("soon", noptmax=5) == ()


def test_all_three_sources_naming_one_iteration_merge_into_one_finding_in_order(tmp_path):
    run = _layout(tmp_path, reinflate_files=(4,))
    verdict = assess_reinflation(
        run, 0, 6, _rec(tmp_path, reinflations=(4,)), _options(tmp_path, "3,999")
    )

    assert verdict.verdict == "found"
    assert len(verdict.findings) == 1
    assert _sources(verdict, 4) == ["run record", "files present", "control file"]
    assert verdict.notes == ()


def test_the_setting_is_labelled_as_read_from_the_setting(tmp_path):
    verdict = assess_reinflation(_layout(tmp_path), 0, 6, None, _options(tmp_path, "3,999"))

    (finding,) = verdict.findings
    assert "from the setting" in finding[1][0].text


def test_sources_naming_different_iterations_are_each_listed_with_a_disagreement_note(tmp_path):
    run = _layout(tmp_path, noptmax=6)
    verdict = assess_reinflation(
        run, 0, 6, _rec(tmp_path, reinflations=(4,)), _options(tmp_path, "5,999")
    )

    assert verdict.verdict == "found"
    assert [i for i, _ in verdict.findings] == [4, 6]
    assert _sources(verdict, 4) == ["run record"]
    assert _sources(verdict, 6) == ["control file"]
    assert len(verdict.notes) == 1 and "disagree" in verdict.notes[0]


def test_a_reinflation_at_the_last_iteration_is_inside(tmp_path):
    verdict = assess_reinflation(
        _layout(tmp_path), 0, 4, _rec(tmp_path, reinflations=(4,)), None
    )

    assert verdict.verdict == "found"
    assert verdict.findings[0][1][0].in_range is True


def test_a_reinflation_at_the_first_iteration_is_outside_and_still_reported(tmp_path):
    verdict = assess_reinflation(
        _layout(tmp_path), 4, 6, _rec(tmp_path, reinflations=(4,)), None
    )

    assert verdict.verdict == "none_found"
    assert len(verdict.findings) == 1
    evidence = verdict.findings[0][1][0]
    assert evidence.iteration == 4
    assert evidence.in_range is False


def test_a_reinflation_after_the_last_iteration_is_outside(tmp_path):
    verdict = assess_reinflation(
        _layout(tmp_path), 0, 3, _rec(tmp_path, reinflations=(4,)), None
    )

    assert verdict.verdict == "none_found"
    assert verdict.findings[0][1][0].in_range is False


def test_no_source_at_all_is_unchecked_and_names_everything_looked_for(tmp_path):
    verdict = assess_reinflation(_layout(tmp_path), 0, 6, None, None)

    assert verdict.verdict == "unchecked"
    assert verdict.findings == ()
    joined = " ".join(verdict.checked)
    assert "run record" in joined
    assert "case.N.reinflate.pcs.csv" in joined
    assert "ies_n_iter_reinflate" in joined


def test_sources_that_look_and_find_nothing_give_none_found_and_say_what_each_said(tmp_path):
    run = _layout(tmp_path, pcs_iterations=(1, 2))
    verdict = assess_reinflation(run, 0, 1, _rec(tmp_path), _options(tmp_path, "5,999"))

    assert verdict.verdict == "none_found"
    assert verdict.findings == ()
    assert len(verdict.checked) == 3
    assert "run record" in verdict.checked[0]
    assert "pcs" in verdict.checked[1]
    assert "ies_n_iter_reinflate" in verdict.checked[2]


def test_a_reinflation_with_no_known_iteration_is_kept_and_not_placed_in_range(tmp_path):
    rec = _rec(tmp_path, reinflation_without_report=True)

    verdict = assess_reinflation(_layout(tmp_path), 0, 6, rec, None)

    assert len(verdict.findings) == 1
    iteration, evidence = verdict.findings[0]
    assert iteration is None
    assert evidence[0].in_range is None
    assert verdict.verdict == "unchecked"
    assert any("iteration is not known" in line for line in verdict.checked + verdict.notes)


def test_a_failed_run_record_becomes_a_checked_line_naming_its_reason(tmp_path):
    failure = ReadFailure(name="rec", path="x", reason="could not open the run record case.rec")

    verdict = assess_reinflation(_layout(tmp_path, reinflate_files=(4,)), 0, 6, failure, None)

    assert verdict.verdict == "found"
    assert any("could not open the run record case.rec" in line for line in verdict.checked)


def test_a_failed_control_file_becomes_a_checked_line_naming_its_reason(tmp_path):
    failure = ReadFailure(name="control file", path="x", reason="not valid UTF-8")

    verdict = assess_reinflation(_layout(tmp_path), 0, 6, None, failure)

    assert verdict.verdict == "unchecked"
    assert any("not valid UTF-8" in line for line in verdict.checked)


def test_a_setting_with_an_unknown_noptmax_is_not_read_and_says_so(tmp_path):
    run = _layout(tmp_path, noptmax=None)

    verdict = assess_reinflation(run, 0, 6, None, _options(tmp_path, "3,999"))

    assert verdict.verdict == "unchecked"
    assert any("noptmax" in line and "not known" in line for line in verdict.checked)


def test_evidence_names_files_by_base_name_only(tmp_path):
    run = _layout(tmp_path, reinflate_files=(4,))
    run = RunLayout(**{**run.__dict__, "pcs": {(4, "reinflate"): tmp_path / "deep" / "case.4.reinflate.pcs.csv"}})

    verdict = assess_reinflation(run, 0, 6, None, None)

    text = verdict.findings[0][1][0].text
    assert "case.4.reinflate.pcs.csv" in text
    assert str(tmp_path) not in text
