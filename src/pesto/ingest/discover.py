"""Work out what a pestpp-ies run directory holds -- pattern matching only.

Tracer scope covers one artifact kind: the control file, its line-scanned
``noptmax``, and the per-iteration parameter ensembles that follow the
``{case}.{iteration}.par.{ext}`` naming convention. Per D-09 this module
opens no ensemble and no grid file; the only file it reads is the control
file, and only as a line scan. Per D-10 it reports only what it recognised
and never lists unmatched files -- a file whose name promises more than its
contents deliver is not caught here; that is the read path's job.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping

_NOPTMAX_RE = re.compile(r"^\s*noptmax\s+(-?\d+)", re.IGNORECASE)
_MACOS_RESOURCE_FORK_PREFIX = "._"
_PAR_ENS_EXTS = "jcb|jco|bin|csv"


class NoRunFound(Exception):
    """Raised when ``run_dir`` holds no control file (``*.pst``)."""


@dataclass(frozen=True)
class RunLayout:
    """One pestpp-ies run directory's discovered inventory.

    Tracer scope holds only the control file and its per-iteration parameter
    ensembles. Later plans in this phase add observation ensembles, starting
    ensembles, phi, pcs/pdc and the grid file to this same record.
    """

    run_dir: Path
    case: str
    pst_path: Path
    noptmax: int
    iterations: tuple[int, ...]
    par_ens: Mapping[int, Path]
    notes: tuple[str, ...]


def _read_noptmax(pst_path: Path) -> int:
    """Scan the control file's lines for a plain ``noptmax <int>`` keyword
    line, case-insensitively. Verified this session against four real
    control files, all of which write it as a plain keyword line."""
    with open(pst_path, "r", errors="replace") as f:
        for line in f:
            match = _NOPTMAX_RE.match(line)
            if match:
                return int(match.group(1))
    raise ValueError(f"no noptmax line found in control file: {pst_path}")


def discover(run_dir: Path) -> RunLayout:
    """Find one pestpp-ies run's control file and per-iteration parameter
    ensembles, without opening either.

    Refuses clearly rather than folding a bad input into an empty result,
    the way ``resolve_cache_root`` does: ``NotADirectoryError`` when
    ``run_dir`` is not an existing directory, and ``NoRunFound`` when the
    directory holds no control file.
    """
    run_path = Path(run_dir)
    if not run_path.is_dir():
        raise NotADirectoryError(f"not a directory: {run_path}")

    pst_matches = sorted(run_path.glob("*.pst"))
    if not pst_matches:
        raise NoRunFound(f"no control file (*.pst) found in {run_path}")
    pst_path = pst_matches[0]
    case = pst_path.stem

    noptmax = _read_noptmax(pst_path)

    # The case prefix AND the iteration AND the "par" segment are all
    # required together: real benchmark directories hold files such as
    # "factors.coarse.boundary.layer10.bin" and
    # "escondida.adjusted.weights.bin", which a looser glob on extension or
    # case prefix alone would sweep in as ensembles.
    par_ens_re = re.compile(
        rf"^{re.escape(case)}\.(?P<iter>\d+)\.par\.(?:{_PAR_ENS_EXTS})$",
        re.IGNORECASE,
    )

    par_ens: dict[int, Path] = {}
    for candidate in run_path.iterdir():
        if candidate.name.startswith(_MACOS_RESOURCE_FORK_PREFIX):
            continue
        match = par_ens_re.match(candidate.name)
        if match:
            par_ens[int(match.group("iter"))] = candidate

    iterations = tuple(sorted(par_ens))

    return RunLayout(
        run_dir=run_path,
        case=case,
        pst_path=pst_path,
        noptmax=noptmax,
        iterations=iterations,
        par_ens=par_ens,
        notes=(),
    )
