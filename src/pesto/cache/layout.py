"""Cache root resolution and the on-disk layout every later phase writes into.

``resolve_cache_root`` decides where a run's cache lives by attempting a real
probe write, never by inspecting permission bits (D-04): the probe catches
failure modes nobody predicted, including ones that only appear on someone
else's machine, whereas ``os.access``/mode-bit inspection is unreliable in
exactly the environments where it matters (a read-only share, a full disk, a
mount with unusual semantics). An override, when given, is taken as-is and is
never probed -- it is the outermost of three precedence levels: override,
then ``<run_dir>/.pesto``, then a stable path under ``~/.cache/pesto/``.
"""

from __future__ import annotations

import hashlib
import os
import uuid
from dataclasses import dataclass
from pathlib import Path

CACHE_VERSION = 1
_DIR_NAME = ".pesto"


def _fallback_root(run_dir: Path) -> Path:
    """A stable path under ``~/.cache/pesto/`` keyed on the resolved run path.

    Keying on ``run_dir.resolve()`` (not the raw string) is what makes a
    trailing slash, a ``.`` segment or a symlink pointing at the same
    directory land on one fallback root instead of three, while two
    genuinely different directories never collide. The path component is a
    16-hex-character sha256 digest, not user text, so no run-directory name
    -- however odd -- can escape ``~/.cache/pesto/`` through traversal
    segments or separators.
    """
    digest = hashlib.sha256(str(run_dir.resolve()).encode()).hexdigest()[:16]
    base = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache"))
    return base / "pesto" / digest


def resolve_cache_root(run_dir: Path, override: Path | None = None) -> Path:
    """Decide where this run's cache lives.

    Precedence is total and fixed: an explicit ``override`` wins outright and
    is never probed; otherwise ``<run_dir>/.pesto`` is tried with a real
    write, falling back to a stable path under ``~/.cache/pesto/`` only when
    that write fails.

    A ``run_dir`` that is not an existing directory is refused with
    ``NotADirectoryError`` rather than created or silently redirected to the
    fallback -- a missing/mistyped run directory is a caller error, not a
    writability failure, and must not be folded into D-04's fallback.
    """
    if override is not None:
        return Path(override)

    run_path = Path(run_dir)
    if not run_path.is_dir():
        raise NotADirectoryError(f"not a directory: {run_path}")

    candidate = run_path / _DIR_NAME
    # A fresh uuid4 per call so two pesto processes probing the same
    # directory at the same moment cannot unlink each other's probe file.
    probe = candidate / f".probe-{uuid.uuid4().hex}"
    try:
        candidate.mkdir(parents=True, exist_ok=True)
        probe.write_bytes(b"")
        probe.unlink()
    except OSError:
        return _fallback_root(run_path)
    return candidate


@dataclass(frozen=True)
class CacheLayout:
    """The on-disk shape of one run's cache. Every phase after this one
    writes through the properties below rather than composing paths itself.
    """

    root: Path

    @property
    def manifest(self) -> Path:
        return self.root / "manifest.json"

    @property
    def config(self) -> Path:
        return self.root / "config.json"

    @property
    def control(self) -> Path:
        return self.root / "control"

    @property
    def phi(self) -> Path:
        return self.root / "phi"

    @property
    def ens(self) -> Path:
        return self.root / "ens"

    @property
    def reals(self) -> Path:
        return self.root / "reals"

    @property
    def agg(self) -> Path:
        return self.root / "agg"

    @property
    def grid(self) -> Path:
        return self.root / "grid"

    @property
    def time(self) -> Path:
        return self.root / "time"

    def ensure(self) -> None:
        """Create the root and all seven directories. Idempotent, and safe
        for two processes doing this at once."""
        for path in (
            self.root,
            self.control,
            self.phi,
            self.ens,
            self.reals,
            self.agg,
            self.grid,
            self.time,
        ):
            path.mkdir(parents=True, exist_ok=True)

    def par_ens(self, iteration: int) -> Path:
        return self.ens / f"par_{iteration}.f32"

    def par_reals(self, iteration: int) -> Path:
        return self.reals / f"par_{iteration}.reals.json"

    def par_agg(self, iteration: int) -> Path:
        return self.agg / f"par_{iteration}.parquet"


def for_run(run_dir: Path, override: Path | None = None) -> CacheLayout:
    """Resolve this run's cache root and hand back a usable layout."""
    return CacheLayout(root=resolve_cache_root(Path(run_dir), override))
