"""Which cell each observation site sits on, cached once per run.

``grid/obs_cell.parquet`` holds one row per site of ``obs_index``, in that
index's site order, named by the site name taken from the index. A site with
a cell but no known layer is stored with layer ``-1``, never ``0``.
``grid/obs_cell.json`` keeps every group's rule and counts, the summary, the
layer-unknown count and every note the resolver left, plus the order digest of
the ``obs_index`` the cells were placed for. The file lives apart from the
ensembles, so a grid edit never rewrites a large table.
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
from pesto.ingest.obsindex import load_obs_index
from pesto.ingest.tables import _write_parquet_atomic

# ObsCells lives in pesto.model, which nothing under pesto.ingest may import,
# even for typing; the "ObsCells" annotation below stays an unresolved string.

_UNMAPPED = "unmapped"
_COLUMNS = ("site_id", "site", "group", "cell", "layer", "x", "y", "rule")


@dataclass(frozen=True)
class ObsCellTable:
    """An obs_cell artifact read back: one entry per site, in obs_index
    order, plus the per-group facts and notes kept beside it."""

    site_id: np.ndarray
    site: tuple[str, ...]
    group: tuple[str | None, ...]
    cell: np.ndarray
    layer: np.ndarray
    x: np.ndarray
    y: np.ndarray
    rule: tuple[str, ...]
    groups: tuple[dict, ...]
    summary: str
    notes: tuple[str, ...]
    placed_sites: int
    layer_unknown: int
    order_digest: str


def _failure(path: Path | str, reason: str) -> ReadFailure:
    return ReadFailure(name="obs_cell", path=str(path), reason=reason)


def _own_xy(sites: pd.DataFrame) -> tuple[np.ndarray, np.ndarray]:
    """The x and y the control file gave each site, as numbers; NaN where
    absent or not a number."""
    n = len(sites)
    out = []
    for column in ("x", "y"):
        if column in sites.columns:
            out.append(pd.to_numeric(sites[column], errors="coerce").to_numpy(dtype=np.float64))
        else:
            out.append(np.full(n, np.nan))
    return out[0], out[1]


def write_obs_cell(
    cells: "ObsCells", sites: pd.DataFrame, order_digest: str, layout: CacheLayout
) -> WrittenArtifact | ReadFailure:
    """Write ``cells`` into ``layout.grid`` as ``obs_cell.parquet`` and
    ``obs_cell.json``.

    Names come from ``sites["site"]``, the site table of the ``obs_index``
    with that ``order_digest``. When ``cells.site`` differs from it the call
    refuses, because a cell joined to a site by position would be silently
    wrong. Never raises.
    """
    parquet_path = layout.grid / "obs_cell.parquet"
    wrote_parquet = False
    try:
        for column in ("site", "group"):
            if column not in sites.columns:
                return _failure(layout.grid, f"the site table has no {column} column")
        names = tuple(sites["site"].astype(str))
        given = tuple(cells.site)
        pairs = list(zip_longest(names, given, fillvalue="<none>"))
        wrong = [(i, a, b) for i, (a, b) in enumerate(pairs) if a != b]
        if wrong:
            first = wrong[0]
            return _failure(
                layout.grid,
                f"refusing to write obs_cell: the placed site names do not match the "
                f"obs_index sites in order; first difference is at position {first[0]}, "
                f"{first[1]!r} against {first[2]!r}, {len(wrong)} position(s) differ",
            )

        n = len(names)
        groups = [None if pd.isna(v) else str(v) for v in sites["group"]]
        rule_of = {g.group: g.rule for g in cells.groups}
        rules = [rule_of.get(g, _UNMAPPED) if g is not None else _UNMAPPED for g in groups]

        x, y = _own_xy(sites)
        if cells.point_xy is not None:
            xy = np.asarray(cells.point_xy, dtype=np.float64).reshape(n, 2)
            moved = np.isfinite(xy[:, 0]) & np.isfinite(xy[:, 1])
            x = np.where(moved, xy[:, 0], x)
            y = np.where(moved, xy[:, 1], y)

        if "site_id" in sites.columns:
            site_id = sites["site_id"].to_numpy(dtype=np.int64)
        else:
            site_id = np.arange(n, dtype=np.int64)

        frame = pd.DataFrame(
            {
                "site_id": site_id,
                "site": pd.Series(names, dtype="object"),
                "group": pd.Series(groups, dtype="object"),
                "cell": np.asarray(cells.cell, dtype=np.int32),
                "layer": np.asarray(cells.layer, dtype=np.int32),
                "x": x,
                "y": y,
                "rule": pd.Series(rules, dtype="object"),
            }
        )

        layout.ensure()
        json_path = layout.grid / "obs_cell.json"
        parquet_bytes = _write_parquet_atomic(frame, parquet_path)
        wrote_parquet = True

        notes = list(cells.notes)
        if n == 0:
            notes.append("observation table has zero sites")
        payload = {
            "cache_version": CACHE_VERSION,
            "order_digest": order_digest,
            "n_sites": n,
            "placed_sites": int(cells.placed_sites),
            "layer_unknown": int(cells.layer_unknown),
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
        return WrittenArtifact(name="obs_cell", files=files, notes=tuple(notes))
    except Exception as exc:
        # A parquet without its sidecar must not stand under its final name.
        if wrote_parquet:
            parquet_path.unlink(missing_ok=True)
        return _failure(layout.grid, f"failed to write obs_cell to {layout.grid}: {exc}")


def load_obs_cell(layout: CacheLayout) -> ObsCellTable | ReadFailure:
    """Read ``obs_cell`` back. The sidecar and its ``cache_version`` are
    checked first, then the columns, then the ``order_digest`` against the
    cached ``obs_index``; any failure is a ``ReadFailure`` naming the file."""
    json_path = layout.grid / "obs_cell.json"
    parquet_path = layout.grid / "obs_cell.parquet"

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
        digest = str(raw["order_digest"])
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
        placed_sites = int(raw["placed_sites"])
        layer_unknown = int(raw["layer_unknown"])
    except (KeyError, TypeError, ValueError) as exc:
        return _failure(json_path, f"{json_path.name} has an unexpected shape: {exc}")

    index = load_obs_index(layout)
    if isinstance(index, ReadFailure):
        return _failure(json_path, f"the obs_index it was placed for could not be read: {index.reason}")
    if index.order_digest != digest:
        return _failure(
            json_path,
            f"{json_path.name} was built against an obs_index with order digest {digest[:12]}..., "
            f"but the cached obs_index has {index.order_digest[:12]}...; ingest again",
        )

    try:
        frame = pd.read_parquet(parquet_path)
    except Exception as exc:
        return _failure(parquet_path, f"failed to read {parquet_path.name}: {exc}")
    missing = [c for c in _COLUMNS if c not in frame.columns]
    if missing:
        return _failure(parquet_path, f"{parquet_path.name} has no column named {missing[0]!r}")

    return ObsCellTable(
        site_id=frame["site_id"].to_numpy(dtype=np.int64),
        site=tuple(str(v) for v in frame["site"]),
        group=tuple(None if pd.isna(v) else str(v) for v in frame["group"]),
        cell=frame["cell"].to_numpy(dtype=np.int32),
        layer=frame["layer"].to_numpy(dtype=np.int32),
        x=frame["x"].to_numpy(dtype=np.float64),
        y=frame["y"].to_numpy(dtype=np.float64),
        rule=tuple(str(v) for v in frame["rule"]),
        groups=groups,
        summary=summary,
        notes=notes,
        placed_sites=placed_sites,
        layer_unknown=layer_unknown,
        order_digest=digest,
    )
