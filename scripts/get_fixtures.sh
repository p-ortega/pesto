#!/usr/bin/env bash
# Fetches two pypestvis example runs into tests/fixtures/: lheg_ies (the only
# real single-layer structured grid available anywhere) and freyberg_ies (a
# multi-layer structured grid whose parameter groups carry the triple-index
# and layer-in-the-name shapes). Neither is vendored in this repository --
# tests/fixtures/ is already gitignored and this is the one script that
# populates it.
#
# This is a convenience, not a build step. Every real-data test in this
# project skips, rather than fails, when its fixture directory is absent --
# the whole suite stays green with tests/fixtures/ never populated. Do not
# wire this script into CI as a required step.
set -euo pipefail

REPO_URL="https://github.com/pypest/pypestvis"
FIXTURES_DIR="tests/fixtures"
EXAMPLES=("lheg_ies" "freyberg_ies")

mkdir -p "$FIXTURES_DIR"

already_present=()
missing=()
for name in "${EXAMPLES[@]}"; do
  if [ -d "$FIXTURES_DIR/$name" ]; then
    already_present+=("$name")
  else
    missing+=("$name")
  fi
done

if [ ${#already_present[@]} -gt 0 ]; then
  echo "already present, left untouched:"
  for name in "${already_present[@]}"; do
    echo "  $FIXTURES_DIR/$name"
  done
fi

if [ ${#missing[@]} -eq 0 ]; then
  echo "nothing to fetch -- both example runs are already present"
  exit 0
fi

clone_dir="$(mktemp -d)"
trap 'rm -rf "$clone_dir"' EXIT

echo "cloning $REPO_URL (shallow) to fetch: ${missing[*]}"
git clone --quiet --depth 1 "$REPO_URL" "$clone_dir"

for name in "${missing[@]}"; do
  src="$clone_dir/examples/$name"
  if [ ! -d "$src" ]; then
    echo "warning: $src not found in the cloned repository -- skipping $name" >&2
    continue
  fi
  cp -R "$src" "$FIXTURES_DIR/$name"
  echo "fetched $FIXTURES_DIR/$name"
done
