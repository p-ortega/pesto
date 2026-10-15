"""The pp_factors artifact: which pilot-point groups can be interpolated,
with what, and which cannot and why.

PstFrom links a pilot-point file to its factor file through
``mult2model_info.csv``; the template beside the pilot-point file names the
control-file parameter behind every point. This module reads those three
files for every linked group and writes one index. It never computes a
weight of its own, and a group it cannot link is recorded with the reason
rather than dropped (CLAUDE.md's fourth hard rule).

Binary (pypestutils) factor files are linked through a ``ppoints.<tag>.csv``
point file and the control table's ``ppname``/``usecol`` columns. Only a
file whose targets are exactly one layer of grid cells is a group; any
other is refused with its target count. Neither path imports a library."""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np
import pandas as pd

from pesto.cache._atomic import write_atomic_text
from pesto.cache.layout import CacheLayout
from pesto.cache.manifest import CACHE_VERSION, CacheFile, WrittenArtifact
from pesto.ingest.failures import ReadFailure

# GridShape lives in pesto.model, which nothing under pesto.ingest may import,
# even for typing; the annotations below stay unresolved forward references.

ARTIFACT_NAME = "pp_factors"
LAYER_PATTERN = re.compile(r"layer[_-]?(\d+)", re.IGNORECASE)


@dataclass(frozen=True)
class PpGroup:
    """One interpolable group. ``parnames`` and ``pp_names`` are parallel,
    in the factor file's own point order. ``factor_file`` is relative to
    the run directory. ``layer`` is zero-based."""

    group: str
    layer: int
    factor_file: str
    format: str  # "text" | "binary"
    parnames: tuple[str, ...]
    pp_names: tuple[str, ...]
    log_space: bool
    n_cells: int
    notes: tuple[str, ...] = ()


@dataclass(frozen=True)
class PpIndex:
    groups: tuple[PpGroup, ...]
    not_interpolable: tuple[tuple[str, str], ...]
    notes: tuple[str, ...] = ()


class _Refused(Exception):
    """Raised inside one group's linking with the reason it cannot be
    interpolated; caught per group so one bad file costs one entry."""


def _read_template(path: Path) -> dict[str, str]:
    """Pilot-point name (lowercased) to parameter name, from a PEST
    template file: first line ``ptf <marker>``, then one point per line
    with the parameter name between two markers."""
    lines = path.read_text().splitlines()
    if not lines or not lines[0].lower().startswith("ptf"):
        raise _Refused(f"template {path.name} does not start with a 'ptf' line")
    parts = lines[0].split()
    if len(parts) < 2:
        raise _Refused(f"template {path.name} names no marker on its 'ptf' line")
    marker = parts[1]
    out: dict[str, str] = {}
    for line in lines[1:]:
        if not line.strip():
            continue
        tokens = line.split()
        name = tokens[0].lower()
        first = line.find(marker)
        last = line.rfind(marker)
        if first < 0 or last <= first:
            raise _Refused(f"template {path.name}: point {name!r} carries no parameter between {marker!r} markers")
        out[name] = line[first + len(marker) : last].strip()
    return out


