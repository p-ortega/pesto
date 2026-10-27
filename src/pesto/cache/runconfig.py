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
from typing import TYPE_CHECKING, Mapping, Sequence

from pesto.cache._atomic import write_atomic_text
from pesto.cache.layout import CACHE_VERSION, CacheLayout
from pesto.cache.manifest import CacheFile, WrittenArtifact
from pesto.ingest.failures import ReadFailure
from pesto.ingest.recfile import RecFacts, read_rec
from pesto.ingest.runopts import ControlOptions, OPTION_ALIASES, scan_options

if TYPE_CHECKING:
    from pesto.ingest.control import ControlTables
    from pesto.ingest.discover import RunLayout
    from pesto.ingest.ensfile import EnsembleData
    from pesto.model import SpatialAdapter

    # Nothing here is imported at runtime: every use below is duck-typed
    # attribute access on an object the caller already read, and importing
    # pesto.model from pesto.cache would add a real dependency this module
    # does not need to carry.

# Bump when the shape or meaning of the facts changes: an older config.json is
# then treated as stale and rewritten once.
FACTS_VERSION = 1
SOURCE_ORDER = ("run record", "control file", "files present", "cache")
FACT_ORDER = (
    "pestpp_version",
    "noptmax",
    "ensemble_size",
    "noise",
    "noise_band",
    "regularization",
    "localization",
    "reinflation",
    "base",
)


@dataclass(frozen=True)
class Reading:
    """What one source says about one fact.

    ``value`` is the comparable form (a number, a bool or short text) and is
    ``None`` for a reading that only supports the fact. ``shown`` is the text
    for the screen and ``evidence`` says where it came from.
    """

    source: str
    value: str | int | float | bool | None
    shown: str
    evidence: str
    extra: Mapping[str, str | int | float | bool] | None = None


@dataclass(frozen=True)
class Fact:
    """One thing about how the run was set up, with every source's reading.

    ``agree`` is ``True`` when two or more sources give the same value,
    ``False`` when any two differ, and ``None`` when there is nothing to
    compare. ``looked_for`` lists each place pesto looked, found or not.
    """

    key: str
    label: str
    readings: tuple[Reading, ...]
    agree: bool | None
    looked_for: tuple[str, ...]
    note: str | None


def _comparable(value: object) -> tuple[str, object]:
    if isinstance(value, bool):
        return ("bool", value)
    if isinstance(value, (int, float)):
        return ("number", float(value))
    return ("text", str(value).strip())


def make_fact(
    key: str,
    label: str,
    readings: Sequence[Reading],
    looked_for: Sequence[str],
    note: str | None = None,
) -> Fact:
    """The one place a fact's ``agree`` is set. Readings are put in
    ``SOURCE_ORDER`` (stable inside one source); numbers compare as numbers.

    Two readings from one source never count as agreement, because that is
    one source repeating itself.
    """
    rank = {name: position for position, name in enumerate(SOURCE_ORDER)}
    for reading in readings:
        if reading.source not in rank:
            raise ValueError(f"unknown reading source {reading.source!r} for fact {key!r}")
    ordered = tuple(sorted(readings, key=lambda r: rank[r.source]))
    valued = [r for r in ordered if r.value is not None]
    agree: bool | None
    if len(valued) < 2:
        agree = None
    elif len({_comparable(r.value) for r in valued}) > 1:
        agree = False
    elif len({r.source for r in valued}) < 2:
        agree = None
    else:
        agree = True
    if not ordered and note is None:
        note = "not found"
    return Fact(
        key=key,
        label=label,
        readings=ordered,
        agree=agree,
        looked_for=tuple(looked_for),
        note=note,
    )


def _reading_to_json(reading: Reading) -> dict:
    return {
        "source": reading.source,
        "value": reading.value,
        "shown": reading.shown,
        "evidence": reading.evidence,
        "extra": dict(reading.extra) if reading.extra is not None else None,
    }


def fact_to_json(fact: Fact) -> dict:
    return {
        "key": fact.key,
        "label": fact.label,
        "readings": [_reading_to_json(r) for r in fact.readings],
        "agree": fact.agree,
        "looked_for": list(fact.looked_for),
        "note": fact.note,
    }


