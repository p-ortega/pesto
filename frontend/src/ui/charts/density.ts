// A density panel for the 1:1 plot: a square grid of counts on one range
// shared by x and y, shaded on a log scale whose top the caller sets so two
// panels can share it, with the 1:1 line drawn corner to corner. Counts are
// stored row by row along y (index iy * nBins + ix); iy runs up the plot.

import { linearAxis, logAxis, type Axis } from './axes'
import type { ChartSize, Chart2D } from './histogram'
import { drawDiagonal } from './marks'
import type { ChartTokens } from './tokens'

export interface DensitySpec {
  nBins: number
  counts: ArrayLike<number>
  lo: number
  hi: number
  shadeMax: number
  title: string
  xLabel: string
  yLabel: string
  /** Both axes together. 'log' needs lo above zero; linear when not given. */
  scale?: DensityScale
}

export type DensityScale = 'linear' | 'log'

/** Why the two axes cannot be log axes over this range, or null when they can. */
export function densityLogRefusal(lo: number): string | null {
  return lo > 0 ? null : `A log axis needs every value above zero, and the drawn range starts at ${Number(lo.toPrecision(4))}.`
}

export interface PlotArea {
  left: number
  top: number
  width: number
  height: number
}

// The top holds two rows: the panel title, then the y-axis label, so the two never run together.
const MARGIN = { left: 52, right: 12, top: 44, bottom: 40 }
const FONT = '12px system-ui, sans-serif'
const TICKS = 5
// Room between the widest y label and the axis line: the 6 px label gap plus a little air.
const LABEL_GAP = 10

// Square, so one unit on x is the same length as one unit on y.
export function densityPlotArea(size: ChartSize, leftMargin = MARGIN.left): PlotArea {
  const room = Math.min(
    size.width - leftMargin - MARGIN.right,
    size.height - MARGIN.top - MARGIN.bottom,
  )
  const side = Math.max(0, room)
  const spare = Math.max(0, size.width - leftMargin - MARGIN.right - side)
  return { left: leftMargin + spare / 2, top: MARGIN.top, width: side, height: side }
}

export interface DensityLayout {
  area: PlotArea
  xAxis: Axis
  yAxis: Axis
}

function axesFor(area: PlotArea, lo: number, hi: number, scale: DensityScale): DensityLayout {
  if (scale === 'log') {
    const xAxis = logAxis([lo, hi], [area.left, area.left + area.width])
    const yAxis = logAxis([lo, hi], [area.top + area.height, area.top])
    if (xAxis !== null && yAxis !== null) return { area, xAxis, yAxis }
  }
  return {
    area,
    xAxis: linearAxis([lo, hi], [area.left, area.left + area.width], TICKS),
    yAxis: linearAxis([lo, hi], [area.top + area.height, area.top], TICKS),
  }
}

// The left margin fits the widest y label, so a long label is never cut at the canvas edge.
// Two passes, because the margin changes the side and so the ticks.
export function densityLayout(ctx: Chart2D, size: ChartSize, lo: number, hi: number, scale: DensityScale = 'linear'): DensityLayout {
  // Font is set and put back by hand, not with save(), so a refused draw leaves no calls.
  const font = ctx.font
  ctx.font = FONT
  const widest = (layout: DensityLayout) =>
    Math.max(0, ...layout.yAxis.ticks.map((tick) => ctx.measureText(tick.label).width))
  let margin = MARGIN.left
  let layout = axesFor(densityPlotArea(size, margin), lo, hi, scale)
  for (let pass = 0; pass < 2; pass++) {
    const needed = Math.ceil(widest(layout)) + LABEL_GAP
    if (needed <= margin) break
    margin = needed
    layout = axesFor(densityPlotArea(size, margin), lo, hi, scale)
  }
  ctx.font = font
  return layout
}

function isValid(spec: DensitySpec): boolean {
  const { nBins, counts, lo, hi, shadeMax } = spec
  if (!Number.isInteger(nBins) || nBins < 1) return false
  if (counts.length !== nBins * nBins) return false
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo >= hi) return false
  let any = false
  for (let i = 0; i < counts.length; i++) {
    const count = counts[i]
    if (!Number.isFinite(count) || count < 0) return false
    if (count > 0) any = true
  }
  if (!Number.isFinite(shadeMax) || shadeMax < 0) return false
  return !(any && shadeMax === 0)
}

// Returns false, and draws nothing, when the grid or range cannot be drawn honestly.
export function drawDensity(
  ctx: Chart2D,
  spec: DensitySpec,
  tokens: ChartTokens,
  size: ChartSize,
): boolean {
  if (!isValid(spec)) return false
  const log = spec.scale === 'log'
  if (log && densityLogRefusal(spec.lo) !== null) return false
  const { area, xAxis, yAxis } = densityLayout(ctx, size, spec.lo, spec.hi, spec.scale)
  if (area.width <= 0) return false
  const { left, top, width, height } = area
  const right = left + width
  const bottom = top + height

  const cell = width / spec.nBins
  const step = (spec.hi - spec.lo) / spec.nBins
  const shadeTop = Math.log1p(spec.shadeMax)

  ctx.save()
  ctx.clearRect(0, 0, size.width, size.height)
  ctx.font = FONT

  ctx.fillStyle = tokens.inkPrimary
  for (let iy = 0; iy < spec.nBins; iy++) {
    for (let ix = 0; ix < spec.nBins; ix++) {
      const count = spec.counts[iy * spec.nBins + ix]
      if (count === 0) continue
      ctx.globalAlpha = Math.min(1, Math.log1p(count) / shadeTop)
      if (log) {
        // The bins are equal steps of value, so on a log axis each cell is drawn between its own two edges.
        const x0 = xAxis.toPx(spec.lo + ix * step)
        const x1 = xAxis.toPx(spec.lo + (ix + 1) * step)
        const y0 = yAxis.toPx(spec.lo + iy * step)
        const y1 = yAxis.toPx(spec.lo + (iy + 1) * step)
        ctx.fillRect(x0, y1, x1 - x0, y0 - y1)
      } else {
        ctx.fillRect(left + ix * cell, bottom - (iy + 1) * cell, cell, cell)
      }
    }
  }
  ctx.globalAlpha = 1

  drawDiagonal(ctx, [left, bottom], [right, top], tokens.axis)

  ctx.strokeStyle = tokens.axis
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(left, top)
  ctx.lineTo(left, bottom)
  ctx.lineTo(right, bottom)
  ctx.stroke()

  ctx.fillStyle = tokens.inkMuted
  ctx.textBaseline = 'top'
  ctx.textAlign = 'center'
  for (const tick of xAxis.ticks) if (tick.label !== '') ctx.fillText(tick.label, tick.px, bottom + 4)
  ctx.fillText(spec.xLabel, (left + right) / 2, bottom + 22)
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'right'
  for (const tick of yAxis.ticks) if (tick.label !== '') ctx.fillText(tick.label, left - 6, tick.px)
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  ctx.fillText(spec.yLabel, left, top - 18)

  ctx.fillStyle = tokens.inkPrimary
  ctx.textAlign = 'right'
  ctx.fillText(spec.title, right, top - 36)

  ctx.restore()
  return true
}
