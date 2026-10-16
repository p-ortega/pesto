"""Correctness checks that sit beside the speed limits: the answer has to be right before its speed counts."""

from __future__ import annotations

import numpy as np
import pytest
from ingest.fixtures import make_run

FILE_SHAPES = ("jcb", "legacy_jcb", "dense", "csv", "variable_major_csv")


def _stored_by_name(run_dir, cache_root):
    """Ingest a run and return the realization names and {name: values} as stored."""
    from pesto.cache.layout import CacheLayout
    from pesto.ingest.ensembles import load_stored, read_realization_field
    from pesto.ingest.failures import ReadFailure
    from pesto.ingest.runner import ingest_run

    ingest_run(run_dir, cache_root=cache_root)
    stored = load_stored(0, CacheLayout(root=cache_root))
    assert not isinstance(stored, ReadFailure), f"load_stored failed: {stored.reason}"
    values = {}
    for name in stored.real_names:
        field = read_realization_field(stored, name)
        assert not isinstance(field, ReadFailure), f"read of {name!r} failed: {field.reason}"
        values[name] = field
    return list(stored.real_names), values


@pytest.mark.slow
def test_every_file_shape_gives_identical_values(tmp_path):
    """The fixture values are exact in float32, so every shape, text ones included, must match bit for bit."""
    results = {}
    written_names = {}
    for shape in FILE_SHAPES:
        run_dir = tmp_path / shape
        run_dir.mkdir()
        run = make_run(run_dir, ensemble_format=shape, n_real=20, n_par=300)
        written_names[shape] = list(run.real_names)
        results[shape] = _stored_by_name(run_dir, tmp_path / f"cache-{shape}")

    first_shape = FILE_SHAPES[0]
    first_names, first_values = results[first_shape]
    for shape, (names, values) in results.items():
        assert names == written_names[shape], f"{shape}: names or their order changed on ingest"
        assert names == first_names, f"{shape}: lists different realizations than {first_shape}"
        for name in first_names:
            assert np.array_equal(values[name], first_values[name]), (
                f"{shape}: realization {name!r} differs from {first_shape}"
            )
