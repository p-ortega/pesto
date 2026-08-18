"""The run's own facts, written into ``config.json`` -- never a fact about
any ingest.

The measurement-noise fact is the one that changes what every other figure
in the header means, so it is never reduced to a bare yes or no: it records
what pesto found and what decided it, so a modeller can tell a run that was
deliberately calibrated without noise from a leading space that ate their
``standard_deviation`` column. Every other fact here follows the same rule
this project applies everywhere else -- a field pesto could not determine is
recorded as unknown with a reason, never as a default that reads like a
measurement.

Ingest time and cache size are facts about a past ingest, not about the run,
and belong in the manifest alongside the per-artifact rows describing that
same ingest. Nothing written here may describe an ingest, so that nothing
describing a past ingest can ever be mistaken for a fact about the run.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

from pesto.cache._atomic import write_atomic_text
from pesto.cache.layout import CACHE_VERSION, CacheLayout
from pesto.cache.manifest import CacheFile, WrittenArtifact
from pesto.ingest.failures import ReadFailure

if TYPE_CHECKING:
    from pesto.ingest.control import ControlTables
    from pesto.ingest.discover import RunLayout
    from pesto.ingest.ensfile import EnsembleData
    from pesto.model import SpatialAdapter

    # Nothing here is imported at runtime: every use below is duck-typed
    # attribute access on an object the caller already read, and importing
    # pesto.model from pesto.cache would add a real dependency this module
    # does not need to carry.

# The legacy "++option(value)" dialect, alongside the plain
# "option    value" keyword form _scan_ies_no_noise also recognises --
# pyemu's own version=2 writer produces the latter.
_IES_NO_NOISE_LEGACY_RE = re.compile(r"^\s*\+\+\s*ies_no_noise\s*\(\s*([^)]*)\)", re.IGNORECASE)

_TRUE_TOKENS = frozenset({"true", "1", "yes"})
_FALSE_TOKENS = frozenset({"false", "0", "no"})


def _parse_bool_token(token: str) -> bool | None:
    lowered = token.strip().lower()
    if lowered in _TRUE_TOKENS:
        return True
    if lowered in _FALSE_TOKENS:
        return False
    return None


def _scan_ies_no_noise(pst_path: Path) -> tuple[bool | None, str | None]:
    """Line-scan ``pst_path`` for an ``ies_no_noise`` option, the same
    plain-text idiom ``discover.py``'s own control-file scan uses -- never a
    ``pyemu.Pst()`` parse.

    Returns ``(value, evidence)``. ``evidence`` is ``None`` only when the
    option was not found at all, or the file could not be read, so a caller
    can tell "not mentioned" from "mentioned with a value that made no
    sense" -- the latter still returns evidence, with ``value=None``.
    """
    try:
        with pst_path.open("r", encoding="utf-8", errors="strict") as f:
            for line in f:
                legacy = _IES_NO_NOISE_LEGACY_RE.match(line)
                if legacy:
                    token = legacy.group(1).strip()
                    return _parse_bool_token(token), f"ies_no_noise={token}"

                stripped = line.strip()
                if not stripped:
                    continue
                parts = stripped.split(None, 1)
                if len(parts) != 2:
                    continue
                key, rest = parts
                if key.strip().lower() != "ies_no_noise":
                    continue
                rest_tokens = rest.split()
                token = rest_tokens[0] if rest_tokens else ""
                return _parse_bool_token(token), f"ies_no_noise={token}"
    except (OSError, UnicodeDecodeError):
        return None, None
    return None, None


@dataclass(frozen=True)
class NoiseFact:
    """What pesto found about measurement noise, and what decided it.

    ``has_noise`` is ``None`` when pesto could not tell -- a different
    answer from ``False``, and one that must stay different all the way to
    the screen. ``decided_by`` is one of ``"noise_ensemble"``,
    ``"ies_no_noise"``, ``"standard_deviation_column"`` or
    ``"undetermined"``, and is never empty.
    """

    has_noise: bool | None
    decided_by: str
    evidence: tuple[str, ...]
    notes: tuple[str, ...]


def describe_noise(run: "RunLayout", tables: "ControlTables") -> NoiseFact:
    """Work out what pesto found about measurement noise, checking in
    order: the control file's ``ies_no_noise`` option, a noise ensemble
    named by ``run.noise`` and present on disk, and a ``standard_deviation``
    column in ``tables.obs``.

    The control-file option wins when it disagrees with a noise ensemble on
    disk, because a run whose author switched noise off is describing their
    own intent -- the disagreement goes into ``notes`` rather than being
    resolved silently. Where the observation table's ``standard_deviation``
    column carries one of Phase 2's stripped-header notes, that note is
    carried into ``evidence`` -- a column that only parsed after a leading
    space was stripped and one that was written cleanly are the same fact
    with different provenance, and the difference is exactly what tells a
    modeller whether their run was deliberately calibrated without noise or
    whether a stray space ate their column. When nothing decides it,
    ``has_noise`` is ``None``, ``decided_by`` is ``"undetermined"``, and
    ``evidence`` lists each place pesto looked.
    """
    notes: list[str] = []

    no_noise_value, no_noise_evidence = _scan_ies_no_noise(run.pst_path)
    ensemble_found = run.noise is not None

    if no_noise_evidence is not None and no_noise_value is not None:
        has_noise = not no_noise_value
        if has_noise is False and ensemble_found:
            notes.append(
                f"ies_no_noise says there is no noise, but a noise ensemble "
                f"{run.noise.name} is present on disk -- the control-file "
                f"option takes precedence"
            )
        return NoiseFact(
            has_noise=has_noise,
            decided_by="ies_no_noise",
            evidence=(no_noise_evidence,),
            notes=tuple(notes),
        )

    checked: list[str] = []
    if no_noise_evidence is not None:
        checked.append(
            f"ies_no_noise was set but its value could not be read as true or false ({no_noise_evidence})"
        )
    else:
        checked.append("no ies_no_noise option in the control file")

    if ensemble_found:
        return NoiseFact(
            has_noise=True,
            decided_by="noise_ensemble",
            evidence=(run.noise.name,),
            notes=tuple(notes),
        )
    checked.append("no measurement-noise ensemble found on disk")

    if "standard_deviation" in tables.obs.columns:
        evidence = ["observation table carries a standard_deviation column"]
        for note in tables.notes:
            if "standard_deviation" in note and "stripped" in note:
                evidence.append(note)
        return NoiseFact(
            has_noise=True,
            decided_by="standard_deviation_column",
            evidence=tuple(evidence),
            notes=tuple(notes),
        )
    checked.append("no standard_deviation column in the observation table")

    return NoiseFact(
        has_noise=None,
        decided_by="undetermined",
        evidence=tuple(checked),
        notes=tuple(notes),
    )


@dataclass(frozen=True)
class RunConfig:
    """One run's own facts -- nothing about any ingest.

    Every count pesto could not determine is ``None``, never zero -- a run
    whose control file could not be read has an unknown parameter count, and
    zero would say the run has no parameters. ``projection_known`` separates
    "there is no projection" from "pesto could not find out", which are
    different chips on a screen and different answers to a modeller.
    """

    cache_version: int
    run_dir: str
    case: str
    n_par: int | None
    n_real: int | None
    base_realization: bool | None
    n_iterations: int | None
    noptmax: int | None
    first_iteration: int | None
    last_iteration: int | None
    projection: str | None
    projection_known: bool
    noise: NoiseFact
    notes: tuple[str, ...]


def build_config(
    run: "RunLayout",
    tables: "ControlTables",
    first: "EnsembleData | None",
    adapter: "SpatialAdapter | None",
) -> RunConfig:
    """Assemble one run's facts from what earlier phases already read.

    The parameter count is the row count of ``tables.par``. The realization
    count is ``len(first.real_names)`` and ``base_realization`` is whether
    the exact string ``"base"`` is among them -- exact, because a
    realization named ``"Base"`` is a different realization and pesto does
    not decide otherwise on the modeller's behalf. The iteration count,
    ``noptmax``, and the first and last iteration numbers come from
    ``run``. The projection comes from ``adapter.crs()`` when an adapter
    exists; a ``ReadFailure`` or a missing adapter leaves ``projection``
    unknown rather than guessing at "there is none".
    """
    notes: list[str] = list(run.notes) + list(tables.notes)

    n_par = len(tables.par)

    if first is not None:
        n_real = len(first.real_names)
        base_realization = "base" in first.real_names
    else:
        n_real = None
        base_realization = None
        notes.append("no realization data available to count realizations or find base")

    n_iterations = len(run.iterations)
    first_iteration = min(run.iterations) if run.iterations else None
    last_iteration = max(run.iterations) if run.iterations else None

    if adapter is None:
        projection = None
        projection_known = False
        notes.append("no grid file, so no spatial adapter exists to report a projection")
    else:
        crs_result = adapter.crs()
        if isinstance(crs_result, ReadFailure):
            projection = None
            projection_known = False
            notes.append(f"projection could not be determined: {crs_result.reason}")
        else:
            # crs_result is None for every run this milestone can open --
            # the binary grid format carries no projection field. That is a
            # known answer ("there is none"), not an unknown one.
            projection = crs_result
            projection_known = True

    noise = describe_noise(run, tables)

    return RunConfig(
        cache_version=CACHE_VERSION,
        run_dir=str(run.run_dir),
        case=run.case,
        n_par=n_par,
        n_real=n_real,
        base_realization=base_realization,
        n_iterations=n_iterations,
        noptmax=run.noptmax,
        first_iteration=first_iteration,
        last_iteration=last_iteration,
        projection=projection,
        projection_known=projection_known,
        noise=noise,
        notes=tuple(notes),
    )


def write_config(config: RunConfig, layout: CacheLayout) -> WrittenArtifact | ReadFailure:
    """Write ``config`` to ``layout.config`` atomically: a temp file in the
    cache root, then a rename, following the same idiom every other cache
    writer in this project uses.

    The payload holds run facts only -- ingest duration and cache size
    belong to the manifest, alongside the per-artifact rows describing the
    same ingest, so that nothing describing a past ingest can be mistaken
    for a fact about the run.
    """
    name = "config"
    target = layout.config
    try:
        payload = {
            "cache_version": config.cache_version,
            "run_dir": config.run_dir,
            "case": config.case,
            "n_par": config.n_par,
            "n_real": config.n_real,
            "base_realization": config.base_realization,
            "n_iterations": config.n_iterations,
            "noptmax": config.noptmax,
            "first_iteration": config.first_iteration,
            "last_iteration": config.last_iteration,
            "projection": config.projection,
            "projection_known": config.projection_known,
            "noise": {
                "has_noise": config.noise.has_noise,
                "decided_by": config.noise.decided_by,
                "evidence": list(config.noise.evidence),
                "notes": list(config.noise.notes),
            },
            "notes": list(config.notes),
        }
        written = write_atomic_text(target, json.dumps(payload, indent=2))
        cache_file = CacheFile(path=str(target.relative_to(layout.root)), bytes=written)
        return WrittenArtifact(name=name, files=(cache_file,))
    except Exception as exc:
        return ReadFailure(
            name=name,
            path=str(target),
            reason=f"failed to write run configuration {target.name}: {exc}",
        )


def _optional_int(value: object) -> int | None:
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    return None


def _optional_bool(value: object) -> bool | None:
    if isinstance(value, bool):
        return value
    return None


def _optional_str(value: object) -> str | None:
    if isinstance(value, str):
        return value
    return None


def _tuple_of_str(value: object) -> tuple[str, ...]:
    if not isinstance(value, list):
        return ()
    return tuple(v for v in value if isinstance(v, str))


def _undetermined_noise() -> NoiseFact:
    return NoiseFact(has_noise=None, decided_by="undetermined", evidence=(), notes=())


def _empty_config() -> RunConfig:
    """A config that states nothing -- every count ``None``, no projection,
    an undetermined noise fact. What ``load_config`` returns for any
    failure, so a parse failure can never report something as known."""
    return RunConfig(
        cache_version=CACHE_VERSION,
        run_dir="",
        case="",
        n_par=None,
        n_real=None,
        base_realization=None,
        n_iterations=None,
        noptmax=None,
        first_iteration=None,
        last_iteration=None,
        projection=None,
        projection_known=False,
        noise=_undetermined_noise(),
        notes=(),
    )


def load_config(layout: CacheLayout) -> RunConfig:
    """Read ``layout.config`` back, following ``Manifest.load``'s shape
    exactly.

    Every failure mode -- absent, unreadable, not valid JSON, valid JSON of
    the wrong shape, or written at a different ``cache_version`` -- resolves
    to a config that states nothing rather than raising or reporting a
    partially populated record. Each key's type is checked before it is
    used; a field that survived the JSON parse but carries the wrong type
    is recorded as unknown rather than passed through as a fabricated fact.
    """
    try:
        data = json.loads(layout.config.read_text())
    except (OSError, json.JSONDecodeError):
        return _empty_config()

    if not isinstance(data, dict):
        return _empty_config()

    if data.get("cache_version") != CACHE_VERSION:
        return _empty_config()

    run_dir = data.get("run_dir", "")
    if not isinstance(run_dir, str):
        return _empty_config()

    case = data.get("case", "")
    if not isinstance(case, str):
        return _empty_config()

    noise_data = data.get("noise")
    if not isinstance(noise_data, dict):
        return _empty_config()

    try:
        decided_by = noise_data.get("decided_by")
        noise = NoiseFact(
            has_noise=_optional_bool(noise_data.get("has_noise")),
            decided_by=decided_by if isinstance(decided_by, str) and decided_by else "undetermined",
            evidence=_tuple_of_str(noise_data.get("evidence")),
            notes=_tuple_of_str(noise_data.get("notes")),
        )

        return RunConfig(
            cache_version=CACHE_VERSION,
            run_dir=run_dir,
            case=case,
            n_par=_optional_int(data.get("n_par")),
            n_real=_optional_int(data.get("n_real")),
            base_realization=_optional_bool(data.get("base_realization")),
            n_iterations=_optional_int(data.get("n_iterations")),
            noptmax=_optional_int(data.get("noptmax")),
            first_iteration=_optional_int(data.get("first_iteration")),
            last_iteration=_optional_int(data.get("last_iteration")),
            projection=_optional_str(data.get("projection")),
            projection_known=bool(data.get("projection_known", False)),
            noise=noise,
            notes=_tuple_of_str(data.get("notes")),
        )
    except (KeyError, TypeError, ValueError, AttributeError):
        return _empty_config()
