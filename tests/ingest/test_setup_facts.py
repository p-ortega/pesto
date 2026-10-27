"""The setup facts in config.json: every fact keeps each source's reading.

Runs are built in a temp directory and ingested in process, and the run record
and control-file options are plain text, so no test depends on a benchmark folder.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from fastapi.testclient import TestClient

from pesto.api.app import create_app
from pesto.cache.layout import CacheLayout
from pesto.cache.manifest import Manifest
from pesto.cache.runconfig import (
    FACTS_VERSION,
    build_config,
    describe_noise,
    FACT_ORDER,
    SOURCE_ORDER,
    Reading,
    config_outdated,
    load_config,
    make_fact,
    write_config,
)
from pesto.ingest.control import read_control
from pesto.ingest.discover import discover
from pesto.ingest.failures import ReadFailure
from pesto.ingest.recfile import read_rec
from pesto.ingest.runopts import scan_options
from pesto.ingest.runner import ingest_run, is_planned_stale, plan_artifacts

from .fixtures import make_run, write_control_file
from .obs_fixtures import make_obs_run
from .rec_fixtures import write_rec

BASE_URL = "http://127.0.0.1"
_OPTION_ANCHOR = "eigwrite                                1\n"


def _add_control_options(pst_path: Path, *lines: str) -> None:
    text = pst_path.read_text()
    assert _OPTION_ANCHOR in text
    pst_path.write_text(text.replace(_OPTION_ANCHOR, _OPTION_ANCHOR + "".join(f"{x}\n" for x in lines)))


def _setup(tmp_path, *, rec=True, options=(), iterations=(0, 1), **rec_kwargs):
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    made = make_run(run_dir, iterations=iterations)
    if options:
        _add_control_options(made.pst_path, *options)
    if rec:
        write_rec(run_dir / "case.rec", **rec_kwargs)
    return run_dir, made


def _ingest(run_dir, cache_root):
    manifest = ingest_run(run_dir, cache_root=cache_root)
    assert manifest.artifacts["config"].state == "ok", manifest.artifacts["config"].reason
    return manifest


def _facts(cache_root) -> dict:
    payload = json.loads((Path(cache_root) / "config.json").read_text())
    return {fact["key"]: fact for fact in payload["facts"]}


def _client(cache_root) -> TestClient:
    app, token = create_app()
    app.state.cache_root = str(cache_root)
    client = TestClient(app, base_url=BASE_URL)
    client.headers["x-pesto-token"] = token
    return client


# ---------------------------------------------------------------------------
# The fact model
# ---------------------------------------------------------------------------


def _reading(source, value, shown="x"):
    return Reading(source=source, value=value, shown=shown, evidence="e", extra=None)


def test_readings_are_sorted_run_record_control_file_files_present_cache():
    fact = make_fact(
        "k",
        "K",
        [_reading("cache", 1), _reading("control file", 1), _reading("run record", 1), _reading("files present", None)],
        looked_for=(),
    )

    assert [r.source for r in fact.readings] == list(SOURCE_ORDER)
    assert SOURCE_ORDER == ("run record", "control file", "files present", "cache")


def test_the_facts_come_in_one_fixed_order():
    assert FACT_ORDER == (
        "pestpp_version",
        "noptmax",
        "ensemble_size",
        "noise",
        "noise_band",
        "regularization",
        "localization",
        "reinflation",
        "base",
    )


def test_numbers_are_compared_as_numbers_so_5_and_5_point_0_agree():
    fact = make_fact("k", "K", [_reading("run record", 5), _reading("control file", 5.0)], looked_for=())

    assert fact.agree is True


def test_a_difference_in_the_values_is_a_disagreement_and_keeps_every_reading():
    fact = make_fact("k", "K", [_reading("run record", 0.75), _reading("control file", 0.5)], looked_for=())

    assert fact.agree is False
    assert len(fact.readings) == 2


def test_fewer_than_two_comparable_readings_leaves_agree_unknown():
    one = make_fact("k", "K", [_reading("run record", 1)], looked_for=())
    with_a_supporting_reading = make_fact(
        "k", "K", [_reading("run record", 1), _reading("files present", None)], looked_for=()
    )

    assert one.agree is None
    assert with_a_supporting_reading.agree is None


def test_two_readings_from_one_source_are_never_shown_as_agreement():
    fact = make_fact("k", "K", [_reading("run record", 0), _reading("run record", 0)], looked_for=())

    assert fact.agree is None


def test_a_fact_with_no_reading_says_not_found_and_keeps_what_was_looked_for():
    fact = make_fact("k", "K", [], looked_for=("a thing in a place",))

    assert fact.readings == ()
    assert fact.agree is None
    assert fact.note == "not found"
    assert fact.looked_for == ("a thing in a place",)


# ---------------------------------------------------------------------------
# config.json carries the facts
# ---------------------------------------------------------------------------


def test_config_carries_the_version_and_the_facts_with_every_source_reading(tmp_path):
    run_dir, _ = _setup(tmp_path, options=("ies_reg_fac 0.0",))
    cache_root = tmp_path / "cache"
    _ingest(run_dir, cache_root)

    payload = json.loads((cache_root / "config.json").read_text())
    facts = _facts(cache_root)

    assert payload["facts_version"] == FACTS_VERSION == 1
    assert [f["key"] for f in payload["facts"]] == [k for k in FACT_ORDER if k in facts]
    version = facts["pestpp_version"]
    assert [(r["source"], r["value"]) for r in version["readings"]] == [("run record", "5.2.23")]
    assert version["agree"] is None
    regularization = facts["regularization"]
    assert [r["source"] for r in regularization["readings"]] == [
        "run record",
        "run record",
        "control file",
    ]
    assert [r["value"] for r in regularization["readings"]] == [0.0, 0.0, 0.0]
    assert regularization["agree"] is True
    assert {r["shown"] for r in regularization["readings"]} == {"off (reg_factor 0)"}
    for fact in payload["facts"]:
        assert set(fact) == {"key", "label", "readings", "agree", "looked_for", "note"}
        for reading in fact["readings"]:
            assert set(reading) == {"source", "value", "shown", "evidence", "extra"}
            assert reading["source"] in SOURCE_ORDER


def test_a_control_file_that_disagrees_with_the_record_keeps_every_reading(tmp_path):
    run_dir, _ = _setup(tmp_path, options=("ies_reg_factor 0.5",))
    cache_root = tmp_path / "cache"
    _ingest(run_dir, cache_root)

    regularization = _facts(cache_root)["regularization"]

    assert regularization["agree"] is False
    assert [r["value"] for r in regularization["readings"]] == [0.0, 0.0, 0.5]
    assert regularization["readings"][2]["shown"] == "on (reg_factor 0.5)"


def test_a_negative_reg_factor_is_on_with_the_full_solution_and_only_zero_is_off(tmp_path):
    run_dir, _ = _setup(tmp_path, rec=False, options=("ies_reg_factor -1",))
    cache_root = tmp_path / "cache"
    _ingest(run_dir, cache_root)

    shown = [r["shown"] for r in _facts(cache_root)["regularization"]["readings"]]

    assert shown == ["on, full solution (reg_factor -1)"]


def test_no_run_record_says_not_found_and_names_the_line_it_looked_for(tmp_path):
    run_dir, _ = _setup(tmp_path, rec=False)
    cache_root = tmp_path / "cache"
    _ingest(run_dir, cache_root)

    version = _facts(cache_root)["pestpp_version"]

    assert version["readings"] == []
    assert version["note"] == "not found"
    assert "a 'version:' line in case.rec" in version["looked_for"]


def test_the_config_sources_end_with_the_run_record_when_there_is_one(tmp_path):
    run_dir, _ = _setup(tmp_path)
    run = discover(run_dir)

    planned = {a.name: a for a in plan_artifacts(run, CacheLayout(root=tmp_path / "cache"))}

    assert planned["config"].sources[-1] == str(run.rec)
    assert Path(planned["config"].sources[-1]).name == "case.rec"


def test_the_config_sources_list_the_first_and_last_parameter_ensemble(tmp_path):
    run_dir, _ = _setup(tmp_path, rec=False)
    run = discover(run_dir)

    planned = {a.name: a for a in plan_artifacts(run, CacheLayout(root=tmp_path / "cache"))}

    assert str(run.par_ens[0]) in planned["config"].sources
    assert str(run.par_ens[1]) in planned["config"].sources


def test_a_rewritten_last_ensemble_makes_the_setup_facts_stale(tmp_path):
    run_dir, _ = _setup(tmp_path, rec=False)
    cache_root = tmp_path / "cache"
    _ingest(run_dir, cache_root)
    layout = CacheLayout(root=cache_root)
    manifest = Manifest.load(layout)
    manifest.run_dir = str(run_dir)
    planned = {a.name: a for a in plan_artifacts(discover(run_dir), layout)}
    assert is_planned_stale(manifest, layout, planned["config"]) is False

    with (run_dir / "case.1.par.jcb").open("ab") as handle:
        handle.write(b"\0")

    assert is_planned_stale(manifest, layout, planned["config"]) is True


def test_a_new_last_iteration_makes_the_setup_facts_stale(tmp_path):
    run_dir, _ = _setup(tmp_path, rec=False)
    cache_root = tmp_path / "cache"
    _ingest(run_dir, cache_root)
    layout = CacheLayout(root=cache_root)
    manifest = Manifest.load(layout)
    manifest.run_dir = str(run_dir)
    (run_dir / "case.2.par.jcb").write_bytes((run_dir / "case.1.par.jcb").read_bytes())
    planned = {a.name: a for a in plan_artifacts(discover(run_dir), layout)}

    assert is_planned_stale(manifest, layout, planned["config"]) is True


def test_a_replaced_obs_noise_file_makes_the_setup_facts_stale(tmp_path):
    run_dir = tmp_path / "band-run"
    make_obs_run(run_dir, with_noise=True)
    cache_root = tmp_path / "band-cache"
    ingest_run(run_dir, cache_root=cache_root)
    layout = CacheLayout(root=cache_root)
    manifest = Manifest.load(layout)
    manifest.run_dir = str(run_dir)
    noise = discover(run_dir).noise
    assert noise is not None
    planned = {a.name: a for a in plan_artifacts(discover(run_dir), layout)}
    assert str(noise) in planned["config"].sources
    assert is_planned_stale(manifest, layout, planned["config"]) is False

    with noise.open("ab") as handle:
        handle.write(b"\0")

    assert is_planned_stale(manifest, layout, planned["config"]) is True


def test_the_config_sources_have_no_run_record_when_there_is_none(tmp_path):
    run_dir, _ = _setup(tmp_path, rec=False)
    run = discover(run_dir)

    planned = {a.name: a for a in plan_artifacts(run, CacheLayout(root=tmp_path / "cache"))}

    assert not any(s.endswith(".rec") for s in planned["config"].sources)


# ---------------------------------------------------------------------------
# An old config.json is rewritten once, and only config
# ---------------------------------------------------------------------------


def _age_config(cache_root: Path) -> None:
    """Rewrite config.json as today's writer wrote it, before facts existed."""
    path = Path(cache_root) / "config.json"
    payload = json.loads(path.read_text())
    for key in ("facts_version", "facts", "par_iterations"):
        payload.pop(key, None)
    path.write_text(json.dumps(payload, indent=2))
    # The manifest records the size it wrote, so record the new size too.
    layout = CacheLayout(root=Path(cache_root))
    manifest = Manifest.load(layout)
    artifact = manifest.artifacts["config"]
    files = tuple(
        type(f)(path=f.path, bytes=path.stat().st_size) if f.path == "config.json" else f
        for f in artifact.files
    )
    manifest.mark_ok("config", list(artifact.sources), files=files, seconds=artifact.seconds, notes=artifact.notes)
    manifest.save(layout)