def _read_factor_header(path: Path) -> tuple[list[str], int, bool]:
    """The point names, the cell count and the transform flag of a PEST
    text factor file, without keeping any weight. Counts cells the way
    pyemu's parser does: a line's ``nfac`` pairs may spill onto the next
    lines, and each cell counts once."""
    with path.open() as f:
        f.readline()  # the pilot-point file name, unused
        f.readline()  # the zone file name, unused
        dims = f.readline().split()
        if len(dims) != 2:
            raise _Refused(f"factor file {path.name}: third line is not 'ncol nrow'")
        try:
            npp = int(f.readline().strip())
        except ValueError:
            raise _Refused(f"factor file {path.name}: fourth line is not a point count")
        names = [f.readline().strip().lower() for _ in range(npp)]
        n_cells = 0
        transforms: set[int] = set()
        while True:
            line = f.readline()
            if not line:
                break
            raw = line.split()
            if not raw:
                continue
            try:
                itrans, nfac = int(raw[1]), int(raw[2])
            except (IndexError, ValueError):
                raise _Refused(f"factor file {path.name}: cannot read a cell line: {line.strip()[:60]!r}")
            items = raw[4:]
            while len(items) < 2 * nfac:
                more = f.readline()
                if not more:
                    raise _Refused(f"factor file {path.name}: ends inside a cell's weights")
                items.extend(more.split())
            transforms.add(itrans)
            n_cells += 1
    if len(transforms) > 1:
        raise _Refused(f"factor file {path.name}: cells disagree on the transform flag")
    return names, n_cells, (transforms == {1})


def _layer_for(group: str, shape: GridShape) -> int:
    match = LAYER_PATTERN.search(group)
    if match:
        layer = int(match.group(1)) - 1
        if not 0 <= layer < shape.nlay:
            raise _Refused(
                f"group {group!r} names layer {match.group(1)} but the grid has {shape.nlay} layers, "
                "so pesto cannot tell which layer its factors describe"
            )
        return layer
    if shape.nlay == 1:
        return 0
    raise _Refused(
        f"group {group!r} carries no layer number in its name and the grid has {shape.nlay} layers, "
        "so pesto cannot tell which layer its factors describe"
    )


def _text_groups(run_dir: Path, mult2model: Path, par: pd.DataFrame, shape: GridShape):
    groups: list[PpGroup] = []
    refused: list[tuple[str, str]] = []
    try:
        table = pd.read_csv(mult2model, dtype=str).fillna("")
    except Exception as exc:
        return groups, [(mult2model.name, f"could not read {mult2model.name}: {exc}")]
    if "pp_file" not in table.columns or "fac_file" not in table.columns:
        return groups, [(mult2model.name, f"{mult2model.name} has no pp_file/fac_file columns")]
    linked = table[(table["pp_file"] != "") & (table["fac_file"] != "")]
    for pp_file, rows in linked.groupby("pp_file", sort=True):
        fac_files = sorted(set(rows["fac_file"]))
        # A refusal is keyed by the group once the template names it, so the
        # map can show the reason beside the group; before that, by the file.
        key = str(pp_file)
        try:
            if len(fac_files) != 1:
                raise _Refused(f"{pp_file} is linked to {len(fac_files)} factor files: {', '.join(fac_files)}")
            fac_path = run_dir / fac_files[0]
            if Path(fac_files[0]).is_absolute() or not fac_path.resolve().is_relative_to(run_dir.resolve()):
                raise _Refused(f"factor file {fac_files[0]} is outside the run directory")
            tpl_path = run_dir / f"{pp_file}.tpl"
            if not fac_path.is_file():
                raise _Refused(f"factor file {fac_files[0]} is not in the run directory")
            if not tpl_path.is_file():
                raise _Refused(f"template {tpl_path.name} is not in the run directory")
            names, n_cells, log_space = _read_factor_header(fac_path)
            tpl = _read_template(tpl_path)
            missing = [n for n in names if n not in tpl]
            if missing:
                raise _Refused(f"template {tpl_path.name} does not name point(s) {', '.join(missing[:5])}")
            parnames = [tpl[n] for n in names]
            absent = [p for p in parnames if p not in par.index]
            if absent:
                raise _Refused(f"parameter(s) {', '.join(absent[:5])} are not in the control table")
            pargps = sorted({str(par.at[p, "pargp"]) for p in parnames})
            if len(pargps) != 1:
                raise _Refused(f"template {tpl_path.name} names parameters from {len(pargps)} groups: {', '.join(pargps[:5])}")
            group = pargps[0]
            key = group
            layer = _layer_for(group, shape)
            groups.append(
                PpGroup(
                    group=group,
                    layer=layer,
                    factor_file=str(fac_path.relative_to(run_dir)),
                    format="text",
                    parnames=tuple(parnames),
                    pp_names=tuple(names),
                    log_space=log_space,
                    n_cells=n_cells,
                )
            )
        except _Refused as exc:
            refused.append((key, str(exc)))
        except OSError as exc:
            refused.append((key, f"could not read a file for {pp_file}: {exc}"))
    return groups, refused


