"""The pp_factors artifact: PstFrom factor and template files become an
index of interpolable groups, and every way that can fail is named."""

from __future__ import annotations

from pathlib import Path

import pandas as pd
import pytest

from pesto.cache.layout import CacheLayout
from pesto.ingest.failures import ReadFailure
from pesto.ingest.ppfactors import PpIndex, build_pp_index, load_pp_index, write_pp_index
from pesto.model import GridShape

SHAPE = GridShape(ncpl=6, nlay=1, nrow=None, ncol=None)

FAC = """pp.dat
zone.dat
1 6
2
pp0
pp1
1 0 2 0.0 1 1.0 2 0.0
2 0 2 0.0 1 0.75 2 0.25
3 0 2 0.0 1 0.5
 2 0.5
4 0 2 0.0 1 0.25 2 0.75
5 0 2 0.0 1 0.0 2 1.0
"""

TPL = """ptf ~
pp0  1.5 0.5 1  ~   p8   ~
pp1  4.5 0.5 1  ~ p9 ~
"""


def _par(names, groups):
    return pd.DataFrame({"pargp": groups}, index=pd.Index(names, name="parnme"))


def _run(tmp_path: Path, fac: str = FAC, tpl: str = TPL) -> Path:
    (tmp_path / "g4pp_inst0pp.fac").write_text(fac)
    (tmp_path / "g4pp_inst0pp.dat").write_text("pp0 1.5 0.5 1 1.0\npp1 4.5 0.5 1 1.0\n")
    (tmp_path / "g4pp_inst0pp.dat.tpl").write_text(tpl)
    (tmp_path / "mult2model_info.csv").write_text(
        ",org_file,model_file,fac_file,pp_file\n"
        "0,org/k_layer1.txt,k_layer1.txt,g4pp_inst0pp.fac,g4pp_inst0pp.dat\n"
    )
    return tmp_path


def _build(run: Path, par=None, shape=SHAPE) -> PpIndex:
    par = _par(["p8", "p9"], ["G4", "G4"]) if par is None else par
    return build_pp_index(run, run / "mult2model_info.csv", (run / "g4pp_inst0pp.fac",), par, shape)


def test_a_text_factor_file_and_its_template_become_one_interpolable_group(tmp_path):
    index = _build(_run(tmp_path))
    assert index.not_interpolable == ()
    (group,) = index.groups
    assert group.group == "G4"
    assert group.layer == 0
    assert group.format == "text"
    assert group.parnames == ("p8", "p9")
    assert group.pp_names == ("pp0", "pp1")
    assert group.log_space is False
    assert group.n_cells == 5  # the wrapped line for cell 3 counts once


def test_template_marker_and_spacing_do_not_matter(tmp_path):
    tpl = "ptf $\npp0 1.5 0.5 1 $p8$\npp1 4.5 0.5 1 $    p9 $\n"
    index = _build(_run(tmp_path, tpl=tpl))
    assert index.groups[0].parnames == ("p8", "p9")


def test_a_point_the_template_does_not_name_refuses_the_group_with_a_reason(tmp_path):
    tpl = "ptf ~\npp0 1.5 0.5 1 ~ p8 ~\n"
    index = _build(_run(tmp_path, tpl=tpl))
    assert index.groups == ()
    ((group, reason),) = index.not_interpolable
    assert group == "g4pp_inst0pp.dat"
    assert "pp1" in reason and "template" in reason


def test_a_parameter_missing_from_the_control_table_refuses_the_group(tmp_path):
    index = _build(_run(tmp_path), par=_par(["p8"], ["G4"]))
    ((_, reason),) = index.not_interpolable
    assert "p9" in reason and "control" in reason


def test_a_group_with_no_layer_in_its_name_on_a_multi_layer_grid_is_refused(tmp_path):
    shape = GridShape(ncpl=6, nlay=3, nrow=None, ncol=None)
    index = _build(_run(tmp_path), shape=shape)
    ((_, reason),) = index.not_interpolable
    assert "layer" in reason


def test_the_layer_is_parsed_from_the_group_name(tmp_path):
    shape = GridShape(ncpl=6, nlay=3, nrow=None, ncol=None)
    index = _build(_run(tmp_path), par=_par(["p8", "p9"], ["npfklayer3pp", "npfklayer3pp"]), shape=shape)
    assert index.groups[0].layer == 2


def test_an_unreadable_factor_file_is_refused_not_skipped(tmp_path):
    run = _run(tmp_path, fac="pp.dat\nzone.dat\nnot numbers\n")
    index = _build(run)
    ((_, reason),) = index.not_interpolable
    assert "g4pp_inst0pp.fac" in reason


def test_the_index_round_trips_through_the_cache(tmp_path):
    run = _run(tmp_path)
    layout = CacheLayout(root=tmp_path / ".pesto")
    layout.ensure()
    written = write_pp_index(_build(run), layout)
    assert not isinstance(written, ReadFailure)
    assert written.name == "pp_factors"
    loaded = load_pp_index(layout)
    assert loaded == _build(run)


def test_a_missing_index_reads_as_a_failure_naming_the_file(tmp_path):
    layout = CacheLayout(root=tmp_path / ".pesto")
    layout.ensure()
    result = load_pp_index(layout)
    assert isinstance(result, ReadFailure)
    assert "index.json" in result.reason


@pytest.mark.parametrize("group", ["hklayer0pp", "hklayer4pp"])
def test_a_layer_number_outside_the_grid_is_refused_naming_the_group(tmp_path, group):
    shape = GridShape(ncpl=6, nlay=3, nrow=None, ncol=None)
    index = _build(_run(tmp_path), par=_par(["p8", "p9"], [group, group]), shape=shape)
    assert index.groups == ()
    ((name, reason),) = index.not_interpolable
    assert name == group
    assert "3 layers" in reason


def test_a_refusal_found_after_the_group_is_known_is_keyed_by_the_group(tmp_path):
    shape = GridShape(ncpl=6, nlay=3, nrow=None, ncol=None)
    index = _build(_run(tmp_path), shape=shape)
    ((name, _),) = index.not_interpolable
    assert name == "G4"


@pytest.mark.parametrize("outside", ["absolute", "parent"])
def test_a_factor_file_outside_the_run_directory_refuses_that_group_only(tmp_path, outside):
    run = tmp_path / "run"
    run.mkdir()
    _run(run)
    elsewhere = tmp_path / "elsewhere.fac"
    elsewhere.write_text(FAC)
    (run / "other.dat.tpl").write_text(TPL)
    fac_file = str(elsewhere) if outside == "absolute" else "../elsewhere.fac"
    (run / "mult2model_info.csv").write_text(
        ",org_file,model_file,fac_file,pp_file\n"
        "0,org/k_layer1.txt,k_layer1.txt,g4pp_inst0pp.fac,g4pp_inst0pp.dat\n"
        f"1,org/k_layer2.txt,k_layer2.txt,{fac_file},other.dat\n"
    )
    index = _build(run)
    assert [g.group for g in index.groups] == ["G4"]
    ((key, reason),) = index.not_interpolable
    assert key == "other.dat" and "outside the run directory" in reason
