"""Make text safe to post in public: the scrubber behind the problem report.

A report must never carry the case name, a folder or file path from the
user's machine, or a parameter, group, observation, site or realization
name. Reasons and notes written by the ingest layer routinely hold all of
these, so every piece of free text in a report goes through ``Scrubber.scrub``.

The scrubber fails closed. After paths, the case name and quoted strings
are replaced, a word in free text is kept only when it is a number or is
made of words pesto itself uses: the words in pesto's own source, common
English function words and Python's exception names. Everything else
becomes ``<name>``, whether or not it was recognised as a name.
"""

from __future__ import annotations

import builtins
import functools
import re
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

CASE = "<case>"
PATH = "<path>"
NAME = "<name>"
FILE = "<file>"

ARTIFACT_KINDS = frozenset(
    {
        "control", "grid", "elev", "config", "par_ens", "par_agg", "par_cell", "par_change",
        "par_groups", "par_hist", "obs_index", "obs_cell", "obs_ens", "obs_agg", "obs_1to1",
        "noise_agg", "pdc", "phi_check", "pp_factors",
    }
)  # fmt: skip

# pesto's own words. A quoted string or a bare word on this list is kept.
VOCABULARY = frozenset(
    {
        *ARTIFACT_KINDS,
        # rule names
        "name-token", "identity-columns", "group", "own-site", "mf6-obs", "xyz-host-cell",
        # grid kinds
        "structured", "vertex", "unstructured", "dis", "disv", "disu", "dis6", "disv6", "disu6",
        # file kinds and extensions
        "jcb", "jco", "bin", "csv", "grb", "pst", "rec", "fac", "tpl", "ins", "par", "obs",
        "phi", "pcs", "noise", "obs+noise", "weights", "adjusted", "prior", "mean", "actual",
        "meas", "regul", "composite", "lambda", "rejected", "case", "run", "cache", "file",
        "folder", "files", "ensemble", "iteration", "realization", "parameter", "observation",
        # column names
        "parnme", "pargp", "parlbnd", "parubnd", "partrans", "parval1", "obsnme", "obgnme",
        "obsval", "weight", "site", "site_id", "site_rule", "time_kind", "time_kinds", "start",
        "count", "ordinal", "object", "cell", "layer", "x", "y", "z", "i", "j", "k", "rule",
        "note", "notes", "name", "names", "value", "values", "time", "datetime",
        # control file options
        "noptmax", "version", "version:", "ies_par_en", "ies_parameter_ensemble", "ies_obs_en",
        "ies_observation_ensemble", "ies_restart_par_en", "ies_restart_parameter_ensemble",
        "ies_restart_obs_en", "ies_restart_observation_ensemble", "ies_no_noise",
        "ies_num_reals", "ies_include_base", "ies_localizer", "ies_autoadaloc",
        "ies_bad_phi", "ies_bad_phi_sigma", "ies_n_iter_reinflate", "ies_noise_ensemble",
        # states and common values
        "ok", "failed", "missing", "absent", "not_ingested", "started", "skipped", "base",
        "none", "null", "nan", "inf", "true", "false", "log", "fixed", "tied", "linear", "log10",
        "pesto", "pestpp", "pestpp-ies", "pest", "pest++", "pyemu", "flopy", "modflow", "mf6",
        "idomain", "top", "botm", "crs", "dtype", "float32", "float64", "int32", "int64",
        "uint8", "uint32", "<f4", "<f8", "<i4", "<u4", "utf-8", "cache_version", "facts_version",
        "grid_type", "nlay", "ncpl", "nrow", "ncol", "and/or", "n/a", "e.g", "i.e", "x86_64",
    }
)  # fmt: skip

# Extensions kept on a replaced file name; any other ending is dropped with the name.
KNOWN_EXTENSIONS = frozenset(
    {
        "jcb", "jco", "bin", "csv", "pst", "rec", "grb", "fac", "tpl", "ins", "dat", "txt",
        "json", "parquet", "f32", "f64", "i32", "u32", "u8", "py", "nam", "dis", "disv", "disu",
        "hds", "cbc", "cbb", "lst", "par", "obs", "res", "rei", "rmr", "rns", "log", "out", "arr",
        "npy", "npz", "zip", "gz", "shp", "prj", "tif", "tiff", "png", "jpg", "jpeg", "pgw",
        "jgw", "wld", "tfw", "exe", "bat", "sh", "yml", "yaml", "toml", "xlsx", "h5", "hdf",
        "nc", "tmp", "bak", "pdf", "md", "ref", "obf", "tdis", "ims", "npf", "sto", "wel", "drn",
        "ghb", "riv", "rch", "chd", "oc", "ic",
    }
)  # fmt: skip

