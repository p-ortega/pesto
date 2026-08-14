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

from pesto.ingest.choices import Ambiguity, choose_one

_NOPTMAX_RE = re.compile(r"^\s*noptmax\s+(-?\d+)", re.IGNORECASE)
_MACOS_RESOURCE_FORK_PREFIX = "._"

_ENS_EXTS = "jcb|jco|bin|csv"
_ITER_TOKEN = r"\d+|prior|mean"
_GRID_EXT = ".grb"
_PHI_KINDS = ("actual", "meas", "regul", "composite", "group", "lambda")

# The starting ensembles pestpp-ies reads as *input* -- named by the control
# file under whatever filename the user gave them, never following the
# case-and-iteration convention its own output follows. RESEARCH.md's
# Pitfall 1: four real control files, four different naming schemes, zero
# matches to filename globbing.
_STARTING_ENSEMBLE_OPTION_KEYS = {
    "ies_par_en": "par",
    "ies_parameter_ensemble": "par",
    "ies_obs_en": "obs",
    "ies_observation_ensemble": "obs",
}

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

    ``ambiguities`` carries the choices this read made among recognised
    files that matched the same slot -- one entry per slot with more than
    one candidate, each also rendered into ``notes`` so the structured and
    prose channels never disagree.
    """

    run_dir: Path
    case: str
    pst_path: Path
    noptmax: int | None
    iterations: tuple[int, ...]
    par_ens: Mapping[IterationKey, Path]
    obs_ens: Mapping[IterationKey, Path]
    rejected_par_ens: Mapping[IterationKey, Path]
    rejected_obs_ens: Mapping[IterationKey, Path]
    starting_par_ens: Path | None
    starting_obs_ens: Path | None
    phi: Mapping[str, Path]
    pdc: Mapping[IterationKey, Path]
    pcs: Mapping[tuple[IterationKey, str], Path]
    grid: Path | None
    noise: Path | None
    notes: tuple[str, ...]
    ambiguities: tuple[Ambiguity, ...]

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


@dataclass(frozen=True)
class _ControlScan:
    """What one line-scan of the control file found. Never a
    ``pyemu.Pst()`` parse -- this keeps discovery instant on an 11 GB run,
    the same promise D-09 already makes for ``noptmax``."""

    noptmax: int | None
    par_en_key: str | None
    par_en_name: str | None
    obs_en_key: str | None
    obs_en_name: str | None
    notes: tuple[str, ...]


def _scan_control_file(pst_path: Path) -> _ControlScan:
    """Line-scan the control file for ``noptmax`` and the starting-ensemble
    options (RESEARCH.md Pitfall 1), matching option keys after
    lower-casing and stripping so an upper-cased or extra-whitespace line
    still resolves.

    Every uncertainty resolves to the documented safe answer: a control
    file that cannot be opened or decoded yields no ``noptmax`` and no
    starting-ensemble names, plus a note naming the file and the reason,
    rather than raising. Discovery already found this file by name; its own
    unreadability is a fact about the run, not a reason to abort the whole
    pass.
    """
    try:
        with pst_path.open("r", encoding="utf-8", errors="strict") as f:
            lines = f.readlines()
    except (OSError, UnicodeDecodeError) as exc:
        return _ControlScan(
            noptmax=None,
            par_en_key=None,
            par_en_name=None,
            obs_en_key=None,
            obs_en_name=None,
            notes=(f"could not read control file {pst_path.name}: {exc}",),
        )

    noptmax: int | None = None
    par_en_key: str | None = None
    par_en_name: str | None = None
    obs_en_key: str | None = None
    obs_en_name: str | None = None

    for line in lines:
        if noptmax is None:
            match = _NOPTMAX_RE.match(line)
            if match:
                noptmax = int(match.group(1))
                continue

        stripped = line.strip()
        if not stripped:
            continue
        parts = stripped.split(None, 1)
        if len(parts) != 2:
            continue
        raw_key, rest = parts
        key = raw_key.strip().lower()
        kind = _STARTING_ENSEMBLE_OPTION_KEYS.get(key)
        if kind is None:
            continue
        rest_tokens = rest.split()
        if not rest_tokens:
            continue
        value = rest_tokens[0]

        if kind == "par" and par_en_name is None:
            par_en_key, par_en_name = key, value
        elif kind == "obs" and obs_en_name is None:
            obs_en_key, obs_en_name = key, value

    return _ControlScan(
        noptmax=noptmax,
        par_en_key=par_en_key,
        par_en_name=par_en_name,
        obs_en_key=obs_en_key,
        obs_en_name=obs_en_name,
        notes=(),
    )


def _resolve_starting_ensemble(
    run_path: Path, key: str | None, name: str | None, notes: list[str]
) -> Path | None:
    """Resolve a starting ensemble named by the control file, relative to
    ``run_path``. A name the control file gives but that is not on disk is
    reported as named-and-missing: the field itself comes back ``None`` --
    exactly as if no option had been given -- and a note names the option
    key and the filename, so the two cases are distinguishable only through
    ``notes``, never confused as "no claim was made"."""
    if name is None:
        return None
    candidate = run_path / name
    if candidate.exists():
        return candidate
    notes.append(f"{key} names {name!r}, which is not present in {run_path.name}")
    return None


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

    The scan collects every candidate that matches a slot -- the control
    file itself, each per-iteration ensemble, each phi/pdc/pcs entry, the
    grid file, the measurement-noise ensemble -- and a single resolution
    pass afterwards is the only place a candidate becomes part of the
    result, through :func:`pesto.ingest.choices.choose_one`. Whenever more
    than one candidate matched the same slot, the chosen one and the
    rejected ones both land in ``ambiguities`` and in ``notes`` -- the
    control file itself is not exempt: two of the four run directories in
    the developer's own benchmark set hold a second ``*.pst`` file (a 70 MB
    ``tmp_d.pst`` left behind by a separate pyemu run), and the run's own
    control file wins only because its name sorts first.

    The control file is also scanned, as plain text, for the starting
    ensembles pestpp-ies reads as input: the ``ies_par_en``/
    ``ies_parameter_ensemble`` and ``ies_obs_en``/``ies_observation_ensemble``
    options, which name a file under whatever convention the user gave it --
    never the case-and-iteration convention pestpp's own output follows
    (RESEARCH.md Pitfall 1). This is the one file discovery reads, and it
    reads it only as a line scan, never a ``pyemu.Pst()`` parse. A starting
    ensemble the control file names but that is absent from disk comes back
    as ``None``, exactly like an ordinary run that names none at all, with
    the distinguishing fact recorded in ``notes`` instead. A control file
    that cannot be opened or decoded is itself a non-fatal outcome: this
    function still returns a layout, with ``noptmax`` and both starting
    ensembles absent and a note naming the file and the reason -- discovery
    already found the file by name, and one bad read costs a note, not the
    whole run.

    Calling this function twice on an unchanged directory returns equal
    layouts, and it writes nothing anywhere: it opens files only for
    reading and probes existence only with ``Path.exists``.
    """
    run_path = Path(run_dir)
    if not run_path.is_dir():
        raise NotADirectoryError(f"not a directory: {run_path}")

    pst_matches = sorted(run_path.glob("*.pst"))
    if not pst_matches:
        raise NoRunFound(f"no control file (*.pst) found in {run_path}")

    notes: list[str] = []
    ambiguities: list[Ambiguity] = []

    pst_path, control_ambiguity = choose_one(
        "control file", [(p.name, p) for p in pst_matches]
    )
    if control_ambiguity is not None:
        ambiguities.append(control_ambiguity)
        notes.append(control_ambiguity.note())
    case = pst_path.stem

    scan = _scan_control_file(pst_path)
    noptmax = scan.noptmax
    notes.extend(scan.notes)
    starting_par_ens = _resolve_starting_ensemble(
        run_path, scan.par_en_key, scan.par_en_name, notes
    )
    starting_obs_ens = _resolve_starting_ensemble(
        run_path, scan.obs_en_key, scan.obs_en_name, notes
    )

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

    # Every bucket below accumulates candidates only -- (display_name, path)
    # pairs in the order the scan saw them. Nothing here is a result: the
    # resolution pass after the loop is the only place a candidate becomes
    # one, through choose_one.
    par_ens_candidates: dict[IterationKey, list[tuple[str, Path]]] = {}
    obs_ens_candidates: dict[IterationKey, list[tuple[str, Path]]] = {}
    rejected_par_ens_candidates: dict[IterationKey, list[tuple[str, Path]]] = {}
    rejected_obs_ens_candidates: dict[IterationKey, list[tuple[str, Path]]] = {}
    phi_candidates: dict[str, list[tuple[str, Path]]] = {}
    pdc_candidates: dict[IterationKey, list[tuple[str, Path]]] = {}
    pcs_candidates: dict[tuple[IterationKey, str], list[tuple[str, Path]]] = {}
    grid_candidates: list[tuple[str, Path]] = []
    noise_candidates: list[tuple[str, Path]] = []

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
                target = rejected_par_ens_candidates if kind == "par" else rejected_obs_ens_candidates
            else:
                target = par_ens_candidates if kind == "par" else obs_ens_candidates
            target.setdefault(iter_key, []).append((name, candidate))
            continue

        match = phi_re.match(name)
        if match:
            phi_candidates.setdefault(match.group("kind").lower(), []).append((name, candidate))
            continue

        match = noise_re.match(name)
        if match:
            noise_candidates.append((name, candidate))
            continue

        match = pcs_re.match(name)
        if match:
            iter_key = _parse_iteration(match.group("iter"))
            infix = (match.group("infix") or "").lower()
            pcs_candidates.setdefault((iter_key, infix), []).append((name, candidate))
            continue

        match = pdc_re.match(name)
        if match:
            iter_key = _parse_iteration(match.group("iter"))
            pdc_candidates.setdefault(iter_key, []).append((name, candidate))
            continue

        if candidate.suffix.lower() == _GRID_EXT:
            grid_candidates.append((name, candidate))

    # Resolution pass: one call to choose_one per slot, in a deterministic
    # order (sorted by str(key), since iteration keys mix int and str), so
    # ambiguities comes out in the same order on every call.
    par_ens: dict[IterationKey, Path] = {}
    for key in sorted(par_ens_candidates, key=str):
        value, ambiguity = choose_one(
            f"parameter ensemble for iteration {key}", par_ens_candidates[key]
        )
        par_ens[key] = value
        if ambiguity is not None:
            ambiguities.append(ambiguity)
            notes.append(ambiguity.note())

    obs_ens: dict[IterationKey, Path] = {}
    for key in sorted(obs_ens_candidates, key=str):
        value, ambiguity = choose_one(
            f"observation ensemble for iteration {key}", obs_ens_candidates[key]
        )
        obs_ens[key] = value
        if ambiguity is not None:
            ambiguities.append(ambiguity)
            notes.append(ambiguity.note())

    rejected_par_ens: dict[IterationKey, Path] = {}
    for key in sorted(rejected_par_ens_candidates, key=str):
        value, ambiguity = choose_one(
            f"rejected parameter ensemble for iteration {key}",
            rejected_par_ens_candidates[key],
        )
        rejected_par_ens[key] = value
        if ambiguity is not None:
            ambiguities.append(ambiguity)
            notes.append(ambiguity.note())

    rejected_obs_ens: dict[IterationKey, Path] = {}
    for key in sorted(rejected_obs_ens_candidates, key=str):
        value, ambiguity = choose_one(
            f"rejected observation ensemble for iteration {key}",
            rejected_obs_ens_candidates[key],
        )
        rejected_obs_ens[key] = value
        if ambiguity is not None:
            ambiguities.append(ambiguity)
            notes.append(ambiguity.note())

    phi_result: dict[str, Path] = {}
    for key in sorted(phi_candidates, key=str):
        value, ambiguity = choose_one(f"{key} phi file", phi_candidates[key])
        phi_result[key] = value
        if ambiguity is not None:
            ambiguities.append(ambiguity)
            notes.append(ambiguity.note())

    pdc: dict[IterationKey, Path] = {}
    for key in sorted(pdc_candidates, key=str):
        value, ambiguity = choose_one(f"pdc file for iteration {key}", pdc_candidates[key])
        pdc[key] = value
        if ambiguity is not None:
            ambiguities.append(ambiguity)
            notes.append(ambiguity.note())

    pcs: dict[tuple[IterationKey, str], Path] = {}
    for key in sorted(pcs_candidates, key=str):
        iter_key, infix = key
        slot = (
            f"pcs file for iteration {iter_key} ({infix} variant)"
            if infix
            else f"pcs file for iteration {iter_key}"
        )
        value, ambiguity = choose_one(slot, pcs_candidates[key])
        pcs[key] = value
        if ambiguity is not None:
            ambiguities.append(ambiguity)
            notes.append(ambiguity.note())

    grid: Path | None = None
    if grid_candidates:
        grid, ambiguity = choose_one("grid file", grid_candidates)
        if ambiguity is not None:
            ambiguities.append(ambiguity)
            notes.append(ambiguity.note())

    noise: Path | None = None
    if noise_candidates:
        noise, ambiguity = choose_one("measurement-noise ensemble", noise_candidates)
        if ambiguity is not None:
            ambiguities.append(ambiguity)
            notes.append(ambiguity.note())

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
        starting_par_ens=starting_par_ens,
        starting_obs_ens=starting_obs_ens,
        phi=phi_result,
        pdc=pdc,
        pcs=pcs,
        grid=grid,
        noise=noise,
        notes=tuple(notes),
        ambiguities=tuple(ambiguities),
    )
