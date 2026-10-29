"""The MODFLOW 6 observation input of a finished run: where each named
observation sits, read from the run's own text files.

``mfsim.nam`` lists the models, each model name file lists its packages, and an
``OBS6`` package names a file of rows ``name type cellid``. A list package (WEL,
DRN, ...) can name its own OBS6 file in its OPTIONS block; its rows name a cell
or a boundname, and a boundname is looked up in the package's period rows. An
advanced package (MAW, SFR, ...) names a feature, never a cell. Nothing here loads
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

from pesto.layer_words import layer_span_words, layer_words

SIM_NAME_FILE = "mfsim.nam"
PLACEABLE_TYPES = ("HEAD", "DRAWDOWN", "CONCENTRATION")
TWO_CELL_TYPES = ("FLOW-JA-FACE",)
DISCRETIZATION_TYPES = ("DIS6", "DISV6", "DISU6")
OPEN_CLOSE = "OPEN/CLOSE"
LIST_PACKAGES = {
    "CHD6": "CHD", "DRN6": "DRN", "GHB6": "GHB", "RIV6": "RIV", "WEL6": "WEL",
    "RCH6": "RCH", "EVT6": "EVT", "CNC6": "CNC", "SRC6": "SRC",
}
FEATURE_PACKAGES = {
    "MAW6": "MAW", "SFR6": "SFR", "LAK6": "LAK", "UZF6": "UZF", "MVR6": "MVR",
    "SFT6": "SFT", "LKT6": "LKT", "MWT6": "MWT", "UZT6": "UZT", "MVT6": "MVT",
}
# Package types that never carry observations; every other type gets one note.
_QUIET_PACKAGES = frozenset(
    {"OBS6", "NPF6", "STO6", "IC6", "OC6", "MST6", "ADV6", "DSP6", "SSM6", "FMI6", "GNC6",
     "BUY6", "VSC6", "HFB6", "TVK6", "TVS6", "TDIS6", "IMS6", *DISCRETIZATION_TYPES}
)
MAX_FOLLOW_DEPTH = 4
EXAMPLE_LIMIT = 3
_TOKEN = re.compile(r"""'[^']*'|"[^"]*"|\S+""")
_WHOLE = re.compile(r"[+-]?\d+")
_NEXT_TOKEN = re.compile(r"_[A-Za-z][A-Za-z0-9]*:")


@dataclass(frozen=True)
class ObsEntry:
    """One row of an OBS6 block: the name as written, the type in capitals,
    the cellid tokens, and where the row was read."""

    name: str
    type: str
    ids: tuple[str, ...]
    file: str
    model: str
    package: str = ""
    package_file: str = ""


@dataclass(frozen=True)
class PackageInfo:
    """A package that names its own OBS6 file: its kind (``WEL``), the file as
    its model name file lists it, and the two options that decide whether a
    boundname can be turned into cells."""

    kind: str
    file: str
    boundnames: bool
    readasarrays: bool


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
    obs_files: tuple[str, ...] = ()
    packages: dict[str, PackageInfo] = field(default_factory=dict)
    run_dir: Path | None = None


