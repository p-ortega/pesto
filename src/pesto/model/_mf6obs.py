"""The MODFLOW 6 observation input of a finished run: where each named
observation sits, read from the run's own text files.

``mfsim.nam`` lists the models, each model name file lists its packages, and an
``OBS6`` package names a file of rows ``name type cellid``. Nothing here loads
``flopy``, and nothing here writes, creates or touches anything in the run
folder; a path that leads outside the folder is never followed.

Every function answers rather than raises: a file that cannot be read gives a
note and no entries from it.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

SIM_NAME_FILE = "mfsim.nam"
PLACEABLE_TYPES = ("HEAD", "DRAWDOWN", "CONCENTRATION")
TWO_CELL_TYPES = ("FLOW-JA-FACE",)
DISCRETIZATION_TYPES = ("DIS6", "DISV6", "DISU6")
OPEN_CLOSE = "OPEN/CLOSE"
MAX_FOLLOW_DEPTH = 4
EXAMPLE_LIMIT = 3
_TOKEN = re.compile(r"""'[^']*'|"[^"]*"|\S+""")
_WHOLE = re.compile(r"[+-]?\d+")


@dataclass(frozen=True)
class ObsEntry:
    """One row of an OBS6 block: the name as written, the type in capitals,
    the cellid tokens, and where the row was read."""

    name: str
    type: str
    ids: tuple[str, ...]
    file: str
    model: str


@dataclass(frozen=True)
class ObsInput:
    """Every observation the run's models list on the run's own grid.

    ``entries`` is keyed by the lower-cased name and holds every row with that
    name, so two rows sharing a name stay visible. ``found`` is False when the
    run has no ``mfsim.nam`` at the top of its folder."""

    entries: dict[str, tuple[ObsEntry, ...]]
    models: tuple[str, ...]
    files: tuple[Path, ...]
    notes: tuple[str, ...]
    found: bool


@dataclass
class _Model:
    name: str
    name_file: str
    dis_file: str | None = None
    obs_files: list[Path] = field(default_factory=list)
    entries: list[ObsEntry] = field(default_factory=list)


@dataclass
class _Scan:
    found: bool
    files: tuple[Path, ...]
    models: list[_Model]
    notes: list[str]


def _tokens(line: str) -> tuple[str, ...]:
    out: list[str] = []
    for raw in _TOKEN.findall(line):
        if raw[0] in "'\"":
            out.append(raw[1:-1])
            continue
        if raw[0] in "#!" or raw.startswith("//"):
            break
        out.append(raw)
    return tuple(out)


def _inside(run_dir: Path, name: str) -> Path | None:
    """``run_dir / name`` when it is an existing file that stays inside the
    run folder once symlinks and ``..`` are resolved, else None."""
    try:
        path = run_dir / name
        root = run_dir.resolve()
        if not path.resolve().is_relative_to(root) or not path.is_file():
            return None
        return path
    except (OSError, ValueError):
        return None


def _read_lines(
    path: Path,
    run_dir: Path,
    notes: list[str],
    followed: list[Path],
    stack: tuple[Path, ...] = (),
) -> list[tuple[tuple[str, ...], str]] | None:
    """The token lines of one file, each with the name of the file it came
    from, with OPEN/CLOSE lines replaced by the file they name. None when the
    file cannot be read as text."""
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        notes.append(f"{path.name} could not be read as text and was skipped ({type(exc).__name__})")
        return None
    if "\x00" in text:
        notes.append(f"{path.name} holds binary bytes and was skipped")
        return None
    lines: list[tuple[tuple[str, ...], str]] = []
    for raw in text.splitlines():
        tokens = _tokens(raw)
        if not tokens:
            continue
        if tokens[0].upper() == OPEN_CLOSE and len(tokens) >= 2:
            target = _inside(run_dir, tokens[1])
            if target is None:
                notes.append(
                    f"{path.name}: OPEN/CLOSE {tokens[1]!r} was not followed, because it is "
                    "missing or leads outside the run folder"
                )
                continue
            if len(stack) >= MAX_FOLLOW_DEPTH or target.resolve() in {p.resolve() for p in (*stack, path)}:
                notes.append(f"{path.name}: OPEN/CLOSE {tokens[1]!r} was not followed, because it nests too deep or loops")
                continue
            inner = _read_lines(target, run_dir, notes, followed, (*stack, path))
            if inner is not None:
                followed.append(target)
                lines.extend(inner)
            continue
        lines.append((tokens, path.name))
    return lines


