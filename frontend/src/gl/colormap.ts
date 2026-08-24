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
// middle. jet has three, which is why it is flagged in the picker later.
//
// Only `viridis` is actually drawn by this plan -- the reverse switch and
// the other eight ramps as user choices land in plan 05.1-05 -- but every
// table is defined here now so that plan extends this file rather than
// rewriting it.

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
 * actually sampled.
 */
export function ramp(name: ColormapName): Uint8Array {
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
  return out
}

/**
 * Robust limits at `fraction` and `1 - fraction` over the finite values,
 * skipping NaN -- the 2-98% default this phase's D-01 fixes at `fraction =
 * 0.02`. A field with too few distinct values (or none at all) still
 * returns a usable, non-degenerate range rather than NaN limits that would
 * blank the whole canvas.
 */
export function scaleLimits(values: Float32Array, fraction: number): [number, number] {
  const finite: number[] = []
  for (let i = 0; i < values.length; i++) {
    if (Number.isFinite(values[i])) finite.push(values[i])
  }
  if (finite.length === 0) return [0, 1]

  finite.sort((a, b) => a - b)
  const lowIndex = Math.floor(fraction * (finite.length - 1))
  const highIndex = Math.ceil((1 - fraction) * (finite.length - 1))
  let lo = finite[lowIndex]
  let hi = finite[highIndex]

  if (hi <= lo) {
    const pad = Math.abs(lo) > 0 ? Math.abs(lo) * 0.05 : 0.5
    lo -= pad
    hi += pad
  }
  return [lo, hi]
}