@dataclass
class _Model:
    name: str
    name_file: str
    dis_file: str | None = None
    obs_files: list[Path] = field(default_factory=list)
    entries: list[ObsEntry] = field(default_factory=list)
    packages: list[PackageInfo] = field(default_factory=list)
    package_obs: list[tuple[Path, PackageInfo]] = field(default_factory=list)


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
    package_lines: list[tuple[_Model, str, str]] = []
    other_kinds: dict[str, None] = {}

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
                    elif kind in LIST_PACKAGES or kind in FEATURE_PACKAGES:
                        package_lines.append((model, kind, ptokens[1]))
                    elif kind not in _QUIET_PACKAGES:
                        other_kinds[kind] = None

    package_files: list[Path] = []
    for model, kind, name in package_lines:
        path = _inside(run_dir, name)
        if path is None:
            notes.append(f"package file {name!r} listed in {model.name_file} is missing or outside the run folder")
            continue
        header = _package_header(path, run_dir, notes)
        if header is None:
            continue
        obs_name, boundnames, readasarrays, period_files = header
        obs_path = _inside(run_dir, obs_name)
        if obs_path is None:
            notes.append(f"observation file {obs_name!r} listed in {path.name} is missing or outside the run folder")
            continue
        tag = LIST_PACKAGES.get(kind) or FEATURE_PACKAGES[kind]
        info = PackageInfo(tag, name, boundnames, readasarrays)
        model.packages.append(info)
        model.package_obs.append((obs_path, info))
        package_files += [path, obs_path, *period_files]
    if other_kinds:
        notes.append(
            f"package type(s) {', '.join(other_kinds)} were not searched for observations; "
            "only list packages (CHD, DRN, GHB, RIV, WEL, RCH, EVT, CNC, SRC) and advanced packages "
            "(MAW, SFR, LAK, UZF, MVR and their transport partners) are read"
        )

    for model in models:
        sources = [(obs_path, "") for obs_path in model.obs_files]
        sources += [(obs_path, info.file) for obs_path, info in model.package_obs]
        for obs_path, package_file in sources:
            info = next((i for i in model.packages if i.file == package_file), None)
            tag = info.kind if info is not None else ""
            for block_name, rows in _blocks(obs_path, run_dir, notes, followed) or []:
                if block_name not in ("CONTINUOUS", "SINGLE"):
                    continue
                for tokens, source in rows:
                    if len(tokens) < 2:
                        notes.append(f"{source}: a row with fewer than two entries was ignored ({' '.join(tokens)})")
                        continue
                    model.entries.append(
                        ObsEntry(
                            tokens[0], tokens[1].upper(), tuple(tokens[2:]), source, model.name, tag, package_file
                        )
                    )
    files = tuple(dict.fromkeys((*name_files, *obs_files, *package_files, *followed)))
    return _Scan(True, files, models, notes)


def _package_header(
    path: Path, run_dir: Path, notes: list[str]
) -> tuple[str, bool, bool, list[Path]] | None:
    """For a package file: the OBS6 file its OPTIONS block names, whether it
    sets BOUNDNAMES and READASARRAYS, and the files its period blocks open
    with OPEN/CLOSE (listed, never read). None when it names no OBS6 file or
    cannot be read. Only this one file is read, and it stops at the end of the
    options when no OBS6 file is named."""
    obs_name: str | None = None
    boundnames = readasarrays = False
    period_files: list[Path] = []
    block = ""
    try:
        with path.open(encoding="utf-8") as handle:
            for raw in handle:
                if "\x00" in raw:
                    notes.append(f"{path.name} holds binary bytes and was skipped")
                    return None
                tokens = _tokens(raw)
                if not tokens:
                    continue
                head = tokens[0].upper()
                if head == "BEGIN" and len(tokens) >= 2:
                    block = tokens[1].upper()
                elif head == "END":
                    if block == "OPTIONS" and obs_name is None:
                        return None
                    block = ""
                elif block == "OPTIONS":
                    if head == "BOUNDNAMES":
                        boundnames = True
                    elif head == "READASARRAYS":
                        readasarrays = True
                    elif head == "OBS6" and len(tokens) >= 3 and tokens[1].upper() == "FILEIN":
                        obs_name = tokens[2]
                elif block == "PERIOD" and head == OPEN_CLOSE and len(tokens) >= 2:
                    target = _inside(run_dir, tokens[1])
                    if target is None:
                        notes.append(
                            f"{path.name}: OPEN/CLOSE {tokens[1]!r} was not followed, because it is "
                            "missing or leads outside the run folder"
                        )
                    else:
                        period_files.append(target)
    except (OSError, UnicodeDecodeError) as exc:
        notes.append(f"{path.name} could not be read as text and was skipped ({type(exc).__name__})")
        return None
    if obs_name is None:
        return None
    return obs_name, boundnames, readasarrays, period_files


