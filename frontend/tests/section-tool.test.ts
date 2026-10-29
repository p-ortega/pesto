// @vitest-environment jsdom
//
// The section line tool on its own (D-01 to D-03, D-42): armed only on purpose, two clicks for a
// line, Escape or the button to back out, and two ends on the same spot refused with a reason.
// The line is read through the recording 2D stand-in. The lasso's disarm and onArm are here too,
// since the map uses them with the tool's to keep only one tool armed.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderLasso, type LassoHandle } from '../src/ui/lasso'
import { renderSectionTool, type SectionToolHandle } from '../src/ui/section-tool'
import { createRecording2d, type RecordedCall } from './support/recording-2d'

interface Harness {
  area: HTMLElement
  canvas: HTMLCanvasElement
  host: HTMLElement
  tool: SectionToolHandle
  lines: { a: [number, number]; b: [number, number] }[]
  armed: number
  calls: RecordedCall[]
  view: { tx: number; ty: number }
  later: ReturnType<typeof vi.fn<(event: Event) => void>>
}

function box(): { area: HTMLElement; canvas: HTMLCanvasElement; host: HTMLElement } {
  const area = document.createElement('div')
  const canvas = document.createElement('canvas')
  canvas.width = 400
  canvas.height = 200
  const host = document.createElement('div')
  area.appendChild(host)
  area.appendChild(canvas)
  document.body.appendChild(area)
  return { area, canvas, host }
}

// The screen is the canvas, the world is the screen moved by the view offset and halved.
function harness(): Harness {
  const { area, canvas, host } = box()
  const { ctx, calls } = createRecording2d()
  const view = { tx: 0, ty: 0 }
  const h = { area, canvas, host, lines: [], armed: 0, calls, view } as unknown as Harness
  h.tool = renderSectionTool({
    area,
    canvas,
    buttonHost: host,
    canvasPoint: (event) => [event.clientX, event.clientY],
    screenToWorld: (x, y) => [(x - view.tx) / 2, (y - view.ty) / 2],
    worldToScreen: (x, y) => [x * 2 + view.tx, y * 2 + view.ty],
    onLine: (a, b) => h.lines.push({ a, b }),
    onArm: () => {
      h.armed += 1
    },
    context: () => ctx,
  })
  // Added after the tool's own listeners, as the map's pan and pick handlers are.
  h.later = vi.fn<(event: Event) => void>()
  canvas.addEventListener('pointerdown', h.later)
  canvas.addEventListener('click', h.later)
  h.tool.setAvailable({ ok: true })
  return h
}

const button = (h: { host: HTMLElement }): HTMLButtonElement => h.host.querySelector('.section-button') as HTMLButtonElement
const reason = (h: { host: HTMLElement }): HTMLElement => h.host.querySelector('#section-tool-reason') as HTMLElement

function pointer(type: string, x: number, y: number): PointerEvent {
  return new PointerEvent(type, { clientX: x, clientY: y, pointerId: 1, button: 0, bubbles: true, cancelable: true })
}

// A press and release in one spot, then the click a browser fires after it.
function clickAt(canvas: HTMLCanvasElement, x: number, y: number): void {
  canvas.dispatchEvent(pointer('pointerdown', x, y))
  canvas.dispatchEvent(pointer('pointerup', x, y))
  canvas.dispatchEvent(new MouseEvent('click', { clientX: x, clientY: y, bubbles: true, cancelable: true }))
}

function escape(): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
}

// What the overlay shows now: the calls after its last clear.
function lastPaint(calls: RecordedCall[]): RecordedCall[] {
  let start = -1
  calls.forEach((c, i) => {
    if (c.method === 'clearRect') start = i
  })
  return start < 0 ? [] : calls.slice(start)
}

function labels(calls: RecordedCall[]): unknown[] {
  return lastPaint(calls)
    .filter((c) => c.method === 'fillText')
    .map((c) => c.args[0])
}

function segment(calls: RecordedCall[]): number[] {
  const paint = lastPaint(calls)
  const move = paint.find((c) => c.method === 'moveTo')
  const to = paint.find((c) => c.method === 'lineTo')
  return move && to ? [...(move.args as number[]), ...(to.args as number[])] : []
}