def _scalar(value: object) -> bool:
    return value is None or isinstance(value, (str, int, float, bool))


def _reading_from_json(data: object) -> Reading:
    if not isinstance(data, dict):
        raise ValueError("a reading is not an object")
    source, shown, evidence = data.get("source"), data.get("shown"), data.get("evidence")
    if source not in SOURCE_ORDER or not isinstance(shown, str) or not isinstance(evidence, str):
        raise ValueError("a reading lacks its source, shown text or evidence")
    value, extra = data.get("value"), data.get("extra")
    if not _scalar(value):
        raise ValueError("a reading's value is not a plain value")
    if extra is not None and not (
        isinstance(extra, dict) and all(isinstance(k, str) and _scalar(v) for k, v in extra.items())
    ):
        raise ValueError("a reading's extra is not a flat object")
    return Reading(source, value, shown, evidence, extra)


def fact_from_json(data: object) -> Fact:
    """A stored fact back as it was written, ``agree`` included; a malformed
    one raises ``ValueError`` so the caller can refuse the whole list."""
    if not isinstance(data, dict):
        raise ValueError("a fact is not an object")
    key, label, readings = data.get("key"), data.get("label"), data.get("readings")
    agree, looked_for, note = data.get("agree"), data.get("looked_for"), data.get("note")
    if not (isinstance(key, str) and isinstance(label, str) and isinstance(readings, list)):
        raise ValueError("a fact lacks its key, label or readings")
    if agree is not None and not isinstance(agree, bool):
        raise ValueError("a fact's agree is not true, false or null")
    if not isinstance(looked_for, list) or not all(isinstance(x, str) for x in looked_for):
        raise ValueError("a fact's looked_for is not a list of text")
    if note is not None and not isinstance(note, str):
        raise ValueError("a fact's note is not text")
    return Fact(
        key=key,
        label=label,
        readings=tuple(_reading_from_json(r) for r in readings),
        agree=agree,
        looked_for=tuple(looked_for),
        note=note,
    )


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
    # ``facts_version`` is ``None`` for a config written before facts existed.
    facts: tuple[Fact, ...] = ()
    facts_version: int | None = None
    par_iterations: tuple[int, ...] = ()


def _parse_number(text: str) -> float | None:
    try:
        return float(text)
    except ValueError:
        return None


def _rec_option(rec: RecFacts | None, name: str):
    """The run record's dump entry for ``name`` under any spelling pestpp
    accepts, as ``(printed key, option)``, or ``None``."""
    if rec is None:
        return None
    for spelling in OPTION_ALIASES.get(name, (name,)):
        found = rec.options.get(spelling)
        if found is not None:
            return spelling, found
    return None


def _control_where(options: ControlOptions | None, reading) -> str:
    return f"{options.path_name} line {reading.line}: {reading.raw_key} {reading.value}"


def _version_fact(rec: RecFacts | None, rec_name: str) -> Fact:
    readings = []
    if rec is not None and rec.version is not None:
        readings.append(
            Reading("run record", str(rec.version.value), str(rec.version.value),
                    f"{rec.name} line {rec.version.line}: {rec.version.text}")
        )
    return make_fact(
        "pestpp_version",
        "pestpp version",
        readings,
        (f"a 'version:' line in {rec_name}",),
    )


def _reg_shown(value: float) -> str:
    if value == 0:
        return "off (reg_factor 0)"
    if value < 0:
        return f"on, full solution (reg_factor {value:g})"
    return f"on (reg_factor {value:g})"


def _regularization_fact(rec: RecFacts | None, options: ControlOptions | None, rec_name: str, pst_name: str) -> Fact:
    readings = []
    dump = _rec_option(rec, "ies_reg_factor")
    if dump is not None:
        key, option = dump
        value = _parse_number(option.value)
        readings.append(
            Reading(
                "run record",
                value,
                _reg_shown(value) if value is not None else f"{key} {option.value!r}, not a number",
                f"{rec.name} options dump, line {option.line}: {key}: {option.value}",
            )
        )
    if rec is not None and rec.reg_factor is not None:
        line = rec.reg_factor
        readings.append(
            Reading("run record", float(line.value), _reg_shown(float(line.value)),
                    f"{rec.name} line {line.line}: {line.text}")
        )
    reading = options.get("ies_reg_factor") if options is not None else None
    if reading is not None:
        value = _parse_number(reading.value)
        readings.append(
            Reading(
                "control file",
                value,
                _reg_shown(value) if value is not None else f"{reading.raw_key} {reading.value!r}, not a number",
                _control_where(options, reading),
            )
        )
    return make_fact(
        "regularization",
        "Regularization",
        readings,
        (
            f"the reg_factor line in {rec_name}",
            f"ies_reg_factor in the options dump of {rec_name}",
            f"ies_reg_factor or ies_reg_fac in {pst_name}",
        ),
    )