def test_an_old_config_with_every_source_unchanged_is_stale_and_rewritten_alone(tmp_path):
    run_dir, _ = _setup(tmp_path, rec=False)
    cache_root = tmp_path / "cache"
    _ingest(run_dir, cache_root)
    _age_config(cache_root)
    layout = CacheLayout(root=cache_root)
    manifest = Manifest.load(layout)
    manifest.run_dir = str(run_dir)
    planned = {a.name: a for a in plan_artifacts(discover(run_dir), layout)}

    assert config_outdated(layout) is True
    assert manifest.is_stale("config", layout, planned["config"].sources) is False
    assert is_planned_stale(manifest, layout, planned["config"]) is True
    assert is_planned_stale(manifest, layout, planned["control"]) is False

    states: dict[str, str] = {}
    ingest_run(run_dir, cache_root=cache_root, on_progress=lambda p: states.__setitem__(p.artifact, p.state))

    assert states.pop("config") == "ok"
    assert set(states.values()) == {"skipped"}
    assert json.loads((cache_root / "config.json").read_text())["facts_version"] == FACTS_VERSION
    assert config_outdated(layout) is False


def test_a_current_config_is_not_outdated_and_a_missing_one_is(tmp_path):
    run_dir, _ = _setup(tmp_path, rec=False)
    cache_root = tmp_path / "cache"
    layout = CacheLayout(root=cache_root)
    layout.ensure()

    assert config_outdated(layout) is True

    _ingest(run_dir, cache_root)

    assert config_outdated(layout) is False


