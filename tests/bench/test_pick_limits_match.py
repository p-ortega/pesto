"""The picking scale test judges against the same limits pesto bench reports."""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from pesto.bench.limits import SPEED_LIMITS

PICK_LIMITS_TS = Path(__file__).parents[2] / "frontend" / "tests" / "support" / "pick-limits.ts"
NAMES = ("pick_index_build_ms", "pick_p95_ms")


def ts_number_object(source: str, name: str) -> dict[str, float]:
    """The `key: number` pairs in `export const NAME = {...} as const`."""
    found = re.search(rf"export\s+const\s+{name}\s*=\s*\{{([^}}]*)\}}\s*as\s+const", source)
    if found is None:
        raise ValueError(f"no `export const {name} = {{...}} as const` in the source")
    return {key: float(value) for key, value in re.findall(r"(\w+)\s*:\s*([0-9.]+)", found.group(1))}


def test_the_typescript_pick_limits_equal_the_python_speed_limits() -> None:
    if not PICK_LIMITS_TS.is_file():
        pytest.skip("frontend source not present")
    found = ts_number_object(PICK_LIMITS_TS.read_text(encoding="utf-8"), "PICK_LIMITS")
    assert found == {name: getattr(SPEED_LIMITS, name) for name in NAMES}


def test_a_changed_limit_is_reported_as_a_difference() -> None:
    changed = "export const PICK_LIMITS = { pick_index_build_ms: 1000, pick_p95_ms: 2 } as const\n"
    found = ts_number_object(changed, "PICK_LIMITS")
    assert found != {name: getattr(SPEED_LIMITS, name) for name in NAMES}


def test_a_missing_object_is_an_error_not_an_empty_answer() -> None:
    with pytest.raises(ValueError):
        ts_number_object("export const OTHER = { a: 1 } as const", "PICK_LIMITS")
