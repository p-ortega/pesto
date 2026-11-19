"""GET /api/report -- a problem report that is safe to post in public.

The report says what pesto, Python and the system are, what kinds of files
the open run holds, what the cache knows, the state of every ingest
artifact, and the last few server-side errors. It never names the case, a
folder or file of this machine, or a parameter, group, observation, site or
realization: every piece of free text goes through ``pesto.api.scrub``.

Building a report reads the run folder and the cache and writes nothing.
pesto sends it nowhere. ``issue_url`` is only a link the browser may open
when the user asks for it.
"""

from __future__ import annotations

import json
import platform
import time
from collections import Counter
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlencode

from fastapi import APIRouter, Request
from starlette.responses import JSONResponse

from pesto import __version__
from pesto.api.errorlog import ErrorEntry, error_log
from pesto.api.scrub import KNOWN_EXTENSIONS, Scrubber, load_known_names, scrubber_for
from pesto.cache.layout import CacheLayout
from pesto.cache.manifest import Manifest

router = APIRouter(prefix="/api")

ISSUES_URL = "https://github.com/p-ortega/pesto/issues/new"
MAX_URL_BODY_CHARS = 6000
MAX_NOTES_PER_ARTIFACT = 5
PASTE_LINE = "paste the full report here (use Copy)"

_GRID_KINDS = {"structured": "DIS", "vertex": "DISV", "unstructured": "DISU"}


def _size(n_bytes: int) -> str:
    value = float(n_bytes)
    for unit in ("B", "KB", "MB", "GB"):
        if value < 1024:
            return f"{int(value)} B" if unit == "B" else f"{value:.1f} {unit}"
        value /= 1024
    return f"{value:.1f} TB"


def _extension(name: str) -> str:
    ext = Path(name).suffix.lower().lstrip(".")
    return f".{ext}" if ext in KNOWN_EXTENSIONS or ext.isdigit() else "another ending"


def _inventory(run_path: Path, run: Any) -> list[str]:
    """Counts and sizes of the files in the run folder, by kind only. No file
    name is ever returned, only pesto's own word for the kind and the ending."""
    kinds: dict[Path, str] = {}

    def claim(paths: Any, label: str) -> None:
        for path in paths:
            if path is not None:
                kinds.setdefault(Path(path), label)

    if run is not None:
        claim([run.pst_path], "control file")
        claim([run.rec], ".rec run record")
        claim([run.grid], "grid file")
        claim(run.par_ens.values(), "par ensembles")
        claim(run.obs_ens.values(), "obs ensembles")
        claim(run.rejected_par_ens.values(), "rejected par ensembles")
        claim(run.rejected_obs_ens.values(), "rejected obs ensembles")
        claim([run.starting_par_ens, run.starting_obs_ens], "starting ensembles")
        claim([run.restart_par_ens, run.restart_obs_ens], "restart ensembles")
        claim([run.noise], "obs+noise ensemble")
        claim([run.adjusted_weights], "adjusted weights")
        claim(run.phi.values(), "phi files")
        claim(run.pdc.values(), "pdc files")
        claim(run.pcs.values(), "pcs files")
        claim(run.factor_files, "pilot-point factor files")
        claim([getattr(run, "mult2model", None)], "mult2model_info.csv")
        claim(run.external_tables, "external control tables")

    counts: Counter[str] = Counter()
    sizes: Counter[str] = Counter()
    endings: dict[str, Counter[str]] = {}
    order: list[str] = []
    folders = 0
    unreadable = 0
    try:
        entries = sorted(run_path.iterdir())
    except OSError:
        return ["- the run folder could not be listed"]
    for entry in entries:
        if entry.name.startswith("._"):
            continue
        try:
            if entry.is_dir():
                folders += 1
                continue
            n_bytes = entry.stat().st_size
        except OSError:
            unreadable += 1
            continue
        label = kinds.get(entry)
        ending = _extension(entry.name)
        if label is None:
            label = f"other {ending} files" if ending.startswith(".") else "other files"
        if label not in counts:
            order.append(label)
        counts[label] += 1
        sizes[label] += n_bytes
        endings.setdefault(label, Counter())[ending] += 1

    known = [label for label in dict.fromkeys(kinds.values()) if label in counts]
    others = sorted((label for label in order if label not in known), key=lambda x: -counts[x])
    shown, lumped = others[:12], others[12:]
    lines = []
    for label in known + shown:
        ends = ", ".join(e for e in sorted(endings[label]) if e.startswith("."))
        suffix = f" ({ends})" if ends and not label.startswith("other .") else ""
        plural = "file" if counts[label] == 1 else "files"
        lines.append(f"- {label}: {counts[label]} {plural}{suffix}, {_size(sizes[label])}")
    if lumped:
        n = sum(counts[label] for label in lumped)
        lines.append(f"- files of other kinds: {n}, {_size(sum(sizes[label] for label in lumped))}")
    lines.append(f"- subfolders: {folders}")
    if unreadable:
        lines.append(f"- entries that could not be read: {unreadable}")
    return lines