# ---------------------------------------------------------------------------
# GET /api/run/config
# ---------------------------------------------------------------------------


def test_the_route_serves_the_facts_and_their_version(tmp_path):
    run_dir, _ = _setup(tmp_path, options=("ies_reg_fac 0.0",))
    cache_root = tmp_path / "cache"
    _ingest(run_dir, cache_root)

    body = _client(cache_root).get("/api/run/config").json()

    assert body["facts_version"] == 1
    keys = [f["key"] for f in body["facts"]]
    assert keys[0] == "pestpp_version"
    assert keys == sorted(keys, key=FACT_ORDER.index)
    assert body["par_iterations"] == [0, 1]
    assert "facts_note" not in body
    assert body["n_par"] == 6


def test_an_iteration_with_no_ensemble_is_not_in_the_setup_facts_range(tmp_path):
    run_dir, _ = _setup(tmp_path, rec=False)
    cache_root = tmp_path / "cache"

    manifest = ingest_run(run_dir, cache_root=cache_root, iterations=[0, 1, 7])

    assert manifest.artifacts["config"].state == "ok"
    assert json.loads((cache_root / "config.json").read_text())["par_iterations"] == [0, 1]


def test_an_old_config_is_served_with_its_old_fields_and_a_note_never_as_not_found(tmp_path):
    run_dir, _ = _setup(tmp_path, rec=False)
    cache_root = tmp_path / "cache"
    _ingest(run_dir, cache_root)
    _age_config(cache_root)

    response = _client(cache_root).get("/api/run/config")

    assert response.status_code == 200
    body = response.json()
    assert body["facts"] == []
    assert body["facts_version"] is None
    assert body["facts_note"] == "written before the setup facts existed; run the ingest again"
    assert body["n_par"] == 6
    assert body["n_real"] == 4


