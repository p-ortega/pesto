"""Hand-written MODFLOW 6 simulation, model name and OBS6 files for tests."""

from __future__ import annotations

from pathlib import Path


def write_mf6_obs_input(
    root: Path,
    *,
    model: str = "model",
    dis_file: str = "coarse.disv",
    dis_type: str = "DISV6",
    obs_files: dict[str, list[tuple[str, str, str]]] | None = None,
    single_blocks: bool = False,
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
    packages = [f"{dis_type}  {dis_file}  dis"]
    packages += [f"OBS6  {name}  obs{i}" for i, name in enumerate(obs_files)]
    put(f"{model}.nam", ["BEGIN packages", *packages, "END packages"])
    kind = "single" if single_blocks else "continuous"
    for name, rows in obs_files.items():
        lines = ["BEGIN options", "  DIGITS 10", "END options", f"BEGIN {kind}  FILEOUT  {name}.sim.csv"]
        lines += [f"  {row_name}  {row_type}  {ids}" for row_name, row_type, ids in rows]
        lines.append(f"END {kind}")
        put(name, lines)
    return written
