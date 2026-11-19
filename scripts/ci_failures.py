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
    # GitHub keeps ten error lines per step and cuts long ones, so pack short reasons into a few.
    lines = []
    for name, problem in failed:
        reason = " ".join((problem.get("message") or "").split())[:260]
        lines.append(f"{name} :: {reason}")
    chunks, chunk = [], ""
    for line in lines:
        if chunk and len(chunk) + len(line) > 3400:
            chunks.append(chunk)
            chunk = ""
        chunk += line + "\n"
    if chunk:
        chunks.append(chunk)
    for i, text in enumerate(chunks[:10], start=1):
        body = text.strip().replace("%", "%25").replace("\r", "").replace("\n", "%0A")
        print(f"::error title={len(failed)} failed test(s), part {i} of {len(chunks)}::{body}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
