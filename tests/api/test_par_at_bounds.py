"""/par/at_bounds: which parameters are at their bounds in the shown iteration, read from
the near-bound counts in par_change, for the first and last iteration only."""

from __future__ import annotations

from pathlib import Path

import pandas as pd
from fastapi.testclient import TestClient

import pesto.api.par as par_module
from ingest.par_fixtures import LOG_BOUNDS, NONE_BOUNDS, make_par_view_run
from ingest.test_control_first import in_process  # noqa: F401  (a fixture, used by name)
from pesto.api.app import create_app
from pesto.cache.layout import CacheLayout
from pesto.ingest.parview import NEAR_BOUND_NOTE, load_par_change
from pesto.ingest.runner import ingest_run

from .test_ingest import _snapshot

BASE_URL = "http://127.0.0.1"
URL = "/api/run/par/at_bounds"


def _client(cache_root) -> TestClient:
    app, token = create_app()
    app.state.cache_root = str(cache_root)
    client = TestClient(app, base_url=BASE_URL)
    client.headers["x-pesto-token"] = token
    return client


def _open(tmp_path, **kwargs):
    run = make_par_view_run(tmp_path / "run", **kwargs)
    cache_root = tmp_path / "cache"
    ingest_run(run.root, cache_root=cache_root)
    return run, cache_root, _client(cache_root)


def _near_bound_overrides(run_kwargs: dict, tmp_path) -> dict:
    """Overrides that put one realization of the first hk_pp and rch_gr parameters on a bound."""
    probe = make_par_view_run(tmp_path / "probe", **run_kwargs)
    hk = probe.groups["hk_pp"][0]
    rch = probe.groups["rch_gr"][0]
    first = probe.values[0]
    hk_col = first[:, probe.par_names.index(hk)].copy()
    hk_col[0] = LOG_BOUNDS[0]
    rch_col = first[:, probe.par_names.index(rch)].copy()
    rch_col[1] = NONE_BOUNDS[1]
    return {(0, hk): hk_col, (0, rch): rch_col}


def _expected(frame: pd.DataFrame, suffix: str) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for group, block in frame.groupby("pargp", sort=False):
        lower = block[f"near_lower_{suffix}"]
        upper = block[f"near_upper_{suffix}"]
        counted = lower.notna() & upper.notna()
        at = counted & ((lower.fillna(0) + upper.fillna(0)) >= 1)
        excluded: dict[str, int] = {}
        for kind in block.loc[~counted, "excluded_kind"]:
            key = kind if isinstance(kind, str) and kind else "not counted"
            excluded[key] = excluded.get(key, 0) + 1
        out[str(group)] = {
            "group": str(group),
            "n_par": len(block),
            "n_counted": int(counted.sum()),
            "n_at_bounds": int(at.sum()),
            "n_excluded": excluded,
            "names": block.loc[at, "parnme"].tolist(),
        }
    return out


def _rewrite_change(cache_root, rows: list[dict], **sidecar) -> None:
    """Replace the cached par_change with ``rows`` (parnme, pargp, counts, excluded_kind),
    every other column copied from the first stored row."""
    import json

    layout = CacheLayout(root=Path(cache_root))
    frame, meta = load_par_change(layout)
    template = frame.iloc[[0] * len(rows)].reset_index(drop=True)
    for column in ("parnme", "pargp", "excluded_kind"):
        template[column] = pd.Series([r.get(column) for r in rows], dtype="object")
    template["included"] = [r.get("excluded_kind") is None for r in rows]
    for column in ("near_lower_first", "near_upper_first", "near_lower_last", "near_upper_last"):
        template[column] = pd.array([r.get(column) for r in rows], dtype="Int64")
    template.to_parquet(layout.par_change, index=False)
    if sidecar:
        layout.par_change_meta.write_text(json.dumps({**meta, **sidecar}, indent=2))


