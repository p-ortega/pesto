"""The MODFLOW 6 implementation of the spatial adapter.

The binary grid file (``.grb``) gives the same interface for a structured
(DIS) grid and a vertex (DISV) grid, so the mesh is built identically
whatever the discretisation; only the grid shape differs, and a vertex grid
has no rows or columns at all.

This module keeps two rules. First, construction opens nothing and loads no
heavy library -- pesto's launcher opens a browser window before ``flopy`` or
``pyemu`` finish importing, and this adapter must not be the thing that
makes that wait longer. Second, a grid file that cannot be read costs one
failure record, never an exception at the caller and never a
plausible-looking empty mesh; three real failure modes -- a truncated or
corrupt file, a file flopy parses into no grid at all, and a grid that
declares no cells -- are each handled explicitly for this reason.

``crs()`` returns nothing for every run this milestone can open, because the
binary grid format carries no projection field and ``pyproj`` is not a
project dependency. That is a normal state here, not an error.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from pesto.ingest.failures import ReadFailure
from pesto.model import GridShape, MeshBuffers, ParCells, fan_polygons
from pesto.model._parcells import resolve


class Mf6Adapter:
    """The spatial adapter for a MODFLOW 6 run, built from its binary grid
    file (``.grb``)."""

    def __init__(self, grb_path: Path) -> None:
        self._grb_path = Path(grb_path)
        self._grid: Any = None
        self._failure: ReadFailure | None = None

    def _grid_or_failure(self) -> Any:
        """Parse the grid file on first use and cache the result -- success
        or failure -- so a bad file is parsed once, not once per call.

        Three failure modes are handled explicitly, because all three are
        real: a truncated or corrupt file makes flopy raise; a partially
        readable file makes flopy print a message and hand back a
        ``modelgrid`` of ``None``; and a grid whose cell list comes back
        empty is a file that could not be read as a grid, refused here
        rather than passed on to geometry.
        """
        if self._grid is not None:
            return self._grid
        if self._failure is not None:
            return self._failure

        from pesto.warm import load_flopy

        load_flopy()
        from flopy.mf6.utils import MfGrdFile

        try:
            grid = MfGrdFile(str(self._grb_path)).modelgrid
        except Exception as exc:
            self._failure = ReadFailure(
                name=self._grb_path.name,
                path=str(self._grb_path),
                reason=f"failed to parse grid file {self._grb_path.name}: {exc}",
            )
            return self._failure

        if grid is None:
            self._failure = ReadFailure(
                name=self._grb_path.name,
                path=str(self._grb_path),
                reason=(
                    f"grid file {self._grb_path.name} could not be read as a "
                    "grid -- flopy returned no model grid for it"
                ),
            )
            return self._failure

        if len(grid.iverts) == 0:
            self._failure = ReadFailure(
                name=self._grb_path.name,
                path=str(self._grb_path),
                reason=f"grid file {self._grb_path.name} declared no cells",
            )
            return self._failure

        self._grid = grid
        return self._grid

    def grid_mesh(self) -> MeshBuffers | ReadFailure:
        grid = self._grid_or_failure()
        if isinstance(grid, ReadFailure):
            return grid
        return fan_polygons(
            np.asarray(grid.verts),
            [list(cell) for cell in grid.iverts],
            nlay=int(grid.nlay),
            crs=self.crs(),
        )

    def grid_shape(self) -> GridShape | ReadFailure:
        grid = self._grid_or_failure()
        if isinstance(grid, ReadFailure):
            return grid
        ncpl = getattr(grid, "ncpl", None)
        if ncpl is None:
            ncpl = len(grid.iverts)
        return GridShape(
            ncpl=int(ncpl),
            nlay=int(grid.nlay),
            nrow=getattr(grid, "nrow", None),
            ncol=getattr(grid, "ncol", None),
        )

    def idomain(self) -> np.ndarray | None | ReadFailure:
        grid = self._grid_or_failure()
        if isinstance(grid, ReadFailure):
            return grid
        idomain = grid.idomain
        if idomain is None:
            return None
        return np.asarray(idomain).reshape(-1)

    def crs(self) -> str | None | ReadFailure:
        grid = self._grid_or_failure()
        if isinstance(grid, ReadFailure):
            return grid
        return getattr(grid, "crs", None)

    def locate_par(self, par: pd.DataFrame) -> ParCells | ReadFailure:
        shape = self.grid_shape()
        if isinstance(shape, ReadFailure):
            return shape
        return resolve(par, shape)

    def locate_obs(self, obs: pd.DataFrame) -> ParCells | ReadFailure:
        return ReadFailure(
            name=self._grb_path.name,
            path=str(self._grb_path),
            reason=(
                "observation placement is not implemented for MODFLOW 6 in "
                "this milestone -- the observation table carries no spatial "
                "columns, so there is nothing to place"
            ),
        )
