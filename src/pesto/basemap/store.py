"""The per-run basemap record, kept only in the home store (D-23).

The record lives at ``~/.cache/pesto/basemap/<run_id>/basemap.json``. The
folder comes from ``Path.home()``, never from the run folder or its cache
root, which can be ``<run_dir>/.pesto`` on read-only archive media. The
record holds the image's real path; it never leaves the server.

A record that is there but cannot be used is reported with a reason and
left in place, never read as "no basemap", so the user sees what happened
and can remove it.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from pesto.cache._atomic import write_atomic_text
from pesto.cache.layout import run_id_for

STORE_VERSION = 1
_RECORD_NAME = "basemap.json"

# Each key a record must carry, with the check its value must pass.
_FIELDS = {
    "source": lambda v: isinstance(v, str),
    "size": lambda v: isinstance(v, int),
    "mtime_ns": lambda v: isinstance(v, int),
    "format": lambda v: v in ("png", "jpeg"),
    "width": lambda v: isinstance(v, int) and v > 0,
    "height": lambda v: isinstance(v, int) and v > 0,
    "extent": lambda v: isinstance(v, list)
    and len(v) == 4
    and all(isinstance(x, (int, float)) and not isinstance(x, bool) for x in v),
    "placed_by": lambda v: v in ("world_file", "numbers"),
    "world_file": lambda v: v is None or isinstance(v, str),
    "world_file_size": lambda v: v is None or (isinstance(v, int) and not isinstance(v, bool)),
    "world_file_mtime_ns": lambda v: v is None or (isinstance(v, int) and not isinstance(v, bool)),
    "notes": lambda v: isinstance(v, list) and all(isinstance(x, str) for x in v),
    "tag": lambda v: isinstance(v, str),
}


@dataclass(frozen=True)
class StoreFailure:
    reason: str


def basemap_dir(run_dir: Path) -> Path:
    return Path.home() / ".cache" / "pesto" / "basemap" / run_id_for(run_dir)


def _record_path(run_dir: Path) -> Path:
    return basemap_dir(run_dir) / _RECORD_NAME


def store_inside(run_dir: Path, cache_root: Path) -> bool:
    """Whether the store folder would sit inside the run folder or its cache
    root, as it does when HOME is the run folder."""
    folder = basemap_dir(run_dir).resolve()
    for guarded in (Path(run_dir).resolve(), Path(cache_root).resolve()):
        if guarded in (folder, *folder.parents):
            return True
    return False


def write_registration(run_dir: Path, record: dict) -> None:
    """Raises OSError when the store cannot be written; the caller reports it."""
    folder = basemap_dir(run_dir)
    folder.mkdir(parents=True, exist_ok=True)
    write_atomic_text(folder / _RECORD_NAME, json.dumps(record, indent=2))


def read_registration(run_dir: Path) -> dict | None | StoreFailure:
    """The record, None when there is none, or a StoreFailure naming what is
    wrong with the one that is there."""
    path = _record_path(run_dir)
    try:
        raw = path.read_bytes()
    except FileNotFoundError:
        return None
    except OSError as exc:
        return StoreFailure(f"it cannot be read ({exc.strerror})")
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return StoreFailure("it is not valid JSON")
    if not isinstance(data, dict):
        return StoreFailure("it is not a JSON object")
    if data.get("version") != STORE_VERSION:
        return StoreFailure(
            f"it was written as version {data.get('version')!r}; this build reads version {STORE_VERSION}"
        )
    for key, valid in _FIELDS.items():
        if key not in data:
            return StoreFailure(f"it has no {key!r} field")
        if not valid(data[key]):
            return StoreFailure(f"its {key!r} field is not valid")
    if data["placed_by"] == "world_file" and None in (
        data["world_file"],
        data["world_file_size"],
        data["world_file_mtime_ns"],
    ):
        return StoreFailure("it says a world file placed the image but does not say which one")
    return data


def _stat_reason(path: Path, size: int, mtime_ns: int, label: str, missing: str, changed: str) -> str | None:
    try:
        st = path.stat()
    except FileNotFoundError:
        return f"{label} is missing; {missing}"
    except OSError as exc:
        return f"{label} cannot be checked ({exc.strerror}); {missing}"
    if st.st_size != size or st.st_mtime_ns != mtime_ns:
        return f"{label} has changed since {changed}"
    return None


def check_source(record: dict) -> str | None:
    """Why a registered basemap can no longer be drawn, or None when its
    image, and the world file that placed it, still match the record (D-24).
    Only file names go into the reason."""
    source = Path(record["source"])
    reason = _stat_reason(
        source,
        record["size"],
        record["mtime_ns"],
        f"the basemap file {source.name}",
        "remove it or add it again",
        "it was placed; remove it and add it again",
    )
    if reason is not None or record["placed_by"] != "world_file":
        return reason
    wf = record["world_file"]
    return _stat_reason(
        source.parent / wf,
        record["world_file_size"],
        record["world_file_mtime_ns"],
        f"the world file {wf}",
        "remove the basemap or add it again",
        "the basemap was placed; remove it and add it again",
    )


class StoreLinkError(Exception):
    """The store folder is a link, so deleting inside it could reach any folder."""


def remove_registration(run_dir: Path) -> None:
    """Delete this run's record and its downscaled copies, and nothing else.

    Only ``basemap.json`` and ``image_*.png`` directly inside the store folder
    go; a link among them is removed as a link, never followed. Raises
    StoreLinkError when the folder itself is a link and OSError when a delete
    fails. The caller checks ``store_inside`` first.
    """
    folder = basemap_dir(run_dir)
    if folder.is_symlink():
        raise StoreLinkError(folder.name)
    if not folder.is_dir():
        return
    resolved = folder.resolve()
    doomed = [folder / _RECORD_NAME, *folder.glob("image_*.png")]
    for path in doomed:
        if path.parent.resolve() != resolved:
            continue
        if path.is_symlink() or path.is_file():
            path.unlink(missing_ok=True)
