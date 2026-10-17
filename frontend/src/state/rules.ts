// The shared selection every view reads and writes, and the pure rules
// that change it. No DOM, no imports from ui/ or views/.
//
// Parameters and realizations are held by name only, never by position in
// a file. A name is kept exactly as the file gave it: no trimming, case
// folding or normalisation.

export interface SharedSelection {
  runId: string
  iteration: number
  layer: number
  timeIdx: number
  /** Cell index within one layer (0..ncpl-1); the layer is kept separately. */
  cells: ReadonlySet<number>
  sites: ReadonlySet<number>
  pars: ReadonlySet<string>
  obsGroups: ReadonlySet<string>
  parGroups: ReadonlySet<string>
  /** 'all' and an empty set are different values: all realizations vs none. */
  reals: ReadonlySet<string> | 'all'
  colour: { source: 'par' | 'obs'; stat: string }
}

export function emptySelection(runId: string, iteration: number): SharedSelection {
  return {
    runId,
    iteration,
    layer: 0,
    timeIdx: 0,
    cells: new Set<number>(),
    sites: new Set<number>(),
    pars: new Set<string>(),
    obsGroups: new Set<string>(),
    parGroups: new Set<string>(),
    reals: 'all',
    colour: { source: 'par', stat: 'value' },
  }
}

export function sameSet<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean {
  if (a.size !== b.size) return false
  for (const member of a) {
    if (!b.has(member)) return false
  }
  return true
}

export function sameReals(a: ReadonlySet<string> | 'all', b: ReadonlySet<string> | 'all'): boolean {
  if (a === 'all' || b === 'all') return a === b
  return sameSet(a, b)
}

export function sameSelection(a: SharedSelection, b: SharedSelection): boolean {
  return (
    a.runId === b.runId &&
    a.iteration === b.iteration &&
    a.layer === b.layer &&
    a.timeIdx === b.timeIdx &&
    sameSet(a.cells, b.cells) &&
    sameSet(a.sites, b.sites) &&
    sameSet(a.pars, b.pars) &&
    sameSet(a.obsGroups, b.obsGroups) &&
    sameSet(a.parGroups, b.parGroups) &&
    sameReals(a.reals, b.reals) &&
    a.colour.source === b.colour.source &&
    a.colour.stat === b.colour.stat
  )
}

function copyReals(reals: ReadonlySet<string> | 'all'): ReadonlySet<string> | 'all' {
  return reals === 'all' ? 'all' : new Set(reals)
}

// Returns a new object with its own copies of every set, so the caller's
// patch can be mutated later without reaching the store.
export function applyPatch(current: SharedSelection, patch: Partial<SharedSelection>): SharedSelection {
  const merged = { ...current, ...patch }
  return {
    runId: merged.runId,
    iteration: merged.iteration,
    layer: merged.layer,
    timeIdx: merged.timeIdx,
    cells: new Set(merged.cells),
    sites: new Set(merged.sites),
    pars: new Set(merged.pars),
    obsGroups: new Set(merged.obsGroups),
    parGroups: new Set(merged.parGroups),
    reals: copyReals(merged.reals),
    colour: { source: merged.colour.source, stat: merged.colour.stat },
  }
}
