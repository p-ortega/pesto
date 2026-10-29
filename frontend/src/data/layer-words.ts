// Words for a layer shown to a person: one-based with the zero-based index alongside,
// `layer 4 (index 3)`. The server's src/pesto/layer_words.py writes the same text; both are
// tested against tests/fixtures/layer_words_cases.json. Only words change: the store, URLs
// and the wire stay zero-based, and a layer number inside a name is never passed through here.

const UNKNOWN = 'layer unknown'
const UNKNOWN_TAIL = ' and an unknown layer'

/** The layer index, or null when it cannot be told; never a guessed number. */
function index(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

function split(indices: Iterable<unknown>): { known: number[]; unknown: boolean } {
  const known = new Set<number>()
  let unknown = false
  for (const value of indices) {
    const i = index(value)
    if (i === null) unknown = true
    else known.add(i)
  }
  return { known: Array.from(known).sort((a, b) => a - b), unknown }
}

/** Consecutive layers as one run: `0–3, 5 and 7–16`. */
function runs(sorted: readonly number[], shift: number): string {
  const out: string[] = []
  for (let i = 0; i < sorted.length; ) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j += 1
    const a = sorted[i] + shift
    const b = sorted[j] + shift
    out.push(j === i ? String(a) : `${a}–${b}`)
    i = j + 1
  }
  if (out.length <= 1) return out.join('')
  return `${out.slice(0, -1).join(', ')} and ${out[out.length - 1]}`
}

function many(known: readonly number[], unknown: boolean, ones: string, indices: string): string {
  if (known.length === 0) return unknown ? UNKNOWN : 'no layer'
  const tail = unknown ? UNKNOWN_TAIL : ''
  if (known.length === 1) return `${layerWords(known[0])}${tail}`
  return `layers ${ones} (index ${indices})${tail}`
}

/** `layer 4 (index 3)`; `layer unknown` for a blank, negative or non-integer index. */
export function layerWords(layer: unknown): string {
  const i = index(layer)
  return i === null ? UNKNOWN : `layer ${i + 1} (index ${i})`
}

/** `4 (3)` where space is tight; `unknown` when the index cannot be told. */
export function layerCompact(layer: unknown): string {
  const i = index(layer)
  return i === null ? 'unknown' : `${i + 1} (${i})`
}

/** `layers 1–4, 6 and 8–17 (index 0–3, 5 and 7–16)`; order and repeats do not matter. */
export function layerRangeWords(layers: Iterable<unknown>): string {
  const { known, unknown } = split(layers)
  return many(known, unknown, runs(known, 1), runs(known, 0))
}

/** `layers 1, 2, 3 (index 0, 1, 2)`; past `cap` entries both halves end in `and more`. */
export function layerListWords(layers: Iterable<unknown>, cap?: number): string {
  const { known, unknown } = split(layers)
  const shown = cap === undefined ? known : known.slice(0, cap)
  const more = shown.length < known.length ? ' and more' : ''
  const ones = shown.map((i) => String(i + 1)).join(', ') + more
  const zeros = shown.map(String).join(', ') + more
  return many(known, unknown, ones, zeros)
}

/** `17 layers (index 0–16)`, `1 layer (index 0)`: how many layers a grid has. */
export function gridLayerCountWords(nlay: unknown): string {
  const n = index(nlay)
  if (n === null) return 'an unknown number of layers'
  if (n === 0) return 'no layers'
  if (n === 1) return '1 layer (index 0)'
  return `${n} layers (index 0–${n - 1})`
}
