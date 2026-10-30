// The setup facts GET /api/run/config serves (src/pesto/cache/runconfig.py):
// each fact keeps every file's reading side by side, so the Config tab and
// the header can show what each file said instead of one picked value.

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

// The screen names where a reading came from by the PEST++ file the user knows.
const FILE_WORDS: Record<string, string> = {
  'run record': '.rec',
  'control file': '.pst',
  'files present': 'run folder',
  cache: 'pesto cache',
}

export function fileWord(source: string): string {
  return FILE_WORDS[source] ?? source
}

// Base has one cache reading per iteration, so present then missing is a change over the run,
// not a disagreement; for base the other readings are compared with the first ingested iteration.
function comparedReadings(fact: ConfigFact): ConfigReading[] {
  if (fact.key !== 'base') return fact.readings.filter((r) => r.value !== null)
  const cacheFirst = cacheReadings(fact).find((r) => r.value !== null)
  return [...fact.readings.filter((r) => r.source !== 'cache' && r.value !== null), ...(cacheFirst ? [cacheFirst] : [])]
}

export function factDisagrees(fact: ConfigFact): boolean {
  if (fact.key !== 'base') return fact.agree === false
  return new Set(comparedReadings(fact).map((r) => r.value)).size > 1
}

/** The files whose readings of a fact are compared, as the screen names them, each once. */
export function comparedFiles(fact: ConfigFact): string[] {
  return Array.from(new Set(comparedReadings(fact).map((r) => fileWord(r.source))))
}

/** "a and b", or "a, b and c". */
export function listWords(items: string[]): string {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/** "The .rec and the .pst do not match", or for two lines of one file, "Two lines in the .pst do not match". */
export function mismatchWords(files: string[]): string {
  if (files.length === 0) return 'The readings do not match'
  if (files.length === 1) return `Two lines in the ${files[0]} do not match`
  return `${listWords(files.map((file) => `the ${file}`)).replace(/^the/, 'The')} do not match`
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

/** The PEST++ file whose reading decided noise, from the server's `decided_by`; null when none did. */
export function noiseFile(decidedBy: string): string | null {
  if (decidedBy === 'run_record') return '.rec'
  if (['ies_no_noise', 'observation_ensemble_option', 'standard_deviation_column'].includes(decidedBy)) return '.pst'
  return null
}

export interface ChipFacts {
  disagree: string[]
  /** For each fact that disagrees, the files whose readings do not match. */
  mismatch: Record<string, string[]>
  /** The files with a noise reading that says the opposite of `hasNoise`. */
  noiseAgainst: string[]
  base: BaseFactState | null
}

/** What the header chips take from the facts: which disagree and in which files, and where base stands. */
export function chipFactsFrom(facts: ConfigFact[] | undefined, hasNoise: boolean | null = null): ChipFacts {
  const all = facts ?? []
  const disagreeing = all.filter(factDisagrees)
  const noise = all.find((f) => f.key === 'noise')
  const against =
    noise === undefined || hasNoise === null ? [] : noise.readings.filter((r) => r.value === !hasNoise).map((r) => fileWord(r.source))
  return {
    disagree: disagreeing.map((f) => f.key),
    mismatch: Object.fromEntries(disagreeing.map((f) => [f.key, comparedFiles(f)])),
    noiseAgainst: Array.from(new Set(against)),
    base: baseFactState(all.find((f) => f.key === 'base')),
  }
}

/** The part of the run's configuration the Config tab reads. */
export interface ConfigPayload {
  facts?: ConfigFact[]
  facts_note?: string
}
