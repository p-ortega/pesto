"""Point-in-cell and z-to-layer lookups, numpy only.

Pilot points carry coordinates, not cell numbers. This module finds the
cell whose polygon contains a point, by testing the point against the
same fan triangles the renderer draws, and the layer whose elevations
bracket a ``z``. No scipy, no shapely: neither is a dependency of this
project, and a vectorised edge test over a bounding-box prefilter is fast
enough for the 12,670 points a real run carries."""

from __future__ import annotations

import numpy as np

from pesto.model import Geometry

# Points are sorted by x and handled in small chunks, so each chunk only
# meets the triangles whose box overlaps the chunk's own box. 64 keeps the
# (chunk x triangles) intermediates under a few megabytes on any grid.
_CHUNK = 64


def locate_points(geometry: Geometry, x: np.ndarray, y: np.ndarray) -> np.ndarray:
    """The cell containing each ``(x, y)``, or ``-1``.

    A point on an edge shared by two cells goes to the lower-numbered
    triangle that contains it, so it lands on exactly one cell. A
    non-finite coordinate finds nothing. Degenerate (zero-area) triangles
    are skipped so they cannot claim every point.
    """
    x = np.asarray(x, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)
    out = np.full(len(x), -1, dtype=np.int64)
    tri = np.asarray(geometry.indices).reshape(-1, 3).astype(np.int64)
    if len(tri) == 0 or len(x) == 0:
        return out

    pos = np.asarray(geometry.positions, dtype=np.float64)
    ax, ay = pos[tri[:, 0], 0], pos[tri[:, 0], 1]
    bx, by = pos[tri[:, 1], 0], pos[tri[:, 1], 1]
    cx, cy = pos[tri[:, 2], 0], pos[tri[:, 2], 1]
    area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay)
    extent = max(np.ptp(pos[:, 0]), np.ptp(pos[:, 1]), 1.0)
    tol = 1e-9 * extent
    keep = np.abs(area) > tol * extent
    ax, ay, bx, by, cx, cy = (v[keep] for v in (ax, ay, bx, by, cx, cy))
    tri_cell = np.asarray(geometry.cell_index)[tri[keep, 0]].astype(np.int64)
    tminx, tmaxx = np.minimum(np.minimum(ax, bx), cx), np.maximum(np.maximum(ax, bx), cx)
    tminy, tmaxy = np.minimum(np.minimum(ay, by), cy), np.maximum(np.maximum(ay, by), cy)

    finite = np.isfinite(x) & np.isfinite(y)
    order = np.argsort(x, kind="stable")
    order = order[finite[order]]

    for start in range(0, len(order), _CHUNK):
        idx = order[start : start + _CHUNK]
        px, py = x[idx], y[idx]
        cand = np.nonzero(
            (tmaxx >= px.min() - tol)
            & (tminx <= px.max() + tol)
            & (tmaxy >= py.min() - tol)
            & (tminy <= py.max() + tol)
        )[0]
        if len(cand) == 0:
            continue
        px_, py_ = px[:, None], py[:, None]
        a_x, a_y = ax[cand][None, :], ay[cand][None, :]
        b_x, b_y = bx[cand][None, :], by[cand][None, :]
        c_x, c_y = cx[cand][None, :], cy[cand][None, :]
        d1 = (px_ - b_x) * (a_y - b_y) - (a_x - b_x) * (py_ - b_y)
        d2 = (px_ - c_x) * (b_y - c_y) - (b_x - c_x) * (py_ - c_y)
        d3 = (px_ - a_x) * (c_y - a_y) - (c_x - a_x) * (py_ - a_y)
        has_neg = (d1 < -tol) | (d2 < -tol) | (d3 < -tol)
        has_pos = (d1 > tol) | (d2 > tol) | (d3 > tol)
        inside = ~(has_neg & has_pos)
        hit = inside.any(axis=1)
        first = np.argmax(inside, axis=1)
        out[idx[hit]] = tri_cell[cand[first[hit]]]
    return out


def layer_from_z(geometry: Geometry, cell: np.ndarray, z: np.ndarray) -> np.ndarray:
    """The layer whose elevations bracket ``z`` in ``cell``, or ``-1``.

    ``-1`` for a point with no cell, a non-finite ``z``, a ``z`` above the
    top or below the bottom, and for every point when the geometry carries
    no elevations. A ``z`` exactly on a boundary belongs to the layer above
    it, so a point never lands in two layers.
    """
    cell = np.asarray(cell, dtype=np.int64)
    z = np.asarray(z, dtype=np.float64)
    out = np.full(len(cell), -1, dtype=np.int64)
    if geometry.top is None or geometry.botm is None:
        return out
    top = np.asarray(geometry.top, dtype=np.float64)
    botm = np.asarray(geometry.botm, dtype=np.float64)
    ok = (cell >= 0) & (cell < len(top)) & np.isfinite(z)
    if not ok.any():
        return out
    c, zz = cell[ok], z[ok]
    uppers = np.vstack([top[c][None, :], botm[:-1, c]]) if botm.shape[0] > 1 else top[c][None, :]
    lowers = botm[:, c]
    inside = (zz[None, :] <= uppers) & (zz[None, :] >= lowers)
    found = inside.any(axis=0)
    out[ok] = np.where(found, np.argmax(inside, axis=0), -1)
    return out
