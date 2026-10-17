"""The bench asks for the same parameter-table columns the page does."""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from pesto.bench.serve import PAR_TABLE_COLUMNS, PAR_TABLE_OPTIONAL_COLUMNS

PARMAP_TS = Path(__file__).parents[2] / "frontend" / "src" / "data" / "parmap.ts"


def ts_string_list(source: str, name: str) -> tuple[str, ...]:
    """The quoted names in `export const NAME = [...] as const`, in order."""
    found = re.search(rf"export\s+const\s+{name}\s*=\s*\[([^\]]*)\]\s*as\s+const", source)
    if found is None:
        raise ValueError(f"no `export const {name} = [...] as const` in the source")
    return tuple(re.findall(r"""['"]([^'"]+)['"]""", found.group(1)))


def test_the_python_lists_equal_the_typescript_lists() -> None:
    if not PARMAP_TS.is_file():
        pytest.skip("frontend source not present")
    source = PARMAP_TS.read_text(encoding="utf-8")
    assert ts_string_list(source, "PAR_TABLE_COLUMNS") == PAR_TABLE_COLUMNS
    assert ts_string_list(source, "PAR_TABLE_OPTIONAL_COLUMNS") == PAR_TABLE_OPTIONAL_COLUMNS


def test_a_changed_list_is_reported_as_a_difference() -> None:
    changed = (
        "export const PAR_TABLE_COLUMNS = ['parnme', 'pargp', 'extra'] as const\n"
        "export const PAR_TABLE_OPTIONAL_COLUMNS = ['partrans', 'parlbnd', 'parubnd'] as const\n"
    )
    assert ts_string_list(changed, "PAR_TABLE_COLUMNS") != PAR_TABLE_COLUMNS
    assert ts_string_list(changed, "PAR_TABLE_OPTIONAL_COLUMNS") != PAR_TABLE_OPTIONAL_COLUMNS


def test_a_missing_list_is_an_error_not_an_empty_answer() -> None:
    with pytest.raises(ValueError):
        ts_string_list("export const OTHER = ['a'] as const", "PAR_TABLE_COLUMNS")
