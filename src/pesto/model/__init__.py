"""The boundary between pesto and any particular kind of model.

Everything downstream of this package talks about a mesh, a grid shape,
placed parameters and an optional projection; nothing outside this package
knows what MODFLOW is. That is what makes a second model type one new file
rather than a rewrite of the whole app.

The ``SpatialAdapter`` protocol below reconciles two drafts that disagreed:
design spec section 2's surface, which carries ``locate_par`` and
``locate_obs``, and the M0 plan's Task 8 draft, which carries ``grid_shape``
and ``idomain``. Merging them costs one deliberate subtraction --
``layers()`` is dropped, because it is redundant with ``grid_shape().nlay``
-- and one amendment: ``locate_par`` returns the frozen ``ParCells`` record
rather than a plain DataFrame, per decision D-02, because a DataFrame has
nowhere to put which rule placed each parameter group.

``MeshBuffers`` keeps ``positions`` and ``cell_index`` as float32 while
``indices`` is uint32. An element buffer -- the triangle index list a GPU
reads to know which vertices form each triangle -- has to be an unsigned
integer type; that is what the drawing call requires. A per-vertex
attribute such as ``cell_index`` is conventionally float on a GPU, and
float32 represents every whole number up to 16,777,216 exactly, which
comfortably covers any grid this project reads. Vertices are duplicated
once per cell rather than shared between neighbours, because a shared
vertex cannot carry a value that differs by cell, and the renderer needs
every vertex it draws to know which cell it belongs to.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol, runtime_checkable

import numpy as np
import pandas as pd

from pesto.ingest.failures import ReadFailure


@dataclass(frozen=True)
class MeshBuffers:
    """The GPU-ready shape of one grid's geometry.

    ``positions`` is ``(n_vert, 2)`` float32, ``cell_index`` is ``(n_vert,)``
    float32 (a per-vertex attribute naming which cell that vertex belongs
    to), and ``indices`` is the ``(n_tri * 3,)`` uint32 triangle list.
    Vertices are duplicated per cell -- a shared vertex cannot carry a
    per-cell value. ``bounds`` is ``(xmin, xmax, ymin, ymax)``.
    """

    positions: np.ndarray
    cell_index: np.ndarray
    indices: np.ndarray
    n_cells: int
    nlay: int
    bounds: tuple[float, float, float, float]
    crs: str | None


@dataclass(frozen=True)
class GridShape:
    """A grid's cell and layer counts. ``nrow``/``ncol`` are ``None`` for a
    vertex (DISV) grid -- that absence is how the rule table in
    ``_parcells.py`` tells a vertex grid from a structured one."""

    ncpl: int
    nlay: int
    nrow: int | None
    ncol: int | None


@dataclass(frozen=True)
class GroupResolution:
    """Which rule placed one parameter group, and how much of it landed.

    ``mapped`` can be less than ``total`` -- a rule can win a group by
    placing at least one parameter and still leave some of that same
    group's rows at ``-1`` because their own cell or layer fell outside the
    grid.
    """

    group: str
    rule: str
    mapped: int
    total: int


@dataclass(frozen=True)
class ParCells:
    """Where every parameter in one table landed, and why.

    ``cell`` and ``layer`` are int32 arrays parallel to the parameter table
    that produced them, with ``-1`` meaning unresolved -- never ``0``, which
    is a real cell. ``parnme`` is the parameter name occupying each row, in
    the same order, so a caller never has to infer identity from position.
    ``groups`` carries one :class:`GroupResolution` per parameter group,
    always, and ``summary`` is the one sentence GRID-03 asks for.
    """

    cell: np.ndarray
    layer: np.ndarray
    parnme: tuple[str, ...]
    groups: tuple[GroupResolution, ...]
    summary: str
    notes: tuple[str, ...]

    @property
    def placed_groups(self) -> tuple[str, ...]:
        return tuple(g.group for g in self.groups if g.mapped > 0)

    @property
    def unplaced_groups(self) -> tuple[str, ...]:
        return tuple(g.group for g in self.groups if g.mapped == 0)


@runtime_checkable
class SpatialAdapter(Protocol):
    """Everything pesto knows how to ask a model for, whatever that model
    turns out to be."""

    def grid_mesh(self) -> MeshBuffers | ReadFailure: ...

    def grid_shape(self) -> GridShape | ReadFailure: ...

    def idomain(self) -> np.ndarray | None | ReadFailure: ...

    def crs(self) -> str | None | ReadFailure: ...

    def locate_par(self, par: pd.DataFrame) -> ParCells | ReadFailure: ...

    def locate_obs(self, obs: pd.DataFrame) -> ParCells | ReadFailure: ...


def fan_polygons(
    verts: np.ndarray,
    iverts: list[list[int]],
    nlay: int = 1,
    crs: str | None = None,
) -> MeshBuffers:
    """Fan each cell's ring of vertices into unshared-vertex triangles.

    Every cell's vertices are copied into ``positions`` rather than shared
    with its neighbours, because a shared vertex cannot carry a per-cell
    value and the renderer needs every vertex to know which cell it came
    from (``cell_index``). Each ring is triangulated by fanning from its
    own first vertex.

    Precondition: ``iverts`` holds at least one ring. A grid with no cells
    is refused as unreadable before this function is ever called -- see
    ``Mf6Adapter._grid_or_failure`` -- so this function does not check for
    that case and does not invent a bounds value for an empty mesh.
    """
    verts = np.asarray(verts, dtype=np.float64)
    positions = np.empty((sum(len(cell) for cell in iverts), 2), dtype=np.float32)
    cell_index = np.empty(positions.shape[0], dtype=np.float32)
    triangles: list[np.ndarray] = []
    offset = 0
    for cell_number, cell in enumerate(iverts):
        count = len(cell)
        positions[offset : offset + count] = verts[np.asarray(cell, dtype=np.int64)]
        cell_index[offset : offset + count] = cell_number
        if count >= 3:
            fan = np.empty((count - 2, 3), dtype=np.uint32)
            fan[:, 0] = offset
            fan[:, 1] = offset + np.arange(1, count - 1, dtype=np.uint32)
            fan[:, 2] = offset + np.arange(2, count, dtype=np.uint32)
            triangles.append(fan.reshape(-1))
        offset += count
    indices = (
        np.concatenate(triangles).astype(np.uint32)
        if triangles
        else np.empty(0, dtype=np.uint32)
    )
    return MeshBuffers(
        positions=positions,
        cell_index=cell_index,
        indices=indices,
        n_cells=len(iverts),
        nlay=nlay,
        bounds=(
            float(positions[:, 0].min()),
            float(positions[:, 0].max()),
            float(positions[:, 1].min()),
            float(positions[:, 1].max()),
        ),
        crs=crs,
    )