# The dotted parts pestpp puts after the case name, as in case.3.par.jcb.
_CASE_PARTS = frozenset(
    {
        "par", "obs", "jcb", "jco", "bin", "csv", "pst", "rec", "phi", "actual", "meas", "regul",
        "composite", "group", "lambda", "pdc", "pcs", "prior", "mean", "obs+noise", "adjusted",
        "weights", "rejected", "base", "rmr", "rns", "log", "rei", "res", "noise",
    }
)  # fmt: skip

# File names pesto writes into its own cache.
_CACHE_STEMS = frozenset(
    {
        "par", "obs", "notes", "manifest", "config", "mesh", "elev", "index", "par_cell",
        "obs_cell", "positions", "indices", "ring", "ring_start", "cell_index", "idomain",
        "obs_index", "obs_order", "obs_time", "obs_value", "obs_flags", "obs_sites",
        "obs_groups", "par_change", "par_groups", "par_hist", "obs_1to1", "noise_agg",
        "mult2model_info", "case",
    }
)  # fmt: skip
_CACHE_STEM_RE = re.compile(r"^(?:par|obs|pdc|phi_check|noise)_\d+$")
_CACHE_PARTS = frozenset(
    {"json", "parquet", "f32", "f64", "i32", "u32", "u8", "txt", "csv", "reals", "notes",
     "parmap", "parnames", "xy", "meta"}
)  # fmt: skip

# Dotted Python names an exception message may hold, such as numpy.float32.
_CODE_ROOTS = frozenset(
    {"pesto", "pyemu", "flopy", "numpy", "np", "pandas", "pd", "pyarrow", "pa", "pq", "pc",
     "json", "os", "pathlib", "builtins", "concurrent", "asyncio", "starlette", "fastapi"}
)  # fmt: skip

_NUMBER_RE = re.compile(r"^[+-]?(?:\d[\d_,]*\.?\d*|\.\d+)(?:[eE][+-]?\d+)?%?$")
_VERSION_RE = re.compile(r"^v?\d+(?:\.\d+)*(?:[a-z]{1,3}\d*)?$", re.IGNORECASE)
_ARTIFACT_NAME_RE = re.compile(r"^([a-z_0-9]+)/(\d+|prior|mean)$")

# Absolute paths. A folder part may hold spaces as long as more path follows.
_WINDOWS_PATH_RE = re.compile(r"(?<![A-Za-z])[A-Za-z]:[\\/]+(?:[^\\/:\n\"']+[\\/]+)*[^\s\\/:\"']*")
_UNC_PATH_RE = re.compile(r"(?<![\w\\:>])\\\\[^\s\\/\"']+(?:[\\/]+[^\s\\/:\"']+)+")
_POSIX_PATH_RE = re.compile(r"(?<![\w.:<>/~\u2026])(?<!:/)/(?:[^/:\n\"']+/)+[^\s/:\"']*")
_POSIX_ONE_PART_RE = re.compile(r"(?<![\w.:<>/\\~\u2026])/[\w.+-]+")
# "~/a/b" and the "…/a/b" form pesto shows on screen.
_SHORT_PATH_RE = re.compile(r"(?<![\w<>])(?:~|…|\.\.\.|\.\.?)(?:[\\/]+[^\s\\/:\"']+)+")
# What is left after a known folder was replaced outright.
_PATH_TAIL_RE = re.compile(r"<path>(?:[\\/]+[^\s\\/:\"'<>]+)+")
# A relative path such as org/k.txt.
_RELATIVE_PATH_RE = re.compile(r"(?<![\w<>/\\.+-])[\w.+-]+(?:[\\/][\w.+-]+)+(?![\w/\\])")

