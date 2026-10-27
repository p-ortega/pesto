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
from pesto.ingest.failures import ReadFailure
from pesto.ingest.parview import load_par_groups
from pesto.ingest.runner import Progress, ingest_run, plan_artifacts
from pesto.ingest.discover import discover

from .par_fixtures import make_par_view_run, numeric_space
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

    touched = {r.artifact for r in rows if r.state != "skipped"}
    assert touched == {"par_groups"}
    assert manifest.artifacts["par_change"].state == "ok"
