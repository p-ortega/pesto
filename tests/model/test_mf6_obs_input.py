"""Sites placed from the model's own MODFLOW 6 observation input.

Every run folder is built in ``tmp_path`` with hand-written name and OBS6 files
and a small synthetic grid whose file name matches the model's discretization
file.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from pesto.model import GridShape, ObsCells
from pesto.model._mf6obs import ObsEntry, ObsInput, place_sites, read_observation_input
from pesto.model.mf6 import OBS_INPUT_RULE, Mf6Adapter, observation_input_files

from .fixtures import write_dis_grb, write_disv_grb
from .mf6_input import write_mf6_obs_input


def _sites(**ids: str | None) -> pd.DataFrame:
    """A site table, one row per keyword, with that site's id and one group."""
    frame = pd.DataFrame(
        {"obgnme": ["grp"] * len(ids), "id": list(ids.values())}, index=list(ids)
    )
    frame.index.name = "obsnme"
    return frame


def _disv_run(tmp_path: Path, rows, nlay: int = 2, **kwargs) -> Path:
    run = tmp_path / "run"
    write_mf6_obs_input(run, obs_files={"m.obs": rows}, **kwargs)
    write_disv_grb(run / "coarse.disv.grb", nlay=nlay)
    return run


def _dis_run(tmp_path: Path, rows) -> Path:
    run = tmp_path / "run"
    write_mf6_obs_input(run, obs_files={"m.obs": rows}, dis_file="coarse.dis", dis_type="DIS6")
    write_dis_grb(run / "coarse.dis.grb", nlay=2, nrow=3, ncol=4)
    return run


def _locate(run: Path, grid: str, sites: pd.DataFrame) -> ObsCells:
    cells = Mf6Adapter(run / grid, model_dir=run).locate_obs(sites)
    assert isinstance(cells, ObsCells), cells
    return cells


def _snapshot(folder: Path) -> dict[str, tuple[bool, int, int]]:
    state = {}
    for path in sorted(folder.rglob("*")):
        stat = path.stat()
        state[str(path.relative_to(folder))] = (path.is_dir(), stat.st_size, stat.st_mtime_ns)
    root = folder.stat()
    state["."] = (True, root.st_size, root.st_mtime_ns)
    return state


def test_a_vertex_cellid_is_one_based_in_the_input_and_stored_zero_based(tmp_path):
    run = _disv_run(tmp_path, [("W", "HEAD", "2 3")])

    cells = _locate(run, "coarse.disv.grb", _sites(a="W"))

    assert (cells.cell[0], cells.layer[0]) == (2, 1)
    assert [(g.group, g.rule, g.mapped) for g in cells.groups] == [("grp", OBS_INPUT_RULE, 1)]
    assert any("zero-based" in note for note in cells.notes)


def test_a_structured_cellid_gives_the_cell_number_within_its_layer(tmp_path):
    run = _dis_run(tmp_path, [("W", "HEAD", "2 3 4")])

    cells = _locate(run, "coarse.dis.grb", _sites(a="W"))

    assert (cells.cell[0], cells.layer[0]) == (11, 1)


def test_the_layer_eleven_cell_3894_example_is_stored_as_layer_10_cell_3893():
    entry = ObsEntry("D-2300A", "HEAD", ("11", "3894"), "coarse_0.obs", "coarse")
    obs = ObsInput({"d-2300a": (entry,)}, ("coarse",), (), (), True)
    shape = GridShape(ncpl=5000, nlay=12, nrow=None, ncol=None)

    placed = place_sites(
        ["d-2300a"], ["D-2300A"], obs, shape, np.array([-1], np.int32), np.array([-1], np.int32)
    )

    assert (placed.cell[0], placed.layer[0]) == (3893, 10)


@pytest.mark.parametrize("kind", ["DRAWDOWN", "CONCENTRATION", "head"])
def test_drawdown_concentration_and_lower_case_types_place_the_same_way(tmp_path, kind):
    run = _disv_run(tmp_path, [("W", kind, "1 2")])

    cells = _locate(run, "coarse.disv.grb", _sites(a="W"))

    assert (cells.cell[0], cells.layer[0]) == (1, 0)