# ---------------------------------------------------------------------------
# An interrupted rewrite costs no fact its sources or its disagreement
# ---------------------------------------------------------------------------


def test_an_interrupted_rewrite_leaves_the_old_config_and_it_is_still_served(tmp_path, monkeypatch):
    run_dir, _ = _setup(tmp_path, options=("ies_reg_factor 0.5",))
    cache_root = tmp_path / "cache"
    _ingest(run_dir, cache_root)
    layout = CacheLayout(root=cache_root)
    before = layout.config.read_bytes()
    config = load_config(layout)

    def refuse(src, dst):
        raise OSError("disk went away")

    monkeypatch.setattr(os, "replace", refuse)
    result = write_config(config, layout)
    monkeypatch.undo()

    assert isinstance(result, ReadFailure)
    assert "config.json" in result.reason
    assert layout.config.read_bytes() == before
    assert not list(cache_root.glob(".ingest-*.tmp"))
    body = _client(cache_root).get("/api/run/config").json()
    regularization = next(f for f in body["facts"] if f["key"] == "regularization")
    assert regularization["agree"] is False
    assert [r["source"] for r in regularization["readings"]] == ["run record", "run record", "control file"]


# ---------------------------------------------------------------------------
# Noise: the run record decides first; the dump and a noise file only support
# ---------------------------------------------------------------------------


