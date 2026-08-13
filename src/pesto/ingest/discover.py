"""Work out what a pestpp-ies run directory holds -- pattern matching only.

Per D-09, this module opens no ensemble, grid or data file; the only file it
reads is the control file, and only as a line scan. Per D-10 it reports only
what it recognised and never lists unmatched files -- a real pestpp working
directory also holds template files, instruction files, model input/output
and worker leftovers, and naming all of that buries the one line that
matters.

A path returned in a :class:`RunLayout` is a name that matched a pestpp-ies
naming convention, never a promise that the file behind it is readable.
Discovery opens nothing but the control file, so a truncated or corrupt
ensemble file matches exactly like a healthy one -- the read path is where an
unreadable file surfaces by name and reason, and a caller must not treat a
populated layout as a clean bill of health.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping

_NOPTMAX_RE = re.compile(r"^\s*noptmax\s+(-?\d+)", re.IGNORECASE)
_MACOS_RESOURCE_FORK_PREFIX = "._"

_ENS_EXTS = "jcb|jco|bin|csv"
_ITER_TOKEN = r"\d+|prior|mean"
_GRID_EXT = ".grb"
_PHI_KINDS = ("actual", "meas", "regul", "composite", "group", "lambda")

# Iteration keys are plain unbounded ints for the ordinary numbered case, or
# one of the literal tags pestpp's own save path can emit in place of a
# number ("prior", "mean" -- RESEARCH.md Open Question 1). Never a sentinel
# collision with a real iteration number.
IterationKey = int | str


class NoRunFound(Exception):
    """Raised when ``run_dir`` holds no control file (``*.pst``)."""


def _parse_iteration(token: str) -> IterationKey:
    if token.isdigit():
        return int(token)
    return token.lower()


@dataclass(frozen=True)
class RunLayout:
    """One pestpp-ies run directory's discovered inventory.

    Every path here is a filename that matched a pestpp-ies naming
    convention -- discovery opened nothing to produce it. Mappings keyed by
    iteration use plain ``int`` keys for the ordinary numbered case and the
    literal strings ``"prior"``/``"mean"`` for the tagged variant pestpp's
    own save path can emit in place of a number; the two never collide.
    Named accessor methods are provided so callers do not have to remember
    each mapping's key shape.
    """

    run_dir: Path
    case: str
    pst_path: Path
    noptmax: int
    iterations: tuple[int, ...]
    par_ens: Mapping[IterationKey, Path]
    obs_ens: Mapping[IterationKey, Path]
    rejected_par_ens: Mapping[IterationKey, Path]
    rejected_obs_ens: Mapping[IterationKey, Path]
    phi: Mapping[str, Path]
    pdc: Mapping[IterationKey, Path]
    pcs: Mapping[tuple[IterationKey, str], Path]
    grid: Path | None
    noise: Path | None
    notes: tuple[str, ...]

    def par_ensemble(self, iteration: IterationKey) -> Path | None:
        return self.par_ens.get(iteration)

    def obs_ensemble(self, iteration: IterationKey) -> Path | None:
        return self.obs_ens.get(iteration)

    def rejected_par_ensemble(self, iteration: IterationKey) -> Path | None:
        return self.rejected_par_ens.get(iteration)

    def rejected_obs_ensemble(self, iteration: IterationKey) -> Path | None:
        return self.rejected_obs_ens.get(iteration)

    def phi_file(self, kind: str) -> Path | None:
        return self.phi.get(kind.lower())

    def pdc_file(self, iteration: IterationKey) -> Path | None:
        return self.pdc.get(iteration)

    def pcs_file(self, iteration: IterationKey, infix: str = "") -> Path | None:
        """The pcs file for ``iteration``. ``infix`` selects the plain file
        (default, empty string) or a tagged variant such as ``"reinflate"``.
        """
        return self.pcs.get((iteration, infix.lower()))


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
    """Find one pestpp-ies run's control file and its full artifact
    inventory, without opening any of it but the control file.

    Refuses clearly rather than folding a bad input into an empty result,
    the way ``resolve_cache_root`` does: ``NotADirectoryError`` when
    ``run_dir`` is not an existing directory, and ``NoRunFound`` when the
    directory holds no control file. A directory with a control file but no
    ensembles at all returns a layout with empty ensemble mappings -- that
    is an ordinary, if early, run, not an error.

    Matching rules require the case prefix, the iteration segment and the
    artifact-kind segment together wherever all three apply. Both real
    benchmark directories hold hundreds of pilot-point factor files and an
    adjusted-weights matrix that end in a real ensemble extension; a rule
    matching on extension or case prefix alone would report all of them as
    ensembles and hand later phases ingest jobs that cannot succeed. The
    grid file is the one exception -- it is matched by extension alone,
    because real runs name it after the model, not the case.

    Extensions and artifact keywords match case-insensitively. Any entry
    whose basename begins with the macOS resource-fork prefix (``._``) is
    skipped entirely.

    Every path in the returned layout is a name that matched -- discovery
    opens no ensemble, grid or data file, so a matched name is never a
    promise that the file behind it is readable. That distinction is what
    lets a later read failure surface as a named, per-artifact fact instead
    of a surprise.
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

    escaped_case = re.escape(case)
    ens_re = re.compile(
        rf"^{escaped_case}\.(?P<iter>{_ITER_TOKEN})\."
        rf"(?:(?P<tag>rejected)\.)?(?P<kind>par|obs)\.(?:{_ENS_EXTS})$",
        re.IGNORECASE,
    )
    phi_re = re.compile(
        rf"^{escaped_case}\.phi\.(?P<kind>{'|'.join(_PHI_KINDS)})\.csv$",
        re.IGNORECASE,
    )
    pdc_re = re.compile(rf"^{escaped_case}\.(?P<iter>{_ITER_TOKEN})\.pdc\.csv$", re.IGNORECASE)
    pcs_re = re.compile(
        rf"^{escaped_case}\.(?P<iter>{_ITER_TOKEN})\.(?:(?P<infix>[A-Za-z0-9]+)\.)?pcs\.csv$",
        re.IGNORECASE,
    )
    noise_re = re.compile(
        rf"^{escaped_case}\.{re.escape('obs+noise')}\.(?:{_ENS_EXTS})$", re.IGNORECASE
    )

    par_ens: dict[IterationKey, Path] = {}
    obs_ens: dict[IterationKey, Path] = {}
    rejected_par_ens: dict[IterationKey, Path] = {}
    rejected_obs_ens: dict[IterationKey, Path] = {}
    phi: dict[str, Path] = {}
    pdc: dict[IterationKey, Path] = {}
    pcs: dict[tuple[IterationKey, str], Path] = {}
    grid: Path | None = None
    noise: Path | None = None

    for candidate in sorted(run_path.iterdir()):
        name = candidate.name
        if name.startswith(_MACOS_RESOURCE_FORK_PREFIX):
            continue
        if not candidate.is_file():
            continue

        match = ens_re.match(name)
        if match:
            iter_key = _parse_iteration(match.group("iter"))
            kind = match.group("kind").lower()
            if match.group("tag"):
                target = rejected_par_ens if kind == "par" else rejected_obs_ens
            else:
                target = par_ens if kind == "par" else obs_ens
            target[iter_key] = candidate
            continue

        match = phi_re.match(name)
        if match:
            phi[match.group("kind").lower()] = candidate
            continue

        match = noise_re.match(name)
        if match:
            noise = candidate
            continue

        match = pcs_re.match(name)
        if match:
            iter_key = _parse_iteration(match.group("iter"))
            infix = (match.group("infix") or "").lower()
            pcs[(iter_key, infix)] = candidate
            continue

        match = pdc_re.match(name)
        if match:
            iter_key = _parse_iteration(match.group("iter"))
            pdc[iter_key] = candidate
            continue

        if grid is None and candidate.suffix.lower() == _GRID_EXT:
            grid = candidate

    iterations = tuple(
        sorted(k for k in set(par_ens) | set(obs_ens) if isinstance(k, int))
    )

    return RunLayout(
        run_dir=run_path,
        case=case,
        pst_path=pst_path,
        noptmax=noptmax,
        iterations=iterations,
        par_ens=par_ens,
        obs_ens=obs_ens,
        rejected_par_ens=rejected_par_ens,
        rejected_obs_ens=rejected_obs_ens,
        phi=phi,
        pdc=pdc,
        pcs=pcs,
        grid=grid,
        noise=noise,
        notes=(),
    )
