"""What pesto found about measurement noise, and what decided it.

The measurement-noise fact is the one that changes what every other figure
in the run's configuration means, so it is never reduced to a bare yes or
no: it records what pesto found and what decided it, so a modeller can tell
a run that was deliberately calibrated without noise from a leading space
that ate their ``standard_deviation`` column. This follows the same rule
this project applies everywhere else -- a field pesto could not determine
is recorded as unknown with a reason, never as a default that reads like a
measurement.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from pesto.ingest.control import ControlTables
    from pesto.ingest.discover import RunLayout

    # Nothing here is imported at runtime: every use below is duck-typed
    # attribute access on an object the caller already read.

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
