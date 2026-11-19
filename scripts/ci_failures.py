"""Print each failed test from a pytest junit report as a GitHub error line.

The tests workflow runs this after a failure, so the failing tests show on the
run's summary page without opening the log.
"""

from __future__ import annotations

import sys
import xml.etree.ElementTree as ET


def main(path: str) -> int:
    failed = []
    for case in ET.parse(path).getroot().iter("testcase"):
        for kind in ("failure", "error"):
            problem = case.find(kind)
            if problem is not None:
                failed.append((f"{case.get('classname')}::{case.get('name')}", problem))
    # GitHub keeps only ten error lines per step, so the full list of names goes first, as one.
    if failed:
        print(f"::error title={len(failed)} failed test(s)::" + "%0A".join(name for name, _ in failed))
    for name, problem in failed:
        text = (problem.get("message") or "") + "\n" + (problem.text or "")[-1500:]
        # GitHub reads %0A as a line break inside one annotation.
        body = text.strip().replace("%", "%25").replace("\r", "").replace("\n", "%0A")
        print(f"::error title={name}::{body}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
