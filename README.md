<p align="center">
  <img src="assets/logo.svg" alt="pesto logo" width="128" height="128">
</p>

<h1 align="center">pesto</h1>

<p align="center">
  A fast viewer for finished PEST++ IES runs on MODFLOW 6 models.
</p>

<p align="center">
  <a href="https://github.com/p-ortega/pesto/actions/workflows/ci.yml"><img src="https://github.com/p-ortega/pesto/actions/workflows/ci.yml/badge.svg" alt="tests"></a>
  <a href="https://github.com/p-ortega/pesto/releases"><img src="https://img.shields.io/github/v/release/p-ortega/pesto?include_prereleases&label=release&color=2e7d4f" alt="latest release"></a>
  <img src="https://img.shields.io/badge/python-3.11%2B-2e7d4f" alt="Python 3.11 or later">
  <img src="https://img.shields.io/badge/runs%20on-macOS%20%7C%20Linux%20%7C%20Windows-2e7d4f" alt="runs on macOS, Linux and Windows">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-BSD--3--Clause-2e7d4f" alt="BSD 3-Clause license"></a>
  <img src="https://img.shields.io/badge/status-alpha-c98a1e" alt="status: alpha">
</p>

pesto is a viewer for finished [PEST++ IES](https://github.com/usgs/pestpp) runs on MODFLOW 6
models. Point it at a run folder and it opens in your browser: parameter fields on the model grid,
observation fit, and the run's settings, all linked.

It runs on your own machine. Nothing is uploaded, and pesto never changes a run's files.

> **Alpha.** This is an early release for testing. Expect rough edges, and please
> [report what breaks](https://github.com/p-ortega/pesto/issues).

## What it shows

- **Parameters on the map.** Colour the grid by any parameter group, iteration, layer and
  realization, or by a statistic across the ensemble. Dragging a slider redraws at once.
- **Observations.** Site dots on the map, 1:1 plots and histograms per group, time series per
  site, and prior-data conflict read from pestpp's own file.
- **Sections.** Draw a line on the map and see the layers cut along it.
- **Run settings.** What the `.pst` and `.rec` say about the run: noise, iterations, realizations
  and the options that matter when reading results.
- **Honest gaps.** When pesto cannot place a group or read a file, it says so and gives the
  reason. It does not guess.

## Install

pesto needs Python 3.11 or later. The easiest way is [uv](https://docs.astral.sh/uv/), which
fetches Python for you. It works the same on macOS, Linux and Windows.

1. Install uv, following [its instructions](https://docs.astral.sh/uv/getting-started/installation/).
2. Install pesto:

   ```
   uv tool install https://github.com/p-ortega/pesto/releases/download/v0.1.0a1/pesto-0.1.0a1-py3-none-any.whl
   ```

With pip instead, inside an environment of your own:

```
pip install https://github.com/p-ortega/pesto/releases/download/v0.1.0a1/pesto-0.1.0a1-py3-none-any.whl
```

## Use

```
pesto path/to/run_folder
```

pesto opens a browser tab. The first time it sees a run it reads the ensembles into a compact
cache, which takes from a few seconds to a few minutes for a large run. After that the run opens
straight away.

Run `pesto` with no folder to pick one in the app.

The run folder should hold what pestpp-ies leaves behind: the `.pst` control file, the `.rec`
file, the parameter and observation ensembles (`.par.jcb`/`.obs.jcb` or `.csv`), and the MODFLOW 6
binary grid file (`.grb`).

Useful options:

| Option | What it does |
| --- | --- |
| `--cache-dir DIR` | Keep the cache in `DIR`. |
| `--port PORT` | Use a fixed port instead of a free one. |
| `--no-browser` | Print the address instead of opening a tab. |
| `--version` | Print the version. |

### Where the cache goes

pesto never changes or re-timestamps a run's own files. The one thing it writes is its cache. The
cache goes to `--cache-dir` if you give one, otherwise to a `.pesto` folder inside the run folder,
and if that folder cannot be written (an archive disk, say), to `~/.cache/pesto/`. Pass
`--cache-dir` to keep a run folder exactly as it is. Deleting a cache is always safe; pesto
rebuilds it.

### Privacy

The server listens only on `127.0.0.1` and needs the one-time link it prints. Your run never
leaves your machine, and pesto does not fetch anything from the internet.

## Develop

```
git clone https://github.com/p-ortega/pesto
cd pesto
uv sync --extra test
uv run pytest -m "not slow"
```

The frontend lives in `frontend/` and needs Node:

```
cd frontend
npm ci
npm test
npm run build
```

`npm run build` writes the frontend into the Python package, so run it after any frontend change.

## License

BSD 3-Clause. See [LICENSE](LICENSE).
