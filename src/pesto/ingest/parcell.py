"""Which cell each parameter sits on, cached once per run.

``grid/par_cell.parquet`` holds one row per parameter in control-file order,
named by ``parnme`` taken from the control table. ``grid/par_cell.json``
keeps every group's rule and counts, the summary sentence and every note the
resolver left, so nothing about an unplaced group is dropped on the way to
disk.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from itertools import zip_longest
from pathlib import Path

import numpy as np
import pandas as pd

from pesto.cache._atomic import write_atomic_text
from pesto.cache.layout import CACHE_VERSION, CacheLayout
from pesto.cache.manifest import CacheFile, WrittenArtifact
from pesto.ingest.failures import ReadFailure
from pesto.ingest.tables import _write_parquet_atomic

# ParCells lives in pesto.model, which nothing under pesto.ingest may import,
# even for typing; the "ParCells" annotation below stays an unresolved string.

_UNMAPPED = "unmapped"
_COLUMNS = ("parnme", "pargp", "cell", "layer", "x", "y", "rule")


@dataclass(frozen=True)
class ParCellTable:
    """A par_cell artifact read back: one entry per parameter, in control
    order, plus the per-group facts and notes kept beside it."""

    parnme: tuple[str, ...]
    pargp: tuple[str | None, ...]
    cell: np.ndarray
    layer: np.ndarray
    x: np.ndarray
    y: np.ndarray
    rule: tuple[str, ...]
    groups: tuple[dict, ...]
    summary: str
    notes: tuple[str, ...]

    @property
    def placed_groups(self) -> tuple[str, ...]:
        return tuple(g["group"] for g in self.groups if g["mapped"] > 0)


def _failure(path: Path, reason: str) -> ReadFailure:
    return ReadFailure(name="par_cell", path=str(path), reason=reason)


def write_par_cell(
    cells: "ParCells", par: pd.DataFrame, layout: CacheLayout
) -> WrittenArtifact | ReadFailure:
    """Write ``cells`` into ``layout.grid`` as ``par_cell.parquet`` and
    ``par_cell.json``.

    Names come from ``par["parnme"]``. When ``cells.parnme`` differs from it
    the call refuses, because names that are really row numbers from a lost
    index would join to the wrong parameters without a sound. Never raises.
    """
    parquet_path = layout.grid / "par_cell.parquet"
    wrote_parquet = False
    try:
        if "parnme" not in par.columns:
            return _failure(layout.grid, "the parameter table has no parnme column")
        names = tuple(par["parnme"].astype(str))
        given = tuple(cells.parnme)
        pairs = list(zip_longest(names, given, fillvalue="<none>"))
        wrong = [(a, b) for a, b in pairs if a != b]
        if wrong:
            return _failure(
                layout.grid,
                f"refusing to write par_cell: the resolved names do not match the control "
                f"table's parnme column; first difference is {wrong[0][0]!r} against "
                f"{wrong[0][1]!r}, {len(wrong)} row(s) differ",
            )

        n = len(names)
        rule_of = {g.group: g.rule for g in cells.groups}
        if "pargp" in par.columns:
            pargp = [None if pd.isna(v) else str(v) for v in par["pargp"]]
        else:
            pargp = [None] * n
        rules = [rule_of.get(g, _UNMAPPED) if g is not None else _UNMAPPED for g in pargp]

        if cells.point_xy is None:
            x = np.full(n, np.nan)
            y = np.full(n, np.nan)
        else:
            xy = np.asarray(cells.point_xy, dtype=np.float64).reshape(n, 2)
            x, y = xy[:, 0].copy(), xy[:, 1].copy()

        frame = pd.DataFrame(
            {
                "parnme": pd.Series(names, dtype="object"),
                "pargp": pd.Series(pargp, dtype="object"),
                "cell": np.asarray(cells.cell, dtype=np.int32),
                "layer": np.asarray(cells.layer, dtype=np.int32),
                "x": x,
                "y": y,
                "rule": pd.Series(rules, dtype="object"),
            }
        )

        layout.ensure()
        json_path = layout.grid / "par_cell.json"
        parquet_bytes = _write_parquet_atomic(frame, parquet_path)
        wrote_parquet = True

        notes = list(cells.notes)
        if n == 0:
            notes.append("parameter table has zero rows")
        payload = {
            "cache_version": CACHE_VERSION,
            "n_par": n,
            "groups": [
                {"group": g.group, "rule": g.rule, "mapped": g.mapped, "total": g.total}
                for g in cells.groups
            ],
            "summary": cells.summary,
            "notes": notes,
        }
        json_bytes = write_atomic_text(json_path, json.dumps(payload, indent=2))

        root = layout.root
        files = (
            CacheFile(path=str(parquet_path.relative_to(root)), bytes=parquet_bytes),
            CacheFile(path=str(json_path.relative_to(root)), bytes=json_bytes),
        )
        return WrittenArtifact(name="par_cell", files=files, notes=tuple(notes))
    except Exception as exc:
        # A parquet without its sidecar must not stand under its final name.
        if wrote_parquet:
            parquet_path.unlink(missing_ok=True)
        return _failure(layout.grid, f"failed to write par_cell to {layout.grid}: {exc}")


def load_par_cell(layout: CacheLayout) -> ParCellTable | ReadFailure:
    """Read ``par_cell`` back. The sidecar and its ``cache_version`` are
    checked first; any failure is a ``ReadFailure`` naming the file."""
    json_path = layout.grid / "par_cell.json"
    parquet_path = layout.grid / "par_cell.parquet"

    try:
        raw = json.loads(json_path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        return _failure(json_path, f"failed to read {json_path.name}: {exc}")
    if not isinstance(raw, dict):
        return _failure(json_path, f"{json_path.name} is not a JSON object")
    if raw.get("cache_version") != CACHE_VERSION:
        return _failure(
            json_path,
            f"{json_path.name} was written at cache_version {raw.get('cache_version')!r}, "
            f"this reader expects {CACHE_VERSION}",
        )

    try:
        groups = tuple(
            {
                "group": str(g["group"]),
                "rule": str(g["rule"]),
                "mapped": int(g["mapped"]),
                "total": int(g["total"]),
            }
            for g in raw["groups"]
        )
        summary = str(raw["summary"])
        notes = tuple(str(n) for n in raw["notes"])
    except (KeyError, TypeError, ValueError) as exc:
        return _failure(json_path, f"{json_path.name} has an unexpected shape: {exc}")

    try:
        frame = pd.read_parquet(parquet_path)
    except Exception as exc:
        return _failure(parquet_path, f"failed to read {parquet_path.name}: {exc}")
    missing = [c for c in _COLUMNS if c not in frame.columns]
    if missing:
        return _failure(parquet_path, f"{parquet_path.name} has no column named {missing[0]!r}")

    return ParCellTable(
        parnme=tuple(str(v) for v in frame["parnme"]),
        pargp=tuple(None if pd.isna(v) else str(v) for v in frame["pargp"]),
        cell=frame["cell"].to_numpy(dtype=np.int32),
        layer=frame["layer"].to_numpy(dtype=np.int32),
        x=frame["x"].to_numpy(dtype=np.float64),
        y=frame["y"].to_numpy(dtype=np.float64),
        rule=tuple(str(v) for v in frame["rule"]),
        groups=groups,
        summary=summary,
        notes=notes,
    )
