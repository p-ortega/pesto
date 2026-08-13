"""The shared per-artifact failure record for the whole read layer.

A single bad file must cost one artifact and no more (D-06, D-10): every
function under ``pesto.ingest`` that can fail returns a ``ReadFailure``
instead of raising, so a caller reading many artifacts keeps going after one
of them fails. ``to_artifact()`` turns a ``ReadFailure`` into the vocabulary
Phase 4's cache manifest already uses, so it can be recorded with
``Manifest.mark_failed`` and no translation. ``reason`` is always a sentence
naming the file and what was tried -- never a bare exception repr.
"""

from __future__ import annotations

from dataclasses import dataclass

from pesto.cache.manifest import Artifact


@dataclass(frozen=True)
class ReadFailure:
    """One artifact that could not be read, and why."""

    name: str
    path: str
    reason: str

    def to_artifact(self) -> Artifact:
        return Artifact(name=self.name, state="failed", reason=self.reason)
