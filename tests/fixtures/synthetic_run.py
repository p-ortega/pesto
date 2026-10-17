"""A small, complete, deterministic synthetic run and cache.

Writes a real run directory -- a control file, two parameter-ensemble files
and a grid file, named so :func:`pesto.ingest.discover.discover` finds them
-- plus a matching ``.pesto`` cache built through the same low-level writers
Plan 05-06 uses, with a manifest that reports every artifact fresh. Any
test in this phase, pytest or Playwright, can stand up a working run with
one call and no benchmark data.

Determinism is the point, not realism: every ensemble draw uses its own
seeded ``np.random.default_rng`` (CLAUDE.md's global-RNG rule), and every
source file's mtime is pinned to a fixed instant right after writing, so
``SourceFingerprint.of`` -- which reads mtime as part of its fast freshness
check -- records the same bytes on every run of this generator. A
screenshot diff against this fixture then has one cause: the code under
test, not the fixture's own clock.

The run is deliberately awkward: two of its parameters share a group and
land on the same cell and layer (a contested mark), a whole group places on
no cell at all (the unmapped disclosure), and most of the grid's cells
carry no parameter of any group -- the states this phase draws only exist
in a run shaped like this one.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd

from pesto.cache.layout import CACHE_VERSION, CacheLayout, for_run
from pesto.cache.manifest import Manifest, SourceFingerprint
from pesto.cache.runconfig import NoiseFact, RunConfig, write_config
from pesto.ingest.aggregate import write_par_agg
from pesto.ingest.control import ControlTables
from pesto.ingest.discover import discover
from pesto.ingest.ensembles import write_par_ensemble
from pesto.ingest.ensfile import EnsembleData
from pesto.ingest.failures import ReadFailure
from pesto.ingest.mesh import write_mesh
from pesto.ingest.parcell import write_par_cell
from pesto.ingest.ppfactors import build_pp_index, write_pp_index
from pesto.ingest.runner import plan_artifacts
from pesto.ingest.tables import write_control
from pesto.model import GridShape, GroupResolution, ParCells, fan_polygons

CASE = "synthetic"

# An arbitrary fixed instant, never wall-clock: pinning every source file's
# mtime to this makes two generator runs produce byte-identical fingerprints
# (and therefore a byte-identical manifest.json) regardless of when either
# run happened.
_FIXED_MTIME_NS = 1_700_000_000_000_000_000

# Nine parameters over four groups: G1 and G2 place on cells, G3 places on
# none at all (the unmapped disclosure has something to disclose). p1 and p2
# share a group, cell and layer (the contested mark has something to mark).
# p8 and p9 are the two pilot points of PP_GROUP, interpolated across every
# cell by a factor file; the layer number in its name is what lets a
# two-layer grid know which layer the field belongs to. They sit on cells 1
# and 3 so cells 4 and 5 stay outside the model for the hairline checks.
# p10 and p11 are POINT_GROUP, placed by x/y and not interpolated: both sit
# in cell 2 on layer 0, so they draw as two dots rather than one contested cell.
PP_GROUP = "G4layer1"
POINT_GROUP = "G5"
CONTROL_NAMES = ("p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9", "p10", "p11")
GROUPS = ("G1", "G1", "G2", "G2", "G2", "G3", "G3", PP_GROUP, PP_GROUP, POINT_GROUP, POINT_GROUP)
PARTRANS = ("log", "log", "none", "none", "none", "none", "none", "none", "none", "none", "none")
MAPPABLE = frozenset({"G1", "G2", PP_GROUP, POINT_GROUP})
CELLS = (0, 0, 1, 2, 3, -1, -1, 1, 3, 2, 2)
LAYERS = (0, 0, 0, 0, 1, -1, -1, 0, 0, 0, 0)
POINT_XY = {"p10": (2.25, 0.5), "p11": (2.75, 0.5)}

REAL_NAMES = ("base", "r1", "r2")
ITERATIONS = (0, 1)
NCPL = 6
NLAY = 2
NOPTMAX = 5  # the run stopped short of noptmax: n_iterations (2) < noptmax


def _pin_mtime(path: Path) -> None:
    os.utime(path, ns=(_FIXED_MTIME_NS, _FIXED_MTIME_NS))


def _write_source_files(run_dir: Path) -> None:
    """The real files ``discover`` finds by name. Their content is never
    parsed by anything this generator's cache depends on -- only their
    presence, name and (pinned) mtime matter -- except the control file's
    ``noptmax`` line, kept consistent with the ``RunConfig`` built below."""
    pst = run_dir / f"{CASE}.pst"
    pst.write_text(f"pcf\n* control data\nnoptmax   {NOPTMAX}\n", encoding="utf-8")
    _pin_mtime(pst)

    for iteration in ITERATIONS:
        ens = run_dir / f"{CASE}.{iteration}.par.jcb"
        ens.write_bytes(f"synthetic parameter ensemble, iteration {iteration}\n".encode())
        _pin_mtime(ens)

    grid = run_dir / "synthetic.grb"
    grid.write_bytes(b"synthetic grid placeholder\n")
    _pin_mtime(grid)

    # Weights run linearly from pp0 at x=1.5 to pp1 at x=3.5 and clamp beyond.
    centres = [0.5 + i for i in range(NCPL)]
    weights = [min(max((xc - 1.5) / 2.0, 0.0), 1.0) for xc in centres]
    lines = ["g4pp_inst0pp.dat", "zone.junk", f"1 {NCPL}", "2", "pp0", "pp1"]
    for node, w in enumerate(weights, start=1):
        lines.append(f"{node} 0 2 0.0 1 {1.0 - w:.6f} 2 {w:.6f}")
    pp_files = {
        "g4pp_inst0pp.fac": "\n".join(lines) + "\n",
        "g4pp_inst0pp.dat": "pp0 1.5 0.5 1 1.0\npp1 3.5 0.5 1 1.0\n",
        "g4pp_inst0pp.dat.tpl": "ptf ~\npp0 1.5 0.5 1 ~ p8 ~\npp1 3.5 0.5 1 ~ p9 ~\n",
        "mult2model_info.csv": (
            ",org_file,model_file,fac_file,pp_file\n"
            "0,org/k.txt,k.txt,g4pp_inst0pp.fac,g4pp_inst0pp.dat\n"
        ),
    }
    for name, text in pp_files.items():
        (run_dir / name).write_text(text)
        _pin_mtime(run_dir / name)


def _control_tables() -> ControlTables:
    n = len(CONTROL_NAMES)
    return ControlTables(
        par=pd.DataFrame(
            {
                "parnme": CONTROL_NAMES,
                "pargp": GROUPS,
                "parlbnd": [0.0] * n,
                "parubnd": [100.0] * n,
                "partrans": PARTRANS,
            }
        ),
        obs=pd.DataFrame({"obsnme": [], "obgnme": [], "weight": []}),
        par_groups=("G1", "G2", "G3", PP_GROUP, POINT_GROUP),
        obs_groups=(),
        source_path=Path(f"{CASE}.pst"),
        notes=(),
        ambiguities=(),
    )


def _cells() -> ParCells:
    point_xy = np.full((len(CONTROL_NAMES), 2), np.nan)
    for name, xy in POINT_XY.items():
        point_xy[CONTROL_NAMES.index(name)] = xy
    return ParCells(
        cell=np.array(CELLS, dtype=np.int32),
        layer=np.array(LAYERS, dtype=np.int32),
        parnme=CONTROL_NAMES,
        groups=(
            GroupResolution(group="G1", rule="synthetic", mapped=2, total=2),
            GroupResolution(group="G2", rule="synthetic", mapped=3, total=3),
            GroupResolution(group="G3", rule="synthetic", mapped=0, total=2),
            GroupResolution(group=PP_GROUP, rule="xyz-host-cell", mapped=2, total=2),
            GroupResolution(group=POINT_GROUP, rule="xyz-host-cell", mapped=2, total=2),
        ),
        summary="synthetic fixture placed G1 and G2 on cells and left G3 unplaced",
        notes=(),
        point_xy=point_xy,
    )


def _ensemble_data(iteration: int) -> EnsembleData:
    # A distinct, fixed seed per iteration -- deterministic across runs of
    # this generator, and different enough between iterations that a bug
    # serving the wrong one's values would be visible.
    rng = np.random.default_rng(1000 + iteration)
    n_real = len(REAL_NAMES)
    n_par = len(CONTROL_NAMES)
    # p1-p7 are drawn first, as before the pilot points existed, so the
    # screenshot of G1 does not move. p8 and p9 are pinned so the
    # interpolated field has known ends: 10 at cell 0, 20 at cell 5.
    n_drawn = CONTROL_NAMES.index("p8")
    drawn = rng.uniform(1.0, 100.0, size=(n_real, n_drawn)).astype(np.float32)
    values = np.empty((n_real, n_par), dtype=np.float32)
    values[:, :n_drawn] = drawn
    values[:, CONTROL_NAMES.index("p8")] = 10.0
    values[:, CONTROL_NAMES.index("p9")] = 20.0
    values[:, CONTROL_NAMES.index("p10")] = 30.0
    values[:, CONTROL_NAMES.index("p11")] = 60.0
    return EnsembleData(
        values=values,
        real_names=REAL_NAMES,
        entity_names=CONTROL_NAMES,
        source_path=Path(f"{CASE}.{iteration}.par.jcb"),
        on_disk_format="dense",
        orientation="realization_major",
        orientation_decided_by="dimensions",
        contiguous=True,
        permutation=tuple(range(n_par)),
        hash_ordered=False,
        notes=(),
    )


def _mesh():
    # Six unit squares in a row: ncpl=6, no CRS recorded. Columns of two
    # vertices each (bottom, top) at x = 0..NCPL; cell i's ring is its own
    # bottom-left, bottom-right, top-right, top-left corners.
    verts = np.array([[float(i), y] for i in range(NCPL + 1) for y in (0.0, 1.0)])
    iverts = []
    for i in range(NCPL):
        bl, tl = 2 * i, 2 * i + 1
        br, tr = 2 * (i + 1), 2 * (i + 1) + 1
        iverts.append([bl, br, tr, tl])
    return fan_polygons(verts, iverts, nlay=NLAY, crs=None)


def _build_config(run_dir: Path) -> RunConfig:
    noise = NoiseFact(
        has_noise=False,
        decided_by="noise_ensemble",
        evidence=("no obs+noise ensemble file was found",),
        notes=(),
    )
    return RunConfig(
        cache_version=CACHE_VERSION,
        run_dir=str(run_dir),
        case=CASE,
        n_par=len(CONTROL_NAMES),
        n_real=len(REAL_NAMES),
        base_realization=True,
        n_iterations=len(ITERATIONS),
        noptmax=NOPTMAX,
        first_iteration=min(ITERATIONS),
        last_iteration=max(ITERATIONS),
        projection=None,
        projection_known=False,
        noise=noise,
        notes=(),
    )


def write_synthetic_run(dest: Path) -> Path:
    """Write a small, complete, deterministic run directory and an
    already-fresh ``.pesto`` cache at ``dest``, and return ``dest``.

    Builds the exact artifact list :func:`pesto.ingest.runner.plan_artifacts`
    would plan for this run, writes each one through the same low-level
    writer the real ingest pipeline uses, and records every one ``ok`` in
    the manifest with sources fingerprinted off the real files just
    written -- so a ``pesto`` process pointed at ``dest`` opens with no
    ingest needed, exactly as a real freshly-ingested run would.
    """
    run_dir = Path(dest)
    run_dir.mkdir(parents=True, exist_ok=True)

    _write_source_files(run_dir)

    layout: CacheLayout = for_run(run_dir)
    layout.ensure()

    run = discover(run_dir)
    planned = plan_artifacts(run, layout)

    tables = _control_tables()
    cells = _cells()
    mesh = _mesh()
    grid_shape = GridShape(ncpl=NCPL, nlay=NLAY, nrow=None, ncol=None)

    manifest = Manifest.empty(str(run_dir))

    for artifact in planned:
        sources = [SourceFingerprint.of(Path(s)) for s in artifact.sources]

        if artifact.kind == "par_ens":
            iteration = int(artifact.name.split("/")[1])
            written = write_par_ensemble(
                _ensemble_data(iteration),
                tables,
                mappable=MAPPABLE,
                iteration=iteration,
                layout=layout,
                cells=cells,
            )
        elif artifact.kind == "par_agg":
            iteration = int(artifact.name.split("/")[1])
            written = write_par_agg(
                _ensemble_data(iteration), tables, iteration=iteration, layout=layout
            )
        elif artifact.kind == "control":
            written = write_control(tables, layout)
        elif artifact.kind == "grid":
            written = write_mesh(mesh, grid_shape, layout)
        elif artifact.kind == "par_cell":
            written = write_par_cell(_cells(), tables.par, layout)
        elif artifact.kind == "pp_factors":
            index = build_pp_index(
                run_dir,
                run.mult2model,
                run.factor_files,
                tables.par.set_index("parnme"),
                grid_shape,
            )
            written = write_pp_index(index, layout)
        elif artifact.kind == "config":
            written = write_config(_build_config(run_dir), layout)
        else:
            raise AssertionError(f"unexpected planned artifact kind: {artifact.kind!r}")

        if isinstance(written, ReadFailure):
            raise AssertionError(f"synthetic fixture failed to write {artifact.name}: {written.reason}")

        manifest.mark_ok(
            artifact.name, sources=sources, files=written.files, notes=written.notes
        )

    manifest.save(layout)
    return run_dir


def main(argv: list[str] | None = None) -> None:
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) != 1:
        raise SystemExit("usage: python -m tests.fixtures.synthetic_run <dest>")
    dest = write_synthetic_run(Path(args[0]))
    print(dest)


if __name__ == "__main__":
    main()
