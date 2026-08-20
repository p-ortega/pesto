"""Env-gated hatchling build hook: runs the Vite build at release time only.

Hatchling calls this hook on every build, but it returns immediately unless
``PESTO_BUILD_FRONTEND=1`` is set, so ``uv sync``, an editable install and
``uv run pytest`` never invoke npm. A release build sets the variable to opt in.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

from hatchling.builders.hooks.plugin.interface import BuildHookInterface


class FrontendBuildHook(BuildHookInterface):
    def initialize(self, version, build_data):
        if os.environ.get("PESTO_BUILD_FRONTEND") != "1":
            return
        frontend = Path(self.root) / "frontend"
        subprocess.run(["npm", "ci"], cwd=frontend, check=True)
        subprocess.run(["npm", "run", "build"], cwd=frontend, check=True)
