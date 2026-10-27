// Two histograms on one set of bin edges, drawn on Canvas 2D. The series are
// drawn in the order given and take colour slots 1 and 2 in that order; the
// caller puts the earlier iteration first. Prior and posterior are also told
// apart by a legend in words and by a dashed outline on the first series.

import { linearAxis, logAxis, type Axis } from './axes'
import { barRects } from './bars'
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
  | 'arc'
  | 'fill'
  | 'closePath'
  | 'rect'
  | 'clip'
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

const MARGIN = { left: 44, right: 12, top: 28, bottom: 40 }
const FONT = '12px system-ui, sans-serif'
const FILL_ALPHA = 0.4
const SWATCH = 10
const Y_TICKS = 4

function isValid(spec: HistogramSpec): boolean {
  const { edges, series } = spec
  if (edges.length < 2 || series.length < 1 || series.length > 2) return false
  if (!edges.every(Number.isFinite)) return false
  for (let i = 1; i < edges.length; i++) if (edges[i] <= edges[i - 1]) return false
  return series.every(
    (s) =>
      s.density.length === edges.length - 1 && s.density.every((d) => Number.isFinite(d) && d >= 0),
  )
}

function buildXAxis(spec: HistogramSpec, range: [number, number]): Axis | null {
  const first = spec.edges[0]
  const last = spec.edges[spec.edges.length - 1]
  if (spec.space === 'native') return linearAxis([first, last], range)
  return logAxis([10 ** first, 10 ** last], range)
}

// Returns false, and draws nothing, when the spec cannot be drawn honestly.
export function drawHistogram(
  ctx: Chart2D,
  spec: HistogramSpec,
  tokens: ChartTokens,
  size: ChartSize,
): boolean {
  if (!isValid(spec)) return false
  const left = MARGIN.left
  const right = size.width - MARGIN.right
  const top = MARGIN.top
  const bottom = size.height - MARGIN.bottom
  if (right <= left || bottom <= top) return false

  const xAxis = buildXAxis(spec, [left, right])
  if (xAxis === null) return false
  const yMax = Math.max(...spec.series.flatMap((s) => s.density))
  const yAxis = linearAxis([0, yMax > 0 ? yMax : 1], [bottom, top], Y_TICKS)
  const slots = [tokens.series1, tokens.series2]

  ctx.save()
  ctx.clearRect(0, 0, size.width, size.height)
  ctx.font = FONT

  ctx.strokeStyle = tokens.gridline
  ctx.lineWidth = 1
  ctx.beginPath()
  for (const tick of xAxis.ticks) {
    if (tick.label === '') continue
    ctx.moveTo(tick.px, top)
    ctx.lineTo(tick.px, bottom)
  }
  for (const tick of yAxis.ticks) {
    ctx.moveTo(left, tick.px)
    ctx.lineTo(right, tick.px)
  }
  ctx.stroke()

  spec.series.forEach((series, index) => {
    const bars = barRects(spec.edges, series.density, xAxis, yAxis, spec.space)
    ctx.globalAlpha = FILL_ALPHA
    ctx.fillStyle = slots[index]
    for (const bar of bars) ctx.fillRect(bar.x, bar.y, bar.w, bar.h)
    ctx.globalAlpha = 1
    ctx.strokeStyle = slots[index]
    ctx.lineWidth = 1
    ctx.setLineDash(spec.series.length === 2 && index === 0 ? [4, 3] : [])
    for (const bar of bars) ctx.strokeRect(bar.x, bar.y, bar.w, bar.h)
    ctx.setLineDash([])
  })

  ctx.strokeStyle = tokens.axis
  ctx.beginPath()
  ctx.moveTo(left, top)
  ctx.lineTo(left, bottom)
  ctx.lineTo(right, bottom)
  ctx.stroke()

  ctx.fillStyle = tokens.inkMuted
  ctx.textBaseline = 'top'
  ctx.textAlign = 'center'
  for (const tick of xAxis.ticks) {
    if (tick.label !== '') ctx.fillText(tick.label, tick.px, bottom + 4)
  }
  ctx.fillText(spec.xLabel, (left + right) / 2, bottom + 22)
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'right'
  for (const tick of yAxis.ticks) ctx.fillText(tick.label, left - 6, tick.px)

  let legendX = left
  const legendY = 8
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  spec.series.forEach((series, index) => {
    ctx.globalAlpha = FILL_ALPHA
    ctx.fillStyle = slots[index]
    ctx.fillRect(legendX, legendY, SWATCH, SWATCH)
    ctx.globalAlpha = 1
    ctx.strokeStyle = slots[index]
    ctx.strokeRect(legendX, legendY, SWATCH, SWATCH)
    ctx.fillStyle = tokens.inkPrimary
    ctx.fillText(series.label, legendX + SWATCH + 6, legendY - 1)
    legendX += SWATCH + 6 + ctx.measureText(series.label).width + 16
  })

  ctx.restore()
  return true
}
