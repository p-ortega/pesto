"""The scrubber behind the problem report: what it must remove and what it must keep."""

from __future__ import annotations

import pytest

from pesto.api.scrub import (
    KnownNames,
    Scrubber,
    collapse_names,
    keep_own_words,
    load_known_names,
    scrubber_for,
    vocabulary,
)


def _scrubber(**kwargs) -> Scrubber:
    names = KnownNames()
    names.add(["hk_layer3", "drnset.cond", "well_12", "r17", "pname:k_inst:0", "base", "7"])
    defaults = dict(
        case="alpha",
        folders=("/home/jo/My Runs/alpha_run", "/home/jo"),
        words=("alpha_run", "jo"),
        names=names,
    )
    defaults.update(kwargs)
    return Scrubber(**defaults)


# -- the case name ------------------------------------------------------------


def test_the_case_name_becomes_a_placeholder_inside_a_pestpp_file_name():
    assert _scrubber().scrub("could not read alpha.3.par.jcb") == "could not read <case>.3.par.jcb"


def test_the_case_name_is_replaced_whatever_its_letter_case():
    assert _scrubber().scrub("ALPHA.rec and Alpha.pst") == "<case>.rec and <case>.pst"


def test_the_case_name_is_not_cut_out_of_a_longer_word():
    assert "<case>" not in _scrubber().scrub("alphabet soup")


def test_a_file_named_after_the_case_with_more_attached_loses_the_rest():
    out = _scrubber().scrub("alpha_northfield.csv and alpha.northfield.csv")
    assert "northfield" not in out
    assert out == "<file>.csv and <file>.csv"


def test_a_case_name_that_is_one_of_pestos_own_words_is_left_alone():
    assert _scrubber(case="grid").scrub("the grid artifact failed") == "the grid artifact failed"


# -- paths --------------------------------------------------------------------


@pytest.mark.parametrize(
    "text",
    [
        "failed to read /home/jo/My Runs/alpha_run/alpha.3.par.jcb: bad header",
        "failed to read /srv/data/client x/runs/alpha.3.par.jcb: bad header",
        r"failed to read C:\Users\Jo Smith\Runs\alpha_run\alpha.3.par.jcb: bad header",
        r"failed to read C:\\Users\\jo\\runs\\alpha.3.par.jcb: bad header",
        "failed to read D:/work/site/alpha.3.par.jcb: bad header",
        r"failed to read \\fileserver\projects\site\alpha.3.par.jcb: bad header",
        "failed to read ~/runs/site/alpha.3.par.jcb: bad header",
        "failed to read \u2026/site/alpha_run/alpha.3.par.jcb: bad header",
    ],
)
def test_an_absolute_path_keeps_only_a_safe_file_name(text):
    assert _scrubber().scrub(text) == "failed to read <path>/<case>.3.par.jcb: bad header"


def test_a_folder_path_leaves_nothing_of_itself():
    out = _scrubber().scrub("no control file (*.pst) found in /srv/data/northfield_mine")
    assert out == "no control file (*.pst) found in <path>"


def test_a_windows_folder_path_leaves_nothing_of_itself():
    out = _scrubber().scrub(r"no control file found in E:\Clients\Northfield Mine\run_07")
    assert "Northfield" not in out and "Clients" not in out and "run_07" not in out


def test_a_file_of_the_users_under_a_path_keeps_only_its_ending():
    out = _scrubber().scrub("cannot open /srv/data/x/northfield_heads.csv")
    assert out == "cannot open <path>/<file>.csv"


def test_a_relative_path_is_replaced_too():
    out = _scrubber().scrub("factor file org/northfield_k.txt was not linked")
    assert out == "factor file <path>/<file>.txt was not linked"


def test_an_artifact_name_with_a_slash_is_not_taken_for_a_path():
    assert _scrubber().scrub("par_ens/0 failed, obs_agg/12 is fine") == "par_ens/0 failed, obs_agg/12 is fine"


def test_a_web_address_is_not_taken_for_a_path():
    text = "see https://github.com/p-ortega/pesto/issues"
    assert _scrubber().scrub(text) == text


def test_the_run_folder_name_and_the_user_name_are_replaced_as_whole_words():
    out = _scrubber().scrub("alpha_run belongs to jo; jolly is another word")
    assert out == "<path> belongs to <path>; <name> is another word"