_BINARY_LAYER = re.compile(r"\.layer(\d+)\.bin$", re.IGNORECASE)


def _binary_header(path: Path) -> tuple[int, int]:
    """Point and target counts from a pypestutils binary factor file: a
    20-byte text tag, then two little-endian int32s. Verified against the
    files escondida's forward run reads with krige_using_file."""
    with path.open("rb") as f:
        f.read(20)
        counts = np.frombuffer(f.read(8), dtype="<i4")
    if counts.shape != (2,):
        raise _Refused(f"{path.name} is too short to be a factor file")
    return int(counts[0]), int(counts[1])


def _binary_groups(run_dir, factor_files, par, shape):
    groups, refused = [], []
    point_files = sorted(run_dir.glob("ppoints.*.csv"))
    for path in [p for p in factor_files if p.suffix.lower() == ".bin"]:
        try:
            npts, mpts = _binary_header(path)
            if mpts != shape.ncpl:
                raise _Refused(
                    f"{path.name} interpolates to {mpts} points, not the grid's {shape.ncpl} cells, so its targets are not cells pesto can draw"
                )
            layer_match = _BINARY_LAYER.search(path.name)
            if not layer_match:
                raise _Refused(f"{path.name} carries no layer number in its name")
            layer = int(layer_match.group(1))
            # The tag must be whole dot-separated segments of the factor file's name.
            matches = [pf for pf in point_files if f".{pf.stem.split('.', 1)[1]}." in f".{path.name}"]
            if not matches:
                raise _Refused(f"no ppoints.<tag>.csv matches {path.name}")
            if len(matches) > 1:
                raise _Refused(f"{len(matches)} points files match {path.name}: {', '.join(m.name for m in matches)}")
            (tag,) = matches
            points = pd.read_csv(tag, dtype=str)
            if "ppname" not in points.columns or len(points) != npts:
                raise _Refused(f"{tag.name} has {len(points)} points, {path.name} was built from {npts}")
            if "ppname" not in par.columns or "usecol" not in par.columns:
                raise _Refused("the control table carries no ppname/usecol columns to link points to parameters")
            rows = par[par["ppname"].astype(str).isin(points["ppname"]) & par["usecol"].astype(str).isin(points.columns)]
            found_before = len(groups)
            for group, block in rows.groupby("pargp", sort=True, observed=True):
                group_layer_match = LAYER_PATTERN.search(str(group))
                if not group_layer_match or int(group_layer_match.group(1)) - 1 != layer:
                    continue
                by_point = {str(pn): str(name) for name, pn in zip(block.index, block["ppname"])}
                ordered = [str(p) for p in points["ppname"]]
                missing = [p for p in ordered if p not in by_point]
                if missing:
                    raise _Refused(f"group {group!r} has no parameter for point(s) {', '.join(missing[:5])}")
                log_space = (
                    "partrans" in block.columns
                    and bool((block["partrans"].astype(str).str.lower() == "log").all())
                )
                notes = (
                    ("log-space interpolation inferred from partrans, the binary factor file does not record it",)
                    if log_space
                    else ()
                )
                groups.append(
                    PpGroup(
                        group=str(group),
                        layer=layer,
                        factor_file=str(path.relative_to(run_dir)),
                        format="binary",
                        parnames=tuple(by_point[p] for p in ordered),
                        pp_names=tuple(ordered),
                        log_space=log_space,
                        n_cells=shape.ncpl,
                        notes=notes,
                    )
                )
            if len(groups) == found_before:
                raise _Refused(
                    f"no parameter group in the control table matches {path.name}'s points "
                    f"in {tag.name} and its layer {layer}"
                )
        except _Refused as exc:
            refused.append((path.name, str(exc)))
        except (OSError, ValueError) as exc:
            refused.append((path.name, f"could not read {path.name}: {exc}"))
    return groups, refused