def _blocks(
    path: Path, run_dir: Path, notes: list[str], followed: list[Path]
) -> list[tuple[str, list[tuple[tuple[str, ...], str]]]] | None:
    """The ``BEGIN name ... END name`` blocks of a file as (upper-case name,
    lines). None when the file is unreadable or a block never ends."""
    lines = _read_lines(path, run_dir, notes, followed)
    if lines is None:
        return None
    blocks: list[tuple[str, list[tuple[tuple[str, ...], str]]]] = []
    current: tuple[str, list] | None = None
    for tokens, source in lines:
        head = tokens[0].upper()
        if head == "BEGIN" and len(tokens) >= 2:
            if current is not None:
                notes.append(f"{path.name}: block {current[0]} has no END and the file was skipped")
                return None
            current = (tokens[1].upper(), [])
        elif head == "END" and current is not None:
            blocks.append(current)
            current = None
        elif current is not None:
            current[1].append((tokens, source))
    if current is not None:
        notes.append(f"{path.name}: block {current[0]} has no END and the file was skipped")
        return None
    return blocks


def _scan(run_dir: Path) -> _Scan:
    notes: list[str] = []
    sim = run_dir / SIM_NAME_FILE
    if not sim.is_file():
        return _Scan(False, (), [], notes)
    followed: list[Path] = []
    name_files: list[Path] = [sim]
    obs_files: list[Path] = []
    models: list[_Model] = []

    sim_blocks = _blocks(sim, run_dir, notes, followed) or []
    for block_name, rows in sim_blocks:
        if block_name != "MODELS":
            continue
        for tokens, _ in rows:
            if len(tokens) < 2:
                continue
            path = _inside(run_dir, tokens[1])
            if path is None:
                notes.append(f"model name file {tokens[1]!r} listed in {SIM_NAME_FILE} is missing or outside the run folder")
                continue
            model = _Model(tokens[2] if len(tokens) >= 3 else path.stem, tokens[1])
            models.append(model)
            name_files.append(path)
            for pkg_name, pkg_rows in _blocks(path, run_dir, notes, followed) or []:
                if pkg_name != "PACKAGES":
                    continue
                for pkg in pkg_rows:
                    ptokens = pkg[0]
                    if len(ptokens) < 2:
                        continue
                    kind = ptokens[0].upper()
                    if kind in DISCRETIZATION_TYPES:
                        model.dis_file = ptokens[1]
                    elif kind == "OBS6":
                        found = _inside(run_dir, ptokens[1])
                        if found is None:
                            notes.append(f"observation file {ptokens[1]!r} listed in {path.name} is missing or outside the run folder")
                            continue
                        model.obs_files.append(found)
                        obs_files.append(found)

    for model in models:
        for obs_path in model.obs_files:
            for block_name, rows in _blocks(obs_path, run_dir, notes, followed) or []:
                if block_name not in ("CONTINUOUS", "SINGLE"):
                    continue
                for tokens, source in rows:
                    if len(tokens) < 2:
                        notes.append(f"{source}: a row with fewer than two entries was ignored ({' '.join(tokens)})")
                        continue
                    model.entries.append(
                        ObsEntry(tokens[0], tokens[1].upper(), tuple(tokens[2:]), source, model.name)
                    )
    files = tuple(dict.fromkeys((*name_files, *obs_files, *followed)))
    return _Scan(True, files, models, notes)