describe('the section line tool', () => {
  let h: Harness

  beforeEach(() => {
    document.body.innerHTML = ''
    h = harness()
  })

  afterEach(() => {
    h.tool.dispose()
  })

  it('lets a press through to the map while it is not armed', () => {
    h.canvas.dispatchEvent(pointer('pointerdown', 10, 10))
    expect(h.later).toHaveBeenCalledTimes(1)
    expect(h.tool.armed()).toBe(false)
    expect(h.tool.consumeClick()).toBe(false)
  })

  it('stops the press while armed, sets A then B in world units, and disarms', () => {
    button(h).click()
    expect(h.tool.armed()).toBe(true)
    expect(h.armed).toBe(1)

    clickAt(h.canvas, 20, 40)
    expect(h.later).not.toHaveBeenCalled()
    expect(h.lines).toHaveLength(0)

    h.canvas.dispatchEvent(pointer('pointermove', 100, 60))
    // The rubber line runs from A to the pointer, dashed, with only A labelled.
    expect(segment(h.calls)).toEqual([20, 40, 100, 60])
    expect(labels(h.calls)).toEqual(['A'])

    clickAt(h.canvas, 120, 80)
    expect(h.later).not.toHaveBeenCalled()
    expect(h.lines).toEqual([{ a: [10, 20], b: [60, 40] }])
    expect(h.tool.armed()).toBe(false)
    expect(button(h).getAttribute('aria-pressed')).toBe('false')
    expect(labels(h.calls)).toEqual(['A', 'B'])
    // The click that set B picks nothing, and only that one.
    expect(h.tool.consumeClick()).toBe(true)
    expect(h.tool.consumeClick()).toBe(false)
  })

  it('lets the next plan click through after a line is set', () => {
    button(h).click()
    clickAt(h.canvas, 20, 40)
    clickAt(h.canvas, 120, 80)
    clickAt(h.canvas, 200, 100)
    expect(h.later).toHaveBeenCalledTimes(2)
    expect(h.tool.consumeClick()).toBe(false)
  })

  it('backs out on Escape after A, keeping the line drawn before', () => {
    button(h).click()
    clickAt(h.canvas, 20, 40)
    clickAt(h.canvas, 120, 80)
    button(h).click()
    clickAt(h.canvas, 200, 20)
    escape()

    expect(h.tool.armed()).toBe(false)
    expect(h.lines).toHaveLength(1)
    expect(segment(h.calls)).toEqual([20, 40, 120, 80])
    expect(labels(h.calls)).toEqual(['A', 'B'])
  })

  it('disarms from its button with the line unchanged', () => {
    button(h).click()
    clickAt(h.canvas, 20, 40)
    clickAt(h.canvas, 120, 80)
    button(h).click()
    clickAt(h.canvas, 200, 20)
    button(h).click()

    expect(h.tool.armed()).toBe(false)
    expect(h.armed).toBe(2)
    expect(h.lines).toHaveLength(1)
    expect(segment(h.calls)).toEqual([20, 40, 120, 80])
  })

  it('refuses a second click under 3 CSS pixels from A, keeps A and stays armed', () => {
    button(h).click()
    clickAt(h.canvas, 20, 40)
    clickAt(h.canvas, 22, 40)

    expect(h.lines).toHaveLength(0)
    expect(h.tool.armed()).toBe(true)
    expect(reason(h).hidden).toBe(false)
    expect(reason(h).textContent).toBe('⚠ Draw section line: the two ends are on the same spot')
    expect(button(h).getAttribute('aria-describedby')).toBe('section-tool-reason')

    clickAt(h.canvas, 25, 40)
    expect(h.lines).toEqual([{ a: [10, 20], b: [12.5, 20] }])
    expect(h.tool.armed()).toBe(false)
    expect(reason(h).hidden).toBe(true)
  })

  it('replaces the old line with the new one: one line, one A and one B', () => {
    button(h).click()
    clickAt(h.canvas, 20, 40)
    clickAt(h.canvas, 120, 80)
    button(h).click()
    clickAt(h.canvas, 200, 20)
    clickAt(h.canvas, 300, 150)

    expect(h.lines).toHaveLength(2)
    const paint = lastPaint(h.calls)
    expect(paint.filter((c) => c.method === 'moveTo')).toHaveLength(1)
    expect(paint.filter((c) => c.method === 'lineTo')).toHaveLength(1)
    expect(labels(h.calls)).toEqual(['A', 'B'])
    expect(segment(h.calls)).toEqual([200, 20, 300, 150])
  })

  it('repaints the line at its new screen points after the mapping moves', () => {
    button(h).click()
    clickAt(h.canvas, 20, 40)
    clickAt(h.canvas, 120, 80)
    h.view.tx = 10
    h.view.ty = -5
    h.tool.redraw()
    expect(segment(h.calls)).toEqual([30, 35, 130, 75])
  })

  it('disables its button with the reason and disarms when it is not available', () => {
    button(h).click()
    clickAt(h.canvas, 20, 40)
    h.tool.setAvailable({ ok: false, reason: 'the grid file records no layer bottoms' })

    expect(h.tool.armed()).toBe(false)
    expect(button(h).disabled).toBe(true)
    expect(reason(h).textContent).toBe('ℹ Draw section line: the grid file records no layer bottoms')
    expect(button(h).title).toBe('the grid file records no layer bottoms')
    expect(button(h).getAttribute('aria-describedby')).toBe('section-tool-reason')
    button(h).click()
    expect(h.tool.armed()).toBe(false)
    expect(h.armed).toBe(1)

    h.tool.setAvailable({ ok: true })
    expect(button(h).disabled).toBe(false)
    expect(reason(h).hidden).toBe(true)
    expect(button(h).title).toBe('Click two points on the plan to draw a section line. Esc stops.')
    expect(button(h).getAttribute('aria-describedby')).toBeNull()
  })

  it('reads Draw section line, in its text and its aria-label', () => {
    expect(button(h).textContent).toBe('Draw section line')
    expect(button(h).getAttribute('aria-label')).toBe('Draw section line')
  })

  it('disarms on disarm() and changes nothing else', () => {
    button(h).click()
    clickAt(h.canvas, 20, 40)
    clickAt(h.canvas, 120, 80)
    button(h).click()
    const armedBefore = h.armed
    h.tool.disarm()

    expect(h.tool.armed()).toBe(false)
    expect(h.armed).toBe(armedBefore)
    expect(button(h).disabled).toBe(false)
    expect(h.lines).toHaveLength(1)
    expect(segment(h.calls)).toEqual([20, 40, 120, 80])
  })

  it('puts the reason through textContent, never as markup', () => {
    h.tool.setAvailable({ ok: false, reason: '<b>no</b> bottoms' })
    expect(reason(h).textContent).toBe('ℹ Draw section line: <b>no</b> bottoms')
    expect(reason(h).querySelector('b')).toBeNull()
  })
})

