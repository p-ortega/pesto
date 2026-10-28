"""The observation view's server side, checked against the real benchmark runs.

Every test here is slow and runs against whichever benchmark runs are present;
each skips when its folder is absent. Every ingest writes to a cache under
``tmp_path``, and a snapshot of the run folder is compared before and after,
because a run folder is a scientist's finished output and must never be written.

Nothing below asserts what a local folder happens to hold. Each check is a
relationship that holds for any run, and a run that cannot show the
relationship skips with the reason.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from pesto.cache.layout import CacheLayout
from pesto.ingest.discover import discover
from pesto.ingest.runner import plan_artifacts

pytestmark = pytest.mark.slow

RUN_FIXTURES = ("hm_run", "pl253_run", "forecast_run", "restarted_run")


def _snapshot(root: Path) -> dict[str, tuple[int, int]]:
    return {
        str(path.relative_to(root)): (path.stat().st_size, path.stat().st_mtime_ns)
        for path in sorted(root.rglob("*"))
        if path.is_file()
    }


# ---------------------------------------------------------------------------
# planning only: no ingest, so seconds
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("run_fixture", RUN_FIXTURES)
def test_obs_1to1_plans_exactly_when_an_observation_ensemble_plans_and_planning_leaves_the_run_untouched(
    request: pytest.FixtureRequest, tmp_path: Path, run_fixture: str
):
    run_dir = request.getfixturevalue(run_fixture)
    before = _snapshot(run_dir)

    planned = plan_artifacts(discover(run_dir), CacheLayout(root=tmp_path / "cache"))

    ensembles = sorted(
        (int(pa.name.split("/", 1)[1]), pa.name) for pa in planned if pa.kind == "obs_ens"
    )
    one_to_one = [pa for pa in planned if pa.kind == "obs_1to1"]
    if not ensembles:
        assert one_to_one == [], "obs_1to1 was planned with no observation ensemble planned"
    else:
        assert len(one_to_one) == 1, f"expected one obs_1to1, found {len(one_to_one)}"
        needs = one_to_one[0].needs
        first, last = ensembles[0][1], ensembles[-1][1]
        assert first in needs and last in needs, f"needs {needs} do not name {first} and {last}"
        named = {n for n in needs if n.startswith("obs_ens/")}
        assert named == {first, last}, f"needs name obs_ens entries {sorted(named)}, not just {first} and {last}"
        assert "obs_index" in needs
        for end in {first, last}:
            assert f"obs_agg/{end.split('/', 1)[1]}" in needs, f"needs hold no obs_agg for {end}"
    assert _snapshot(run_dir) == before, "planning changed the run folder"
    if not ensembles:
        pytest.skip(f"{run_fixture} plans no observation ensemble, so obs_1to1 correctly plans none")