_QUOTED_RES = (
    re.compile(r'"([^"\n]*)"'),
    re.compile(r"(?<!\w)'([^'\n]*)'"),
    re.compile(r"`([^`\n]*)`"),
)

_CASE_TOKEN_RE = re.compile(r"<case>[\w.+-]*")
_DOTTED_TOKEN_RE = re.compile(r"(?<![\w<>/\\.+-])[\w+-]+(?:\.[\w+-]+)+(?![\w>])")
# A piece of text that could be one name: no spaces, quotes or brackets.
_AFTER_PATH_RE = re.compile(r"(?<=<path>/)[\w+-]+(?:\.[\w+-]+)+")
_CANDIDATE_RE = re.compile(r"[^\s'\"`(),;\[\]{}<>=|]+")
_PLACEHOLDER_ONLY_RE = re.compile(r"^(?:<path>/)?(?:<case>|<file>|<name>|<path>)[\w.+-]*$")

_ENGLISH = frozenset(
    """
    a about above after again against all also although always am an and any are aren as at be
    because been before being below between both but by can cannot could couldn did didn do does
    doesn doing don done down during each either else enough even ever every few first for from
    further get given gives go got had hadn has hasn have haven having he her here hers him his
    how however i if in instead into is isn it its itself just last least less let like likely
    made make many may me might more most much must my need needs neither never new next no nor
    not nothing now of off often on once one only onto or other others otherwise our ours out
    over own per rather s same second see seen several shall she should shouldn since so some
    still such t than that the their theirs them then there these they third this those though
    three through thus to too two under unless until up upon us use used uses using very was
    wasn way we were weren what when where whether which while who whom whose why will with
    within without won would wouldn yes yet you your yours zero four five six seven eight nine
    ten able already back bad been both came come comes could e eg etc g good ie kept keep left
    long looked looks nd rd right st th try tried went
    """.split()
)

# Words of pesto's own that glue a digit to letters; any other such word is taken for a name.
_DIGIT_WORDS = frozenset(
    {
        "float16", "float32", "float64", "int8", "int16", "int32", "int64", "uint8", "uint16",
        "uint32", "uint64", "f4", "f8", "i4", "i8", "u1", "u4", "f32", "f64", "i32", "u32", "u8",
        "mf6", "dis6", "disv6", "disu6", "log10", "log2", "sha256", "utf8", "1to1", "0x", "webgl2",
        "1d", "2d", "3d", "python3", "x86", "ipv4", "ipv6",
    }
)  # fmt: skip

_ALPHA_RE = re.compile(r"[A-Za-z]+")


@functools.lru_cache(maxsize=1)
def vocabulary() -> frozenset[str]:
    """Every word pesto may say in free text, lower-cased: each alphabetic word
    in pesto's own Python source, common English function words and Python's
    exception names. Read once per process from the installed package."""
    words: set[str] = set(_ENGLISH)
    for name, value in vars(builtins).items():
        if isinstance(value, type) and issubclass(value, BaseException):
            words.add(name.lower())
    for term in VOCABULARY | _CASE_PARTS | _CACHE_STEMS | _CACHE_PARTS | _CODE_ROOTS | KNOWN_EXTENSIONS:
        words.update(w.lower() for w in _ALPHA_RE.findall(term))
    package = Path(__file__).resolve().parent.parent
    try:
        sources = sorted(package.rglob("*.py"))
    except OSError:
        sources = []
    for source in sources:
        try:
            text = source.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        words.update(w.lower() for w in _ALPHA_RE.findall(text))
    return frozenset(words)


_PLACEHOLDER_RE = re.compile(r"<(?:case|path|name|file)>")
# A run of characters that could all belong to one name, placeholders included.
_WORD_RE = re.compile(r"(?:<(?:case|path|name|file)>|[\w.:+\-/@])+")
_EDGE = ".:+-/"
_PIECE_SPLIT_RE = re.compile(r"[^A-Za-z0-9]+")
_LOOSE_NUMBER_RE = re.compile(
    r"^[+-]?(?:0[xX][0-9a-fA-F]+|0[oO][0-7]+|0[bB][01]+|(?:\d[\d_,]*\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)"
    r"(?:[kKmMgGtT]?[bB]|ms|s|x|px)?$"
)
_TIMES_RE = re.compile(r"^x\d+$")
_NAME_RUN_RE = re.compile(r"<name>(?: \(x\d+\))?(?:(?:\s*,\s*(?:and\s+)?|\s+and\s+|\s+)<name>(?: \(x\d+\))?)+")


