// The nine ramps the map colours a field with. Stops are the real
// matplotlib/ColorBrewer/turbo/jet values, nine points each, reused
// verbatim from docs/superpowers/plans/2026-08-12-pesto-m0.md rather than
// hand-derived or pulled from a new npm dependency (PROJECT.md's fixed
// frontend stack).
//
// `reversals` is the measured count of lightness-direction changes over 64
// samples -- the property that decides whether a ramp can be trusted on a
// continuous field. Zero means brightness tracks value everywhere. A
// diverging ramp has one by design, since it must be brightest in the
// middle. jet has three, which is why it is flagged in the picker.
//
// This module also holds the two value scales, the three limits modes and
// a small per-statistic limits memory -- everything the colour and scale
// controls (ui/controls.ts) and the legend (ui/legend.ts) need, as pure
// functions over plain arrays with no WebGL2 context.

export interface RampInfo {
  kind: 'sequential' | 'diverging' | 'rainbow'
  reversals: number
  hex: string[]
}

export const STOPS = {
  viridis: {
    kind: 'sequential',
    reversals: 0,
    hex: ['#440154', '#472d7b', '#3b528b', '#2c728e', '#21918c', '#28ae80', '#5ec962', '#addc30', '#fde725'],
  },
  magma: {
    kind: 'sequential',
    reversals: 0,
    hex: ['#000004', '#1d1147', '#51127c', '#832681', '#b73779', '#e75263', '#fc8961', '#fec488', '#fcfdbf'],
  },
  cividis: {
    kind: 'sequential',
    reversals: 0,
    hex: ['#00224e', '#1a386f', '#434e6c', '#61656f', '#7d7c78', '#9b9476', '#bcae6c', '#dec958', '#fee838'],
  },
  greys: {
    kind: 'sequential',
    reversals: 0,
    hex: ['#ffffff', '#f0f0f0', '#d9d9d9', '#bdbdbd', '#959595', '#727272', '#515151', '#242424', '#000000'],
  },
  RdBu: {
    kind: 'diverging',
    reversals: 1,
    hex: ['#67001f', '#bb2a34', '#e58368', '#fbceb7', '#f6f7f7', '#c0dceb', '#68abd0', '#2870b1', '#053061'],
  },
  coolwarm: {
    kind: 'diverging',
    reversals: 1,
    hex: ['#3b4cc0', '#6282ea', '#8db0fe', '#b9d0f9', '#dddcdc', '#f5c4ac', '#f4987a', '#dd5f4b', '#b40426'],
  },
  BrBG: {
    kind: 'diverging',
    reversals: 1,
    hex: ['#543005', '#995d13', '#cfa256', '#f1dfb3', '#f4f5f5', '#b4e2db', '#58b0a7', '#0c7169', '#003c30'],
  },
  turbo: {
    kind: 'rainbow',
    reversals: 1,
    hex: ['#30123b', '#466be3', '#28bceb', '#32f298', '#a4fc3c', '#eecf3a', '#fb7e21', '#d02f05', '#7a0403'],
  },
  jet: {
    kind: 'rainbow',
    reversals: 3,
    hex: ['#000080', '#0000ff', '#0080ff', '#16ffe1', '#7dff7a', '#e4ff13', '#ff9400', '#ff1e00', '#800000'],
  },
} as const satisfies Record<string, RampInfo>

export type ColormapName = keyof typeof STOPS

export function hexToRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/**
 * A 256-entry RGBA8 lookup table, built by linearly interpolating a ramp's
 * nine stops. Entry 0 is exactly the first stop and entry 255 is exactly
 * the last, so a legend reading the ramp's own end values matches what was
 * actually sampled. `reverse` mirrors the built 256-entry table -- applied
 * to the table, not the stops, so a reversed ramp is exactly the forward
 * ramp read backwards.
 */
export function ramp(name: ColormapName, reverse = false): Uint8Array {
  const stops = STOPS[name].hex.map(hexToRgb)
  const out = new Uint8Array(256 * 4)
  const last = stops.length - 1
  for (let i = 0; i < 256; i++) {
    const t = (i / 255) * last
    const lo = Math.min(Math.floor(t), last - 1)
    const f = t - lo
    for (let c = 0; c < 3; c++) {
      out[i * 4 + c] = Math.round(stops[lo][c] + f * (stops[lo + 1][c] - stops[lo][c]))
    }
    out[i * 4 + 3] = 255
  }
  if (!reverse) return out

  const reversed = new Uint8Array(256 * 4)
  for (let i = 0; i < 256; i++) {
    const src = (255 - i) * 4
    const dst = i * 4
    reversed[dst] = out[src]
    reversed[dst + 1] = out[src + 1]
    reversed[dst + 2] = out[src + 2]
    reversed[dst + 3] = out[src + 3]
  }
  return reversed
}

export type ValueScale = 'linear' | 'log10'

