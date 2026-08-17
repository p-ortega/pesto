"""The boundary invariant, proven rather than assumed.

GRID-05's whole claim is that everything MODFLOW-specific sits behind
``src/pesto/model/`` -- so adding a second model type later costs one new
file, not a rewrite. GRID-04's claim is that the mesh is never reprojected,
re-origined or rescaled once it reaches pesto. Both claims are worth nothing
as intentions and everything as tests that go red the moment either stops
being true.

Every import check here parses the source with ``ast`` and walks the real
syntax tree, rather than searching text. A text search matches a string
inside a docstring or a comment and misses an aliased import entirely;
parsing gives the import graph Python itself would build. "Module level"
means "at column 0, outside any function or class body" -- an import nested
inside an ``if``/``try`` at the top of a file is still module level (it
still runs at import time, unconditionally guarded), so this walk descends
into control-flow bodies but stops at the first function or class
definition, which is where a deferred, first-use import actually lives in
this codebase (``pesto.warm.load_flopy()``/``load_pyemu()``, called from
inside a method body).
"""

from __future__ import annotations

import ast
import math
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from pesto.model import SpatialAdapter
from pesto.model.mf6 import Mf6Adapter

from .fixtures import _VERTICES, write_disv_grb

SRC_ROOT = Path("src/pesto")
WARM_MODULE = SRC_ROOT / "warm.py"
MODEL_PACKAGE = SRC_ROOT / "model"

HEAVY_LIBRARIES = ("flopy", "pyemu")
MODFLOW_KEYWORDS = ("flopy", "mf6", "modflow", "disv")
REPROJECTION_CALL_NAMES = ("to_crs", "set_crs", "reproject")


def _all_source_files() -> list[Path]:
    return sorted(SRC_ROOT.rglob("*.py"))


def _under(path: Path, package: Path) -> bool:
    try:
        path.relative_to(package)
    except ValueError:
        return False
    return True


def _module_level_imports(path: Path) -> list[tuple[str, int]]:
    """Every module-level import in ``path``, as ``(dotted_name, lineno)``.

    For ``import a.b`` this yields ``("a.b", lineno)``. For
    ``from a.b import c`` this yields both ``("a.b.c", lineno)`` (so a check
    for one imported name matches) and ``("a.b", lineno)`` (so a check for
    the module itself, e.g. a bare package import, also matches). Descends
    into ``if``/``try``/``with``/``for``/``while`` bodies, which do not open
    a new scope, but never into a ``FunctionDef``/``AsyncFunctionDef``/
    ``ClassDef`` body -- that boundary is exactly where this project's
    deferred heavy imports live.
    """
    tree = ast.parse(path.read_text(), filename=str(path))
    found: list[tuple[str, int]] = []

    def visit(body: list[ast.stmt]) -> None:
        for node in body:
            if isinstance(node, ast.Import):
                for alias in node.names:
                    found.append((alias.name, node.lineno))
            elif isinstance(node, ast.ImportFrom):
                module = node.module or ""
                for alias in node.names:
                    full = f"{module}.{alias.name}" if module else alias.name
                    found.append((full, node.lineno))
                    if module:
                        found.append((module, node.lineno))
            elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                continue  # a new scope -- not module level
            else:
                for field in ("body", "orelse", "finalbody"):
                    child = getattr(node, field, None)
                    if isinstance(child, list):
                        visit(child)
                for handler in getattr(node, "handlers", []):
                    visit(handler.body)

    visit(tree.body)
    return found


# ---------------------------------------------------------------------------
# Only pesto.warm names a heavy modelling library, anywhere in the tree.
# ---------------------------------------------------------------------------


def test_only_warm_names_a_heavy_modelling_library_at_module_scope():
    offenders = []
    for path in _all_source_files():
        if path == WARM_MODULE:
            continue
        for name, lineno in _module_level_imports(path):
            for heavy in HEAVY_LIBRARIES:
                if name == heavy or name.startswith(f"{heavy}."):
                    offenders.append(f"{path}:{lineno} imports {name!r}")
    assert not offenders, (
        "only src/pesto/warm.py may name flopy or pyemu at module scope; "
        "every other module must go through load_flopy()/load_pyemu() "
        "inside a function body -- offending imports:\n" + "\n".join(offenders)
    )


# ---------------------------------------------------------------------------
# The rule table is private: nothing outside src/pesto/model/ may see it.
# ---------------------------------------------------------------------------