# A letter and a digit joined by "_", "-" or ".", as in well-12 or layer_3: the usual shape of a name.
_JOINED_NUMBER_RE = re.compile(r"[A-Za-z][_.-]\d|\d[_.-][A-Za-z]")
_OWN_NUMBERED_RE = re.compile(r"^(?:par|obs|pdc|noise|phi_check)_\d+(?:\.[a-z0-9]+)*$")


def _own_numbered(part: str) -> bool:
    """The few numbered words pesto writes itself, such as par_0.f32 and obs_agg/12."""
    lower = part.lower()
    if lower in VOCABULARY or _OWN_NUMBERED_RE.match(lower):
        return True
    artifact = _ARTIFACT_NAME_RE.match(lower)
    return bool(artifact and artifact.group(1) in ARTIFACT_KINDS)


def _is_own_word(core: str, words: frozenset[str]) -> bool:
    """Whether one word may stay: a number, or made only of pesto's own words."""
    # What follows <case> was already checked against pestpp's own endings.
    after_case = CASE in core
    rest = _PLACEHOLDER_RE.sub(" ", core)
    for part in rest.split():
        part = part.strip(_EDGE + "_@")
        if not part or _LOOSE_NUMBER_RE.match(part) or _TIMES_RE.match(part) or _VERSION_RE.match(part):
            continue
        if not part.isascii():
            return False
        if _JOINED_NUMBER_RE.search(part) and not after_case and not _own_numbered(part):
            return False
        for piece in _PIECE_SPLIT_RE.split(part):
            if not piece or piece.isdigit():
                continue
            lower = piece.lower()
            if piece.isalpha():
                if lower not in words:
                    return False
            elif lower not in _DIGIT_WORDS:
                return False
    return True


def keep_own_words(text: str) -> str:
    """Replace every word that is not a number or made of pesto's own words."""
    words = vocabulary()

    def one(match: re.Match[str]) -> str:
        token = match.group(0)
        core = token.strip(_EDGE)
        if not core or _is_own_word(core, words):
            return token
        start = token.index(core)
        return token[:start] + NAME + token[start + len(core) :]

    return _WORD_RE.sub(one, text)


def collapse_names(text: str) -> str:
    """``<name>, <name>, <name>`` reads better as ``<name> (x3)``."""

    def one(match: re.Match[str]) -> str:
        run = match.group(0)
        counted = sum(int(n) for n in re.findall(r"<name> \(x(\d+)\)", run))
        plain = len(re.findall(r"<name>(?! \(x\d+\))", run))
        return f"{NAME} (x{counted + plain})"

    return _NAME_RUN_RE.sub(one, text)


MAX_NAME_ROWS = 5_000_000
"""A cached name table with more rows than this is not loaded for a report."""


def _extension_form(token: str) -> str:
    """What a file name of the user's becomes: its extension when that is a
    well-known one, nothing but a placeholder otherwise."""
    ext = token.rsplit(".", 1)[-1].lower() if "." in token else ""
    return f"{FILE}.{ext}" if ext in KNOWN_EXTENSIONS else NAME


def _safe_dotted(token: str) -> str:
    """One dotted word made safe: kept when it is a number, a version or a
    name pesto itself writes, replaced otherwise."""
    lower = token.lower()
    parts = lower.split(".")
    if _NUMBER_RE.match(token) or _VERSION_RE.match(token) or lower in VOCABULARY:
        return token
    if parts[0] == "case" and all(p in _CASE_PARTS or p.isdigit() for p in parts[1:]):
        return token
    if (parts[0] in _CACHE_STEMS or _CACHE_STEM_RE.match(parts[0])) and all(
        p in _CACHE_PARTS or p.isdigit() for p in parts[1:]
    ):
        return token
    if parts[0] in _CODE_ROOTS and all(p.isidentifier() for p in parts[1:]):
        return token
    return _extension_form(token)


