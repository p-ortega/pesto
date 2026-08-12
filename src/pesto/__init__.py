"""pesto: a local viewer for finished PEST++ (pestpp-ies) calibration runs.

This module is deliberately free of imports beyond the version string, so the
loopback port can bind and the launcher can print its URL before anything in
the science stack (pyemu, flopy) has to load. See ``pesto.warm`` for the only
place those imports are allowed to happen.
"""

from __future__ import annotations

__version__ = "0.1.0"
