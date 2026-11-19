"""Open a cached float32 block for reading.

On POSIX the block is memory-mapped, so a large ensemble costs no memory until
it is touched. Windows refuses to replace a file while it is mapped, and a
re-ingest must replace it, so there the block is read into memory instead.
"""

from __future__ import annotations

import math
import os
from pathlib import Path

import numpy as np


def read_only_f32(path: Path, shape: tuple[int, ...], offset: int = 0) -> np.ndarray:
    """The little-endian float32 block of ``shape`` at ``offset`` bytes in ``path``, read-only."""
    if os.name != "nt":
        return np.memmap(path, dtype="<f4", mode="r", offset=offset, shape=shape)
    count = math.prod(shape)
    values = np.fromfile(path, dtype="<f4", count=count, offset=offset)
    if values.size != count:
        raise ValueError(f"{path.name} holds {values.size} values where {count} were expected")
    values = values.reshape(shape)
    values.flags.writeable = False
    return values