def _noise_run(tmp_path, *, rec_kwargs=None, options=(), noise_file=False, obs_meta=()):
    """A run read back through the real readers, with a record only when
    ``rec_kwargs`` is given."""
    run_dir = tmp_path / "noise-run"
    run_dir.mkdir()
    pst_path, _ = write_control_file(
        run_dir / "case.pst", ["par0", "par1"], ["obs0", "obs1"], obs_meta=obs_meta
    )
    if options:
        _add_control_options(pst_path, *options)
    if noise_file:
        (run_dir / "case.obs+noise.jcb").write_bytes(b"placeholder")
    if rec_kwargs is not None:
        write_rec(run_dir / "case.rec", **rec_kwargs)
    run = discover(run_dir)
    tables = read_control(pst_path)
    assert not isinstance(tables, ReadFailure)
    rec = read_rec(run.rec) if run.rec is not None else None
    return run, tables, rec, scan_options(pst_path)


FORECAST = {
    "noise": "reset_to_no_noise",
    "options": {"ies_no_noise": "0", "ies_num_reals": "300"},
}


def _noise_fact(run, tables, rec, options):
    config = build_config(run, tables, None, None, rec=rec, options=options)
    return config, {f.key: f for f in config.facts}["noise"]


def test_the_forecast_shape_is_no_noise_from_the_record_and_the_dump_and_file_only_support(tmp_path):
    run, tables, rec, options = _noise_run(tmp_path, rec_kwargs=FORECAST, noise_file=True)

    config, fact = _noise_fact(run, tables, rec, options)

    assert config.noise.has_noise is False
    assert config.noise.decided_by == "run_record"
    supporting = [r for r in fact.readings if r.value is None]
    assert {r.source for r in supporting} == {"run record", "files present"}
    dump = next(r for r in supporting if r.source == "run record")
    assert "ies_no_noise 0" in dump.shown
    file_reading = next(r for r in supporting if r.source == "files present")
    assert "case.obs+noise.jcb" in file_reading.shown
    assert "pestpp writes this file whether or not noise was drawn" in file_reading.evidence
    assert any(r.value is False and r.source == "run record" for r in fact.readings)


def test_the_same_run_without_a_record_is_undetermined_and_a_noise_file_never_makes_it_noisy(tmp_path):
    run, tables, rec, options = _noise_run(tmp_path, noise_file=True)

    fact = describe_noise(run, tables, rec, options)

    assert fact.has_noise is None
    assert fact.decided_by == "undetermined"
    evidence = " ".join(fact.evidence)
    for looked_for in ("run record", "ies_no_noise", "observation ensemble", "standard_deviation"):
        assert looked_for in evidence


def test_a_record_that_loaded_an_observation_ensemble_says_noise_even_when_the_control_file_disagrees(tmp_path):
    run, tables, rec, options = _noise_run(
        tmp_path,
        rec_kwargs={"noise": "loaded_obs_ensemble"},
        options=("ies_no_noise true",),
    )

    config, fact = _noise_fact(run, tables, rec, options)

    assert config.noise.has_noise is True
    assert config.noise.decided_by == "run_record"
    assert fact.agree is False
    assert [(r.source, r.value) for r in fact.readings] == [("run record", True), ("control file", False)]
    assert config.noise.notes


def test_without_a_record_the_control_file_decides_before_a_supplied_ensemble_and_the_column(tmp_path):
    cases = [
        ({"options": ("ies_no_noise true",)}, False, "ies_no_noise"),
        ({"options": ("ies_obs_en noise_oe.jcb",)}, True, "observation_ensemble_option"),
        ({"obs_meta": ("standard_deviation",)}, True, "standard_deviation_column"),
    ]
    for number, (kwargs, expected, decided_by) in enumerate(cases):
        folder = tmp_path / f"case{number}"
        folder.mkdir()
        run, tables, rec, options = _noise_run(folder, **kwargs)

        fact = describe_noise(run, tables, rec, options)

        assert (fact.has_noise, fact.decided_by) == (expected, decided_by)


# ---------------------------------------------------------------------------
# The noise band
# ---------------------------------------------------------------------------


def _noise_band_run(tmp_path, *, with_noise=True, rec_kwargs=None):
    run_dir = tmp_path / "band-run"
    make_obs_run(run_dir, with_noise=with_noise)
    if rec_kwargs is not None:
        write_rec(run_dir / "case.rec", **rec_kwargs)
    cache_root = tmp_path / "band-cache"
    ingest_run(run_dir, cache_root=cache_root)
    return cache_root


