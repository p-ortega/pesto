"""The only module in pesto permitted to import pyemu or flopy.

Importing pyemu mutates global state and has historically seeded numpy's
global RNG. Anything in pesto that needs randomness must construct its own
``np.random.default_rng(...)`` rather than relying on numpy's global state,
because the moment ``warm_up()`` runs, that global state is no longer
trustworthy.

Every loader here is guarded by a module-level lock so concurrent callers
(the warm-up thread and, later, an eager caller) share one import rather than
racing each other.
"""

from __future__ import annotations

import threading
from types import ModuleType

_lock = threading.Lock()
_modules: dict[str, ModuleType] = {}


def _load(name: str) -> ModuleType:
    with _lock:
        if name not in _modules:
            _modules[name] = __import__(name)
        return _modules[name]


def load_pyemu() -> ModuleType:
    return _load("pyemu")


def load_flopy() -> ModuleType:
    return _load("flopy")


def warm_up() -> None:
    load_pyemu()
    load_flopy()