/**
 * Linear returns the input unchanged. Log10 returns `Math.log10(v)` for
 * every strictly positive finite value and NaN for every zero, negative or
 * non-finite one -- never a guess at a value the data does not have.
 */
export function applyScale(values: Float32Array, scale: ValueScale): Float32Array {
  if (scale === 'linear') return values
  const out = new Float32Array(values.length)
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    out[i] = Number.isFinite(v) && v > 0 ? Math.log10(v) : Number.NaN
  }
  return out
}

/**
 * The count of finite entries that are zero or negative -- a count, not a
 * boolean, so D-03's disabled-control message can name exactly how many
 * cells forbid log10.
 */
export function logIsUsable(values: Float32Array): number {
  let count = 0
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (Number.isFinite(v) && v <= 0) count += 1
  }
  return count
}

/**
 * Pulls out the values at the given block-row indices, in the order given
 * -- the piece a caller needs to compute limits from one parameter group's
 * own rows rather than a whole multi-group field. Kept in this module
 * (rather than parmap.ts, which owns the `pargp` lookup) so it stays a pure
 * array function with no dependency on the identity-join types.
 */
export function subsetValues(values: Float32Array, indices: readonly number[]): Float32Array {
  const out = new Float32Array(indices.length)
  for (let i = 0; i < indices.length; i++) {
    out[i] = values[indices[i]]
  }
  return out
}

export type LimitsMode = 'robust' | 'minmax' | 'manual'

/**
 * Robust limits are the 2nd and 98th percentiles of the finite values --
 * 2-98%, the roadmap's correction against the reference's 1-99%. Minmax is
 * the finite minimum and maximum. Manual returns the caller's own pair
 * unchanged, so every mode shares one call site. When the resulting upper
 * and lower limits are equal, or their difference is denormal, they are
 * returned as they are -- the shader's own `max(hi - lo, 1e-20)` floor
 * already handles it, and a second fix here would be a second thing for
 * the two to disagree about.
 */
export function scaleLimits(values: Float32Array, mode: LimitsMode, manual?: [number, number]): [number, number] {
  if (mode === 'manual') {
    if (!manual) {
      throw new Error('manual limits mode requires a manual pair')
    }
    return manual
  }

  const finite: number[] = []
  for (let i = 0; i < values.length; i++) {
    if (Number.isFinite(values[i])) finite.push(values[i])
  }
  if (finite.length === 0) return [0, 1]
  finite.sort((a, b) => a - b)

  if (mode === 'minmax') {
    return [finite[0], finite[finite.length - 1]]
  }

  const lowIndex = Math.floor(0.02 * (finite.length - 1))
  const highIndex = Math.ceil(0.98 * (finite.length - 1))
  return [finite[lowIndex], finite[highIndex]]
}

/**
 * The shader's own normalisation, mirrored on the CPU: a value exactly at
 * either limit is provably 0 or 1, and a value beyond either limit clamps
 * to that same end rather than becoming missing -- clipping is never
 * mistaken for absence.
 */
export function normalize(value: number, limits: [number, number]): number {
  const [lo, hi] = limits
  const span = Math.max(hi - lo, 1e-20)
  return Math.min(Math.max((value - lo) / span, 0), 1)
}

/**
 * The n + 1 edges of n equal classes between the limits, in whatever scale
 * the limits are already in (D-05).
 */
export function classEdges(limits: [number, number], n: number): number[] {
  const [lo, hi] = limits
  return Array.from({ length: n + 1 }, (_, k) => lo + ((hi - lo) * k) / n)
}

/**
 * The ramp table entry each class is drawn in: the one nearest the class
 * middle. Computed here and handed to the shader, so the GPU never has to
 * round a half itself (n 9, class 1 lands exactly on 42.5).
 */
export function classTexelIndices(n: number): number[] {
  return Array.from({ length: n }, (_, k) => Math.round(((k + 0.5) / n) * 255))
}

/** The colour class k of n is drawn in, read from the same table the shader samples. */
export function classColour(k: number, n: number, table: Uint8Array): [number, number, number] {
  const i = classTexelIndices(n)[k] * 4
  return [table[i], table[i + 1], table[i + 2]]
}

/**
 * A small limits memory (D-02), keyed by whatever string the caller
 * builds: two realizations of one statistic share the limits computed for
 * it, so flicking between them is a comparison. Switching statistic, scale,
 * limits mode or drawn group each land under a different key rather than
 * triggering a clear -- a group switched back to replays its own
 * previously computed pair, the same way a statistic switched back to
 * already did. The caller clears it only when the iteration changes, since
 * that invalidates every key's meaning at once.
 */
export class LimitsMemory {
  private readonly memo = new Map<string, [number, number]>()

  get(key: string): [number, number] | undefined {
    return this.memo.get(key)
  }

  set(key: string, limits: [number, number]): void {
    this.memo.set(key, limits)
  }

  clear(): void {
    this.memo.clear()
  }
}