@pytest.mark.parametrize(
    "row, reason",
    [
        (("W", "HEAD", "3 1"), "layer 3"),
        (("W", "HEAD", "1 4"), "cell2d 4"),
        (("W", "HEAD", "0 1"), "layer 0"),
    ],
)
def test_a_vertex_cellid_outside_the_grid_leaves_the_site_unplaced_and_says_why(tmp_path, row, reason):
    run = _disv_run(tmp_path, [row])

    cells = _locate(run, "coarse.disv.grb", _sites(a="W"))

    assert cells.cell[0] == -1 and cells.layer[0] == -1
    note = next(n for n in cells.notes if "outside the grid" in n)
    assert "observation W in m.obs" in note and reason in note


def test_a_structured_row_outside_the_grid_leaves_the_site_unplaced(tmp_path):
    run = _dis_run(tmp_path, [("W", "HEAD", "1 4 1")])

    cells = _locate(run, "coarse.dis.grb", _sites(a="W"))

    assert cells.cell[0] == -1
    assert any("row 4" in n and "m.obs" in n for n in cells.notes)


def test_a_cellid_that_is_not_whole_numbers_is_refused_not_rounded(tmp_path):
    run = _disv_run(tmp_path, [("W", "HEAD", "1 2.5")])

    cells = _locate(run, "coarse.disv.grb", _sites(a="W"))

    assert cells.cell[0] == -1
    assert any("not whole numbers" in n and "1 2.5" in n for n in cells.notes)


def test_a_cellid_with_the_wrong_number_of_parts_for_the_grid_is_refused(tmp_path):
    run = _disv_run(tmp_path, [("W", "HEAD", "1 2 3")])

    cells = _locate(run, "coarse.disv.grb", _sites(a="W"))

    assert cells.cell[0] == -1
    assert any("wrong number of parts" in n and "needs 2" in n for n in cells.notes)


def test_a_flow_ja_face_observation_names_two_cells_so_the_site_stays_unplaced(tmp_path):
    run = _disv_run(tmp_path, [("W", "FLOW-JA-FACE", "1 2")])

    cells = _locate(run, "coarse.disv.grb", _sites(a="W"))

    assert cells.cell[0] == -1
    assert any("names two cells" in n for n in cells.notes)


def test_comments_quoted_names_mixed_case_keywords_and_single_blocks_are_read(tmp_path):
    run = tmp_path / "run"
    write_mf6_obs_input(run, obs_files={"m.obs": []})
    write_disv_grb(run / "coarse.disv.grb", nlay=2)
    (run / "m.obs").write_text(
        "# a comment\n"
        "Begin Options\n  digits 10  ! trailing note\nEnd Options\n"
        "begin SINGLE fileout m.csv\n"
        "  'W 1'  head  1 1   // another\n"
        "  // whole-line comment\n"
        '  "W2"  Head  2 3\n'
        "end single\n",
        encoding="utf-8",
    )

    cells = _locate(run, "coarse.disv.grb", _sites(a="w 1", b="w2"))

    assert [(int(c), int(l)) for c, l in zip(cells.cell, cells.layer)] == [(0, 0), (2, 1)]


def test_an_open_close_line_naming_a_file_inside_the_run_folder_is_followed(tmp_path):
    run = _disv_run(tmp_path, [])
    (run / "rows.txt").write_text("W HEAD 1 3\n", encoding="utf-8")
    (run / "m.obs").write_text(
        "BEGIN continuous FILEOUT m.csv\n  OPEN/CLOSE rows.txt\nEND continuous\n", encoding="utf-8"
    )

    cells = _locate(run, "coarse.disv.grb", _sites(a="W"))

    assert (cells.cell[0], cells.layer[0]) == (2, 0)
    assert run / "rows.txt" in observation_input_files(run)