def test_the_first_iteration_counts_parameters_at_their_bounds_per_group(tmp_path, in_process):  # noqa: F811
    overrides = _near_bound_overrides({}, tmp_path)
    run, cache_root, client = _open(tmp_path, overrides=overrides)
    frame, _meta = load_par_change(CacheLayout(root=cache_root))
    expected = _expected(frame, "first")

    response = client.get(URL, params={"iteration": 0})

    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    assert body["available"] is True
    assert body["reason"] is None
    assert body["artifact"] == "par_change"
    assert (body["iteration"], body["first_iteration"], body["last_iteration"]) == (0, 0, 1)
    assert body["names"] is None
    assert [g["group"] for g in body["groups"]] == list(expected)
    for entry in body["groups"]:
        want = expected[entry["group"]]
        assert entry == {k: v for k, v in want.items() if k != "names"}
    by_group = {g["group"]: g for g in body["groups"]}
    # The overridden parameters sit on a bound in one realization each.
    assert by_group["hk_pp"]["n_at_bounds"] >= 1
    assert by_group["rch_gr"]["n_at_bounds"] >= 1
    assert by_group["fixed_gr"]["n_excluded"] == {"fixed": 2}
    assert by_group["fixed_gr"]["n_at_bounds"] == 0
    assert by_group["mix"]["n_excluded"].get("tied") == 1


def test_names_list_every_at_bounds_parameter_of_the_group_in_par_change_order(tmp_path, in_process):  # noqa: F811
    overrides = _near_bound_overrides({}, tmp_path)
    run, cache_root, client = _open(tmp_path, overrides=overrides)
    frame, _meta = load_par_change(CacheLayout(root=cache_root))
    expected = _expected(frame, "first")

    body = client.get(URL, params={"iteration": 0, "group": "hk_pp"}).json()

    assert body["names"] == expected["hk_pp"]["names"]
    assert run.groups["hk_pp"][0] in body["names"]


def test_the_last_iteration_reads_the_last_columns(tmp_path, in_process):  # noqa: F811
    run, cache_root, client = _open(tmp_path)
    _rewrite_change(
        cache_root,
        [
            {"parnme": "a", "pargp": "g", "near_lower_first": 0, "near_upper_first": 0,
             "near_lower_last": 2, "near_upper_last": 0},
            {"parnme": "b", "pargp": "g", "near_lower_first": 3, "near_upper_first": 0,
             "near_lower_last": 0, "near_upper_last": 0},
        ],
    )

    first = client.get(URL, params={"iteration": 0, "group": "g"}).json()
    last = client.get(URL, params={"iteration": 1, "group": "g"}).json()

    assert first["names"] == ["b"]
    assert last["names"] == ["a"]
    assert last["iteration"] == 1


def test_zero_one_and_missing_counts_are_classified_as_stated(tmp_path, in_process):  # noqa: F811
    _run, cache_root, client = _open(tmp_path)
    _rewrite_change(
        cache_root,
        [
            {"parnme": "zero", "pargp": "g", "near_lower_first": 0, "near_upper_first": 0},
            {"parnme": "low", "pargp": "g", "near_lower_first": 1, "near_upper_first": 0},
            {"parnme": "up", "pargp": "g", "near_lower_first": 0, "near_upper_first": 1},
            {"parnme": "fixed", "pargp": "g", "excluded_kind": "fixed"},
            {"parnme": "badbound", "pargp": "g"},
        ],
    )

    body = client.get(URL, params={"iteration": 0, "group": "g"}).json()

    assert body["names"] == ["low", "up"]
    assert body["groups"] == [
        {
            "group": "g",
            "n_par": 5,
            "n_counted": 3,
            "n_at_bounds": 2,
            "n_excluded": {"fixed": 1, "not counted": 1},
        }
    ]


