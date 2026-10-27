"""The speed limits and the rule for passing each one.

An "or less" limit passes exactly at the limit; an "under" limit does not.
"""

from __future__ import annotations

import pytest

from pesto.bench.limits import SPEED_LIMITS, passes, speed_limits_dict


def test_the_ten_speed_limits_hold_the_agreed_values() -> None:
    assert speed_limits_dict() == {
        "reopen_seconds": 1.5,
        "values_p95_seconds": 0.100,
        "obs_frame_p95_seconds": 0.100,
        "cache_ratio": 1.5,
        "ingest_growth_data_factor": 4.0,
        "ingest_growth_time_factor": 10.0,
        "slider_fetch_p95_ms": 150.0,
        "slider_no_fetch_p95_ms": 50.0,
        "pick_index_build_ms": 1000.0,
        "pick_p95_ms": 1.0,
    }
    assert SPEED_LIMITS.reopen_seconds == 1.5


@pytest.mark.parametrize(
    ("name", "measured", "expected"),
    [
        ("reopen_seconds", 1.5, True),
        ("reopen_seconds", 1.4999999, True),
        ("reopen_seconds", 1.5000001, False),
        ("values_p95_seconds", 0.100, True),
        ("values_p95_seconds", 0.1001, False),
        ("obs_frame_p95_seconds", 0.100, True),
        ("obs_frame_p95_seconds", 0.1001, False),
        ("cache_ratio", 1.5, True),
        ("cache_ratio", 1.5000001, False),
        ("ingest_growth_time_factor", 10.0, False),
        ("ingest_growth_time_factor", 9.999, True),
        ("slider_fetch_p95_ms", 150.0, False),
        ("slider_fetch_p95_ms", 149.9, True),
        ("slider_no_fetch_p95_ms", 50.0, False),
        ("slider_no_fetch_p95_ms", 49.9, True),
        ("pick_index_build_ms", 1000.0, True),
        ("pick_index_build_ms", 1000.1, False),
        ("pick_p95_ms", 1.0, True),
        ("pick_p95_ms", 1.01, False),
    ],
)
def test_a_measurement_at_the_limit_passes_only_for_or_less_limits(
    name: str, measured: float, expected: bool
) -> None:
    assert passes(name, measured) is expected


@pytest.mark.parametrize("name", ["ingest_growth_data_factor", "nonsense"])
def test_a_name_with_no_pass_rule_is_refused_by_name(name: str) -> None:
    with pytest.raises(ValueError, match=name):
        passes(name, 1)