def test_the_noise_band_fact_names_the_file_it_was_built_from_and_that_base_was_left_out(tmp_path):
    cache_root = _noise_band_run(tmp_path)

    band = _facts(cache_root)["noise_band"]

    cached = next(r for r in band["readings"] if r["source"] == "cache")
    assert "case.obs+noise.jcb" in cached["shown"]
    assert "base was left out" in cached["shown"]
    assert cached["extra"]["source"] == "case.obs+noise.jcb"
    assert "without noise" not in (band["note"] or "")


def test_when_no_noise_was_drawn_the_band_fact_says_the_file_holds_the_observed_values(tmp_path):
    cache_root = _noise_band_run(tmp_path, rec_kwargs=FORECAST)

    band = _facts(cache_root)["noise_band"]

    assert "holds the observed values without noise" in band["note"]


def test_a_run_with_no_noise_file_gives_the_reason_there_is_no_band(tmp_path):
    cache_root = _noise_band_run(tmp_path, with_noise=False)

    band = _facts(cache_root)["noise_band"]

    assert band["readings"] == []
    assert "no obs+noise file" in band["note"]
    assert band["looked_for"]


# ---------------------------------------------------------------------------
# Localization: a stat call only
# ---------------------------------------------------------------------------


def _localization_run(tmp_path, name="localization.jcb", *, write_file=True):
    run_dir, _ = _setup(tmp_path, rec=False, options=(f"ies_localizer {name}",))
    if write_file:
        (run_dir / name).write_bytes(b"x" * 1234)
    return run_dir


def test_the_localization_file_is_only_stated_never_opened_and_never_a_source(tmp_path):
    run_dir = _localization_run(tmp_path)
    target = run_dir / "localization.jcb"
    target.chmod(0)
    cache_root = tmp_path / "cache"
    try:
        manifest = _ingest(run_dir, cache_root)
    finally:
        target.chmod(0o644)

    fact = _facts(cache_root)["localization"]
    stat_reading = next(r for r in fact["readings"] if r["source"] == "files present")
    assert stat_reading["extra"]["name"] == "localization.jcb"
    assert stat_reading["extra"]["size_bytes"] == 1234
    assert stat_reading["extra"]["mtime_ns"] > 0
    assert stat_reading["value"] is None
    control = next(r for r in fact["readings"] if r["source"] == "control file")
    assert "localization.jcb" in control["shown"]
    for artifact in manifest.artifacts.values():
        assert not any(Path(source.path).name == "localization.jcb" for source in artifact.sources)


def test_a_name_that_leaves_the_run_directory_gets_a_note_and_no_stat(tmp_path):
    (tmp_path / "outside.jcb").write_bytes(b"y" * 99)
    run_dir = _localization_run(tmp_path, "../outside.jcb", write_file=False)
    cache_root = tmp_path / "cache"
    _ingest(run_dir, cache_root)

    fact = _facts(cache_root)["localization"]

    assert not any(r["source"] == "files present" for r in fact["readings"])
    assert "resolves outside" in fact["note"]
    assert "size_bytes" not in json.dumps(fact)


def test_a_record_that_says_localized_with_no_option_in_the_control_file_has_nothing_to_compare(tmp_path):
    run_dir, _ = _setup(tmp_path, localization=48785)
    cache_root = tmp_path / "cache"
    _ingest(run_dir, cache_root)

    fact = _facts(cache_root)["localization"]

    assert [(r["source"], r["value"]) for r in fact["readings"]] == [("run record", True)]
    assert "48785 sequential upgrade steps" in fact["readings"][0]["shown"]
    assert fact["agree"] is None


def test_the_route_stats_the_file_again_and_shows_both_when_it_changed(tmp_path):
    run_dir = _localization_run(tmp_path)
    cache_root = tmp_path / "cache"
    _ingest(run_dir, cache_root)
    client = _client(cache_root)
    before = next(f for f in client.get("/api/run/config").json()["facts"] if f["key"] == "localization")
    assert not any(r["extra"] and r["extra"].get("now") for r in before["readings"])

    (run_dir / "localization.jcb").write_bytes(b"z" * 4321)
    after = next(f for f in client.get("/api/run/config").json()["facts"] if f["key"] == "localization")

    stats = [r for r in after["readings"] if r["source"] == "files present"]
    assert [r["extra"]["size_bytes"] for r in stats] == [1234, 4321]
    assert stats[1]["extra"]["now"] is True
    assert "changed since the ingest" in after["note"]