def test_an_open_close_line_leading_outside_the_run_folder_is_not_followed(tmp_path):
    run = _disv_run(tmp_path, [])
    (tmp_path / "outside.txt").write_text("W HEAD 1 3\n", encoding="utf-8")
    (run / "m.obs").write_text(
        "BEGIN continuous FILEOUT m.csv\n  OPEN/CLOSE ../outside.txt\nEND continuous\n",
        encoding="utf-8",
    )

    cells = _locate(run, "coarse.disv.grb", _sites(a="W"))

    assert cells.cell[0] == -1
    assert any("../outside.txt" in n and "outside the run folder" in n for n in cells.notes)
    assert tmp_path / "outside.txt" not in observation_input_files(run)


def test_a_block_with_no_end_gives_no_entries_from_that_file_and_a_note(tmp_path):
    run = _disv_run(tmp_path, [])
    (run / "m.obs").write_text("BEGIN continuous FILEOUT m.csv\n  W HEAD 1 1\n", encoding="utf-8")

    cells = _locate(run, "coarse.disv.grb", _sites(a="W"))

    assert cells.cell[0] == -1
    assert any("m.obs" in n and "no END" in n for n in cells.notes)


def test_a_binary_observation_file_gives_no_entries_and_a_note(tmp_path):
    run = _disv_run(tmp_path, [])
    (run / "m.obs").write_bytes(b"\xff\xfe\x00\x01BEGIN\x80\x81")

    cells = _locate(run, "coarse.disv.grb", _sites(a="W"))

    assert cells.cell[0] == -1
    assert any("m.obs" in n and "skipped" in n for n in cells.notes)


def test_locating_sites_changes_nothing_in_the_run_folder(tmp_path):
    run = _disv_run(tmp_path, [("W", "HEAD", "1 1"), ("X", "HEAD", "9 9")])
    before = _snapshot(run)

    _locate(run, "coarse.disv.grb", _sites(a="W", b="X"))

    assert _snapshot(run) == before


def test_observation_input_files_lists_the_simulation_name_file_and_obs_files_in_order(tmp_path):
    run = _disv_run(tmp_path, [("W", "HEAD", "1 1")])

    assert observation_input_files(run) == (run / "mfsim.nam", run / "model.nam", run / "m.obs")


def test_an_exact_case_match_places_with_no_lower_casing_note_and_a_case_only_match_is_counted(tmp_path):
    run = _disv_run(tmp_path, [("W-1", "HEAD", "1 1"), ("W-2", "HEAD", "1 2"), ("W-3", "HEAD", "1 3")])

    exact = _locate(run, "coarse.disv.grb", _sites(a="W-1"))
    folded = _locate(run, "coarse.disv.grb", _sites(a="w-1", b="w-2", c="W-3"))

    assert exact.cell[0] == 0
    assert not any("lower-casing" in n for n in exact.notes)
    assert list(folded.cell) == [0, 1, 2]
    note = next(n for n in folded.notes if "lower-casing" in n)
    assert note.startswith("2 site(s)") and "'w-1' for W-1" in note


def test_a_name_is_matched_whole_never_by_prefix_or_part(tmp_path):
    run = _disv_run(tmp_path, [("W-10", "HEAD", "1 1"), ("W", "HEAD", "1 2")])

    cells = _locate(run, "coarse.disv.grb", _sites(a="W-1", b="W-1 HEAD"))

    assert list(cells.cell) == [-1, -1]
    assert any("2 site(s) have an id that names no observation" in n for n in cells.notes)


def test_a_site_with_no_id_stays_unplaced_and_is_counted_under_no_id(tmp_path):
    run = _disv_run(tmp_path, [("W", "HEAD", "1 1")])

    cells = _locate(run, "coarse.disv.grb", _sites(a=None, b="  ", c="W"))

    assert list(cells.cell) == [-1, -1, 0]
    assert any("2 site(s) carry no id" in n and "'a'" in n for n in cells.notes)


def test_a_table_with_no_id_column_places_nothing_and_counts_every_site_under_no_id(tmp_path):
    run = _disv_run(tmp_path, [("W", "HEAD", "1 1")])
    sites = _sites(a="W").drop(columns="id")

    cells = _locate(run, "coarse.disv.grb", sites)

    assert cells.cell[0] == -1
    assert any("1 site(s) carry no id" in n for n in cells.notes)