describe('the lasso disarm and onArm', () => {
  let lasso: LassoHandle
  let parts: ReturnType<typeof box>
  let calls: RecordedCall[]
  let arms: number

  beforeEach(() => {
    document.body.innerHTML = ''
    parts = box()
    const recording = createRecording2d()
    calls = recording.calls
    arms = 0
    lasso = renderLasso({
      area: parts.area,
      canvas: parts.canvas,
      buttonHost: parts.host,
      canvasPoint: (event) => [event.clientX, event.clientY],
      screenToWorld: (x, y) => [x, y],
      worldToScreen: (x, y) => [x, y],
      onRelease: () => {},
      onTooSmall: () => {},
      onArm: () => {
        arms += 1
      },
      context: () => recording.ctx,
    })
    lasso.setAvailable({ ok: true })
  })

  afterEach(() => {
    lasso.dispose()
  })

  const lassoButton = (): HTMLButtonElement => parts.host.querySelector('.lasso-button') as HTMLButtonElement

  it('tells the map when its button arms it, and not when it disarms', () => {
    lassoButton().click()
    expect(lasso.armed()).toBe(true)
    expect(arms).toBe(1)
    lassoButton().click()
    expect(lasso.armed()).toBe(false)
    expect(arms).toBe(1)
  })

  it('disarms on disarm() and keeps the outline it left', () => {
    lassoButton().click()
    parts.canvas.dispatchEvent(pointer('pointerdown', 10, 10))
    parts.canvas.dispatchEvent(pointer('pointermove', 50, 10))
    parts.canvas.dispatchEvent(pointer('pointermove', 50, 50))
    parts.canvas.dispatchEvent(pointer('pointermove', 10, 50))
    parts.canvas.dispatchEvent(pointer('pointerup', 10, 50))
    const outline = lastPaint(calls).filter((c) => c.method === 'lineTo').length
    expect(outline).toBeGreaterThan(1)

    lasso.disarm()
    expect(lasso.armed()).toBe(false)
    expect(lassoButton().getAttribute('aria-pressed')).toBe('false')
    expect(lastPaint(calls).filter((c) => c.method === 'lineTo')).toHaveLength(outline)
    lasso.redraw()
    expect(lastPaint(calls).filter((c) => c.method === 'lineTo')).toHaveLength(outline)
  })
})
