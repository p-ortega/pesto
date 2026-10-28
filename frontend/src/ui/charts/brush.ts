// A horizontal drag brush for a chart canvas. It reads a closed value range
// off the chart through the caller's axis invert, so the range is in the
// drawn axis's own units. It draws nothing itself; drawBrushBand does that.

import type { Chart2D } from './histogram'
import type { ChartTokens } from './tokens'

// A press that moves less than this, in css px, is a click and never a range.
export const BRUSH_MIN_PX = 3

const BAND_ALPHA = 0.15

export interface BrushKeys {
  shiftKey: boolean
  altKey: boolean
}

export interface BrushOptions {
  // The plot area's left and right edges, in css px from the canvas's left edge.
  plotLeft(): number
  plotRight(): number
  invert(px: number): number
  onBrush(range: [number, number], keys: BrushKeys): void
  onClick?(event: PointerEvent): void
  // Called on every move with the live range, and with null when the press ends.
  onDrag?(range: [number, number] | null): void
}

export interface BrushHandle {
  dragging(): [number, number] | null
  dispose(): void
}

interface Press {
  pointerId: number
  startX: number
  startClientX: number
  startClientY: number
  live: [number, number] | null
}

export function attachBrush(canvas: HTMLCanvasElement, options: BrushOptions): BrushHandle {
  let press: Press | null = null

  // Charts draw in css px (the host scales for the device), so css px from the box is the plot's space.
  const cssX = (event: PointerEvent): number => event.clientX - canvas.getBoundingClientRect().left

  const clampPx = (px: number): number => {
    const left = options.plotLeft()
    const right = options.plotRight()
    return Math.min(Math.max(px, Math.min(left, right)), Math.max(left, right))
  }

  // Null until the drag spans at least BRUSH_MIN_PX inside the plot area.
  const rangeOf = (current: Press, x: number): [number, number] | null => {
    const a = clampPx(current.startX)
    const b = clampPx(x)
    if (Math.abs(b - a) < BRUSH_MIN_PX) return null
    const va = options.invert(a)
    const vb = options.invert(b)
    return va <= vb ? [va, vb] : [vb, va]
  }

  const release = (event: PointerEvent): void => {
    try {
      if (canvas.hasPointerCapture?.(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
    } catch {
      // Capture was already gone; nothing to release.
    }
  }

  const onDown = (event: PointerEvent): void => {
    if (press !== null) return
    const x = cssX(event)
    const left = Math.min(options.plotLeft(), options.plotRight())
    const right = Math.max(options.plotLeft(), options.plotRight())
    if (x < left || x > right) return
    press = { pointerId: event.pointerId, startX: x, startClientX: event.clientX, startClientY: event.clientY, live: null }
    try {
      canvas.setPointerCapture?.(event.pointerId)
    } catch {
      // The brush still works on canvas events; capture only helps when the pointer leaves it.
    }
  }

  const onMove = (event: PointerEvent): void => {
    if (press === null || event.pointerId !== press.pointerId) return
    press.live = rangeOf(press, cssX(event))
    options.onDrag?.(press.live)
  }

  const onUp = (event: PointerEvent): void => {
    if (press === null || event.pointerId !== press.pointerId) return
    const current = press
    press = null
    release(event)
    const range = rangeOf(current, cssX(event))
    options.onDrag?.(null)
    if (range !== null) {
      options.onBrush(range, { shiftKey: event.shiftKey, altKey: event.altKey })
      return
    }
    const moved = Math.hypot(event.clientX - current.startClientX, event.clientY - current.startClientY)
    if (moved < BRUSH_MIN_PX) options.onClick?.(event)
  }

  const onCancel = (event: PointerEvent): void => {
    if (press === null || event.pointerId !== press.pointerId) return
    press = null
    release(event)
    options.onDrag?.(null)
  }

  canvas.addEventListener('pointerdown', onDown)
  canvas.addEventListener('pointermove', onMove)
  canvas.addEventListener('pointerup', onUp)
  canvas.addEventListener('pointercancel', onCancel)

  return {
    dragging: () => (press?.live ? [press.live[0], press.live[1]] : null),
    dispose() {
      press = null
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointercancel', onCancel)
    },
  }
}

// The band a brush leaves on the chart, redrawn from a held range so it stays until cleared.
export function drawBrushBand(
  ctx: Chart2D,
  area: { top: number; bottom: number },
  range: [number, number],
  toPx: (v: number) => number,
  tokens: ChartTokens,
): void {
  const a = toPx(range[0])
  const b = toPx(range[1])
  if (!Number.isFinite(a) || !Number.isFinite(b)) return
  const left = Math.min(a, b)
  const right = Math.max(a, b)
  const alpha = ctx.globalAlpha
  ctx.globalAlpha = BAND_ALPHA
  ctx.fillStyle = tokens.inkMuted
  ctx.fillRect(left, area.top, right - left, area.bottom - area.top)
  ctx.globalAlpha = alpha
  ctx.strokeStyle = tokens.inkPrimary
  ctx.lineWidth = 1
  for (const x of [left, right]) {
    ctx.beginPath()
    ctx.moveTo(x, area.top)
    ctx.lineTo(x, area.bottom)
    ctx.stroke()
  }
}