# ---------------------------------------------------------------------------
# Base per ingested iteration
# ---------------------------------------------------------------------------


def _set_cached_names(cache_root, iteration, names):
    """Rewrite the realization names the cache holds for one iteration."""
    path = Path(cache_root) / "reals" / f"par_{iteration}.reals.json"
    payload = json.loads(path.read_text())
    payload["names"] = names
    path.write_text(json.dumps(payload))


def _cached_names(cache_root, iteration):
    path = Path(cache_root) / "reals" / f"par_{iteration}.reals.json"
    return json.loads(path.read_text())["names"]


def _fact(cache_root, key):
    body = _client(cache_root).get("/api/run/config").json()
    return next(f for f in body["facts"] if f["key"] == key)


def _cache_rows(fact):
    return [r["shown"] for r in fact["readings"] if r["source"] == "cache"]


def _without_base(names):
    return [n for n in names if n != "base"]


def _base_run(tmp_path, *, iterations=(0, 3), options=(), **kwargs):
    run_dir, _ = _setup(tmp_path, rec=False, options=options, iterations=iterations, **kwargs)
    cache_root = tmp_path / "cache"
    _ingest(run_dir, cache_root)
    return run_dir, cache_root


def test_base_has_one_cache_row_per_ingested_iteration_in_ascending_order(tmp_path):
    _, cache_root = _base_run(tmp_path)

    assert _cache_rows(_fact(cache_root, "base")) == ["iteration 0: base present", "iteration 3: base present"]


def test_an_iteration_that_lost_base_after_the_first_kept_it_says_base_missing(tmp_path):
    _, cache_root = _base_run(tmp_path)
    _set_cached_names(cache_root, 3, _without_base(_cached_names(cache_root, 3)))

    assert _cache_rows(_fact(cache_root, "base")) == ["iteration 0: base present", "iteration 3: base missing"]


def test_a_run_that_never_had_base_says_it_was_not_included_and_never_lost(tmp_path):
    _, cache_root = _base_run(tmp_path, options=("ies_include_base 0",))
    for iteration in (0, 3):
        _set_cached_names(cache_root, iteration, _without_base(_cached_names(cache_root, iteration)))

    fact = _fact(cache_root, "base")

    assert _cache_rows(fact) == [
        "iteration 0: base was not included in this run",
        "iteration 3: base was not included in this run",
    ]
    assert "lost" not in json.dumps(fact)
    assert fact["agree"] is True


def test_base_is_matched_after_trimming_and_lower_casing_with_a_note_saying_so(tmp_path):
    _, cache_root = _base_run(tmp_path, iterations=(0, 1))
    names = ["Base " if n == "base" else n for n in _cached_names(cache_root, 0)]
    _set_cached_names(cache_root, 0, names)

    row = next(r for r in _fact(cache_root, "base")["readings"] if r["source"] == "cache")

    assert row["shown"] == "iteration 0: base present"
    assert "only after trimming" in row["evidence"]


def test_a_control_file_that_adds_base_while_the_cache_has_none_disagrees_and_keeps_both(tmp_path):
    _, cache_root = _base_run(tmp_path, iterations=(0, 1), options=("ies_add_base true",))
    for iteration in (0, 1):
        _set_cached_names(cache_root, iteration, _without_base(_cached_names(cache_root, iteration)))

    fact = _fact(cache_root, "base")

    assert fact["agree"] is False
    assert [r["source"] for r in fact["readings"]][0] == "control file"
    assert {r["source"] for r in fact["readings"]} == {"control file", "cache"}


def test_a_parameter_ensemble_that_failed_says_not_ingested_with_the_manifest_reason(tmp_path):
    _, cache_root = _base_run(tmp_path)
    layout = CacheLayout(root=cache_root)
    manifest = Manifest.load(layout)
    manifest.mark_failed("par_ens/3", "the file was damaged")
    manifest.save(layout)

    rows = [r for r in _fact(cache_root, "base")["readings"] if r["source"] == "cache"]

    assert [r["shown"] for r in rows] == ["iteration 0: base present", "iteration 3: not ingested"]
    assert "the file was damaged" in rows[1]["evidence"]
    assert rows[1]["value"] is None


