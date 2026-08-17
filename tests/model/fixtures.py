"""Synthetic MODFLOW 6 binary grid files (``.grb``), written by hand so the
whole grid-reading path is testable with no external data and no network.

The format is a self-describing record list: four 50-character header
lines, then one 100-character text record per data record naming its key,
type, dimensionality and shape, then the binary payload in the same order.
This module writes exactly the record set each discretisation needs and
nothing more; both writers were checked against flopy's own reader
(``flopy.mf6.utils.MfGrdFile``) before being written here, so a record it
rejects means the reader's own header parsing is the reference, not this
module's comments.

No structured (DIS) grid file exists anywhere in this repository or in any
benchmark run -- every real fixture reachable from this project is DISV --
so ``write_dis_grb`` is the only way to test the structured path at all.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np

_HEADER_LEN = 50
_TEXT_LEN = 100

_DTYPES = {"INTEGER": np.int32, "DOUBLE": np.float64}

# A small hand-built mesh: three cells with 4-, 5- and 6-sided rings,
# sharing vertices with their neighbours rather than each owning a private
# set. Ring vertex counts must stay (4, 5, 6) -- every value below (vertex
# count, closed-ring lengths, NVERT) is derived from this exact layout.
_VERTICES = (
    (0.0, 0.0),
    (1.0, 0.0),
    (1.0, 1.0),
    (0.0, 1.0),
    (2.0, 0.0),
    (2.0, 1.0),
    (1.5, 1.6),
    (3.0, 0.0),
    (3.6, 0.6),
    (3.2, 1.6),
    (2.4, 2.0),
)
_RINGS = (
    (0, 1, 2, 3),
    (1, 4, 5, 6, 2),
    (5, 7, 8, 9, 10, 6),
)


def _pad(text: str, width: int) -> bytes:
    if len(text) > width:
        raise ValueError(f"text record too long for width {width}: {text!r}")
    return text.ljust(width).encode("ascii")


def _text_record(key: str, dtype_name: str, ndim: int, shape: tuple[int, ...]) -> str:
    parts = [key, dtype_name, "NDIM", str(ndim)]
    parts.extend(str(d) for d in shape)
    return " ".join(parts)


def _write_grb(
    path: Path,
    grid_type: str,
    records: list[tuple[str, str, int, tuple[int, ...], object]],
) -> Path:
    """Write the four-line header, the text-record table, then every
    record's binary payload, in that order -- the one record-writing shape
    both ``write_disv_grb`` and ``write_dis_grb`` share.

    ``records`` is ``(key, dtype_name, ndim, header_shape, payload)``;
    ``header_shape`` is what the text record declares (already in the
    reversed order flopy's reader expects), while ``payload`` is flattened
    to a 1-D array of ``dtype_name`` before being written -- the reader
    only cares about the element count and order, not the array's
    in-memory shape.
    """
    path = Path(path)
    with open(path, "wb") as f:
        f.write(_pad(f"GRID {grid_type}", _HEADER_LEN))
        f.write(_pad("VERSION 1", _HEADER_LEN))
        f.write(_pad(f"NTXT {len(records)}", _HEADER_LEN))
        f.write(_pad(f"LENTXT {_TEXT_LEN}", _HEADER_LEN))
        for key, dtype_name, ndim, shape, _ in records:
            f.write(_pad(_text_record(key, dtype_name, ndim, shape), _TEXT_LEN))
        for key, dtype_name, _ndim, _shape, payload in records:
            array = np.asarray(payload, dtype=_DTYPES[dtype_name]).reshape(-1)
            f.write(array.tobytes())
    return path


def write_disv_grb(
    path: Path,
    *,
    xorigin: float = 1000.0,
    yorigin: float = 2000.0,
    angrot: float = 0.0,
    nlay: int = 2,
    inactive_layer: int = 1,
    inactive_cell: int = 1,
    inconsistent_botm: bool = False,
) -> Path:
    """Write a small synthetic DISV binary grid file to ``path`` and return
    it.

    Two layers, three cells whose rings have 4, 5 and 6 vertices sharing
    vertices between neighbours, a non-zero ``XORIGIN``/``YORIGIN``, and
    one inactive cell (``inactive_cell`` in ``inactive_layer``, both
    zero-based) -- one file that exercises unshared-vertex expansion,
    mixed-sided fanning, model-coordinate placement and a non-trivial
    ``idomain`` at once.

    ``inconsistent_botm=True`` declares ``BOTM`` with length ``ncpl``
    instead of ``nlay * ncpl`` -- every individual record is still well
    formed, but the grid they describe is not. Against flopy's own reader,
    this is the shape that reaches "parsed but no model grid could be
    built": flopy's ``_set_modelgrid`` catches the resulting reshape
    failure internally, prints a line, and leaves the model grid unset,
    never raising to its caller.
    """
    path = Path(path)
    ncpl = len(_RINGS)
    nvert = len(_VERTICES)

    # IAVERT/JAVERT are one-based on disk, and each ring is stored closed
    # (its first vertex repeated at the end) -- flopy subtracts one and
    # strips the repeat on read, so what pesto ever sees is the open,
    # zero-based ring in ``_RINGS`` above.
    closed_rings = [list(ring) + [ring[0]] for ring in _RINGS]
    javert = np.array(
        [vertex + 1 for ring in closed_rings for vertex in ring], dtype=np.int32
    )
    boundaries = np.cumsum([0] + [len(ring) for ring in closed_rings])
    iavert = (boundaries + 1).astype(np.int32)
    njavert = int(javert.shape[0])

    ncells = nlay * ncpl
    # A self-consistent diagonal-only connectivity -- pesto's grid reading
    # never touches IA/JA, so this only has to be internally consistent,
    # not a real connection graph.
    ia = np.arange(1, ncells + 2, dtype=np.int32)
    ja = np.arange(1, ncells + 1, dtype=np.int32)
    nja = ncells

    idomain = np.ones((nlay, ncpl), dtype=np.int32)
    idomain[inactive_layer, inactive_cell] = 0

    verts_array = np.array(_VERTICES, dtype=np.float64)
    top = np.full(ncpl, 10.0, dtype=np.float64)
    botm = np.empty((nlay, ncpl), dtype=np.float64)
    for lay in range(nlay):
        botm[lay, :] = 10.0 - 5.0 * (lay + 1)

    cellx = np.array(
        [sum(_VERTICES[v][0] for v in ring) / len(ring) for ring in _RINGS], dtype=np.float64
    )
    celly = np.array(
        [sum(_VERTICES[v][1] for v in ring) / len(ring) for ring in _RINGS], dtype=np.float64
    )

    # (key, dtype name, ndim, header shape dims, payload). Order matches
    # the record list a DISV grid needs. VERTICES is the one two-dimensional
    # record: the reader reverses the shape numbers it reads, so its real
    # shape (nvert, 2) is declared here as "2 nvert", in that order.
    records: list[tuple[str, str, int, tuple[int, ...], object]] = [
        ("NCELLS", "INTEGER", 0, (), ncells),
        ("NLAY", "INTEGER", 0, (), nlay),
        ("NCPL", "INTEGER", 0, (), ncpl),
        ("NVERT", "INTEGER", 0, (), nvert),
        ("NJAVERT", "INTEGER", 0, (), njavert),
        ("NJA", "INTEGER", 0, (), nja),
        ("XORIGIN", "DOUBLE", 0, (), xorigin),
        ("YORIGIN", "DOUBLE", 0, (), yorigin),
        ("ANGROT", "DOUBLE", 0, (), angrot),
        ("TOP", "DOUBLE", 1, (ncpl,), top),
        (
            ("BOTM", "DOUBLE", 1, (ncpl,), botm[0])
            if inconsistent_botm
            else ("BOTM", "DOUBLE", 1, (nlay * ncpl,), botm.reshape(-1))
        ),
        ("VERTICES", "DOUBLE", 2, (2, nvert), verts_array),
        ("CELLX", "DOUBLE", 1, (ncpl,), cellx),
        ("CELLY", "DOUBLE", 1, (ncpl,), celly),
        ("IAVERT", "INTEGER", 1, (ncpl + 1,), iavert),
        ("JAVERT", "INTEGER", 1, (njavert,), javert),
        ("IA", "INTEGER", 1, (ncells + 1,), ia),
        ("JA", "INTEGER", 1, (nja,), ja),
        ("IDOMAIN", "INTEGER", 1, (nlay * ncpl,), idomain.reshape(-1)),
    ]

    return _write_grb(path, "DISV", records)


def write_dis_grb(
    path: Path,
    *,
    nlay: int = 2,
    nrow: int = 3,
    ncol: int = 4,
    delr: float = 10.0,
    delc: float = 20.0,
    xorigin: float = 1000.0,
    yorigin: float = 2000.0,
    angrot: float = 0.0,
    idomain: bool = True,
) -> Path:
    """Write a small synthetic DIS (structured) binary grid file to
    ``path`` and return it.

    Unlike the DISV writer, this carries no ``VERTICES``/``IAVERT``/
    ``JAVERT`` records at all -- flopy's ``StructuredGrid`` computes its
    vertices geometrically from ``DELR``/``DELC`` plus the origin and
    rotation, the same way it would for a real MODFLOW 6 structured model,
    so there is nothing to hand-write there. ``idomain=False`` omits the
    ``IDOMAIN`` record entirely, which is the shape a grid file with no
    idomain record actually takes on disk -- not an array of ones.
    """
    path = Path(path)
    ncells = nlay * nrow * ncol
    nja = ncells

    delr_array = np.full(ncol, delr, dtype=np.float64)
    delc_array = np.full(nrow, delc, dtype=np.float64)
    top = np.full(nrow * ncol, 10.0, dtype=np.float64)
    botm = np.empty((nlay, nrow, ncol), dtype=np.float64)
    for lay in range(nlay):
        botm[lay, :, :] = 10.0 - 5.0 * (lay + 1)

    # A self-consistent diagonal-only connectivity, same convention as
    # ``write_disv_grb`` -- pesto's grid reading never touches IA/JA, so
    # this only has to be internally consistent, not a real connection
    # graph. IA and JA are one-based on disk.
    ia = np.arange(1, ncells + 2, dtype=np.int32)
    ja = np.arange(1, ncells + 1, dtype=np.int32)

    records: list[tuple[str, str, int, tuple[int, ...], object]] = [
        ("NCELLS", "INTEGER", 0, (), ncells),
        ("NLAY", "INTEGER", 0, (), nlay),
        ("NROW", "INTEGER", 0, (), nrow),
        ("NCOL", "INTEGER", 0, (), ncol),
        ("NJA", "INTEGER", 0, (), nja),
        ("XORIGIN", "DOUBLE", 0, (), xorigin),
        ("YORIGIN", "DOUBLE", 0, (), yorigin),
        ("ANGROT", "DOUBLE", 0, (), angrot),
        ("DELR", "DOUBLE", 1, (ncol,), delr_array),
        ("DELC", "DOUBLE", 1, (nrow,), delc_array),
        ("TOP", "DOUBLE", 1, (nrow * ncol,), top),
        ("BOTM", "DOUBLE", 1, (nlay * nrow * ncol,), botm.reshape(-1)),
        ("IA", "INTEGER", 1, (ncells + 1,), ia),
        ("JA", "INTEGER", 1, (nja,), ja),
    ]
    if idomain:
        idomain_array = np.ones(nlay * nrow * ncol, dtype=np.int32)
        records.append(("IDOMAIN", "INTEGER", 1, (nlay * nrow * ncol,), idomain_array))

    return _write_grb(path, "DIS", records)