def test_no_file_outside_model_imports_the_private_rule_table():
    offenders = []
    for path in _all_source_files():
        if _under(path, MODEL_PACKAGE):
            continue
        for name, lineno in _module_level_imports(path):
            if name == "pesto.model._parcells" or name.startswith("pesto.model._parcells."):
                offenders.append(f"{path}:{lineno} imports {name!r}")
    assert not offenders, (
        "pesto.model._parcells is private -- the ordered rule table that "
        "puts parameters on cells is MODFLOW-shaped and must stay behind "
        "src/pesto/model/ per GRID-05 (D-01) -- offending imports:\n"
        + "\n".join(offenders)
    )


def test_no_file_outside_model_names_a_modflow_concept_in_an_import():
    offenders = []
    for path in _all_source_files():
        if _under(path, MODEL_PACKAGE):
            continue
        for name, lineno in _module_level_imports(path):
            lowered = name.lower()
            for keyword in MODFLOW_KEYWORDS:
                if keyword in lowered:
                    offenders.append(
                        f"{path}:{lineno} imports {name!r}, which names {keyword!r}"
                    )
    assert not offenders, (
        "no file outside src/pesto/model/ may import anything naming a "
        "MODFLOW discretisation or the MODFLOW-specific reader -- the "
        "model adapter is the one place that knows what MODFLOW is "
        "(GRID-05) -- offending imports:\n" + "\n".join(offenders)
    )


# ---------------------------------------------------------------------------
# The one allowed cross-package dependency, and its cycle-freedom.
# ---------------------------------------------------------------------------


def test_model_imports_exactly_one_name_from_ingest_and_it_is_readfailure():
    offenders = []
    seen_names: set[str] = set()
    for path in sorted(MODEL_PACKAGE.rglob("*.py")):
        for name, lineno in _module_level_imports(path):
            if name == "pesto.ingest" or name.startswith("pesto.ingest."):
                if name in ("pesto.ingest", "pesto.ingest.failures"):
                    # the module path itself, not an imported name
                    continue
                seen_names.add(name.rsplit(".", 1)[-1])
                if name != "pesto.ingest.failures.ReadFailure":
                    offenders.append(f"{path}:{lineno} imports {name!r}")
    assert not offenders, (
        "src/pesto/model/ may import exactly one name from pesto.ingest -- "
        "ReadFailure from pesto.ingest.failures -- and nothing else; that "
        "single dependency is what keeps the two packages from forming an "
        "import cycle -- offending imports:\n" + "\n".join(offenders)
    )
    assert seen_names == {"ReadFailure"}, (
        "expected pesto.model to import exactly {'ReadFailure'} from "
        f"pesto.ingest, found {seen_names!r} instead"
    )


def test_no_ingest_file_imports_anything_from_model():
    offenders = []
    for path in sorted(Path("src/pesto/ingest").rglob("*.py")):
        for name, lineno in _module_level_imports(path):
            if name == "pesto.model" or name.startswith("pesto.model."):
                offenders.append(f"{path}:{lineno} imports {name!r}")
    assert not offenders, (
        "nothing under pesto.ingest may import pesto.model -- together "
        "with model's one-name dependency the other way, this is what "
        "makes that dependency safe rather than merely convenient (it "
        "cannot become an import cycle) -- offending imports:\n"
        + "\n".join(offenders)
    )


# ---------------------------------------------------------------------------
# GRID-04: nothing reprojects, re-origins or rescales the mesh.
# ---------------------------------------------------------------------------


def test_nothing_under_src_pesto_imports_pyproj():
    offenders = []
    for path in _all_source_files():
        for name, lineno in _module_level_imports(path):
            if name == "pyproj" or name.startswith("pyproj."):
                offenders.append(f"{path}:{lineno} imports {name!r}")
    assert not offenders, (
        "pyproj is not a project dependency (deferred to a later "
        "milestone) -- no module under src/pesto/ may import it -- "
        "offending imports:\n" + "\n".join(offenders)
    )


def test_no_module_under_model_calls_a_reprojection_or_rescale_operation():
    offenders = []
    for path in sorted(MODEL_PACKAGE.rglob("*.py")):
        tree = ast.parse(path.read_text(), filename=str(path))
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            func = node.func
            call_name = func.attr if isinstance(func, ast.Attribute) else (
                func.id if isinstance(func, ast.Name) else None
            )
            if call_name in REPROJECTION_CALL_NAMES:
                offenders.append(f"{path}:{node.lineno} calls {call_name!r}")
    assert not offenders, (
        "no module under src/pesto/model/ may call a coordinate-system "
        "conversion, a re-origining or a rescale -- the mesh arrives in "
        "the model's own coordinates and pesto must not touch them "
        "(GRID-04) -- offending calls:\n" + "\n".join(offenders)
    )