def _boundname_cells(
    run_dir: Path, info: PackageInfo, shape: Any
) -> tuple[dict[str, set[tuple[int, int]]], list[str]]:
    """Each boundname (lower-cased) of one package with the set of zero-based
    (layer, cell) of the period rows that carry it, and notes. Reads the
    package file's period blocks and the OPEN/CLOSE files inside the run
    folder that they name. The boundname is the last token of a row."""
    notes: list[str] = []
    found: dict[str, set[tuple[int, int]]] = {}
    path = _inside(run_dir, info.file)
    if path is None:
        return found, [f"package file {info.file!r} is missing or outside the run folder"]
    structured = shape.ncol is not None
    need = 3 if structured else 2
    unusable = 0
    seen: set[Path] = set()

    def take(tokens: tuple[str, ...]) -> None:
        nonlocal unusable
        if len(tokens) < need + 1 or not all(_WHOLE.fullmatch(t) for t in tokens[:need]):
            unusable += 1
            return
        numbers = [int(t) for t in tokens[:need]]
        layer = numbers[0]
        if structured:
            row, column = numbers[1], numbers[2]
            inside = 1 <= layer <= shape.nlay and 1 <= row <= shape.nrow and 1 <= column <= shape.ncol
            cell = (row - 1) * shape.ncol + (column - 1)
        else:
            inside = 1 <= layer <= shape.nlay and 1 <= numbers[1] <= shape.ncpl
            cell = numbers[1] - 1
        if not inside:
            unusable += 1
            return
        found.setdefault(tokens[-1].lower(), set()).add((layer - 1, cell))

    def read_rows(target: Path) -> None:
        try:
            text = target.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as exc:
            notes.append(f"{target.name} could not be read as text and was skipped ({type(exc).__name__})")
            return
        if "\x00" in text:
            notes.append(f"{target.name} holds binary bytes and was skipped")
            return
        for raw in text.splitlines():
            tokens = _tokens(raw)
            if tokens:
                take(tokens)

    block = ""
    try:
        with path.open(encoding="utf-8") as handle:
            for raw in handle:
                tokens = _tokens(raw)
                if not tokens:
                    continue
                head = tokens[0].upper()
                if head == "BEGIN" and len(tokens) >= 2:
                    block = tokens[1].upper()
                elif head == "END":
                    block = ""
                elif block == "PERIOD" and head == OPEN_CLOSE and len(tokens) >= 2:
                    target = _inside(run_dir, tokens[1])
                    if target is None or any(t.upper() == "(BINARY)" for t in tokens[2:]):
                        notes.append(
                            f"{path.name}: OPEN/CLOSE {tokens[1]!r} was not followed, because it is "
                            "binary, missing or leads outside the run folder"
                        )
                    elif target.resolve() not in seen:
                        seen.add(target.resolve())
                        read_rows(target)
                elif block == "PERIOD":
                    take(tokens)
    except (OSError, UnicodeDecodeError) as exc:
        return {}, [f"{path.name} could not be read as text and was skipped ({type(exc).__name__})"]
    if unusable:
        notes.append(
            f"{unusable} period row(s) of {path.name} were not used for boundnames, because they have "
            "too few entries or a cellid that is not whole numbers inside the grid"
        )
    return found, notes


def observation_input_files(run_dir: Path) -> tuple[Path, ...]:
    """``mfsim.nam``, the model name files it lists, the OBS6 files those list
    and any file an OPEN/CLOSE line in them follows, in reading order, then,
    for each list or advanced package that names an OBS6 file, the package
    file, that OBS6 file and the files its period blocks open with OPEN/CLOSE
    (listed only, not read). Only files that exist inside the run folder.
    Empty when there is no ``mfsim.nam``."""
    return _scan(Path(run_dir)).files


