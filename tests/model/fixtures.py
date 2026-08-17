"""A synthetic MODFLOW 6 binary grid file (``.grb``), written by hand so the
whole grid-reading path is testable with no external data and no network.

The format is a self-describing record list: four 50-character header
lines, then one 100-character text record per data record naming its key,
type, dimensionality and shape, then the binary payload in the same order.
This module writes exactly the record set a DISV grid needs and nothing
more; it was checked against flopy's own reader (``flopy.mf6.utils.MfGrdFile``)
before being written here, so a record it rejects means the reader's own
header parsing is the reference, not this module's comments.
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


def write_disv_grb(
    path: Path,
    *,
    xorigin: float = 1000.0,
    yorigin: float = 2000.0,
    angrot: float = 0.0,
    nlay: int = 2,
    inactive_layer: int = 1,
    inactive_cell: int = 1,
) -> Path:
    """Write a small synthetic DISV binary grid file to ``path`` and return
    it.

    Two layers, three cells whose rings have 4, 5 and 6 vertices sharing
    vertices between neighbours, a non-zero ``XORIGIN``/``YORIGIN``, and
    one inactive cell (``inactive_cell`` in ``inactive_layer``, both
    zero-based) -- one file that exercises unshared-vertex expansion,
    mixed-sided fanning, model-coordinate placement and a non-trivial
    ``idomain`` at once.
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
        ("BOTM", "DOUBLE", 1, (nlay * ncpl,), botm.reshape(-1)),
        ("VERTICES", "DOUBLE", 2, (2, nvert), verts_array),
        ("CELLX", "DOUBLE", 1, (ncpl,), cellx),
        ("CELLY", "DOUBLE", 1, (ncpl,), celly),
        ("IAVERT", "INTEGER", 1, (ncpl + 1,), iavert),
        ("JAVERT", "INTEGER", 1, (njavert,), javert),
        ("IA", "INTEGER", 1, (ncells + 1,), ia),
        ("JA", "INTEGER", 1, (nja,), ja),
        ("IDOMAIN", "INTEGER", 1, (nlay * ncpl,), idomain.reshape(-1)),
    ]

    with open(path, "wb") as f:
        f.write(_pad("GRID DISV", _HEADER_LEN))
        f.write(_pad("VERSION 1", _HEADER_LEN))
        f.write(_pad(f"NTXT {len(records)}", _HEADER_LEN))
        f.write(_pad(f"LENTXT {_TEXT_LEN}", _HEADER_LEN))
        for key, dtype_name, ndim, shape, _ in records:
            f.write(_pad(_text_record(key, dtype_name, ndim, shape), _TEXT_LEN))
        for key, dtype_name, _, _shape, payload in records:
            array = np.asarray(payload, dtype=_DTYPES[dtype_name]).reshape(-1)
            f.write(array.tobytes())

    return path
