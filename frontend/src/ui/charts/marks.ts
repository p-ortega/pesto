// Marks for the chart kit: markers, polylines, bands, range bars and guides.
// Identity never rests on colour alone, so markers differ by shape and by
// fill. Every gap in the data starts a new subpath; nothing is joined across
// a missing value. All positions are in pixels and all colours are tokens
// passed in by the caller.

import type { Chart2D } from './histogram'

export interface MarkerPoint {
  x: number
  y: number
  hollow: boolean
}

export interface MarkerStyle {
  shape: 'circle' | 'square'
  radius: number
  colour: string
}

const HOLLOW_LINE_WIDTH = 1.5

// Returns how many points were skipped because x or y was not a finite number.
export function drawMarkers(ctx: Chart2D, points: MarkerPoint[], style: MarkerStyle): number {
  let skipped = 0
  ctx.save()
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      skipped += 1
      continue
    }
    ctx.beginPath()
    if (style.shape === 'circle') {
      ctx.arc(point.x, point.y, style.radius, 0, Math.PI * 2)
    } else {
      ctx.rect(point.x - style.radius, point.y - style.radius, style.radius * 2, style.radius * 2)
    }
    ctx.strokeStyle = style.colour
    ctx.lineWidth = HOLLOW_LINE_WIDTH
    if (!point.hollow) {
      ctx.fillStyle = style.colour
      ctx.fill()
    }
    ctx.stroke()
  }
  ctx.restore()
  return skipped
}

// Returns the number of breaks, one per run of non-finite values that sat
// between two drawn points.
export function drawPolyline(
  ctx: Chart2D,
  xs: number[],
  ys: number[],
  style: { colour: string; width: number },
): number {
  let breaks = 0
  let pen = false
  let drawnAny = false
  ctx.save()
  ctx.strokeStyle = style.colour
  ctx.lineWidth = style.width
  ctx.beginPath()
  const n = Math.min(xs.length, ys.length)
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(xs[i]) || !Number.isFinite(ys[i])) {
      if (pen) pen = false
      continue
    }
    if (!pen) {
      if (drawnAny) breaks += 1
      ctx.moveTo(xs[i], ys[i])
      pen = true
      drawnAny = true
    } else {
      ctx.lineTo(xs[i], ys[i])
    }
  }
  ctx.stroke()
  ctx.restore()
  return breaks
}

function usable(low: number | null | undefined, high: number | null | undefined, x: number): boolean {
  return (
    low !== null &&
    low !== undefined &&
    high !== null &&
    high !== undefined &&
    Number.isFinite(low) &&
    Number.isFinite(high) &&
    Number.isFinite(x)
  )
}

// One filled polygon per unbroken run; a null or non-finite bound ends the run.
export function drawBand(
  ctx: Chart2D,
  xs: number[],
  lows: (number | null)[],
  highs: (number | null)[],
  fill: string,
  alpha: number,
): void {
  ctx.save()
  ctx.fillStyle = fill
  ctx.globalAlpha = alpha
  const n = Math.min(xs.length, lows.length, highs.length)
  let start = -1
  const flush = (end: number): void => {
    if (start < 0) return
    ctx.beginPath()
    ctx.moveTo(xs[start], highs[start] as number)
    for (let i = start + 1; i <= end; i++) ctx.lineTo(xs[i], highs[i] as number)
    for (let i = end; i >= start; i--) ctx.lineTo(xs[i], lows[i] as number)
    ctx.closePath()
    ctx.fill()
    start = -1
  }
  for (let i = 0; i < n; i++) {
    if (usable(lows[i], highs[i], xs[i])) {
      if (start < 0) start = i
    } else {
      flush(i - 1)
    }
  }
  flush(n - 1)
  ctx.restore()
}

export function drawRangeBars(
  ctx: Chart2D,
  bars: Array<{ x: number; low: number; high: number }>,
  style: { colour: string; width: number },
): void {
  ctx.save()
  ctx.strokeStyle = style.colour
  ctx.lineWidth = style.width
  ctx.beginPath()
  for (const bar of bars) {
    if (!Number.isFinite(bar.x) || !Number.isFinite(bar.low) || !Number.isFinite(bar.high)) continue
    ctx.moveTo(bar.x, bar.low)
    ctx.lineTo(bar.x, bar.high)
  }
  ctx.stroke()
  ctx.restore()
}

export function drawCursor(ctx: Chart2D, x: number, top: number, bottom: number, colour: string): void {
  if (!Number.isFinite(x)) return
  ctx.save()
  ctx.strokeStyle = colour
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(x, top)
  ctx.lineTo(x, bottom)
  ctx.stroke()
  ctx.restore()
}

export function drawDiagonal(
  ctx: Chart2D,
  from: [number, number],
  to: [number, number],
  colour: string,
): void {
  ctx.save()
  ctx.strokeStyle = colour
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(from[0], from[1])
  ctx.lineTo(to[0], to[1])
  ctx.stroke()
  ctx.restore()
}
