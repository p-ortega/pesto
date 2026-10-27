// The setup facts GET /api/run/config serves (src/pesto/cache/runconfig.py):
// each fact keeps every source's reading side by side, so the Config tab and
// the header chips can show what each source said instead of one picked value.

export interface ConfigReading {
  /** "run record", "control file", "files present" or "cache". */
  source: string
  /** The comparable form; null for a reading that only supports the fact. */
  value: string | number | boolean | null
  /** The text for the screen. */
  shown: string
  /** Where it came from: a file name and line. */
  evidence: string
  extra: Record<string, string | number | boolean> | null
}

export interface ConfigFact {
  key: string
  label: string
  readings: ConfigReading[]
  /** True: two or more sources give one value. False: two readings differ. Null: nothing to compare. */
  agree: boolean | null
  looked_for: string[]
  note: string | null
}

export type BaseState = 'present' | 'missing' | 'not_included' | 'unknown'

export interface BaseFactState {
  state: BaseState
  iteration?: number
}

function cacheReadings(fact: ConfigFact): ConfigReading[] {
  return fact.readings.filter((r) => r.source === 'cache')
}

// Base has one cache reading per iteration, so present then missing is a change over the run,
// not a disagreement; for base the other sources are compared with the first ingested iteration.
export function factDisagrees(fact: ConfigFact): boolean {
  if (fact.key !== 'base') return fact.agree === false
  const cacheFirst = cacheReadings(fact).find((r) => r.value !== null)
  const compared = [...fact.readings.filter((r) => r.source !== 'cache' && r.value !== null), ...(cacheFirst ? [cacheFirst] : [])]
  return new Set(compared.map((r) => r.value)).size > 1
}

// Never "missing" when the first ingested iteration already lacked base: the run never included it.
export function baseFactState(fact: ConfigFact | undefined): BaseFactState | null {
  if (fact === undefined) return null
  const valued = cacheReadings(fact).filter((r) => r.value !== null)
  if (valued.length === 0) return null
  if (valued[0].value === false) return { state: 'not_included' }
  if (valued[valued.length - 1].value === true) return { state: 'present' }
  // Where base went: the first iteration of the run of missing iterations at the end.
  let start = valued.length - 1
  while (start > 0 && valued[start - 1].value === false) start -= 1
  const iteration = valued[start].extra?.iteration
  return typeof iteration === 'number' ? { state: 'missing', iteration } : { state: 'unknown' }
}

/** What the header chips take from the facts: which disagree, and where base stands. */
export function chipFactsFrom(facts: ConfigFact[] | undefined): { disagree: string[]; base: BaseFactState | null } {
  const all = facts ?? []
  return {
    disagree: all.filter(factDisagrees).map((f) => f.key),
    base: baseFactState(all.find((f) => f.key === 'base')),
  }
}

/** The part of the run's configuration the Config tab reads. */
export interface ConfigPayload {
  facts?: ConfigFact[]
  facts_note?: string
}