def _read_json(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _parquet_rows(path: Path) -> int | None:
    try:
        import pyarrow.parquet as pq

        return int(pq.read_metadata(path).num_rows)
    except Exception:  # noqa: BLE001 - an unreadable table is simply not counted
        return None


def _known(value: object) -> str:
    return "not known" if value is None else str(value)


def _cache_lines(layout: CacheLayout, manifest: Manifest) -> list[str]:
    from pesto.cache.runconfig import load_config

    config = load_config(layout)
    elev = _read_json(layout.grid / "elev.json")
    mesh = _read_json(layout.grid / "mesh.json")
    grid_type = elev.get("grid_type")
    grid_kind = _GRID_KINDS.get(grid_type) if isinstance(grid_type, str) else None

    lines = [f"- grid kind: {_known(grid_kind)}"]
    for label, key in (("cells", "n_cells"), ("layers", "nlay")):
        if isinstance(mesh.get(key), int):
            lines.append(f"- grid {label}: {mesh[key]}")
    n_par = config.n_par if config.n_par is not None else _parquet_rows(layout.control / "par.parquet")
    lines.append(f"- parameters: {_known(n_par)}")
    lines.append(f"- observations: {_known(_parquet_rows(layout.control / 'obs.parquet'))}")
    lines.append(f"- realizations: {_known(config.n_real)}")
    lines.append(f"- iterations: {_known(config.n_iterations)} (noptmax {_known(config.noptmax)})")
    if config.par_iterations:
        lines.append(f"- iterations ingested: {', '.join(str(k) for k in config.par_iterations)}")
    lines.append(f"- base realization: {_known(config.base_realization)}")
    lines.append(f"- noise: {_known(config.noise.has_noise)}")
    lines.append(f"- cache version: {manifest.cache_version}")
    if manifest.found_cache_version is not None:
        lines.append(f"- an older cache was found at version {manifest.found_cache_version}")
    if manifest.cache_bytes is not None:
        lines.append(f"- cache size: {_size(manifest.cache_bytes)}")
    if manifest.ingest_seconds is not None:
        lines.append(f"- ingest time: {manifest.ingest_seconds:.1f} s")
    return lines


def _collapsed(texts: list[str]) -> list[str]:
    """Scrubbed notes often read the same once the names are gone; say each once with a count."""
    counted = Counter(texts)
    return [text if n == 1 else f"{text} (x{n})" for text, n in counted.items()]


def _artifact_lines(manifest: Manifest, planned: list[str], scrubber: Scrubber) -> list[str]:
    names = list(dict.fromkeys(planned + list(manifest.artifacts)))
    if not names:
        return ["- no artifact is planned or recorded"]
    lines = []
    for name in names:
        artifact = manifest.artifacts.get(name)
        safe_name = scrubber.scrub(name)
        if artifact is None:
            lines.append(f"- {safe_name}: absent")
            continue
        line = f"- {safe_name}: {artifact.state}"
        if artifact.seconds is not None:
            line += f", {artifact.seconds:.1f} s"
        lines.append(line)
        if artifact.reason:
            lines.append(f"  - reason: {scrubber.scrub(artifact.reason)}")
        notes = _collapsed([scrubber.scrub(note) for note in artifact.notes])
        for note in notes[:MAX_NOTES_PER_ARTIFACT]:
            lines.append(f"  - note: {note}")
        if len(notes) > MAX_NOTES_PER_ARTIFACT:
            lines.append(f"  - {len(notes) - MAX_NOTES_PER_ARTIFACT} more notes left out")
    return lines


def _ingest_line(state: Any, scrubber: Scrubber) -> str:
    ingest = getattr(state, "ingest", None)
    if ingest is None:
        return "- ingest in this session: none started"
    if not ingest.done:
        return "- ingest in this session: running"
    if ingest.error is not None:
        return (
            f"- ingest in this session: failed with {type(ingest.error).__name__}: "
            f"{scrubber.scrub(ingest.error)}"
        )
    return "- ingest in this session: finished"


def _error_lines(entries: list[ErrorEntry], scrubber: Scrubber, run_dir: str | None) -> list[str]:
    if not entries:
        return ["None recorded since pesto started."]
    lines = []
    for number, entry in enumerate(reversed(entries), start=1):
        when = time.strftime("%H:%M:%S", time.gmtime(entry.at))
        head = f"{number}. {when} UTC, {entry.where}"
        if entry.status is not None:
            head += f", status {entry.status}"
        if entry.artifact:
            head += f", artifact {scrubber.scrub(entry.artifact)}"
        lines.append(head)
        # A message from a run that is no longer open cannot be scrubbed against that run's names.
        same_run = entry.run_dir is None or entry.run_dir == run_dir
        said = [part for part in (entry.title, entry.detail) if part]
        if entry.exc_type:
            said.insert(0, entry.exc_type)
        if said and same_run:
            lines.append("   " + ": ".join(scrubber.scrub(part) for part in said))
        elif said:
            kept = f"{entry.exc_type}: " if entry.exc_type else ""
            lines.append(f"   {kept}message left out, it came from a run that is no longer open")
        for frame in entry.trace:
            lines.append(f"   at {frame}")
    return lines


def _open_run(state: Any) -> tuple[Path | None, CacheLayout | None]:
    run_dir = getattr(state, "initial_run_dir", None)
    cache_root = getattr(state, "cache_root", None)
    if run_dir is None or cache_root is None:
        return None, None
    return Path(run_dir), CacheLayout(root=Path(cache_root))


def build_report(state: Any) -> dict[str, Any]:
    """The whole report for the app's current state. Reads only."""
    run_path, layout = _open_run(state)
    run_dir = None if run_path is None else str(run_path)

    head = [
        f"- pesto: {__version__}",
        f"- Python: {platform.python_version()}",
        f"- system: {platform.system()} {platform.release()} {platform.machine()}",
        f"- a run is open: {'yes' if run_path is not None else 'no'}",
    ]

    run = None
    case = None
    run_lines: list[str] = []
    cache_lines: list[str] = []
    artifact_lines: list[str] = []
    scrub_lines: list[str] = []
    manifest = None
    names = None

    if run_path is not None and layout is not None:
        from pesto.ingest.discover import discover
        from pesto.ingest.runner import plan_artifacts

        planned: list[str] = []
        try:
            run = discover(run_path)
            case = run.case
            planned = [p.name for p in plan_artifacts(run, layout)]
        except Exception as exc:  # noqa: BLE001 - the report still has to be built
            run_lines.append(f"- the run folder could not be read as a run ({type(exc).__name__})")
        manifest = Manifest.load(layout)
        if case is None:
            from pesto.cache.runconfig import load_config

            case = load_config(layout).case or None
        names = load_known_names(layout.root)
        scrubber = scrubber_for(case=case, run_dir=run_path, cache_root=layout.root, names=names)
        # One lookup of every word against the cached names, instead of one per note.
        free_text: list[object] = [e.detail for e in error_log(state).entries()]
        free_text += [e.title for e in error_log(state).entries()]
        free_text += [getattr(getattr(state, "ingest", None), "error", None)]
        for artifact in manifest.artifacts.values():
            free_text += [artifact.name, artifact.reason, *artifact.notes]
        scrubber.prime(free_text)
        run_lines += _inventory(run_path, run) if run_path.is_dir() else ["- the run folder is no longer there"]
        cache_lines = _cache_lines(layout, manifest)
        artifact_lines = [_ingest_line(state, scrubber)] + _artifact_lines(manifest, planned, scrubber)
        scrub_lines = [f"- cached names the report was checked against: {names.count}"]
        scrub_lines += [f"- {scrubber.scrub(note)}" for note in dict.fromkeys(names.notes)]
    else:
        scrubber = scrubber_for(case=None, run_dir=None, cache_root=None)

    error_lines = _error_lines(error_log(state).entries(), scrubber, run_dir)

    sections = [
        "## What happened",
        "",
        "(Say in a line or two what you did and what went wrong.)",
        "",
        "## pesto and this machine",
        "",
        *head,
    ]
    if run_path is not None:
        sections += ["", "## Files in the run folder, by kind", "", *run_lines]
        sections += ["", "## What the cache knows", "", *cache_lines]
        sections += ["", "## Ingest artifacts", "", *artifact_lines]
    sections += ["", "## Latest errors on the server", "", *error_lines]
    sections += [
        "",
        "## What was left out",
        "",
        "- The case name is shown as `<case>`, folders as `<path>`, other file names as "
        "`<file>`, and parameter, group, observation, site and realization names as `<name>`.",
        "- In notes, reasons and error messages, any word that is not one of pesto's own "
        "is shown as `<name>` too.",
        *scrub_lines,
    ]
    body = "\n".join(sections) + "\n"

    failed = (
        [name for name, a in manifest.artifacts.items() if a.state == "failed"] if manifest else []
    )
    if failed:
        title = f"pesto {__version__}: {scrubber.scrub(failed[0])} failed"
        if len(failed) > 1:
            title += f" and {len(failed) - 1} more"
    elif error_log(state).entries():
        title = f"pesto {__version__}: an error on the server"
    else:
        title = f"pesto {__version__}: problem report"

    truncated = len(body) > MAX_URL_BODY_CHARS
    url_body = body
    if truncated:
        url_body = "\n".join(
            ["## What happened", "", "(Say in a line or two what you did and what went wrong.)", ""]
            + ["## pesto and this machine", "", *head, "", "## Full report", "", f"({PASTE_LINE})", ""]
        )
    issue_url = f"{ISSUES_URL}?{urlencode({'title': title, 'body': url_body}, quote_via=quote)}"
    return {"title": title, "body": body, "issue_url": issue_url, "truncated": truncated}


@router.get("/report")
def get_report(request: Request) -> JSONResponse:
    # A plain def: the report reads files, so it runs off the event loop.
    return JSONResponse(build_report(request.app.state), headers={"Cache-Control": "no-store"})
