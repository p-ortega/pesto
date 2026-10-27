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
  ticks: AxisTick[]
}

export function linearAxis(domain: [number, number], range: [number, number], tickCount = 5): Axis {
  const scale = scaleLinear().domain(domain).range(range)
  const format = scale.tickFormat(tickCount)
  return {
    toPx: (value) => scale(value),
    ticks: scale.ticks(tickCount).map((value) => ({ value, label: format(value), px: scale(value) })),
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
    ticks: scale.ticks(count).map((value) => ({ value, label: format(value), px: scale(value) })),
  }
}