def test_a_base_par_file_in_the_run_directory_is_a_files_present_reading(tmp_path):
    run_dir, _ = _setup(tmp_path, rec=False)
    (run_dir / "case.0.base.par").write_text("par0 1.0 1.0 0.0\n")
    cache_root = tmp_path / "cache"
    _ingest(run_dir, cache_root)

    fact = _facts(cache_root)["base"]

    files = [r for r in fact["readings"] if r["source"] == "files present"]
    assert [r["shown"] for r in files] == ["case.0.base.par is present"]


def test_the_stored_base_fact_carries_the_record_dump_and_the_control_file(tmp_path):
    run_dir, _ = _setup(tmp_path, options=("ies_add_base true",), base_kept=True)
    cache_root = tmp_path / "cache"
    _ingest(run_dir, cache_root)

    readings = _facts(cache_root)["base"]["readings"]

    sources = [r["source"] for r in readings]
    assert sources[:3] == ["run record", "run record", "control file"]
    assert [r["value"] for r in readings[:3]] == [True, True, True]


# ---------------------------------------------------------------------------
# Ensemble size, noptmax, reinflation
# ---------------------------------------------------------------------------


def test_the_ensemble_size_readings_disagree_and_are_all_kept(tmp_path):
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    made = make_run(run_dir, iterations=(0, 1), n_real=294)
    _add_control_options(made.pst_path, "ies_num_reals 300")
    write_rec(run_dir / "case.rec")
    cache_root = tmp_path / "cache"
    _ingest(run_dir, cache_root)

    fact = _facts(cache_root)["ensemble_size"]

    assert [(r["source"], r["value"]) for r in fact["readings"]] == [
        ("run record", 300),
        ("control file", 300),
        ("cache", 294),
    ]
    assert fact["agree"] is False


def test_the_noptmax_fact_compares_the_control_file_with_a_record_that_states_one(tmp_path):
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    make_run(run_dir, iterations=(0, 1))
    write_rec(run_dir / "case.rec", options={"noptmax": "5", "ies_num_reals": "4"})
    cache_root = tmp_path / "cache"
    _ingest(run_dir, cache_root)

    fact = _facts(cache_root)["noptmax"]

    assert [(r["source"], r["value"]) for r in fact["readings"]] == [("run record", 5), ("control file", 3)]
    assert fact["agree"] is False


def _reinflation_run(tmp_path, *, rec_kwargs, files=()):
    run_dir = tmp_path / "reinflation-run"
    run_dir.mkdir()
    pst_path, _ = write_control_file(run_dir / "case.pst", ["par0"], ["obs0"], noptmax=5)
    for name in files:
        (run_dir / name).write_text("group,count\n")
    write_rec(run_dir / "case.rec", **rec_kwargs)
    run = discover(run_dir)
    tables = read_control(pst_path)
    assert not isinstance(tables, ReadFailure)
    return run, tables, read_rec(run.rec), scan_options(pst_path)


def test_a_pl253_shaped_run_lists_the_finding_at_4_with_each_source_that_says_so(tmp_path):
    run, tables, rec, options = _reinflation_run(
        tmp_path, rec_kwargs={"reinflations": (4,)}, files=("case.4.reinflate.pcs.csv",)
    )

    config = build_config(run, tables, None, None, rec=rec, options=options, par_iterations=(0, 6))
    fact = {f.key: f for f in config.facts}["reinflation"]

    assert [(r.source, r.extra["in_range"]) for r in fact.readings] == [
        ("run record", "4"),
        ("files present", "4"),
    ]
    assert fact.agree is True
    assert "reinflation at iteration 4" in fact.readings[0].shown
    assert "between iteration 0 and 6" in fact.note


def test_a_run_with_no_parameter_iterations_says_unchecked_and_lists_where_it_looked(tmp_path):
    run, tables, rec, options = _reinflation_run(tmp_path, rec_kwargs={})

    config = build_config(run, tables, None, None, rec=rec, options=options, par_iterations=())
    fact = {f.key: f for f in config.facts}["reinflation"]

    assert fact.readings == ()
    assert fact.note.startswith("unchecked")
    assert fact.looked_for
