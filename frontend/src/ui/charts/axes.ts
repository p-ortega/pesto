// Axes for the chart kit, built on d3-scale for its tick choice and log scale.

import { scaleLinear, scaleLog } from 'd3-scale'

export interface AxisTick {
  value: number
  // Empty when a log axis would crowd this tick; the caller skips empty labels.
  label: string
  px: number
}

export interface Axis {
  toPx(value: number): number
  // Back from a pixel to a value in the axis's own units, so a drag reads as data.
  invert(px: number): number
  ticks: AxisTick[]
}

// Labels longer than this switch to '~g', so -1,000,000 prints as −1e+6.
const LONG_LABEL = 6

// The tick count follows the pixel span, about one label per 60 px; maxTicks caps it.
export function linearAxis(domain: [number, number], range: [number, number], maxTicks = Infinity): Axis {
  const scale = scaleLinear().domain(domain).range(range)
  const count = Math.max(2, Math.min(maxTicks, Math.floor(Math.abs(range[1] - range[0]) / 60)))
  const values = scale.ticks(count)
  let format = scale.tickFormat(count)
  if (values.some((value) => format(value).length > LONG_LABEL)) format = scale.tickFormat(count, '~g')
  return {
    toPx: (value) => scale(value),
    invert: (px) => scale.invert(px),
    ticks: values.map((value) => ({ value, label: format(value), px: scale(value) })),
  }
}

// The domain is in native units. A log scale needs it strictly positive, so
// anything else is refused rather than bent into shape.
export function logAxis(nativeDomain: [number, number], range: [number, number]): Axis | null {
  const [lo, hi] = nativeDomain
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo <= 0 || hi <= lo) return null
  const scale = scaleLog().domain(nativeDomain).range(range)
  // About one label per 50 px; d3 blanks the rest so a narrow chart over
  // many decades does not print labels on top of each other.
  const count = Math.max(2, Math.floor(Math.abs(range[1] - range[0]) / 50))
  // '~g' prints 0.01 or 1e-5, never SI prefixes like 10µ that read oddly for parameter values.
  const format = scale.tickFormat(count, '~g')
  return {
    toPx: (value) => scale(value),
    invert: (px) => scale.invert(px),
    ticks: scale.ticks(count).map((value) => ({ value, label: format(value), px: scale(value) })),
  }
}