def test_scrubber_for_knows_the_home_folder_and_the_run_folder(tmp_path, monkeypatch):
    home = tmp_path / "home" / "msmith"
    run = home / "clients" / "northfield"
    run.mkdir(parents=True)
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))
    scrubber = scrubber_for(case="alpha", run_dir=run, cache_root=run / ".pesto")
    out = scrubber.scrub(f"{run}/.pesto/manifest.json is unreadable; msmith may not read northfield")
    assert "msmith" not in out and "northfield" not in out and "clients" not in out
    assert "manifest.json" in out


# -- quoted strings -----------------------------------------------------------


def test_a_quoted_name_is_replaced_in_every_quote_style():
    out = _scrubber().scrub("""parameter 'kx_zone9' in group "north pit" and site `bh-204`""")
    assert out == "parameter <name> in group <name> and site <name>"


def test_a_quoted_word_of_pestos_own_is_kept():
    text = "the grid is of type 'vertex' and the rule is 'xyz-host-cell'; artifact 'par_ens/0'"
    assert _scrubber().scrub(text) == text


def test_a_quoted_number_is_kept():
    assert _scrubber().scrub("cache_version '3' was found") == "cache_version '3' was found"


def test_an_apostrophe_inside_a_word_does_not_open_a_quote():
    text = "this run's grid has no layers and the file's header is short"
    assert _scrubber().scrub(text) == text


def test_a_quoted_path_does_not_survive():
    out = _scrubber().scrub("PosixPath('/srv/data/northfield/alpha.pst') is missing")
    assert "northfield" not in out and "srv" not in out
    assert "<case>.pst" in out


def test_a_quoted_file_of_the_users_keeps_only_its_ending():
    assert _scrubber().scrub("could not parse 'northfield_obs.csv'") == "could not parse <file>.csv"


# -- names the cache knows ----------------------------------------------------


def test_a_known_name_is_replaced_without_quotes():
    out = _scrubber().scrub("hk_layer3 and well_12 are missing; realization r17 was dropped")
    assert out == "<name> (x2) are missing; realization <name> was dropped"


def test_a_known_name_with_dots_or_colons_is_replaced_whole():
    out = _scrubber().scrub("drnset.cond has 12 rows, pname:k_inst:0 is at its bound.")
    assert out == "<name> has 12 rows, <name> is at its bound."


def test_a_known_name_is_matched_whatever_its_letter_case():
    assert _scrubber().scrub("HK_LAYER3 is fixed") == "<name> is fixed"


def test_a_known_name_is_not_cut_out_of_a_longer_word():
    # The cached-name step on its own; the own-words rule replaces this word afterwards.
    assert _scrubber()._known_names("well_120 is fine") == "well_120 is fine"


def test_a_known_name_that_is_a_number_or_pestos_own_word_is_left_alone():
    assert _scrubber().scrub("base was kept at iteration 7") == "base was kept at iteration 7"


def test_known_names_are_read_from_the_cache_tables(tmp_path):
    from fixtures.synthetic_run import write_synthetic_run
    from pesto.cache.layout import for_run

    dest = write_synthetic_run(tmp_path / "run")
    names = load_known_names(for_run(dest).root)
    assert names.matching({"p1", "G4layer1", "r1", "nothing_like_this"}) == {"p1", "G4layer1", "r1"}
    assert names.notes == []


def test_a_cache_that_is_not_there_gives_no_names_and_does_not_raise(tmp_path):
    names = load_known_names(tmp_path / "absent")
    assert names.count == 0
    assert names.matching({"p1"}) == set()


# -- what is kept -------------------------------------------------------------


def test_numbers_versions_and_pestos_own_file_names_are_kept():
    text = "par_0.f32 holds 3.5e-05 at version 1.2.3; manifest.json and case.phi.actual.csv, e.g. 12 rows"
    assert _scrubber().scrub(text) == text


def test_a_dotted_word_that_is_not_pestos_is_replaced():
    out = _scrubber().scrub("northfield.heads was rejected and pit.lake.csv was read")
    assert out == "<name> was rejected and <file>.csv was read"


def test_none_scrubs_to_an_empty_string():
    assert _scrubber().scrub(None) == ""


# -- fail closed: only pesto's own words stay ---------------------------------


def test_the_vocabulary_holds_pestos_own_words_and_no_made_up_ones():
    words = vocabulary()
    for word in ("parameter", "ensemble", "realization", "the", "keyerror", "obs", "agg"):
        assert word in words, word
    for word in ("northfield", "pit", "qwertyish"):
        assert word not in words, word
    assert vocabulary() is words


