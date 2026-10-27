import type { Axis } from './axes'

export interface BarRect {
  x: number
  y: number
  w: number
  h: number
}

export function barRects(
  _edges: number[],
  _density: number[],
  _xAxis: Axis,
  _yAxis: Axis,
  _space: 'log10' | 'native',
): BarRect[] {
  return []
}