def observation_input_files(run_dir: Path) -> tuple[Path, ...]:
    """``mfsim.nam``, the model name files it lists, the OBS6 files those list
    and any file an OPEN/CLOSE line in them follows, in reading order, only
    files that exist inside the run folder. Empty when there is no
    ``mfsim.nam``."""
    return _scan(Path(run_dir)).files


def read_observation_input(run_dir: Path, grid_file_name: str) -> ObsInput:
    """The observations of the models whose discretization file name plus
    ``.grb`` is ``grid_file_name``. Other models are skipped with a note."""
    scan = _scan(Path(run_dir))
    grid_name = Path(grid_file_name).name
    notes = list(scan.notes)
    used: list[str] = []
    entries: dict[str, list[ObsEntry]] = {}
    for model in scan.models:
        if model.dis_file is None:
            notes.append(f"model {model.name!r} ({model.name_file}) lists no discretization file, so its observations were not used")
            continue
        if f"{Path(model.dis_file).name}.grb" != grid_name:
            notes.append(
                f"model {model.name!r} was skipped: its discretization file {model.dis_file} gives "
                f"{Path(model.dis_file).name}.grb, but the run's grid file is {grid_name}"
            )
            continue
        used.append(model.name)
        for entry in model.entries:
            entries.setdefault(entry.name.lower(), []).append(entry)
    return ObsInput(
        entries={key: tuple(value) for key, value in entries.items()},
        models=tuple(used),
        files=scan.files,
        notes=tuple(notes),
        found=scan.found,
    )


def _cell_of(entry: ObsEntry, shape: Any) -> tuple[str, Any, Any]:
    """("ok", cell, layer) with zero-based numbers, or ("fail", reason key,
    reason text) for one entry on a grid of ``shape``."""
    where = f"observation {entry.name} in {entry.file}"
    if entry.type in TWO_CELL_TYPES:
        return "fail", "two_cells", f"{where} is a {entry.type} observation, which names two cells"
    if entry.type not in PLACEABLE_TYPES:
        return "fail", "type", f"{where} has type {entry.type}, which is not a head, drawdown or concentration observation"
    structured = shape.ncol is not None
    need = 3 if structured else 2
    if len(entry.ids) != need:
        return "fail", "count", f"{where} has {len(entry.ids)} cellid number(s) but this grid needs {need}"
    if not all(_WHOLE.fullmatch(token) for token in entry.ids):
        return "fail", "not_whole", f"{where} has a cellid that is not whole numbers ({' '.join(entry.ids)})"
    numbers = [int(token) for token in entry.ids]
    layer = numbers[0]
    if structured:
        row, column = numbers[1], numbers[2]
        limits = (("layer", layer, shape.nlay), ("row", row, shape.nrow), ("column", column, shape.ncol))
        cell = (row - 1) * shape.ncol + (column - 1)
    else:
        limits = (("layer", layer, shape.nlay), ("cell2d", numbers[1], shape.ncpl))
        cell = numbers[1] - 1
    for label, value, top in limits:
        if not 1 <= value <= top:
            return "fail", "outside", f"{where} has {label} {value}, outside 1 to {top} on this grid"
    return "ok", cell, layer - 1


@dataclass(frozen=True)
class SitePlacement:
    """What the observation input says about each site: ``cell`` and ``layer``
    are -1 where it placed nothing. ``notes`` count what was placed, matched
    after lower-casing, disagreed with the columns, and could not be placed."""

    cell: np.ndarray
    layer: np.ndarray
    notes: tuple[str, ...]
    files_used: tuple[str, ...]


def _examples(items: list[str]) -> str:
    shown = "; ".join(items[:EXAMPLE_LIMIT])
    if len(items) > EXAMPLE_LIMIT:
        shown += f"; and {len(items) - EXAMPLE_LIMIT} more"
    return shown


