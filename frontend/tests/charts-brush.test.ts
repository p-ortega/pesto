// @vitest-environment jsdom
//
// The chart-kit brush: a horizontal drag becomes a closed value range in the
// axis's own units, a near-still press is a click, and a press outside the
// plot area starts nothing.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { linearAxis, logAxis } from '../src/ui/charts/axes'
import { BRUSH_MIN_PX, attachBrush, drawBrushBand, type BrushOptions } from '../src/ui/charts/brush'
import type { ChartTokens } from '../src/ui/charts/tokens'
import { createRecording2d } from './support/recording-2d'

const TOKENS: ChartTokens = {
  axis: 'axis',
  gridline: 'grid',
  inkPrimary: 'ink',
  inkMuted: 'muted',
  series1: 's1',
  series2: 's2',
}

function mountCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  document.body.appendChild(canvas)
  canvas.getBoundingClientRect = () =>
    ({ left: 0, right: 300, width: 300, top: 0, bottom: 150, height: 150, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
  return canvas
}

function pointer(type: string, clientX: number, init: PointerEventInit = {}): PointerEvent {
  return new PointerEvent(type, { clientX, clientY: 50, pointerId: 1, bubbles: true, ...init })
}

function drag(canvas: HTMLCanvasElement, from: number, to: number, up: PointerEventInit = {}): void {
  canvas.dispatchEvent(pointer('pointerdown', from))
  canvas.dispatchEvent(pointer('pointermove', to))
  canvas.dispatchEvent(pointer('pointerup', to, up))
}

function setup(extra: Partial<BrushOptions> = {}) {
  const canvas = mountCanvas()
  const axis = linearAxis([-2, 2], [40, 240])
  const onBrush = vi.fn()
  const onClick = vi.fn()
  const handle = attachBrush(canvas, {
    plotLeft: () => 40,
    plotRight: () => 240,
    invert: axis.invert,
    onBrush,
    onClick,
    ...extra,
  })
  return { canvas, axis, onBrush, onClick, handle }
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('axis invert', () => {
  it('turns a pixel back into a value on a linear axis', () => {
    const axis = linearAxis([0, 10], [40, 240])
    expect(axis.invert(140)).toBe(5)
    for (const v of [0, 1.5, 3.25, 7, 10]) expect(Math.abs(axis.invert(axis.toPx(v)) - v)).toBeLessThan(1e-9)
  })

  it('turns a pixel back into a native value on a log axis', () => {
    const axis = logAxis([1, 1000], [0, 300])
    expect(axis).not.toBeNull()
    expect(Math.abs(axis!.invert(200) - 100)).toBeLessThan(1e-9)
    for (const v of [1, 3, 42, 999]) expect(Math.abs(axis!.invert(axis!.toPx(v)) - v)).toBeLessThan(1e-9)
  })

  it('still refuses a log axis over a bad domain', () => {
    expect(logAxis([0, 10], [0, 300])).toBeNull()
    expect(logAxis([5, 1], [0, 300])).toBeNull()
  })
})

describe('attachBrush', () => {
  it('reports the dragged range in axis units with the keys held at release', () => {
    const { canvas, onBrush, onClick } = setup()
    drag(canvas, 90, 190, { shiftKey: true, altKey: false })
    expect(onBrush).toHaveBeenCalledTimes(1)
    const [range, keys] = onBrush.mock.calls[0]
    expect(range[0]).toBeCloseTo(-1, 9)
    expect(range[1]).toBeCloseTo(1, 9)
    expect(keys).toEqual({ shiftKey: true, altKey: false })
    expect(onClick).not.toHaveBeenCalled()
  })

  it('reads the keys at release, not at press', () => {
    const { canvas, onBrush } = setup()
    canvas.dispatchEvent(pointer('pointerdown', 90, { shiftKey: true }))
    canvas.dispatchEvent(pointer('pointermove', 190, { shiftKey: true }))
    canvas.dispatchEvent(pointer('pointerup', 190, { altKey: true }))
    expect(onBrush.mock.calls[0][1]).toEqual({ shiftKey: false, altKey: true })
  })

  it('gives the same range whichever way the drag went', () => {
    const { canvas, onBrush } = setup()
    drag(canvas, 190, 90)
    const [range] = onBrush.mock.calls[0]
    expect(range[0]).toBeCloseTo(-1, 9)
    expect(range[1]).toBeCloseTo(1, 9)
    expect(range[0]).toBeLessThanOrEqual(range[1])
  })

  it('clamps a drag past the plot edge to the domain end', () => {
    const { canvas, onBrush } = setup()
    drag(canvas, 190, 290)
    const [range] = onBrush.mock.calls[0]
    expect(range[0]).toBeCloseTo(1, 9)
    expect(range[1]).toBeCloseTo(2, 9)

    drag(canvas, 90, 0)
    const [left] = onBrush.mock.calls[1]
    expect(left[0]).toBeCloseTo(-2, 9)
    expect(left[1]).toBeCloseTo(-1, 9)
  })

  it('treats a press that moves 2 px as a click and reports no range', () => {
    expect(BRUSH_MIN_PX).toBe(3)
    const { canvas, onBrush, onClick } = setup()
    drag(canvas, 100, 102)
    expect(onBrush).not.toHaveBeenCalled()
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('reports no range for a short press even with no click handler', () => {
    const { canvas, onBrush } = setup({ onClick: undefined })
    expect(() => drag(canvas, 100, 101)).not.toThrow()
    expect(onBrush).not.toHaveBeenCalled()
  })

  it('starts no brush for a press outside the plot area', () => {
    const { canvas, onBrush, onClick, handle } = setup()
    canvas.dispatchEvent(pointer('pointerdown', 20))
    canvas.dispatchEvent(pointer('pointermove', 200))
    expect(handle.dragging()).toBeNull()
    canvas.dispatchEvent(pointer('pointerup', 200))
    expect(onBrush).not.toHaveBeenCalled()
    expect(onClick).not.toHaveBeenCalled()
  })

  it('reads the pointer in css px from the canvas box', () => {
    const { canvas, onBrush } = setup()
    canvas.getBoundingClientRect = () =>
      ({ left: 100, right: 400, width: 300, top: 0, bottom: 150, height: 150, x: 100, y: 0, toJSON: () => ({}) }) as DOMRect
    drag(canvas, 190, 290)
    const [range] = onBrush.mock.calls[0]
    expect(range[0]).toBeCloseTo(-1, 9)
    expect(range[1]).toBeCloseTo(1, 9)
  })

  it('shows the live range while dragging and clears it on release', () => {
    const onDrag = vi.fn()
    const { canvas, handle } = setup({ onDrag })
    expect(handle.dragging()).toBeNull()
    canvas.dispatchEvent(pointer('pointerdown', 90))
    canvas.dispatchEvent(pointer('pointermove', 91))
    expect(handle.dragging()).toBeNull()
    canvas.dispatchEvent(pointer('pointermove', 190))
    const live = handle.dragging()
    expect(live).not.toBeNull()
    expect(live![0]).toBeCloseTo(-1, 9)
    expect(live![1]).toBeCloseTo(1, 9)
    expect(onDrag).toHaveBeenLastCalledWith(live)
    canvas.dispatchEvent(pointer('pointerup', 190))
    expect(handle.dragging()).toBeNull()
    expect(onDrag).toHaveBeenLastCalledWith(null)
  })

  it('ends the press without a range when the pointer is cancelled', () => {
    const { canvas, onBrush, handle } = setup()
    canvas.dispatchEvent(pointer('pointerdown', 90))
    canvas.dispatchEvent(pointer('pointermove', 190))
    canvas.dispatchEvent(pointer('pointercancel', 190))
    expect(handle.dragging()).toBeNull()
    canvas.dispatchEvent(pointer('pointerup', 190))
    expect(onBrush).not.toHaveBeenCalled()
  })

  it('removes every listener on dispose', () => {
    const { canvas, onBrush, onClick, handle } = setup()
    const removed = vi.spyOn(canvas, 'removeEventListener')
    handle.dispose()
    const types = removed.mock.calls.map((call) => call[0]).sort()
    expect(types).toEqual(['pointercancel', 'pointerdown', 'pointermove', 'pointerup'])
    drag(canvas, 90, 190)
    drag(canvas, 100, 101)
    expect(onBrush).not.toHaveBeenCalled()
    expect(onClick).not.toHaveBeenCalled()
  })
})

describe('drawBrushBand', () => {
  it('fills one rect at reduced alpha and strokes both edges, then restores alpha', () => {
    const { ctx, calls } = createRecording2d()
    const axis = linearAxis([-2, 2], [40, 240])
    drawBrushBand(ctx, { top: 10, bottom: 110 }, [-1, 1], axis.toPx, TOKENS)

    const fills = calls.filter((c) => c.method === 'fillRect')
    expect(fills).toHaveLength(1)
    const [x, y, w, h] = fills[0].args as number[]
    expect(x).toBeCloseTo(90, 9)
    expect(y).toBe(10)
    expect(w).toBeCloseTo(100, 9)
    expect(h).toBe(100)
    expect(fills[0].state.fillStyle).toBe('muted')
    expect(fills[0].state.globalAlpha).toBe(0.15)

    const strokes = calls.filter((c) => c.method === 'stroke')
    expect(strokes).toHaveLength(2)
    for (const s of strokes) {
      expect(s.state.strokeStyle).toBe('ink')
      expect(s.state.globalAlpha).toBe(1)
    }
    const edges = calls.filter((c) => c.method === 'moveTo').map((c) => (c.args as number[])[0])
    expect(edges[0]).toBeCloseTo(90, 9)
    expect(edges[1]).toBeCloseTo(190, 9)
    expect(ctx.globalAlpha).toBe(1)
  })

  it('draws the same band whichever order the range ends are given', () => {
    const { ctx, calls } = createRecording2d()
    const axis = linearAxis([-2, 2], [40, 240])
    drawBrushBand(ctx, { top: 10, bottom: 110 }, [1, -1], axis.toPx, TOKENS)
    const [x, , w] = calls.find((c) => c.method === 'fillRect')!.args as number[]
    expect(x).toBeCloseTo(90, 9)
    expect(w).toBeCloseTo(100, 9)
  })
})