def read_observation_input(run_dir: Path, grid_file_name: str) -> ObsInput:
    """The observations of the models whose discretization file name plus
    ``.grb`` is ``grid_file_name``. Other models are skipped with a note. Rows
    of a package's own OBS6 file carry the package kind in ``package``; rows of
    a model-level OBS6 file leave it empty."""
    scan = _scan(Path(run_dir))
    grid_name = Path(grid_file_name).name
    notes = list(scan.notes)
    used: list[str] = []
    entries: dict[str, list[ObsEntry]] = {}
    packages: dict[str, PackageInfo] = {}
    for model in scan.models:
        if model.dis_file is None:
            notes.append(f"model {model.name!r} ({model.name_file}) lists no discretization file, so its observations were not used")
            continue
        if f"{Path(model.dis_file).name}.grb" != grid_name:
            skipped = [p.name for p in model.obs_files] + [p.name for p, _ in model.package_obs]
            tail = f"; its observation file(s) {', '.join(skipped)} were not read" if skipped else ""
            notes.append(
                f"model {model.name!r} was skipped: its discretization file {model.dis_file} gives "
                f"{Path(model.dis_file).name}.grb, but the run's grid file is {grid_name}{tail}"
            )
            continue
        used.append(model.name)
        for entry in model.entries:
            entries.setdefault(entry.name.lower(), []).append(entry)
        for info in model.packages:
            packages[info.file] = info
    obs_paths = [p.name for m in scan.models if m.name in used for p in m.obs_files]
    obs_paths += [p.name for m in scan.models if m.name in used for p, _ in m.package_obs]
    return ObsInput(
        entries={key: tuple(value) for key, value in entries.items()},
        models=tuple(used),
        files=scan.files,
        notes=tuple(notes),
        found=scan.found,
        obs_files=tuple(dict.fromkeys(obs_paths)),
        packages=packages,
        run_dir=Path(run_dir),
    )


def _grid_cell(numbers: list[int], shape: Any, where: str) -> tuple:
    """("ok", cell, layer, "") with zero-based numbers, or a refusal, for
    one-based cellid ``numbers`` that already have the right count."""
    layer = numbers[0]
    if shape.ncol is not None:
        row, column = numbers[1], numbers[2]
        limits = (("layer", layer, shape.nlay), ("row", row, shape.nrow), ("column", column, shape.ncol))
        cell = (row - 1) * shape.ncol + (column - 1)
    else:
        limits = (("layer", layer, shape.nlay), ("cell2d", numbers[1], shape.ncpl))
        cell = numbers[1] - 1
    for label, value, top in limits:
        if not 1 <= value <= top:
            return "fail", "outside", f"{where} has {label} {value}, outside 1 to {top} on this grid"
    return "ok", cell, layer - 1, ""


def _cellid_outcome(entry: ObsEntry, shape: Any, where: str) -> tuple:
    need = 3 if shape.ncol is not None else 2
    if len(entry.ids) != need:
        return "fail", "count", f"{where} has {len(entry.ids)} cellid number(s) but this grid needs {need}"
    if not all(_WHOLE.fullmatch(token) for token in entry.ids):
        return "fail", "not_whole", f"{where} has a cellid that is not whole numbers ({' '.join(entry.ids)})"
    return _grid_cell([int(token) for token in entry.ids], shape, where)


def _cell_of(entry: ObsEntry, shape: Any) -> tuple:
    """("ok", cell, layer, "") with zero-based numbers, or ("fail", reason key,
    reason text) for one model-level entry on a grid of ``shape``."""
    where = f"observation {entry.name} in {entry.file}"
    if entry.type in TWO_CELL_TYPES:
        return "fail", "two_cells", f"{where} is a {entry.type} observation, which names two cells"
    if entry.type not in PLACEABLE_TYPES:
        return "fail", "type", f"{where} has type {entry.type}, which is not a head, drawdown or concentration observation"
    return _cellid_outcome(entry, shape, where)


def _boundname_outcome(entry: ObsEntry, observations: ObsInput, shape: Any, lookups: dict, notes: list[str]) -> tuple:
    where = f"observation {entry.name} in {entry.file}"
    name = entry.ids[0]
    info = observations.packages.get(entry.package_file)
    if info is None or observations.run_dir is None:
        return "fail", "no_row", f"{where} names {name!r}, but its package file could not be read"
    if not info.boundnames or info.readasarrays:
        return (
            "fail",
            "no_boundnames",
            f"{where} names {name!r}, but {info.file} declares no BOUNDNAMES, so the name cannot be turned into a cell",
        )
    if info.file not in lookups:
        lookups[info.file], more = _boundname_cells(observations.run_dir, info, shape)
        notes.extend(more)
    rows = lookups[info.file].get(name.lower())
    if not rows:
        return "fail", "no_row", f"{where} names boundname {name!r}, which no period row of {info.file} carries"
    cells = {cell for _, cell in rows}
    if len(cells) > 1:
        return "fail", "many_cells", f"{where}: boundname {name!r} covers {len(cells)} cells in {info.file}"
    layers = sorted({layer for layer, _ in rows})
    if len(layers) == 1:
        return "ok", cells.pop(), layers[0], ""
    return "ok", cells.pop(), -1, f"spans {layer_span_words(layers[0], layers[-1])}"


