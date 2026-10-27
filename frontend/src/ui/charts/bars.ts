// The layout of histogram bars on shared edges, with no DOM. Densities are
// drawn as given; this never recomputes them.

import type { Axis } from './axes'

export interface BarRect {
  x: number
  y: number
  w: number
  h: number
}

// `edges` is in log10 space when `space` is 'log10' and the x axis is a log
// axis over the native range, so equal log10 widths stay equal on screen.
export function barRects(
  edges: number[],
  density: number[],
  xAxis: Axis,
  yAxis: Axis,
  space: 'log10' | 'native',
): BarRect[] {
  if (edges.length < 2 || density.length !== edges.length - 1) return []
  const toNative = space === 'log10' ? (edge: number) => 10 ** edge : (edge: number) => edge
  const baseline = yAxis.toPx(0)
  return density.map((value, i) => {
    const left = xAxis.toPx(toNative(edges[i]))
    const right = xAxis.toPx(toNative(edges[i + 1]))
    const top = yAxis.toPx(value)
    return { x: Math.min(left, right), y: top, w: Math.abs(right - left), h: baseline - top }
  })
}