def _safe_case_token(token: str) -> str:
    """``<case>`` and what follows it: kept for pestpp's own endings such as
    ``<case>.3.par.jcb``, replaced when anything else is attached."""
    rest = token[len(CASE) :]
    if not rest:
        return token
    trailing = ""
    while rest.endswith("."):
        rest, trailing = rest[:-1], trailing + "."
    if not rest:
        return token
    if rest.startswith(".") and all(
        p.lower() in _CASE_PARTS or p.isdigit() for p in rest[1:].split(".")
    ):
        return token
    if not any(ch.isalpha() for ch in rest):
        return token
    return _extension_form(rest) + trailing


def _path_form(match_text: str) -> str:
    """A path cut down to ``<path>``, plus its last part when that looks like
    a file. The file part is made safe by the later rules."""
    last = re.split(r"[\\/]", match_text.rstrip("\\/"))[-1]
    if "." not in last.strip(".") or last == PATH:
        return PATH
    if not re.fullmatch(r"[\w.+-]+", last):
        return f"{PATH}/{_extension_form(last)}"
    return f"{PATH}/{last}"


@dataclass
class KnownNames:
    """Names read from the cache, lower-cased, looked up without loading them into Python."""

    small: set[str] = field(default_factory=set)
    columns: list[Any] = field(default_factory=list)
    count: int = 0
    notes: list[str] = field(default_factory=list)
    # Lower-cased words already looked up. One lookup hashes a whole table, so each word is asked once.
    _seen: dict[str, bool] = field(default_factory=dict)

    def add(self, names: Iterable[object]) -> None:
        for name in names:
            if isinstance(name, str) and name:
                self.small.add(name.lower())
                self.count += 1
        self._seen.clear()

    def add_column(self, column: Any) -> None:
        """One pyarrow string array of names; kept lower-cased."""
        import pyarrow.compute as pc

        self.columns.append(pc.utf8_lower(column))
        self.count += len(column)
        self._seen.clear()

    def matching(self, candidates: set[str]) -> set[str]:
        """The candidates that are a known name, whatever their letter case."""
        new = sorted({c.lower() for c in candidates} - self._seen.keys())
        if new:
            hits = {c for c in new if c in self.small}
            if self.columns:
                try:
                    import pyarrow as pa
                    import pyarrow.compute as pc

                    for column in self.columns:
                        mask = pc.is_in(pa.array(new, type=column.type), value_set=column)
                        hits.update(c for c, hit in zip(new, mask.to_pylist()) if hit)
                except Exception as exc:  # noqa: BLE001 - a failed lookup must not stop the report
                    self.notes.append(f"a cached name table could not be searched ({type(exc).__name__})")
            for c in new:
                self._seen[c] = c in hits
        return {c for c in candidates if self._seen.get(c.lower(), False)}


