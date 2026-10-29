"""Walk a straight line across a grid of polygon cells, in float64.

The rings are a flat vertex list relative to the mesh origin: ``vx``, ``vy``
(float64) and ``start`` (``ncpl + 1``), so cell ``c`` owns vertices
``start[c]:start[c + 1]``. A and B are in the same frame. The answer is a list
of pieces ``(cell, s0, s1)``, with ``s`` measured from A along the line.

Each candidate cell's breakpoints are the two ends plus every edge crossing; a
gap between two breakpoints is kept when its midpoint is inside the closed
polygon. Kept gaps of one cell are merged, and where two cells claim the same
stretch (a line running along a shared edge) the lower cell index wins.

Pure numpy on purpose: nothing here knows about pesto, the cache or the model.
"""

from __future__ import annotations

import numpy as np


class LineTooShort(ValueError):
    """The two ends of the line are closer together than the tolerance."""


def cell_bboxes(vx, vy, start):
    """Each cell's bounding box, as ``(xmin, xmax, ymin, ymax)`` arrays."""
    idx = start[:-1]
    return (
        np.minimum.reduceat(vx, idx),
        np.maximum.reduceat(vx, idx),
        np.minimum.reduceat(vy, idx),
        np.maximum.reduceat(vy, idx),
    )


def _slab_candidates(bbox, a, d, tol):
    x0, x1, y0, y1 = bbox
    tmin = np.zeros(x0.shape[0])
    tmax = np.ones(x0.shape[0])
    ok = np.ones(x0.shape[0], dtype=bool)
    for lo, hi, a_c, d_c in ((x0, x1, a[0], d[0]), (y0, y1, a[1], d[1])):
        lo = lo - tol
        hi = hi + tol
        if abs(d_c) < 1e-300:
            # A line parallel to this axis meets the box only if it starts inside the slab.
            ok &= (a_c >= lo) & (a_c <= hi)
        else:
            t1 = (lo - a_c) / d_c
            t2 = (hi - a_c) / d_c
            tmin = np.maximum(tmin, np.minimum(t1, t2))
            tmax = np.minimum(tmax, np.maximum(t1, t2))
    return np.nonzero(ok & (tmin <= tmax))[0]


def _empty(counts):
    return np.empty(0, np.int64), np.empty(0), np.empty(0), counts


