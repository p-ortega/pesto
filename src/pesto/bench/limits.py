"""pesto's speed limits, in one place.

They come from the governing exit criteria (REQ-m0-exit-criteria-v2) and the
slider limits settled for Phase 6. The slow tests, the `pesto bench` table and
the browser check all read these values, so no number lives in two places.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class SpeedLimits:
    reopen_seconds: float = 1.5
    values_p95_seconds: float = 0.100
    cache_ratio: float = 1.5
    ingest_growth_data_factor: float = 4.0
    ingest_growth_time_factor: float = 10.0
    slider_fetch_p95_ms: float = 150.0
    slider_no_fetch_p95_ms: float = 50.0


SPEED_LIMITS = SpeedLimits()

# "or less" limits pass when exactly at the limit; "under" limits do not.
_AT_OR_UNDER = ("reopen_seconds", "values_p95_seconds", "cache_ratio")
_STRICTLY_UNDER = (
    "ingest_growth_time_factor",
    "slider_fetch_p95_ms",
    "slider_no_fetch_p95_ms",
)


def speed_limits_dict() -> dict[str, float]:
    return asdict(SPEED_LIMITS)


def passes(name: str, measured: float) -> bool:
    if name in _AT_OR_UNDER:
        return measured <= getattr(SPEED_LIMITS, name)
    if name in _STRICTLY_UNDER:
        return measured < getattr(SPEED_LIMITS, name)
    raise ValueError(f"{name!r} is not a speed limit that has a pass or miss rule")