def load_known_names(cache_root: Path) -> KnownNames:
    """Every parameter, group, observation, site and realization name the
    cache holds. Reads the cache only, and never raises: a table that cannot
    be read is named in ``notes`` and the quoted-string rule still applies."""
    import json

    known = KnownNames()
    root = Path(cache_root)

    try:
        notes = json.loads((root / "control" / "notes.json").read_text())
        known.add(notes.get("par_groups", ()))
        known.add(notes.get("obs_groups", ()))
    except Exception:  # noqa: BLE001
        pass
    for path in sorted((root / "reals").glob("*.reals.json")) if (root / "reals").is_dir() else ():
        try:
            known.add(json.loads(path.read_text()).get("names", ()))
        except Exception:  # noqa: BLE001
            known.notes.append("a realization name list could not be read")

    tables = (
        ("control/par.parquet", ("parnme", "pargp")),
        ("control/obs.parquet", ("obsnme", "obgnme")),
        ("control/obs_sites.parquet", ("site", "group")),
        ("grid/obs_cell.parquet", ("site", "group")),
    )
    try:
        import pyarrow as pa
        import pyarrow.parquet as pq
    except Exception:  # noqa: BLE001
        known.notes.append("pyarrow could not be loaded, so the cached name tables were not used")
        return known

    for relative, wanted in tables:
        path = root / relative
        if not path.is_file():
            continue
        try:
            meta = pq.read_metadata(path)
            if meta.num_rows > MAX_NAME_ROWS:
                known.notes.append(
                    f"{relative} has {meta.num_rows} rows, more than the {MAX_NAME_ROWS} a report loads"
                )
                continue
            have = set(meta.schema.names)
            table = pq.read_table(path, columns=[c for c in wanted if c in have])
            for column in table.columns:
                if pa.types.is_dictionary(column.type):
                    column = column.cast(column.type.value_type)
                if not (pa.types.is_string(column.type) or pa.types.is_large_string(column.type)):
                    continue
                flat = column.combine_chunks()
                if isinstance(flat, pa.ChunkedArray):
                    flat = pa.concat_arrays(flat.chunks) if flat.num_chunks else None
                if flat is not None and len(flat):
                    known.add_column(flat)
        except Exception as exc:  # noqa: BLE001
            known.notes.append(f"{relative} could not be read for names ({type(exc).__name__})")

    for path in sorted((root / "ens").glob("*.parnames.txt")) if (root / "ens").is_dir() else ():
        try:
            if path.stat().st_size > 64 * 1024 * 1024:
                known.notes.append("an ensemble name list was too large to load")
                continue
            lines = [line for line in path.read_text().splitlines() if line]
            if lines:
                known.add_column(pa.array(lines, type=pa.string()))
        except Exception:  # noqa: BLE001
            known.notes.append("an ensemble name list could not be read")
    return known


def _skippable_name(name: str) -> bool:
    """Names too plain to replace: one character, a number, or one of pesto's own words."""
    return len(name) < 2 or bool(_NUMBER_RE.match(name)) or name.lower() in VOCABULARY


def _whole_token_re(word: str) -> re.Pattern[str]:
    return re.compile(rf"(?<![\w.+:<-]){re.escape(word)}(?![\w+:>-]|\.\w)", re.IGNORECASE)