def test_upper_case_unquoted_site_names_in_a_matching_note_do_not_survive():
    # The shape that leaked: the names are not in the cache in this letter case.
    note = (
        "289 site(s) matched an observation only after lower-casing (whole names, case ignored; "
        "e.g. 'well-12a' for WELL-12A, 'well-13b' for WELL-13B, 'pit-07' for PIT-07)"
    )
    out = Scrubber(case="alpha").scrub(note)
    for secret in ("WELL", "12A", "13B", "PIT", "well", "pit", "07"):
        assert secret not in out, secret
    assert out.startswith("289 site(s) matched an observation only after lower-casing")
    assert out.count("<name>") >= 3


@pytest.mark.parametrize(
    ("text", "secrets"),
    [
        ("KeyError: north_pit_k", ["north_pit_k", "pit"]),
        ("ValueError: could not convert Qwertyish to float", ["Qwertyish"]),
        ("the column NorthPitDrain is missing", ["NorthPitDrain"]),
        ("groups npfklayer1gr, hds_layer1 and BH-204 were skipped", ["npfklayer1gr", "hds_layer1", "BH-204", "204"]),
        ("unknown name (pit-lake)", ["pit-lake", "pit", "lake"]),
        ("names: pit;lake|quarry=[bund]", ["pit", "lake", "quarry", "bund"]),
        ("site pit_lake. Next: quarry!", ["pit_lake", "quarry"]),
        ("observation oname:hds_usecol:trgw-0-9-1_time:3652.5 has no weight", ["trgw", "usecol", "0-9-1"]),
        ("read failed for Müller-Pegel", ["Müller", "Pegel"]),
        ("user jsmith@fieldco owns it", ["jsmith", "fieldco"]),
        ("see https://fieldco.example/runs/quarry", ["fieldco", "quarry"]),
    ],
)
def test_a_word_that_is_not_pestos_own_becomes_a_placeholder(text, secrets):
    out = Scrubber(case="alpha").scrub(text)
    for secret in secrets:
        assert secret not in out, (secret, out)
    assert "<name>" in out or "<path>" in out


def test_an_exception_name_and_plain_words_around_a_name_are_kept():
    assert Scrubber().scrub("KeyError: north_pit_k") == "KeyError: <name>"


@pytest.mark.parametrize(
    "text",
    [
        "par_agg and obs_index are ok; rule xyz-host-cell placed 43 of 1200 parameters",
        "the layer is zero-based; 12% of 3.5e-05, 0o555, 1.2e-3 and 264.9 MB in 39.9 s",
        "artifact par_ens/0 failed: np.float64(0.0) is not a float32",
        "no control file (*.pst) was found, so there is nothing to read",
    ],
)
def test_pestos_own_words_and_numbers_are_kept(text):
    assert Scrubber().scrub(text) == text


def test_a_run_of_placeholders_is_said_once_with_a_count():
    out = Scrubber().scrub("for example qqa1, qqb2, qqc3 and qqd4; then 'aa' for BB-1")
    assert out == "for example <name> (x4); then <name> for <name>"


def test_collapse_names_adds_up_counts_it_already_made():
    assert collapse_names("<name> (x3), <name>") == "<name> (x4)"
    assert collapse_names("<name> for <name>") == "<name> for <name>"


def test_keep_own_words_keeps_placeholders_with_pestpp_endings():
    text = "read <path>/<case>.3.par.jcb and <file>.csv"
    assert keep_own_words(text) == text


def test_a_cached_name_is_found_whatever_case_the_cache_holds_it_in():
    names = KnownNames()
    names.add(["Well_Site", "MINE"])
    assert names.matching({"well_site", "WELL_SITE", "mine", "other"}) == {"well_site", "WELL_SITE", "mine"}
    # "mine" and "well" and "site" are words in pesto's source, so only the cache catches these.
    out = Scrubber(names=names).scrub("well_site and Mine are missing")
    assert "well_site" not in out and "Mine" not in out


def test_a_plain_word_joined_to_a_number_is_taken_for_a_name():
    # "well", "layer" and "site" are pesto words, so only the joined number gives these away.
    out = Scrubber().scrub("WELL-12, layer_3 and site.7 were skipped; par_0.f32 and obs_agg/12 are fine")
    assert out == "<name> (x3) were skipped; par_0.f32 and obs_agg/12 are fine"