_REASON_TEXT = {
    "no_id": "carry no id, so the observation input was not searched for them",
    "no_obs": "have an id that names no observation in the model's observation input",
    "outside": "have an observation whose cellid is outside the grid",
    "not_whole": "have an observation whose cellid is not whole numbers",
    "count": "have an observation whose cellid has the wrong number of parts for this grid",
    "two_cells": "have an observation of a type that names two cells",
    "type": "have an observation of a type that is not a head, drawdown or concentration observation",
    "ambiguous": "have an id whose name points at more than one different cell",
}


def place_sites(
    site_names: list[str],
    ids: list[str],
    observations: ObsInput,
    shape: Any,
    cell: np.ndarray,
    layer: np.ndarray,
) -> SitePlacement:
    """Look each site's id up, whole name, ignoring case only. Sites with a
    cell already (``cell >= 0``) are never moved; if the input names a
    different cell for one, it is counted and named."""
    n = len(site_names)
    new_cell = np.full(n, -1, dtype=np.int32)
    new_layer = np.full(n, -1, dtype=np.int32)
    failures: dict[str, list[str]] = {key: [] for key in _REASON_TEXT}
    case_only: list[tuple[str, str]] = []
    disagree: list[str] = []
    files_used: dict[str, None] = {}

    for row in range(n):
        site, site_id = site_names[row], ids[row].strip()
        placed = cell[row] >= 0
        if not site_id:
            if not placed:
                failures["no_id"].append(repr(site))
            continue
        entries = observations.entries.get(site_id.lower())
        if not entries:
            if not placed:
                failures["no_obs"].append(f"{site!r} (id {site_id!r})")
            continue
        results = [_cell_of(entry, shape) for entry in entries]
        # Two rows with the same failure reason are one outcome, whatever their text.
        outcomes = {result if result[0] == "ok" else result[:2] for result in results}
        if len(outcomes) > 1:
            if not placed:
                where = " and ".join(sorted({e.file for e in entries}))
                failures["ambiguous"].append(f"{site!r}: id {site_id!r} appears with different cells in {where}")
            continue
        status, first, second = results[0]
        entry = entries[0]
        if placed:
            if status == "ok" and (first != cell[row] or (layer[row] >= 0 and second != layer[row])):
                disagree.append(
                    f"{site!r}: columns say cell {int(cell[row])} layer {int(layer[row])}, "
                    f"{entry.name} in {entry.file} says cell {first} layer {second}"
                )
            continue
        if not any(e.name == site_id for e in entries):
            case_only.append((site_id, entry.name))
        if status == "fail":
            failures[first].append(f"{site!r}: {second}")
            continue
        new_cell[row], new_layer[row] = first, second
        files_used[entry.file] = None

    notes: list[str] = []
    placed_count = int((new_cell >= 0).sum())
    if placed_count:
        notes.append(
            f"{placed_count} site(s) were placed from the model's observation input "
            f"({', '.join(files_used)}) by the observation their id names; its cellid is one-based "
            "there and was stored zero-based, and the control file's own layer column is unchanged"
        )
    if case_only:
        samples = [f"{sid!r} for {name}" for sid, name in case_only[:EXAMPLE_LIMIT]]
        notes.append(
            f"{len(case_only)} site(s) matched an observation only after lower-casing "
            f"(whole names, case ignored; e.g. {', '.join(samples)})"
        )
    if disagree:
        notes.append(
            f"{len(disagree)} site(s) placed by the control file's columns disagree with the model's "
            f"observation input; the columns were kept ({_examples(disagree)})"
        )
    for key, items in failures.items():
        if items:
            notes.append(f"{len(items)} site(s) {_REASON_TEXT[key]} and stay unplaced ({_examples(items)})")
    return SitePlacement(new_cell, new_layer, tuple(notes), tuple(files_used))