@dataclass
class Scrubber:
    """Everything known about one run that must not be said in public."""

    case: str | None = None
    folders: tuple[str, ...] = ()
    """Absolute folders to replace outright: the run folder, the cache, the home folder."""
    words: tuple[str, ...] = ()
    """Single words that give the machine away: the run folder's name, the user name."""
    names: KnownNames | None = None

    def scrub(self, text: object) -> str:
        if text is None:
            return ""
        out = str(text)
        out = self._paths(out)
        # Before the case rule: a run folder is often named after the case.
        out = self._machine_words(out)
        out = self._case(out)
        out = self._quoted(out)
        out = self._known_names(out)
        out = self._file_words(out)
        # The last word: whatever the rules above did not recognise goes too.
        return collapse_names(keep_own_words(out))

    def prime(self, texts: Iterable[object]) -> None:
        """Look up the words of many texts against the cached names in one pass."""
        if self.names is None:
            return
        candidates: set[str] = set()
        for text in texts:
            if text is None:
                continue
            ready = self._quoted(self._case(self._machine_words(self._paths(str(text)))))
            candidates |= self._candidates(ready)
        self.names.matching(candidates)

    # -- paths ---------------------------------------------------------------

    def _paths(self, text: str) -> str:
        spellings: set[str] = set()
        for folder in self.folders:
            if len(folder) < 2:
                continue
            spellings.update({folder, folder.replace("\\", "/"), folder.replace("\\", "\\\\")})
        for spelling in sorted(spellings, key=len, reverse=True):
            text = re.sub(re.escape(spelling), lambda _m: PATH, text, flags=re.IGNORECASE)
        text = _PATH_TAIL_RE.sub(lambda m: _path_form(m.group(0)), text)
        for pattern in (_WINDOWS_PATH_RE, _UNC_PATH_RE, _SHORT_PATH_RE, _POSIX_PATH_RE):
            text = pattern.sub(lambda m: _path_form(m.group(0)), text)
        text = _POSIX_ONE_PART_RE.sub(lambda m: _path_form(m.group(0)), text)
        return _RELATIVE_PATH_RE.sub(self._relative_path, text)

    @staticmethod
    def _relative_path(match: re.Match[str]) -> str:
        token = match.group(0)
        lower = token.lower()
        artifact = _ARTIFACT_NAME_RE.match(lower)
        if (artifact and artifact.group(1) in ARTIFACT_KINDS) or lower in VOCABULARY:
            return token
        parts = re.split(r"[\\/]", token)
        if all(_NUMBER_RE.match(p) for p in parts):
            return token
        return _path_form(token)

    # -- the case name -------------------------------------------------------

    def _case(self, text: str) -> str:
        case = self.case
        if not case or case.lower() in VOCABULARY or _NUMBER_RE.match(case):
            return text
        pattern = re.compile(rf"(?<![A-Za-z0-9]){re.escape(case)}(?![A-Za-z0-9])", re.IGNORECASE)
        return pattern.sub(lambda _m: CASE, text)

    # -- quoted strings ------------------------------------------------------

    def _quoted(self, text: str) -> str:
        for pattern in _QUOTED_RES:
            text = pattern.sub(self._one_quoted, text)
        return text

    def _one_quoted(self, match: re.Match[str]) -> str:
        whole, inner = match.group(0), match.group(1)
        quote = whole[0]
        stripped = inner.strip()
        lower = stripped.lower()
        if not stripped or lower in VOCABULARY or _NUMBER_RE.match(stripped):
            return whole
        artifact = _ARTIFACT_NAME_RE.match(lower)
        if artifact and artifact.group(1) in ARTIFACT_KINDS:
            return whole
        if " " not in stripped and _PLACEHOLDER_ONLY_RE.match(stripped):
            # A file name already cut down by the path and case rules; the file rule finishes it.
            return whole
        if " " not in stripped and "." in stripped.strip(".") and "<" not in stripped:
            safe = _safe_dotted(stripped)
            return f"{quote}{safe}{quote}" if safe == stripped else safe
        return NAME

    # -- names the cache knows -----------------------------------------------

    def _known_names(self, text: str) -> str:
        if self.names is None:
            return text
        found = self.names.matching(self._candidates(text))
        for name in sorted(found, key=len, reverse=True):
            text = _whole_token_re(name).sub(lambda _m: NAME, text)
        return text

    @staticmethod
    def _candidates(text: str) -> set[str]:
        candidates: set[str] = set()
        for match in _CANDIDATE_RE.finditer(text):
            token = match.group(0).strip(".:!?*#-")
            if not token:
                continue
            candidates.add(token)
            candidates.update(piece for piece in re.split(r"[:/\\]", token) if piece)
        return {c for c in candidates if not _skippable_name(c)}

    # -- file names ----------------------------------------------------------

    def _file_words(self, text: str) -> str:
        text = _CASE_TOKEN_RE.sub(lambda m: _safe_case_token(m.group(0)), text)
        text = _AFTER_PATH_RE.sub(lambda m: _safe_dotted(m.group(0)), text)
        return _DOTTED_TOKEN_RE.sub(lambda m: _safe_dotted(m.group(0)), text)

    # -- the run folder's name and the user name -----------------------------

    def _machine_words(self, text: str) -> str:
        for word in sorted(set(self.words), key=len, reverse=True):
            if _skippable_name(word):
                continue
            text = _whole_token_re(word).sub(lambda _m: PATH, text)
        return text


def scrubber_for(
    *,
    case: str | None,
    run_dir: str | Path | None,
    cache_root: str | Path | None,
    names: KnownNames | None = None,
) -> Scrubber:
    """A scrubber that knows this machine's folders and user name."""
    import getpass

    folders: list[str] = []
    words: list[str] = []
    for raw in (run_dir, cache_root):
        if raw is None:
            continue
        path = Path(raw)
        folders.append(str(path))
        try:
            folders.append(str(path.resolve()))
        except OSError:
            pass
    if run_dir is not None:
        words.append(Path(run_dir).name)
    try:
        home = Path.home()
        folders.append(str(home))
        words.append(home.name)
    except (RuntimeError, OSError):
        pass
    try:
        words.append(getpass.getuser())
    except Exception:  # noqa: BLE001 - no user name is known on some systems
        pass
    return Scrubber(
        case=case,
        folders=tuple(dict.fromkeys(f for f in folders if f)),
        words=tuple(dict.fromkeys(w for w in words if w)),
        names=names,
    )