def test_a_rotated_offset_grid_reports_bounds_matching_the_transformed_geometry_exactly(
    tmp_path,
):
    """Not "no forbidden name appears" but "the transform arrives untouched":
    this computes the rotated, offset geometry independently from the
    fixture's own known vertex list, and checks pesto's reported bounds
    against that computation directly, to float32 precision -- proof by
    geometry, not by absence."""
    xorigin, yorigin, angrot = 1000.0, 2000.0, 30.0
    grid_path = write_disv_grb(
        tmp_path / "rotated.disv.grb", xorigin=xorigin, yorigin=yorigin, angrot=angrot
    )

    mesh = Mf6Adapter(grid_path).grid_mesh()

    theta = math.radians(angrot)
    verts = np.array(_VERTICES, dtype=np.float64)
    x, y = verts[:, 0], verts[:, 1]
    expected_x = xorigin + x * math.cos(theta) - y * math.sin(theta)
    expected_y = yorigin + x * math.sin(theta) + y * math.cos(theta)
    expected_bounds = (
        float(expected_x.min()),
        float(expected_x.max()),
        float(expected_y.min()),
        float(expected_y.max()),
    )

    for actual, expected in zip(mesh.bounds, expected_bounds):
        assert actual == pytest.approx(expected, abs=1e-2)

    at_origin = write_disv_grb(
        tmp_path / "origin.disv.grb", xorigin=0.0, yorigin=0.0, angrot=0.0
    )
    origin_bounds = Mf6Adapter(at_origin).grid_mesh().bounds
    assert mesh.bounds != origin_bounds


# ---------------------------------------------------------------------------
# Protocol conformance: "one new file" is a mechanical, testable claim.
# ---------------------------------------------------------------------------


class _MissingLocateObs:
    """Five of ``SpatialAdapter``'s six methods -- everything but
    ``locate_obs`` -- proving the negative half without which the positive
    half proves nothing."""

    def grid_mesh(self):
        raise NotImplementedError

    def grid_shape(self):
        raise NotImplementedError

    def idomain(self):
        raise NotImplementedError

    def crs(self):
        raise NotImplementedError

    def locate_par(self, par):
        raise NotImplementedError


class _AllSixMethods:
    """All six ``SpatialAdapter`` methods -- the mechanical statement that a
    second model type providing this surface is a valid adapter."""

    def grid_mesh(self):
        raise NotImplementedError

    def grid_shape(self):
        raise NotImplementedError

    def idomain(self):
        raise NotImplementedError

    def crs(self):
        raise NotImplementedError

    def locate_par(self, par):
        raise NotImplementedError

    def locate_obs(self, obs):
        raise NotImplementedError


def test_a_class_missing_one_of_six_protocol_methods_fails_isinstance():
    assert not isinstance(_MissingLocateObs(), SpatialAdapter)


def test_a_class_providing_all_six_protocol_methods_passes_isinstance():
    assert isinstance(_AllSixMethods(), SpatialAdapter)


def test_mf6adapter_satisfies_the_spatial_adapter_protocol(tmp_path):
    grid_path = write_disv_grb(tmp_path / "t.disv.grb")
    assert isinstance(Mf6Adapter(grid_path), SpatialAdapter)


# ---------------------------------------------------------------------------
# The numeric contract, checked against what crosses the boundary.
# ---------------------------------------------------------------------------


def test_the_boundarys_numeric_contract_is_checked_against_what_crosses_it(tmp_path):
    grid_path = write_disv_grb(tmp_path / "t.disv.grb")
    adapter = Mf6Adapter(grid_path)

    mesh = adapter.grid_mesh()
    assert mesh.positions.dtype is np.dtype(np.float32)
    assert mesh.cell_index.dtype is np.dtype(np.float32)
    assert mesh.indices.dtype is np.dtype(np.uint32)

    par = pd.DataFrame(
        {"pargp": pd.Categorical(["g"]), "idx0": [0], "idx1": [0]},
        index=["p1"],
    )
    par.index.name = "parnme"
    result = adapter.locate_par(par)
    assert result.cell.dtype is np.dtype(np.int32)
    assert result.layer.dtype is np.dtype(np.int32)
