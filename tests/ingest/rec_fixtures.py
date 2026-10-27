"""A generator for pestpp run-record text (``case.rec``).

The lines are copied from real pestpp-ies records, so a reader tested against
them reads a real record. A plain helper module like ``fixtures.py``: it
writes only the one file it is given.
"""

from __future__ import annotations

from pathlib import Path

DEFAULT_OPTIONS = {
    "ies_parameter_ensemble": "prior_pe.jcb",
    "ies_observation_ensemble": "noise_oe.jcb",
    "ies_weights_ensemble": "",
    "ies_reg_factor": "0",
    "ies_num_reals": "300",
    "ies_include_base": "1",
    "ies_n_iter_reinflate": "3,999,",
    "ies_reinflate_factor": "0.75,1,",
}

GROUP_HEADER = (
    "group                                   count  mean chg  std chg  n at ubnd  "
    "% at ubnd  n at lbnd  % at lbnd  n std decr"
)

_NOISE_LINES = {
    "reset_to_no_noise": (
        "  ---  NOTE: no obs-noise-specific options have been passed, "
        "resetting to `ies_no_noise` to true  ---  "
    ),
    "no_noise_ensemble": "...initializing no-noise observation ensemble of :  494",
    "drawn_noise": "drawing observation noise realizations: 300",
    "loaded_obs_ensemble": "...loading obs ensemble from binary file noise_oe.jcb",
    "standard_deviation_column": (
        "Note: the following observations have 'standard_deviation' defined - this will be used"
    ),
}


def _dump_lines(options: dict[str, str]) -> list[str]:
    lines = []
    for key, value in options.items():
        if "," in value:
            # pestpp prints a list option's key alone and the list on the next line
            lines.extend([f"{key}: ", value])
        else:
            lines.append(f"{key}: {value}")
    return lines


def write_rec(
    path: Path,
    *,
    version: str | None = "5.2.23",
    options: dict[str, str] | None = None,
    noise: str | tuple[str, ...] | None = None,
    reg_factor: float | None = 0,
    localization: str | int | None = None,
    base_kept: bool = False,
    reinflations: tuple[int, ...] = (),
    reinflation_without_report: bool = False,
    group_tables: dict[str, list[tuple]] | None = None,
    heading: str = "summary",
    bad_byte: bool = False,
    unknown_lines: int = 0,
) -> Path:
    """Write a run record and return its path.

    ``noise`` is one kind or several, named as ``RecLine.kind`` names them.
    ``localization`` is ``"off"`` or a number of upgrade steps.
    ``group_tables`` maps the pcs file a table is saved to onto its rows,
    each ``(group, count, mean_chg, std_chg, n_ub, pct_ub, n_lb, pct_lb,
    n_std_decr)`` (a row of any other width is written as given). ``heading`` is ``"summary"`` or the 5.2.17 spelling
    ``"summmary"``.
    """
    lines: list[str] = ["             pestpp-ies", ""]
    if version is not None:
        lines.append(f"version: {version}")
    lines.append("")
    lines.extend(f"junk line {i} that no reader should recognise" for i in range(unknown_lines))

    dump = DEFAULT_OPTIONS if options is None else options
    lines.append("...shared pestpp-ies/pestpp-da options:")
    lines.append("(note: 'da' args override 'ies' args when using pestpp-da)")
    lines.extend(_dump_lines(dump))
    lines.append("")
    lines.append("pestpp-sen options: ")
    lines.append("")

    kinds = (noise,) if isinstance(noise, str) else (noise or ())
    lines.extend(_NOISE_LINES[kind] for kind in kinds)

    if localization == "off":
        lines.append("...not using localization")
    elif localization is not None:
        lines.append(f"...using localized solution with {localization} sequential upgrade steps")
    if reg_factor is not None:
        lines.append(f"...using reg_factor:  {reg_factor:g}")
    if base_kept:
        lines.append("...'base' realization already in parameter ensemble, ignoring '++ies_include_base'")
    if bad_byte:
        lines.append("...a note with a bad byte \udcff in the middle")

    for iteration in reinflations:
        lines.extend(
            [
                "incrementing iteration count for reinflation cycle",
                "",
                "  ---  resetting current parameter ensemble to prior ensemble with current ensemble mean  ---  ",
                "...reinflation factor: 0.75",
                "",
                "  ---  running new mean-shifted prior realizations:  300  ---  ",
                "",
                f"  ---  EnsembleMethod iteration {iteration} report  ---  ",
                "   number of active realizations:  296",
            ]
        )

    if reinflation_without_report:
        lines.extend(["incrementing iteration count for reinflation cycle", "...reinflation factor: 0.5"])

    spelled = "summmary" if heading == "summmary" else "summary"
    for file_name, rows in (group_tables or {}).items():
        lines.extend(["", "", f"   ---  parameter group change {spelled}  ---    ", GROUP_HEADER])
        for row in rows:
            if len(row) != 9:
                # a row of the wrong width, written as it is
                lines.append("  ".join(str(v) for v in row))
                continue
            group, count, mean_chg, std_chg, n_ub, pct_ub, n_lb, pct_lb, n_dec = row
            lines.append(
                f"{group:<38}{count:>5}{mean_chg:>10}{std_chg:>9}{n_ub:>11}{pct_ub:>11}"
                f"{n_lb:>11}{pct_lb:>11}{n_dec:>12}"
            )
        lines.extend(["", f"...saved parameter change summary to {file_name}"])

    path = Path(path)
    # surrogateescape turns the lone surrogate above into a raw 0xff byte
    path.write_bytes(("\n".join(lines) + "\n").encode("utf-8", errors="surrogateescape"))
    return path
