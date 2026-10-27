import type { ChartTokens } from './tokens'

export type Chart2D = Pick<
  CanvasRenderingContext2D,
  | 'fillStyle'
  | 'strokeStyle'
  | 'lineWidth'
  | 'globalAlpha'
  | 'font'
  | 'textAlign'
  | 'textBaseline'
  | 'clearRect'
  | 'fillRect'
  | 'strokeRect'
  | 'beginPath'
  | 'moveTo'
  | 'lineTo'
  | 'stroke'
  | 'fillText'
  | 'measureText'
  | 'setLineDash'
  | 'save'
  | 'restore'
  | 'setTransform'
>

export interface HistogramSeries {
  label: string
  density: number[]
}

export interface HistogramSpec {
  space: 'log10' | 'native'
  edges: number[]
  series: HistogramSeries[]
  xLabel: string
}

export interface ChartSize {
  width: number
  height: number
}

export function drawHistogram(
  _ctx: Chart2D,
  _spec: HistogramSpec,
  _tokens: ChartTokens,
  _size: ChartSize,
): boolean {
  return false
}
