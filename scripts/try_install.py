"""Start an installed pesto, fetch its page once, and stop it.

The release workflow runs this on each system after installing the wheel, so
a release that cannot start or ships without its frontend never goes out.
"""

from __future__ import annotations

import re
import subprocess
import sys
import time
import urllib.request


def main() -> int:
    proc = subprocess.Popen(
        ["pesto", "--no-browser"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    try:
        deadline = time.monotonic() + 120
        url = None
        while time.monotonic() < deadline:
            line = proc.stdout.readline()
            if not line:
                break
            match = re.search(r"http://\S+", line)
            if match:
                url = match.group(0)
                break
        if url is None:
            print("pesto never printed its address")
            return 1
        with urllib.request.urlopen(url, timeout=30) as response:
            page = response.read().decode("utf-8")
        if "<title>pesto</title>" not in page:
            print("the page pesto served is not its frontend")
            return 1
        print("pesto started and served its page")
        return 0
    finally:
        proc.terminate()
        proc.wait(timeout=30)


if __name__ == "__main__":
    sys.exit(main())