def _entry_outcome(entry: ObsEntry, observations: ObsInput, shape: Any, lookups: dict, notes: list[str]) -> tuple:
    """("ok", cell, layer, note) or ("fail", key, text) for one entry."""
    kind = entry.package
    if not kind:
        return _cell_of(entry, shape)
    where = f"observation {entry.name} in {entry.file}"
    if kind in FEATURE_PACKAGES.values():
        return "fail", "feature", f"{where} names a feature of the {kind} package, not a cell"
    if entry.type != kind and not entry.type.startswith(f"{kind}-"):
        return "fail", "type", f"{where} has type {entry.type}, which is not a {kind} package observation"
    if len(entry.ids) == 1:
        return _boundname_outcome(entry, observations, shape, lookups, notes)
    return _cellid_outcome(entry, shape, where)


def usecol_token(site_name: str) -> str:
    """The text after the last ``usecol:`` in a site name, up to the next
    ``_word:`` token or the end; empty when the name has no ``usecol:``."""
    head, found, rest = site_name.rpartition("usecol:")
    if not found:
        return ""
    return _NEXT_TOKEN.split(rest, maxsplit=1)[0].strip()


@dataclass(frozen=True)
class SitePlacement:
    """What the observation input says about each site: ``cell`` and ``layer``
    are -1 where it placed nothing. ``notes`` count what was placed, matched
    after lower-casing, disagreed with the columns, and could not be placed.
    ``site_note`` is one sentence per site: why it stayed unplaced, that the
    columns were kept against a different answer, or that its layer is unknown;
    empty otherwise."""

    cell: np.ndarray
    layer: np.ndarray
    notes: tuple[str, ...]
    files_used: tuple[str, ...]
    site_note: tuple[str, ...] = ()


def _examples(items: list[str]) -> str:
    shown = "; ".join(items[:EXAMPLE_LIMIT])
    if len(items) > EXAMPLE_LIMIT:
        shown += f"; and {len(items) - EXAMPLE_LIMIT} more"
    return shown


def _files_text(observations: ObsInput) -> str:
    names = list(observations.obs_files)
    if not names:
        return "the model's observation input (it lists no OBS6 file for this grid)"
    return ", ".join(names[:EXAMPLE_LIMIT]) + (f" and {len(names) - EXAMPLE_LIMIT} more" if len(names) > EXAMPLE_LIMIT else "")


_REASON_TEXT = {
    "no_id": "carry no id or usecol value, so the observation input was not searched for them",
    "no_obs": "have an id that names no observation in the model's observation input",
    "no_obs_usecol": "have no id and a usecol value that names no observation in the model's observation input",
    "outside": "have an observation whose cellid is outside the grid",
    "not_whole": "have an observation whose cellid is not whole numbers",
    "count": "have an observation whose cellid has the wrong number of parts for this grid",
    "two_cells": "have an observation of a type that names two cells",
    "type": "have an observation of a type that is not a head, drawdown or concentration observation",
    "ambiguous": "have an id or usecol value whose name points at more than one different cell",
    "feature": "have an observation that names a feature of an advanced package, not a cell",
    "no_boundnames": "have an observation that names a boundname in a package with no BOUNDNAMES",
    "no_row": "have an observation whose boundname no period row of its package carries",
    "many_cells": "have an observation whose boundname covers several cells",
}


