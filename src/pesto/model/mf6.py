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
plausible-looking empty mesh; four real failure modes -- a truncated or
corrupt grid file, a file flopy parses into no grid at all, a grid that
declares no cells, and a parameter table with no ``pargp`` column -- are
each handled explicitly for this reason. The fourth is a defect in the
parameter table handed to ``locate_par``, not in the grid file, so it is
named and reasoned about separately from the other three.

``crs()`` returns nothing for every run this milestone can open, because the
binary grid format carries no projection field and ``pyproj`` is not a
project dependency. That is a normal state here, not an error.
"""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from pesto.ingest.failures import ReadFailure
from pesto.model import Geometry, GridShape, MeshBuffers, ObsCells, ParCells, fan_polygons
from pesto.model import GroupResolution
from pesto.model._mf6obs import observation_input_files as _observation_input_files
from pesto.model._mf6obs import SitePlacement, place_sites, read_observation_input
from pesto.model._parcells import UNMAPPED, _summarize, resolve

OBS_INPUT_RULE = "mf6-obs"
NO_GROUP_LABEL = "(no obgnme)"
_NOT_FOUND_TEXT = "the model's observation input (mfsim.nam) was not found in the run folder"


def observation_input_files(run_dir: Path) -> tuple[Path, ...]:
    """The MF6 text files a site's placement can come from: ``mfsim.nam``, the
    model name files, the OBS6 files, and each package file that names an OBS6
    file with its OPEN/CLOSE period files. Empty when the run has no ``mfsim.nam``."""
    return _observation_input_files(Path(run_dir))


def _not_found_note(unplaced: int) -> str:
    return (
        f"{unplaced} site(s) are unplaced and the model's observation input "
        "(mfsim.nam) was not found in the run folder"
    )


def note_missing_observation_input(cells: ObsCells) -> ObsCells:
    """``cells`` with one note that the model's observation input was not
    found, when some site is unplaced. For a run with no ``mfsim.nam``, where
    the adapter is built without a run folder."""
    unplaced = int((cells.cell < 0).sum())
    if not unplaced:
        return cells
    site_note = cells.site_note
    if site_note is not None:
        site_note = tuple(
            "; ".join(filter(None, (text, _NOT_FOUND_TEXT))) if cells.cell[i] < 0 else text
            for i, text in enumerate(site_note)
        )
    return replace(cells, notes=(*cells.notes, _not_found_note(unplaced)), site_note=site_note)


def _column_reason(label: str, group: GroupResolution | None) -> str:
    if group is None or group.mapped == 0:
        return f"no placement column rule applied to group {label}"
    return f"group {label} was placed by rule {group.rule}, but this site's own placement values could not be used"


def _site_rule_and_note(
    sites: pd.DataFrame,
    result: ParCells,
    cell: np.ndarray,
    layer: np.ndarray,
    placement: SitePlacement | None,
    input_missing: bool,
) -> tuple[tuple[str, ...], tuple[str, ...]]:
    """One rule and one sentence per site: the rule that placed it ("unmapped"
    when none did), and why it is unplaced or has no layer."""
    labels = [NO_GROUP_LABEL if pd.isna(v) else str(v) for v in sites["obgnme"]]
    by_group = {g.group: g for g in result.groups}
    rules: list[str] = []
    notes: list[str] = []
    for i, label in enumerate(labels):
        group = by_group.get(label)
        own = placement.site_note[i] if placement is not None and placement.site_note else ""
        if result.cell[i] >= 0:
            rules.append(group.rule if group is not None else UNMAPPED)
            blank = "layer unknown: blank layer in the control file" if layer[i] < 0 else ""
            notes.append("; ".join(filter(None, (blank, own))))
        elif cell[i] >= 0:
            rules.append(OBS_INPUT_RULE)
            blank = "layer unknown" if layer[i] < 0 and not own else ""
            notes.append(own or blank)
        else:
            rules.append(UNMAPPED)
            tail = _NOT_FOUND_TEXT if input_missing else own
            notes.append("; ".join(filter(None, (_column_reason(label, group), tail))))
    return tuple(rules), tuple(notes)


class Mf6Adapter:
    """The spatial adapter for a MODFLOW 6 run, built from its binary grid
    file (``.grb``). ``model_dir`` is the run folder; when given, sites the
    control file's columns leave unplaced are looked up in the model's own
    observation input there. It is only ever read."""

    def __init__(self, grb_path: Path, model_dir: Path | None = None) -> None:
        self._grb_path = Path(grb_path)
        self._model_dir = None if model_dir is None else Path(model_dir)
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

    def geometry(self) -> Geometry | ReadFailure:
        """The fanned mesh plus the grid's elevations. ``top``/``botm`` come
        back ``None`` when flopy's grid carries none, which places nothing by
        ``z`` rather than guessing a layer."""
        grid = self._grid_or_failure()
        if isinstance(grid, ReadFailure):
            return grid
        mesh = self.grid_mesh()
        if isinstance(mesh, ReadFailure):
            return mesh
        top = getattr(grid, "top", None)
        botm = getattr(grid, "botm", None)
        ncpl = mesh.n_cells
        top_arr = None if top is None else np.asarray(top, dtype=np.float64).reshape(-1)
        botm_arr = (
            None
            if botm is None
            else np.asarray(botm, dtype=np.float64).reshape(int(grid.nlay), -1)
        )
        if top_arr is not None and top_arr.shape[0] != ncpl:
            top_arr, botm_arr = None, None
        if botm_arr is not None and botm_arr.shape[1] != ncpl:
            top_arr, botm_arr = None, None
        # The render mesh is float32, which moves an edge by up to half a metre
        # at real northings; placement uses the grid's own float64 vertices,
        # copied per cell in the same order fan_polygons uses.
        verts = np.asarray(grid.verts, dtype=np.float64)
        positions = np.concatenate([verts[np.asarray(list(cell), dtype=np.int64)] for cell in grid.iverts])
        return Geometry(
            positions=positions,
            cell_index=mesh.cell_index,
            indices=mesh.indices,
            top=top_arr,
            botm=botm_arr,
            xoff=float(grid.xoffset or 0.0),
            yoff=float(grid.yoffset or 0.0),
            angrot=float(grid.angrot or 0.0),
        )

    def locate_par(self, par: pd.DataFrame) -> ParCells | ReadFailure:
        shape = self.grid_shape()
        if isinstance(shape, ReadFailure):
            return shape
        geometry = self.geometry()
        if isinstance(geometry, ReadFailure):
            return geometry
        return resolve(par, shape, geometry=geometry)

    def locate_obs(self, sites: pd.DataFrame) -> ObsCells | ReadFailure:
        shape = self.grid_shape()
        if isinstance(shape, ReadFailure):
            return shape
        geometry = self.geometry()
        if isinstance(geometry, ReadFailure):
            return geometry
        result = resolve(
            sites, shape, geometry=geometry, group_column="obgnme", sites=True
        )
        if isinstance(result, ReadFailure):
            return result
        notes = result.notes
        evidence = self._layer_base_note(sites, result, shape)
        if evidence is not None:
            notes = notes + (evidence,)
        cell, layer, groups, summary = result.cell, result.layer, result.groups, result.summary
        placement: SitePlacement | None = None
        searched = False
        if self._model_dir is not None and len(sites):
            cell, layer, groups, summary, extra, placement, searched = (
                self._place_from_observation_input(sites, result, shape)
            )
            notes = notes + extra
        site_rule, site_note = _site_rule_and_note(
            sites, result, cell, layer, placement, self._model_dir is not None and not searched
        )
        return ObsCells(
            cell=cell,
            layer=layer,
            site=result.parnme,
            groups=groups,
            summary=summary,
            notes=notes,
            point_xy=result.point_xy,
            site_rule=site_rule,
            site_note=site_note,
        )

    def _place_from_observation_input(
        self, sites: pd.DataFrame, result: ParCells, shape: GridShape
    ) -> tuple[
        np.ndarray, np.ndarray, tuple[GroupResolution, ...], str, tuple[str, ...], SitePlacement | None, bool
    ]:
        """Place the still-unplaced sites by joining their ``id`` to the names
        in the model's observation input. Placed sites are never moved. The
        last two values are the per-site placement and whether the input was
        found at all."""
        observations = read_observation_input(self._model_dir, self._grb_path.name)
        cell, layer = result.cell.copy(), result.layer.copy()
        unplaced = int((cell < 0).sum())
        if not observations.found:
            if not unplaced:
                return cell, layer, result.groups, result.summary, (), None, False
            return cell, layer, result.groups, result.summary, (_not_found_note(unplaced),), None, False
        if "id" in sites.columns:
            ids = [("" if pd.isna(v) else str(v)) for v in sites["id"]]
        else:
            ids = [""] * len(sites)
        placement = place_sites(list(result.parnme), ids, observations, shape, cell, layer)
        notes = observations.notes + placement.notes
        gained = placement.cell >= 0
        if not gained.any():
            return cell, layer, result.groups, result.summary, notes, placement, True
        cell[gained], layer[gained] = placement.cell[gained], placement.layer[gained]
        labels = np.array(
            [NO_GROUP_LABEL if pd.isna(v) else str(v) for v in sites["obgnme"]], dtype=object
        )
        groups = []
        for group in result.groups:
            more = int(gained[labels == group.group].sum())
            if more == 0:
                groups.append(group)
                continue
            rule = OBS_INPUT_RULE if group.mapped == 0 and group.rule == UNMAPPED else group.rule
            groups.append(
                GroupResolution(group=group.group, rule=rule, mapped=group.mapped + more, total=group.total)
            )
        groups_tuple = tuple(groups)
        summary = _summarize(groups_tuple, len(sites), "observation group", "sites")
        return cell, layer, groups_tuple, summary, notes, placement, True

    def _layer_base_note(
        self, sites: pd.DataFrame, result: ParCells, shape: GridShape
    ) -> str | None:
        """The D-02 evidence: of the sites placed by ``icpl-layer`` with a known
        layer, how many sit in active cells if the layer is read zero-based and
        how many if it is read one-based. Nothing is decided here; a wrong base
        would show as the zero-based count falling behind the one-based one."""
        groups = {g.group for g in result.groups if g.rule == "icpl-layer"}
        if not groups:
            return None
        in_group = sites["obgnme"].astype(str).isin(groups).to_numpy()
        rows = np.nonzero(in_group & (result.cell >= 0) & (result.layer >= 0))[0]
        if len(rows) == 0:
            return None
        cells, layers = result.cell[rows].astype(np.int64), result.layer[rows].astype(np.int64)
        idomain = self.idomain()
        if (
            isinstance(idomain, ReadFailure)
            or idomain is None
            or idomain.shape[0] != shape.nlay * shape.ncpl
        ):
            return (
                f"layer base: the layer base of {len(rows)} site(s) with an icpl and a layer "
                "could not be checked against active cells, because the grid file has no "
                "usable idomain; the layer is read as zero-based"
            )
        zero_based = int((idomain[layers * shape.ncpl + cells] > 0).sum())
        below = layers - 1
        known = below >= 0
        one_based = int((idomain[below[known] * shape.ncpl + cells[known]] > 0).sum())
        return (
            f"layer base: {zero_based} of {len(rows)} site(s) with an icpl and a layer sit in "
            f"active cells read as zero-based; {one_based} of {len(rows)} would sit in active "
            "cells read as one-based (layer minus 1); the layer is read as zero-based"
        )