def walk(vx, vy, start, a, b, tol, bbox=None):
    """The pieces of the line from ``a`` to ``b``, ordered by ``s0`` then cell.

    Returns ``(cell, s0, s1, counts)``; ``counts`` holds ``candidates`` (cells
    whose box the line meets), ``zero_length_dropped`` and ``ties_resolved``.
    Raises ``LineTooShort`` when the line is no longer than ``tol``.
    """
    vx = np.asarray(vx, dtype=np.float64)
    vy = np.asarray(vy, dtype=np.float64)
    start = np.asarray(start, dtype=np.int64)
    a = np.asarray(a, dtype=np.float64)
    b = np.asarray(b, dtype=np.float64)
    d = b - a
    length = float(np.hypot(*d))
    counts = {"candidates": 0, "zero_length_dropped": 0, "ties_resolved": 0}
    if not length > tol:
        raise LineTooShort(
            f"the line is {length!r} long, no longer than the tolerance {tol!r}"
        )
    if bbox is None:
        bbox = cell_bboxes(vx, vy, start)
    cand = _slab_candidates(bbox, a, d, tol)
    counts["candidates"] = int(cand.size)
    if cand.size == 0:
        return _empty(counts)

    n_k = (start[cand + 1] - start[cand]).astype(np.int64)
    e_off = np.concatenate([[0], np.cumsum(n_k)])
    n_edges = int(e_off[-1])
    k_of_edge = np.repeat(np.arange(cand.size), n_k)
    j = np.arange(n_edges) - e_off[k_of_edge]
    base = start[cand][k_of_edge]
    i0 = base + j
    i1 = base + (j + 1) % n_k[k_of_edge]
    px, py = vx[i0], vy[i0]
    ex, ey = vx[i1] - px, vy[i1] - py
    wx, wy = px - a[0], py - a[1]

    den = d[0] * ey - d[1] * ex
    elen = np.hypot(ex, ey)
    parallel = np.abs(den) <= 1e-12 * length * np.maximum(elen, 1e-300)
    # a + t d = p + u e  gives  t = (w x e) / (d x e),  u = (w x d) / (d x e),  w = p - a
    safe_den = np.where(parallel, 1.0, den)
    u_edge = (wx * d[1] - wy * d[0]) / safe_den
    t_edge = (wx * ey - wy * ex) / safe_den
    tol_t = tol / length
    tol_u = tol / np.maximum(elen, 1e-300)
    hit = (
        (~parallel)
        & (t_edge >= -tol_t)
        & (t_edge <= 1 + tol_t)
        & (u_edge >= -tol_u)
        & (u_edge <= 1 + tol_u)
    )

    # An edge lying on the line has no single crossing, so both its ends become breakpoints.
    dist_line = np.abs(wx * d[1] - wy * d[0]) / length
    collinear = parallel & (dist_line <= tol)
    t_p0 = np.clip((wx * d[0] + wy * d[1]) / length**2, 0, 1)
    t_p1 = np.clip(((wx + ex) * d[0] + (wy + ey) * d[1]) / length**2, 0, 1)

    every = np.arange(cand.size)
    bk = np.concatenate([every, every, k_of_edge[hit], k_of_edge[collinear], k_of_edge[collinear]])
    bt = np.concatenate(
        [
            np.zeros(cand.size),
            np.ones(cand.size),
            np.clip(t_edge[hit], 0, 1),
            t_p0[collinear],
            t_p1[collinear],
        ]
    )
    order = np.lexsort((bt, bk))
    bk, bt = bk[order], bt[order]

    same = bk[1:] == bk[:-1]
    g_k = bk[:-1][same]
    g_t0 = bt[:-1][same]
    g_t1 = bt[1:][same]
    mid_t = 0.5 * (g_t0 + g_t1)
    mx = a[0] + mid_t * d[0]
    my = a[1] + mid_t * d[1]

    # Each gap's midpoint is tested against the edges of its own cell only.
    n_g = n_k[g_k]
    g_off = np.concatenate([[0], np.cumsum(n_g)])
    g_of_pair = np.repeat(np.arange(g_k.size), n_g)
    pair_edge = e_off[g_k][g_of_pair] + (np.arange(int(g_off[-1])) - g_off[g_of_pair])
    qx, qy = mx[g_of_pair], my[g_of_pair]
    x0, y0 = px[pair_edge], py[pair_edge]
    x1, y1 = x0 + ex[pair_edge], y0 + ey[pair_edge]
    straddle = (y0 > qy) != (y1 > qy)
    with np.errstate(divide="ignore", invalid="ignore"):
        xcross = x0 + (qy - y0) * (x1 - x0) / (y1 - y0)
    right = straddle & (qx < xcross)
    crossings = np.bincount(g_of_pair, weights=right.astype(float), minlength=g_k.size)
    inside = (crossings.astype(np.int64) % 2) == 1
    # A midpoint within tol of an edge counts as inside, so a line along an edge keeps it.
    ee = ex[pair_edge]
    ff = ey[pair_edge]
    ll = np.maximum(ee * ee + ff * ff, 1e-300)
    u = np.clip(((qx - x0) * ee + (qy - y0) * ff) / ll, 0, 1)
    dist = np.hypot(qx - (x0 + u * ee), qy - (y0 + u * ff))
    on_edge = np.bincount(g_of_pair, weights=(dist <= tol).astype(float), minlength=g_k.size) > 0
    keep = inside | on_edge

    k_c = g_k[keep]
    t0 = g_t0[keep]
    t1 = g_t1[keep]
    if k_c.size == 0:
        return _empty(counts)
    new = np.ones(k_c.size, dtype=bool)
    new[1:] = (k_c[1:] != k_c[:-1]) | (t0[1:] > t1[:-1] + tol_t)
    first = np.nonzero(new)[0]
    last = np.concatenate([first[1:], [k_c.size]]) - 1
    p_cell = cand[k_c[first]].astype(np.int64)
    p_s0 = t0[first] * length
    p_s1 = t1[last] * length

    p_cell, p_s0, p_s1 = _resolve_ties(p_cell, p_s0, p_s1, tol, counts)

    long_enough = (p_s1 - p_s0) > tol
    counts["zero_length_dropped"] += int((~long_enough).sum())
    p_cell, p_s0, p_s1 = p_cell[long_enough], p_s0[long_enough], p_s1[long_enough]
    order = np.lexsort((p_cell, p_s0))
    return p_cell[order], p_s0[order], p_s1[order], counts


def _resolve_ties(cell, s0, s1, tol, counts):
    """Split overlapping pieces at every end and give each stretch to the
    lowest cell index covering it, so no stretch of the line is drawn twice."""
    order = np.argsort(s0, kind="stable")
    cell, s0, s1 = cell[order], s0[order], s1[order]
    if cell.size < 2:
        return cell, s0, s1
    run_end = np.maximum.accumulate(s1)
    overlap = s0[1:] < run_end[:-1] - tol
    if not overlap.any():
        return cell, s0, s1
    bps = np.unique(np.concatenate([s0, s1]))
    bps = bps[np.concatenate([[True], np.diff(bps) > tol])]
    out_c: list[int] = []
    out_a: list[float] = []
    out_b: list[float] = []
    for lo, hi in zip(bps[:-1], bps[1:]):
        mid = 0.5 * (lo + hi)
        cover = (s0 <= mid) & (s1 >= mid)
        if not cover.any():
            continue
        winner = int(cell[cover].min())
        if cover.sum() > 1:
            counts["ties_resolved"] += 1
        if out_c and out_c[-1] == winner and abs(out_b[-1] - lo) <= tol:
            out_b[-1] = float(hi)
        else:
            out_c.append(winner)
            out_a.append(float(lo))
            out_b.append(float(hi))
    return np.array(out_c, np.int64), np.array(out_a), np.array(out_b)