def place_sites(
    site_names: list[str],
    ids: list[str],
    observations: ObsInput,
    shape: Any,
    cell: np.ndarray,
    layer: np.ndarray,
) -> SitePlacement:
    """Look each site up by its id and then by the value after ``usecol:`` in
    its name, whole name, ignoring case only. Sites with a cell already
    (``cell >= 0``) are never moved; if the input names a different cell for
    one, it is counted and named. When the two keys point at different cells
    the site stays unplaced."""
    n = len(site_names)
    new_cell = np.full(n, -1, dtype=np.int32)
    new_layer = np.full(n, -1, dtype=np.int32)
    failures: dict[str, list[str]] = {key: [] for key in _REASON_TEXT}
    case_only: list[tuple[str, str]] = []
    disagree: list[str] = []
    spans = 0
    files_used: dict[str, None] = {}
    site_note = [""] * n
    where_text = _files_text(observations)
    lookups: dict[str, dict] = {}
    package_notes: list[str] = []

    for row in range(n):
        site, site_id = site_names[row], ids[row].strip()
        placed = cell[row] >= 0
        keys: list[tuple[str, str]] = []
        if site_id:
            keys.append(("id", site_id))
        token = usecol_token(site)
        if token and token.lower() != site_id.lower():
            keys.append(("usecol value", token))
        if not keys:
            if not placed:
                failures["no_id"].append(repr(site))
                site_note[row] = "no id or usecol value to match an MF6 observation name"
            continue
        matched = [(label, name, observations.entries[name.lower()]) for label, name in keys if name.lower() in observations.entries]
        if not matched:
            if not placed:
                key = "no_obs" if site_id else "no_obs_usecol"
                names = " or ".join(repr(name) for _, name in keys)
                shown = f"{site!r} (id {site_id!r})" if site_id else f"{site!r} (usecol value {keys[0][1]!r})"
                failures[key].append(shown)
                site_note[row] = f"no MF6 observation is named {names} in {where_text}"
            continue
        results = [
            _entry_outcome(entry, observations, shape, lookups, package_notes)
            for _, _, entries in matched
            for entry in entries
        ]
        # Two rows with the same failure reason are one outcome, whatever their text.
        outcomes = {result if result[0] == "ok" else result[:2] for result in results}
        label, matched_name, entries = matched[0]
        if len(outcomes) > 1:
            if not placed:
                where = " and ".join(sorted({e.file for _, _, es in matched for e in es}))
                if len(matched) > 1:
                    text = (
                        f"id {matched[0][1]!r} and usecol value {matched[1][1]!r} point at different cells ({where})"
                    )
                else:
                    text = f"{label} {matched_name!r} appears with different cells in {where}"
                failures["ambiguous"].append(f"{site!r}: {text}")
                site_note[row] = text
            continue
        outcome = next(r for r in results if (r if r[0] == "ok" else r[:2]) in outcomes)
        entry = entries[0]
        if outcome[0] == "ok":
            _, first, second, extra = outcome
        else:
            _, first, second = outcome
            extra = ""
        if placed:
            if outcome[0] == "ok" and (first != cell[row] or (layer[row] >= 0 and second >= 0 and second != layer[row])):
                # The control file's column holds an index, so it is shown as one; MF6 writes its layer one-based.
                held = int(layer[row])
                column_layer = f"layer index {held}" if held >= 0 else layer_words(held)
                text = (
                    f"columns say cell {int(cell[row])} {column_layer}, "
                    f"{entry.name} in {entry.file} says cell {first} {layer_words(second)}"
                )
                disagree.append(f"{site!r}: {text}")
                site_note[row] = f"the control file's columns were kept; {text}"
            continue
        if not any(e.name == matched_name for e in entries):
            case_only.append((matched_name, entry.name))
        if outcome[0] == "fail":
            failures[first].append(f"{site!r}: {second}")
            site_note[row] = second
            continue
        new_cell[row], new_layer[row] = first, second
        site_note[row] = extra
        spans += int(second < 0)
        files_used[entry.file] = None

    notes: list[str] = list(dict.fromkeys(package_notes))
    placed_count = int((new_cell >= 0).sum())
    if placed_count:
        notes.append(
            f"{placed_count} site(s) were placed from the model's observation input "
            f"({', '.join(files_used)}) by the observation their id or usecol value names; its cellid is "
            "one-based there and was stored zero-based, and the control file's own layer column is unchanged"
        )
    if spans:
        notes.append(
            f"{spans} site(s) were placed by boundname on one cell whose period rows span several layers, "
            "so their layer is unknown (layer -1)"
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
    return SitePlacement(new_cell, new_layer, tuple(notes), tuple(files_used), tuple(site_note))