def test_the_same_name_in_two_files_with_different_cells_is_ambiguous_and_names_both_files(tmp_path):
    run = tmp_path / "run"
    write_mf6_obs_input(
        run, obs_files={"a.obs": [("W", "HEAD", "1 1")], "b.obs": [("W", "HEAD", "1 2")]}
    )
    write_disv_grb(run / "coarse.disv.grb", nlay=2)

    cells = _locate(run, "coarse.disv.grb", _sites(s="W"))

    assert cells.cell[0] == -1
    assert any("different cells" in n and "a.obs" in n and "b.obs" in n for n in cells.notes)


def test_the_same_name_in_two_files_with_the_same_cell_is_placed(tmp_path):
    run = tmp_path / "run"
    write_mf6_obs_input(
        run, obs_files={"a.obs": [("W", "HEAD", "1 2")], "b.obs": [("W", "HEAD", "1 2")]}
    )
    write_disv_grb(run / "coarse.disv.grb", nlay=2)

    cells = _locate(run, "coarse.disv.grb", _sites(s="W"))

    assert (cells.cell[0], cells.layer[0]) == (1, 0)


def test_a_model_on_another_grid_is_skipped_and_one_note_names_the_model_file_and_grid(tmp_path):
    run = _disv_run(tmp_path, [("W", "HEAD", "1 1")], dis_file="other.disv")
    write_disv_grb(run / "coarse.disv.grb", nlay=2)

    cells = _locate(run, "coarse.disv.grb", _sites(a="W"))

    assert cells.cell[0] == -1
    notes = [n for n in cells.notes if "was skipped" in n]
    assert len(notes) == 1
    assert "'model'" in notes[0] and "other.disv" in notes[0] and "coarse.disv.grb" in notes[0]


def test_a_run_with_no_simulation_file_keeps_its_cells_and_one_note_says_the_input_was_not_found(tmp_path):
    run = tmp_path / "run"
    run.mkdir()
    write_disv_grb(run / "coarse.disv.grb", nlay=2)

    cells = _locate(run, "coarse.disv.grb", _sites(a="W", b="X"))

    assert list(cells.cell) == [-1, -1]
    found = [n for n in cells.notes if "mfsim.nam" in n and "not found" in n]
    assert len(found) == 1 and found[0].startswith("2 site(s)")


def test_a_site_placed_by_its_columns_keeps_that_cell_and_a_disagreement_is_counted_and_named(tmp_path):
    run = _disv_run(tmp_path, [("W", "HEAD", "1 3"), ("V", "HEAD", "1 1")])
    sites = pd.DataFrame(
        {
            "obgnme": ["grp", "grp", "grp"],
            "id": ["W", "V", "U"],
            "icpl": ["0", "0", None],
            "layer": ["0", "0", None],
        },
        index=pd.Index(["w", "v", "u"], name="obsnme"),
    )

    cells = _locate(run, "coarse.disv.grb", sites)

    assert list(cells.cell[:2]) == [0, 0] and list(cells.layer[:2]) == [0, 0]
    assert [g.rule for g in cells.groups] == ["icpl-layer"]
    note = next(n for n in cells.notes if "disagree" in n)
    assert note.startswith("1 site(s)") and "'w'" in note and "'v'" not in note


def test_the_no_column_note_says_the_column_rules_were_not_tried(tmp_path):
    run = _disv_run(tmp_path, [])

    cells = _locate(run, "coarse.disv.grb", _sites(a="W"))

    note = next(n for n in cells.notes if "placement columns" in n)
    assert "no site was placed" not in note
    assert "no column rule was tried" in note
    assert "obgnme" in note and "id" in note


def test_a_run_with_no_simulation_file_has_no_observation_input_files(tmp_path):
    assert observation_input_files(tmp_path) == ()
    assert read_observation_input(tmp_path, "coarse.disv.grb").found is False
