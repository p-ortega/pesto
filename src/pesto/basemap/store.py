"""The per-run basemap record, kept only in the home store (D-23).

The record lives at ``~/.cache/pesto/basemap/<run_id>/basemap.json``. The
folder comes from ``Path.home()``, never from the run folder or its cache
root, which can be ``<run_dir>/.pesto`` on read-only archive media. The
record holds the image's real path; it never leaves the server.
"""

from __future__ import annotations

import json
from pathlib import Path

from pesto.cache._atomic import write_atomic_text
from pesto.cache.layout import run_id_for

STORE_VERSION = 1
_RECORD_NAME = "basemap.json"


def basemap_dir(run_dir: Path) -> Path:
    return Path.home() / ".cache" / "pesto" / "basemap" / run_id_for(run_dir)


def write_registration(run_dir: Path, record: dict) -> None:
    folder = basemap_dir(run_dir)
    folder.mkdir(parents=True, exist_ok=True)
    write_atomic_text(folder / _RECORD_NAME, json.dumps(record, indent=2))


def read_registration(run_dir: Path) -> dict | None:
    path = basemap_dir(run_dir) / _RECORD_NAME
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