def _resolve_rec(run: "RunLayout", rec: RecFacts | ReadFailure | None) -> RecFacts | ReadFailure | None:
    """The record the caller gave, else the one in the run directory."""
    if rec is None and run.rec is not None:
        return read_rec(run.rec)
    return rec


def _resolve_options(run: "RunLayout", options: ControlOptions | ReadFailure | None) -> ControlOptions | ReadFailure:
    return options if options is not None else scan_options(run.pst_path)


def build_config(
    run: "RunLayout",
    tables: "ControlTables",
    first: "EnsembleData | None",
    adapter: "SpatialAdapter | None",
    *,
    rec: RecFacts | ReadFailure | None = None,
    options: ControlOptions | ReadFailure | None = None,
    par_iterations: Sequence[int] = (),
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

    ``rec`` and ``options`` are the run record and the control-file options
    when the caller already read them; otherwise they are read here. Every
    fact keeps each source's reading side by side, and a source that could
    not be read is named in ``notes``.
    """
    notes: list[str] = list(run.notes) + list(tables.notes)
    rec = _resolve_rec(run, rec)
    options = _resolve_options(run, options)
    for source in (rec, options):
        if isinstance(source, ReadFailure):
            notes.append(source.reason)
    rec_ok = rec if isinstance(rec, RecFacts) else None
    options_ok = options if isinstance(options, ControlOptions) else None
    if rec_ok is not None:
        notes.extend(rec_ok.notes)
    if options_ok is not None:
        notes.extend(options_ok.notes)
    rec_name = run.rec.name if run.rec is not None else f"{run.case}.rec"

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

    facts = (
        _version_fact(rec_ok, rec_name),
        _regularization_fact(rec_ok, options_ok, rec_name, run.pst_path.name),
    )

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
        facts=facts,
        facts_version=FACTS_VERSION,
        par_iterations=tuple(par_iterations),
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
            "facts_version": FACTS_VERSION,
            "facts": [fact_to_json(f) for f in config.facts],
            "par_iterations": list(config.par_iterations),
        }
        written = write_atomic_text(target, json.dumps(payload, indent=2))
        cache_file = CacheFile(path=str(target.relative_to(layout.root)), bytes=written)
        return WrittenArtifact(name=name, files=(cache_file,), notes=tuple(config.notes))
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


def _load_facts(data: dict) -> tuple[tuple[Fact, ...], int | None]:
    """The stored facts and their version. A config with no version, or with
    facts that are not shaped right, gives no facts and no version, so it
    reads as an old one rather than as a half-trusted one."""
    version = data.get("facts_version")
    if type(version) is not int:
        return (), None
    stored = data.get("facts")
    if not isinstance(stored, list):
        return (), None
    try:
        return tuple(fact_from_json(item) for item in stored), version
    except ValueError:
        return (), None


def config_outdated(layout: CacheLayout) -> bool:
    """Whether ``config.json`` needs writing again: it is missing, unreadable,
    or carries no facts of the current version. Reads only the one file."""
    try:
        data = json.loads(layout.config.read_text())
    except (OSError, json.JSONDecodeError):
        return True
    if not isinstance(data, dict):
        return True
    version = data.get("facts_version")
    return type(version) is not int or version != FACTS_VERSION


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

        facts, facts_version = _load_facts(data)
        par_iterations = data.get("par_iterations")
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
            facts=facts,
            facts_version=facts_version,
            par_iterations=tuple(
                v for v in par_iterations if isinstance(v, int) and not isinstance(v, bool)
            )
            if isinstance(par_iterations, list)
            else (),
        )
    except (KeyError, TypeError, ValueError, AttributeError):
        return _empty_config()
