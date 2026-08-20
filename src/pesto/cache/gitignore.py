"""Idempotent ``.pesto/`` gitignore entry for git-tracked run directories.

Per D-05, this happens silently during cache creation -- not as a prompt --
because the cache runs to gigabytes and a modeller who version-controls
their run directory would otherwise stage it by accident.
"""

from __future__ import annotations

from pathlib import Path

_IGNORE_LINE = ".pesto/"


def ensure_gitignored(run_dir: Path) -> str | None:
    """Append a ``.pesto/`` line to ``run_dir``'s ``.gitignore`` if the run
    directory is a git repository and does not already ignore it.

    Existence, not ``is_dir()``, is the right test for ``.git``: in a git
    worktree or a submodule, ``.git`` is a *file* holding a pointer rather
    than a directory, and treating those as "not a repository" would let the
    cache be staged in exactly the setups a careful modeller is most likely
    to be using.

    Never rewrites, reorders or rewraps existing content -- this is a file
    in the user's repository and the only permitted change is one line
    appended at the end.

    Returns ``None`` when nothing needed doing or the line was written, or a
    reason string when the write failed. A run directory is routinely
    read-only archive media, and opening it must still succeed -- but a
    dropped gitignore line is exactly the kind of silent normalisation this
    project refuses to allow, so the failure is handed back to the caller
    rather than swallowed here.
    """
    if not (run_dir / ".git").exists():
        return None

    gitignore = run_dir / ".gitignore"
    try:
        existing = gitignore.read_text() if gitignore.exists() else ""
        lines = existing.splitlines()
        if _IGNORE_LINE in lines or ".pesto" in lines:
            return None

        with gitignore.open("a") as f:
            if existing and not existing.endswith("\n"):
                f.write("\n")
            f.write(_IGNORE_LINE + "\n")
    except OSError as exc:
        return str(exc)
    return None
