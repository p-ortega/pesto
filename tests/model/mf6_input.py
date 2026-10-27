"""Hand-written MODFLOW 6 simulation, model name and OBS6 files for tests."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class PackageSpec:
    """One package of the model: its OBS6 rows and its period rows.

    ``kind`` is the name file entry (``WEL6``), ``rows`` are inline period rows
    as text, and each ``open_close`` entry becomes a file of rows named by an
    OPEN/CLOSE line in its own period block (single-quoted when ``quote``).
    """

    kind: str
    file: str
    obs_rows: list[tuple[str, str, str]] = field(default_factory=list)
    boundnames: bool = True
    rows: list[str] = field(default_factory=list)
    open_close: dict[str, list[str]] = field(default_factory=dict)
    quote: bool = False
    options: tuple[str, ...] = ()
    obs_file: str | None = None
    declares_obs: bool = True


def write_mf6_obs_input(
    root: Path,
    *,
    model: str = "model",
    dis_file: str = "coarse.disv",
    dis_type: str = "DISV6",
    obs_files: dict[str, list[tuple[str, str, str]]] | None = None,
    single_blocks: bool = False,
    packages: list[PackageSpec] | None = None,
) -> dict[str, Path]:
    """Write ``mfsim.nam``, ``<model>.nam`` and each OBS6 file under ``root``.

    ``obs_files`` maps a file name to its rows, each ``(name, type, id text)``;
    the default is one empty file ``<model>.obs``. Returns every path written,
    keyed by file name.
    """
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    if obs_files is None:
        obs_files = {f"{model}.obs": []}
    written: dict[str, Path] = {}

    def put(name: str, lines: list[str]) -> None:
        path = root / name
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        written[name] = path

    put(
        "mfsim.nam",
        ["BEGIN options", "END options", "BEGIN models", f"gwf6  {model}.nam  {model}", "END models"],
    )
    lines_of = [f"{dis_type}  {dis_file}  dis"]
    lines_of += [f"OBS6  {name}  obs{i}" for i, name in enumerate(obs_files)]
    lines_of += [f"{spec.kind}  {spec.file}  pkg{i}" for i, spec in enumerate(packages or [])]
    put(f"{model}.nam", ["BEGIN packages", *lines_of, "END packages"])
    kind = "single" if single_blocks else "continuous"
    for name, rows in obs_files.items():
        lines = ["BEGIN options", "  DIGITS 10", "END options", f"BEGIN {kind}  FILEOUT  {name}.sim.csv"]
        lines += [f"  {row_name}  {row_type}  {ids}" for row_name, row_type, ids in rows]
        lines.append(f"END {kind}")
        put(name, lines)
    for spec in packages or []:
        obs_name = spec.obs_file or f"{spec.file}.obs"
        options = ["BEGIN options"]
        if spec.boundnames:
            options.append("  BOUNDNAMES")
        options += [f"  {text}" for text in spec.options]
        if spec.declares_obs:
            options.append(f"  OBS6  FILEIN  {obs_name}")
        options.append("END options")
        body = [*options, "BEGIN dimensions", "  MAXBOUND 5", "END dimensions"]
        period = 1
        if spec.rows:
            body += [f"BEGIN period {period}", *[f"  {row}" for row in spec.rows], "END period"]
            period += 1
        for name, rows in spec.open_close.items():
            shown = f"'{name}'" if spec.quote else name
            body += [f"BEGIN period {period}", f"  OPEN/CLOSE  {shown}", "END period"]
            period += 1
            put(name, [f"  {row}" for row in rows])
        put(spec.file, body)
        if spec.declares_obs:
            put(
                obs_name,
                [f"BEGIN continuous FILEOUT {obs_name}.csv"]
                + [f"  {n}  {t}  {i}" for n, t, i in spec.obs_rows]
                + ["END continuous"],
            )
    return written