def build_pp_index(
    run_dir: Path,
    mult2model: Path | None,
    factor_files: tuple[Path, ...],
    par: pd.DataFrame,
    shape: GridShape,
) -> PpIndex:
    """Link every pilot-point group to the factor file that places it.
    ``par`` is the control table indexed by ``parnme`` with a ``pargp``
    column. Reads files only; writes nothing."""
    groups: list[PpGroup] = []
    refused: list[tuple[str, str]] = []
    if mult2model is not None:
        g, r = _text_groups(Path(run_dir), Path(mult2model), par, shape)
        groups.extend(g)
        refused.extend(r)
    g, r = _binary_groups(Path(run_dir), factor_files, par, shape)
    groups.extend(g)
    refused.extend(r)
    seen = {}
    for group in groups:
        if group.group in seen:
            refused.append((group.group, f"two factor files claim group {group.group!r}: {seen[group.group]} and {group.factor_file}"))
        seen.setdefault(group.group, group.factor_file)
    kept = tuple(g for g in groups if sum(1 for h in groups if h.group == g.group) == 1)
    return PpIndex(groups=kept, not_interpolable=tuple(refused))


def write_pp_index(index: PpIndex, layout: CacheLayout) -> WrittenArtifact | ReadFailure:
    try:
        layout.pp.mkdir(parents=True, exist_ok=True)
        payload = {
            "cache_version": CACHE_VERSION,
            "groups": [asdict(g) for g in index.groups],
            "not_interpolable": [list(pair) for pair in index.not_interpolable],
            "notes": list(index.notes),
        }
        n = write_atomic_text(layout.pp_index, json.dumps(payload, indent=2))
        notes = tuple(f"{group}: {reason}" for group, reason in index.not_interpolable)
        return WrittenArtifact(
            name=ARTIFACT_NAME,
            files=(CacheFile(path=str(layout.pp_index.relative_to(layout.root)), bytes=n),),
            notes=notes,
        )
    except Exception as exc:
        return ReadFailure(name=ARTIFACT_NAME, path=str(layout.pp_index), reason=f"failed to write {layout.pp_index.name}: {exc}")


def load_pp_index(layout: CacheLayout) -> PpIndex | ReadFailure:
    path = layout.pp_index
    try:
        raw = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        return ReadFailure(name=ARTIFACT_NAME, path=str(path), reason=f"failed to read {path.name}: {exc}")
    if not isinstance(raw, dict) or raw.get("cache_version") != CACHE_VERSION:
        return ReadFailure(name=ARTIFACT_NAME, path=str(path), reason=f"{path.name} is not a cache_version {CACHE_VERSION} index")
    try:
        groups = tuple(
            PpGroup(
                group=str(g["group"]),
                layer=int(g["layer"]),
                factor_file=str(g["factor_file"]),
                format=str(g["format"]),
                parnames=tuple(g["parnames"]),
                pp_names=tuple(g["pp_names"]),
                log_space=bool(g["log_space"]),
                n_cells=int(g["n_cells"]),
                notes=tuple(g.get("notes", ())),
            )
            for g in raw["groups"]
        )
        refused = tuple((str(a), str(b)) for a, b in raw["not_interpolable"])
        return PpIndex(groups=groups, not_interpolable=refused, notes=tuple(raw.get("notes", ())))
    except (KeyError, TypeError, ValueError) as exc:
        return ReadFailure(name=ARTIFACT_NAME, path=str(path), reason=f"{path.name} has an unexpected shape: {exc}")
