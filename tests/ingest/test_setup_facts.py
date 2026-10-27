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
    FACT_ORDER,
    SOURCE_ORDER,
    Reading,
    config_outdated,
    load_config,
    make_fact,
    write_config,
)
from pesto.ingest.discover import discover
from pesto.ingest.failures import ReadFailure
from pesto.ingest.runner import ingest_run, is_planned_stale, plan_artifacts

from .fixtures import make_run
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
