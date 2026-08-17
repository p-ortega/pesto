# Working on pesto

## How to write

Plain English, and short with it. This applies to chat replies, questions, commit messages, and any
document written into the project.

- Say what a thing is and why it matters. Skip the reasoning that got you there.
- Ordinary words over jargon. Full sentences, not fragments.
- Describe a bug by what it does, not by where it lives. "The reader quietly picks one file when
  there are several and never says so" is useful. "Unconditional overwrite at line 326" is not —
  that detail belongs after the behaviour is clear.
- Keep file paths, API names and numbers exact. Plain means plain wording, not vague content.
- Set up a question in two sentences at most, then ask it.

## Commits

One line, plain language, saying what changed and why. No conventional-commit prefixes, no
co-author trailer. Look at `git log` for the house style — commits read like
"load a manifest of the wrong shape as empty instead of raising".

## What this project will not do

These are hard rules, not preferences. Each exists because breaking it produces a wrong answer that
looks right.

**Never write to a run directory.** A PEST++ run directory is a scientist's finished output and is
routinely on read-only archive media. Reading one must not write, truncate, create inside, or
re-timestamp anything in it.

**Never substitute position for identity.** Realization and parameter names come from inside the
file. A missing or unreadable name is a failure carrying a reason, never a silent "row 1 is
realization 1".

**Never answer when you cannot tell.** If orientation, names or values cannot be determined, refuse
with a reason naming what was tried. Do not guess and do not silently transpose.

**Never drop something without a trace.** Any column, name or file that gets dropped, repaired or
normalised must leave a note the caller can read. A silent normalisation is indistinguishable from
a correct read.

## Heavy imports

No module under `src/pesto/` imports `pyemu` or `flopy` at module scope. Every call goes through
`load_pyemu()` from `pesto.warm`, inside a function body. The launcher has to open a browser window
before these libraries finish importing.

Ensembles are read only through `pyemu.Matrix.from_binary` and its `.x`, `.row_names` and
`.col_names`. The pandas-returning and Ensemble-subclass binary readers are off limits — see
Constraints in `.planning/PROJECT.md`.

## Tests

```
uv run pytest              # everything
uv run pytest -m "not slow"   # skip tests that need real run data
```

Slow tests run against real PEST++ runs in `~/dev/data/pesto-bench/` and skip when absent.

Write tests against reader behaviour, not against facts about local benchmark folders. A test
asserting "this run has no observation ensembles" breaks the moment someone copies the data
properly, and tells you nothing about whether the code works.

## Planning files

`.planning/` and `docs/` are gitignored. Never commit specs, plans, or GSD artifacts.
