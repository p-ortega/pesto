// Two histograms on one set of bin edges, drawn on Canvas 2D. The series are
// drawn in the order given and take colour slots 1 and 2 in that order; the
// caller puts the earlier iteration first. Prior and posterior are also told
// apart by a legend in words and by a dashed outline on the first series.

import { linearAxis, logAxis, type Axis } from './axes'
import { barRects } from './bars'
import { drawBrushBand } from './brush'
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

// Outline-only bars on the same edges, such as a brushed subset at the other iteration.
export interface HistogramOverlay {
  density: number[]
  label: string
  /** Which colour slot to outline in: 0 for series 1, 1 for series 2. */
  slot: 0 | 1
}

export interface HistogramSpec {
  space: 'log10' | 'native'
  edges: number[]
  series: HistogramSeries[]
  xLabel: string
  /** A held brush range, in the same space as the edges (log10 when space is 'log10'). */
  band?: [number, number] | null
  overlay?: HistogramOverlay | null
  /** Alpha for what is faded: bars outside the band and the overlay. 1 when not given. */
  dimAlpha?: number
}

export interface HistogramLayout {
  left: number
  right: number
  top: number
  bottom: number
  /** The drawn x axis; on a log10 histogram it works in native units. */
  xAxis: Axis
  /** A css px back to a value in the edges' own space. */
  edgeAt(px: number): number
  edgeToPx(value: number): number
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

function usableDensity(density: number[], bins: number): boolean {
  return density.length === bins && density.every((d) => Number.isFinite(d) && d >= 0)
}

function isValid(spec: HistogramSpec): boolean {
  const { edges, series, band, overlay, dimAlpha } = spec
  if (edges.length < 2 || series.length < 1 || series.length > 2) return false
  if (!edges.every(Number.isFinite)) return false
  for (let i = 1; i < edges.length; i++) if (edges[i] <= edges[i - 1]) return false
  if (!series.every((s) => usableDensity(s.density, edges.length - 1))) return false
  if (band != null && !(Number.isFinite(band[0]) && Number.isFinite(band[1]) && band[0] <= band[1])) return false
  if (overlay != null && !usableDensity(overlay.density, edges.length - 1)) return false
  return dimAlpha === undefined || (Number.isFinite(dimAlpha) && dimAlpha >= 0 && dimAlpha <= 1)
}

// Bins are half open except the last, so a bin ending exactly at lo holds nothing in the band.
function outsideBand(edges: number[], i: number, band: [number, number]): boolean {
  const last = i === edges.length - 2
  const endsBefore = last ? edges[i + 1] < band[0] : edges[i + 1] <= band[0]
  return endsBefore || edges[i] > band[1]
}

function buildXAxis(spec: HistogramSpec, range: [number, number]): Axis | null {
  const first = spec.edges[0]
  const last = spec.edges[spec.edges.length - 1]
  if (spec.space === 'native') return linearAxis([first, last], range)
  return logAxis([10 ** first, 10 ** last], range)
}

// The plot area and x axis drawHistogram uses, so a brush reads the same pixels; null when it would refuse.
export function histogramLayout(spec: HistogramSpec, size: ChartSize): HistogramLayout | null {
  if (!isValid(spec)) return null
  const left = MARGIN.left
  const right = size.width - MARGIN.right
  const top = MARGIN.top
  const bottom = size.height - MARGIN.bottom
  if (right <= left || bottom <= top) return null
  const xAxis = buildXAxis(spec, [left, right])
  if (xAxis === null) return null
  const log = spec.space === 'log10'
  return {
    left,
    right,
    top,
    bottom,
    xAxis,
    edgeAt: (px) => (log ? Math.log10(xAxis.invert(px)) : xAxis.invert(px)),
    edgeToPx: (value) => xAxis.toPx(log ? 10 ** value : value),
  }
}

// Returns false, and draws nothing, when the spec cannot be drawn honestly.
export function drawHistogram(
  ctx: Chart2D,
  spec: HistogramSpec,
  tokens: ChartTokens,
  size: ChartSize,
): boolean {
  const layout = histogramLayout(spec, size)
  if (layout === null) return false
  const { left, right, top, bottom, xAxis } = layout
  const band = spec.band ?? null
  const overlay = spec.overlay ?? null
  const dimAlpha = spec.dimAlpha ?? 1
  const yMax = Math.max(...spec.series.flatMap((s) => s.density), ...(overlay?.density ?? []))
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

  const faded = spec.edges.slice(1).map((_, i) => band !== null && outsideBand(spec.edges, i, band))
  spec.series.forEach((series, index) => {
    const bars = barRects(spec.edges, series.density, xAxis, yAxis, spec.space)
    ctx.fillStyle = slots[index]
    bars.forEach((bar, i) => {
      ctx.globalAlpha = faded[i] ? FILL_ALPHA * dimAlpha : FILL_ALPHA
      ctx.fillRect(bar.x, bar.y, bar.w, bar.h)
    })
    ctx.strokeStyle = slots[index]
    ctx.lineWidth = 1
    ctx.setLineDash(spec.series.length === 2 && index === 0 ? [4, 3] : [])
    bars.forEach((bar, i) => {
      ctx.globalAlpha = faded[i] ? dimAlpha : 1
      ctx.strokeRect(bar.x, bar.y, bar.w, bar.h)
    })
    ctx.globalAlpha = 1
    ctx.setLineDash([])
  })

  if (overlay !== null) {
    ctx.globalAlpha = dimAlpha
    ctx.strokeStyle = slots[overlay.slot]
    ctx.lineWidth = 1
    for (const bar of barRects(spec.edges, overlay.density, xAxis, yAxis, spec.space)) ctx.strokeRect(bar.x, bar.y, bar.w, bar.h)
    ctx.globalAlpha = 1
  }

  if (band !== null) drawBrushBand(ctx, { top, bottom }, band, layout.edgeToPx, tokens)

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
  if (overlay !== null) {
    ctx.globalAlpha = dimAlpha
    ctx.strokeStyle = slots[overlay.slot]
    ctx.strokeRect(legendX, legendY, SWATCH, SWATCH)
    ctx.globalAlpha = 1
    ctx.fillStyle = tokens.inkPrimary
    ctx.fillText(overlay.label, legendX + SWATCH + 6, legendY - 1)
  }

  ctx.restore()
  return true
}