def test_a_middle_iteration_has_no_answer_and_never_borrows_another(tmp_path, in_process):  # noqa: F811
    _run, _cache_root, client = _open(tmp_path, iterations=(0, 1, 2))

    response = client.get(URL, params={"iteration": 1, "group": "hk_pp"})

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["available"] is False
    assert body["reason"] == "near-bound counts exist for iterations 0 and 2 only"
    assert body["groups"] == []
    assert body["names"] is None
    assert (body["first_iteration"], body["last_iteration"]) == (0, 2)
    assert client.get(URL, params={"iteration": 2}).json()["available"] is True


def test_a_single_iteration_run_answers_for_that_iteration_only(tmp_path, in_process):  # noqa: F811
    _run, cache_root, client = _open(tmp_path, iterations=(0,), drop_in_last=None)
    frame, meta = load_par_change(CacheLayout(root=cache_root))
    assert meta["single_iteration"] is True

    here = client.get(URL, params={"iteration": 0}).json()
    other = client.get(URL, params={"iteration": 1}).json()

    assert here["available"] is True
    assert [g["n_at_bounds"] for g in here["groups"]] == [
        v["n_at_bounds"] for v in _expected(frame, "first").values()
    ]
    assert other["available"] is False
    assert other["reason"] == "near-bound counts exist for iteration 0 only"


def test_an_unknown_group_is_a_404_naming_par_change(tmp_path, in_process):  # noqa: F811
    _run, _cache_root, client = _open(tmp_path)

    response = client.get(URL, params={"iteration": 0, "group": "nosuch"})

    assert response.status_code == 404
    assert response.json()["artifact"] == "par_change"


def test_a_group_over_the_drill_down_limit_is_served_in_full(tmp_path, in_process):  # noqa: F811
    _run, cache_root, client = _open(tmp_path)
    n = 10_001
    rows = [
        {"parnme": f"p{i}", "pargp": "big", "near_lower_first": i % 2, "near_upper_first": 0}
        for i in range(n)
    ]
    _rewrite_change(cache_root, rows)

    response = client.get(URL, params={"iteration": 0, "group": "big"})

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["groups"][0]["n_par"] == n
    assert body["groups"][0]["n_at_bounds"] == n // 2
    assert body["names"] == [f"p{i}" for i in range(1, n, 2)]


def test_the_answer_states_pestpps_rule_and_the_float32_caveat(tmp_path, in_process):  # noqa: F811
    _run, _cache_root, client = _open(tmp_path)

    body = client.get(URL, params={"iteration": 0}).json()

    assert NEAR_BOUND_NOTE in body["rule"]
    assert "at least one realization" in body["rule"]
    assert "float32" in body["caveat"]
    assert "one high" in body["caveat"]
    assert "pcs.csv" in body["caveat"]


def test_a_second_call_uses_the_memo_and_a_rewrite_is_read_again(tmp_path, in_process, monkeypatch):  # noqa: F811
    _run, cache_root, client = _open(tmp_path)
    calls: list = []
    original = par_module.load_par_change

    def counted(layout):
        calls.append(layout)
        return original(layout)

    monkeypatch.setattr(par_module, "load_par_change", counted)

    client.get(URL, params={"iteration": 0})
    client.get(URL, params={"iteration": 0, "group": "hk_pp"})
    assert len(calls) == 1

    _rewrite_change(
        cache_root, [{"parnme": "only", "pargp": "solo", "near_lower_first": 0, "near_upper_first": 4}]
    )
    body = client.get(URL, params={"iteration": 0, "group": "solo"}).json()

    assert len(calls) == 2
    assert body["names"] == ["only"]


def test_the_run_directory_and_cache_are_untouched(tmp_path, in_process):  # noqa: F811
    run, cache_root, client = _open(tmp_path, iterations=(0, 1, 2))
    run_before, cache_before = _snapshot(run.root), _snapshot(cache_root)

    for params in ({"iteration": 0}, {"iteration": 1}, {"iteration": 2, "group": "hk_pp"}):
        assert client.get(URL, params=params).status_code == 200
    client.get(URL, params={"iteration": 0, "group": "nosuch"})

    assert _snapshot(run.root) == run_before
    assert _snapshot(cache_root) == cache_before

