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

from pesto.cache.gitignore import ensure_gitignored

CACHE_VERSION = 3
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


def probe_writable(folder: Path) -> bool:
    """Can a file be created in ``folder``? Answered by a real write, never
    by permission bits (D-04). Never creates ``folder`` itself.

    The probe name is a fresh uuid4 so two pesto processes probing the same
    folder cannot unlink each other's file.
    """
    probe = Path(folder) / f".probe-{uuid.uuid4().hex}"
    try:
        probe.write_bytes(b"")
        probe.unlink()
    except OSError:
        return False
    return True


def run_id_for(run_dir: Path) -> str:
    """A short stable id for one run: 12 hex characters of the sha256 of the
    resolved run path. It names the run, it is not a secret.

    Resolving first is what makes a trailing slash or a symlink give the
    same id as the plain path.
    """
    return hashlib.sha256(str(Path(run_dir).resolve()).encode()).hexdigest()[:12]


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
    try:
        candidate.mkdir(parents=True, exist_ok=True)
    except OSError:
        return _fallback_root(run_path)
    if not probe_writable(candidate):
        return _fallback_root(run_path)
    return candidate


@dataclass(frozen=True)
class CacheLayout:
    """The on-disk shape of one run's cache. Every phase after this one
    writes through the properties below rather than composing paths itself.
    """

    root: Path
    # Set by `for_run` when the run directory is a git repository whose
    # `.gitignore` could not be written -- carried here so a caller can
    # report it rather than the failure disappearing once `for_run` returns.
    gitignore_note: str | None = None

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

    @property
    def pp(self) -> Path:
        return self.root / "grid" / "pp"

    @property
    def pp_index(self) -> Path:
        return self.pp / "index.json"

    def pp_field(self, group: str, iteration: int, tag: str, key: str) -> Path:
        """Where one computed field is memoised. ``tag`` is the ensemble
        artifact's cache tag, so a re-ingest never serves a stale field;
        ``key`` is the realization name or statistic. Both names are
        URL-quoted so a name can never escape the folder."""
        from urllib.parse import quote

        def segment(name: str) -> str:
            # quote() leaves "." and ".." alone, and those would walk the path.
            quoted = quote(name, safe="")
            return quoted.replace(".", "%2E") if quoted in {".", ".."} else quoted

        return (
            self.pp
            / "fields"
            / segment(group)
            / str(iteration)
            / tag
            / f"{segment(key)}.f32"
        )

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

    def par_agg_notes(self, iteration: int) -> Path:
        return self.agg / f"par_{iteration}.notes.json"

    # Observation artifacts. Every path the observation ingest writes is named
    # here so no later module composes one itself. They live in the folders
    # ensure() already makes, so the cache version does not change.

    @property
    def obs_order(self) -> Path:
        return self.control / "obs_order.i32"

    @property
    def obs_time(self) -> Path:
        return self.control / "obs_time.f64"

    @property
    def obs_value(self) -> Path:
        return self.control / "obs_value.f64"

    @property
    def obs_flags(self) -> Path:
        return self.control / "obs_flags.u8"

    @property
    def obs_sites(self) -> Path:
        return self.control / "obs_sites.parquet"

    @property
    def obs_groups(self) -> Path:
        return self.control / "obs_groups.parquet"

    @property
    def obs_index_meta(self) -> Path:
        return self.control / "obs_index.json"

    @property
    def obs_cell(self) -> Path:
        return self.grid / "obs_cell.parquet"

    @property
    def obs_cell_meta(self) -> Path:
        return self.grid / "obs_cell.json"

    @property
    def noise_agg(self) -> Path:
        return self.agg / "noise.f32"

    @property
    def noise_agg_meta(self) -> Path:
        return self.agg / "noise.json"

    def obs_ens(self, iteration: int) -> Path:
        return self.ens / f"obs_{iteration}.f32"

    def obs_ens_meta(self, iteration: int) -> Path:
        return self.ens / f"obs_{iteration}.json"

    def obs_reals(self, iteration: int) -> Path:
        return self.reals / f"obs_{iteration}.reals.json"

    def obs_agg(self, iteration: int) -> Path:
        return self.agg / f"obs_{iteration}.f32"

    def obs_agg_meta(self, iteration: int) -> Path:
        return self.agg / f"obs_{iteration}.json"

    def pdc(self, iteration: int) -> Path:
        return self.agg / f"pdc_{iteration}.parquet"

    def pdc_meta(self, iteration: int) -> Path:
        return self.agg / f"pdc_{iteration}.json"

    def phi_check(self, iteration: int) -> Path:
        return self.agg / f"phi_check_{iteration}.json"

    # The parameter view spans the first and last iteration, so none of these takes one.

    @property
    def par_change(self) -> Path:
        return self.agg / "par_change.parquet"

    @property
    def par_change_meta(self) -> Path:
        return self.agg / "par_change.json"

    @property
    def par_groups(self) -> Path:
        return self.agg / "par_groups.json"


def for_run(run_dir: Path, override: Path | None = None) -> CacheLayout:
    """Resolve this run's cache root, ensure a git-tracked run directory
    ignores it, and hand back a usable layout. Cache creation and the
    gitignore line happen together so no caller has to remember to pair
    them. A run directory that refuses that write (read-only archive media)
    still opens -- the refusal comes back on `CacheLayout.gitignore_note`,
    never as a raised exception."""
    root = resolve_cache_root(Path(run_dir), override)
    gitignore_note = ensure_gitignored(Path(run_dir))
    return CacheLayout(root=root, gitignore_note=gitignore_note)
