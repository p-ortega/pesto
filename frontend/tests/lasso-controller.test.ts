// @vitest-environment jsdom
//
// The lasso control on its own: the button and its armed state, the gesture on the canvas, the
// thinned path in world units, the dashed outline that follows the camera, and the click a lasso
// drag must swallow. The outline is read through the recording 2D stand-in.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderLasso, type LassoHandle, type LassoKeys } from '../src/ui/lasso'
import { createRecording2d, type RecordedCall } from './support/recording-2d'

interface Harness {
  area: HTMLElement
  canvas: HTMLCanvasElement
  host: HTMLElement
  lasso: LassoHandle
  released: { path: [number, number][]; keys: LassoKeys }[]
  tooSmall: number
  calls: RecordedCall[]
  view: { tx: number; ty: number }
  panListener: ReturnType<typeof vi.fn>
}

// The screen is the canvas, the world is the screen moved by the view offset and halved.
function harness(): Harness {
  const area = document.createElement('div')
  const canvas = document.createElement('canvas')
  canvas.width = 400
  canvas.height = 200
  const host = document.createElement('div')
  area.appendChild(host)
  area.appendChild(canvas)
  document.body.appendChild(area)
  const panListener = vi.fn()
  canvas.addEventListener('pointerdown', panListener)
  canvas.addEventListener('pointermove', panListener)
  canvas.addEventListener('pointerup', panListener)
  const { ctx, calls } = createRecording2d()
  const view = { tx: 0, ty: 0 }
  const h = {
    area,
    canvas,
    host,
    released: [] as Harness['released'],
    tooSmall: 0,
    calls,
    view,
    panListener,
  } as unknown as Harness
  h.lasso = renderLasso({
    area,
    canvas,
    buttonHost: host,
    canvasPoint: (event) => [event.clientX, event.clientY],
    screenToWorld: (x, y) => [(x - view.tx) / 2, (y - view.ty) / 2],
    worldToScreen: (x, y) => [x * 2 + view.tx, y * 2 + view.ty],
    onRelease: (path, keys) => h.released.push({ path, keys }),
    onTooSmall: () => {
      h.tooSmall += 1
    },
    context: () => ctx,
  })
  return h
}

const button = (h: Harness): HTMLButtonElement => h.host.querySelector('.lasso-button') as HTMLButtonElement

function pointer(type: string, x: number, y: number, init: PointerEventInit = {}): PointerEvent {
  return new PointerEvent(type, { clientX: x, clientY: y, pointerId: 1, button: 0, bubbles: true, cancelable: true, ...init })
}

// A square from (10, 10) to (50, 50) in screen pixels, released with the given keys.
function dragSquare(h: Harness, keys: PointerEventInit = {}): void {
  h.canvas.dispatchEvent(pointer('pointerdown', 10, 10))
  h.canvas.dispatchEvent(pointer('pointermove', 50, 10))
  h.canvas.dispatchEvent(pointer('pointermove', 50, 50))
  h.canvas.dispatchEvent(pointer('pointermove', 10, 50))
  h.canvas.dispatchEvent(pointer('pointerup', 10, 50, keys))
}

function arm(h: Harness): void {
  h.lasso.setAvailable({ ok: true })
  button(h).click()
}

const methods = (calls: RecordedCall[]): string[] => calls.map((c) => c.method)

describe('the lasso control', () => {
  beforeEach(() => {
    document.body.textContent = ''
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('puts a Lasso sites button in the host that arms and disarms on click, and Esc disarms', () => {
    const h = harness()
    const b = button(h)
    expect(b.textContent).toBe('Lasso sites')
    expect(b.getAttribute('aria-pressed')).toBe('false')

    arm(h)
    expect(h.lasso.armed()).toBe(true)
    expect(b.getAttribute('aria-pressed')).toBe('true')
    expect(h.area.classList.contains('lasso-armed')).toBe(true)

    b.click()
    expect(h.lasso.armed()).toBe(false)
    expect(b.getAttribute('aria-pressed')).toBe('false')
    expect(h.area.classList.contains('lasso-armed')).toBe(false)

    b.click()
    expect(h.lasso.armed()).toBe(true)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(h.lasso.armed()).toBe(false)
    expect(h.area.classList.contains('lasso-armed')).toBe(false)
  })

  it('is disabled with its reason shown and in the title, and going unavailable disarms it', () => {
    const h = harness()
    const reason = 'no observation site dots are drawn; colour the map by observations'
    // Unavailable from the start: nothing is drawn yet.
    expect(button(h).disabled).toBe(true)
    expect(h.host.textContent).toContain(reason)

    arm(h)
    expect(button(h).disabled).toBe(false)
    expect(h.host.textContent).not.toContain(reason)
    expect(h.lasso.armed()).toBe(true)

    h.lasso.setAvailable({ ok: false, reason })
    expect(button(h).disabled).toBe(true)
    expect(button(h).title).toBe(reason)
    expect(h.host.textContent).toContain(reason)
    expect(h.lasso.armed()).toBe(false)
    button(h).click()
    expect(h.lasso.armed()).toBe(false)
  })

  it('names itself in its reason line, which the button points at while it shows', () => {
    const h = harness()
    const line = h.host.querySelector('#lasso-reason') as HTMLElement
    expect(line.textContent).toBe('ℹ Lasso sites: no observation site dots are drawn; colour the map by observations')
    expect(button(h).getAttribute('aria-describedby')).toBe('lasso-reason')
    h.lasso.setAvailable({ ok: true })
    expect(line.hidden).toBe(true)
    expect(line.textContent).toBe('')
    expect(button(h).getAttribute('aria-describedby')).toBeNull()
  })

  it('puts the reason line in the reason host when one is given', () => {
    const area = document.createElement('div')
    const canvas = document.createElement('canvas')
    const buttons = document.createElement('div')
    const reasons = document.createElement('div')
    area.append(buttons, reasons, canvas)
    document.body.appendChild(area)
    const lasso = renderLasso({
      area,
      canvas,
      buttonHost: buttons,
      reasonHost: reasons,
      canvasPoint: (event) => [event.clientX, event.clientY],
      screenToWorld: (x, y) => [x, y],
      worldToScreen: (x, y) => [x, y],
      onRelease: () => {},
      onTooSmall: () => {},
      context: () => null,
    })
    expect(buttons.querySelector('.lasso-button')).not.toBeNull()
    expect(buttons.querySelector('#lasso-reason')).toBeNull()
    expect(reasons.querySelector('#lasso-reason')).not.toBeNull()
    lasso.dispose()
    expect(buttons.children).toHaveLength(0)
    expect(reasons.children).toHaveLength(0)
  })

  it('names the remove key in its title: Option on a Mac, Alt elsewhere', () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel' })
    const mac = harness()
    mac.lasso.setAvailable({ ok: true })
    expect(button(mac).title).toBe('Drag around site dots to select them. Shift adds, Option removes. Esc stops.')
    mac.lasso.dispose()

    vi.stubGlobal('navigator', { platform: 'Win32' })
    const pc = harness()
    pc.lasso.setAvailable({ ok: true })
    expect(button(pc).title).toBe('Drag around site dots to select them. Shift adds, Alt removes. Esc stops.')
    pc.lasso.dispose()
    vi.unstubAllGlobals()
  })

  it('reports an armed drag once on release, in world units, with the keys held at release', () => {
    const h = harness()
    arm(h)
    dragSquare(h, { shiftKey: true, altKey: false })
    expect(h.released).toHaveLength(1)
    expect(h.released[0].path).toEqual([
      [5, 5],
      [25, 5],
      [25, 25],
      [5, 25],
    ])
    expect(h.released[0].keys).toEqual({ shiftKey: true, altKey: false })

    dragSquare(h, { altKey: true })
    expect(h.released).toHaveLength(2)
    expect(h.released[1].keys).toEqual({ shiftKey: false, altKey: true })
  })

  it('stops an armed drag before the pan handler on the same canvas sees it', () => {
    const h = harness()
    arm(h)
    dragSquare(h)
    expect(h.panListener).not.toHaveBeenCalled()
  })

  it('thins points closer than 3 css px to the last kept one', () => {
    const h = harness()
    arm(h)
    h.canvas.dispatchEvent(pointer('pointerdown', 10, 10))
    h.canvas.dispatchEvent(pointer('pointermove', 11, 10))
    h.canvas.dispatchEvent(pointer('pointermove', 12, 11))
    h.canvas.dispatchEvent(pointer('pointermove', 50, 10))
    h.canvas.dispatchEvent(pointer('pointermove', 51, 10))
    h.canvas.dispatchEvent(pointer('pointermove', 50, 50))
    h.canvas.dispatchEvent(pointer('pointerup', 10, 50))
    expect(h.released).toHaveLength(1)
    expect(h.released[0].path).toEqual([
      [5, 5],
      [25, 5],
      [25, 25],
      [5, 25],
    ])
  })

  it('a path of fewer than 3 points after thinning is too small and is not released', () => {
    const h = harness()
    arm(h)
    h.canvas.dispatchEvent(pointer('pointerdown', 10, 10))
    h.canvas.dispatchEvent(pointer('pointermove', 11, 11))
    h.canvas.dispatchEvent(pointer('pointermove', 12, 10))
    h.canvas.dispatchEvent(pointer('pointerup', 40, 40))
    expect(h.released).toHaveLength(0)
    expect(h.tooSmall).toBe(1)

    // A tap is too small too.
    h.canvas.dispatchEvent(pointer('pointerdown', 10, 10))
    h.canvas.dispatchEvent(pointer('pointerup', 10, 10))
    expect(h.tooSmall).toBe(2)
    expect(h.released).toHaveLength(0)
  })

  it('draws the outline dashed in the ink colour on a .lasso-overlay canvas the size of the map canvas', () => {
    const h = harness()
    const overlay = h.area.querySelector('canvas.lasso-overlay') as HTMLCanvasElement
    expect(overlay).not.toBeNull()
    arm(h)
    dragSquare(h)
    expect(overlay.width).toBe(400)
    expect(overlay.height).toBe(200)
    const last = h.calls.slice(h.calls.map((c) => c.method).lastIndexOf('clearRect'))
    expect(methods(last)).toEqual(expect.arrayContaining(['beginPath', 'moveTo', 'lineTo', 'closePath', 'stroke']))
    const moveTo = last.find((c) => c.method === 'moveTo')!
    expect(moveTo.args).toEqual([10, 10])
    expect(last.filter((c) => c.method === 'lineTo').map((c) => c.args)).toEqual([
      [50, 10],
      [50, 50],
      [10, 50],
    ])
    const stroke = last.find((c) => c.method === 'stroke')!
    expect(stroke.state.dash.length).toBeGreaterThan(0)
    expect(String(stroke.state.strokeStyle)).toMatch(/^rgba\(/)
  })

  it('redraws the outline from its world points after the camera moves, and clearOutline removes it', () => {
    const h = harness()
    arm(h)
    dragSquare(h)
    h.view.tx = 30
    h.view.ty = -5
    h.calls.length = 0
    h.lasso.redraw()
    expect(h.calls.find((c) => c.method === 'moveTo')!.args).toEqual([40, 5])
    expect(h.calls.filter((c) => c.method === 'lineTo').map((c) => c.args)).toEqual([
      [80, 5],
      [80, 45],
      [40, 45],
    ])

    h.calls.length = 0
    h.lasso.clearOutline()
    expect(methods(h.calls)).toContain('clearRect')
    expect(methods(h.calls)).not.toContain('stroke')
    h.calls.length = 0
    h.lasso.redraw()
    expect(methods(h.calls)).not.toContain('stroke')
  })

  it('keeps the outline after disarming, until clearOutline', () => {
    const h = harness()
    arm(h)
    dragSquare(h)
    button(h).click()
    h.calls.length = 0
    h.lasso.redraw()
    expect(methods(h.calls)).toContain('stroke')
  })

  it('consumeClick is true once right after a lasso drag ends, then false', () => {
    const h = harness()
    arm(h)
    expect(h.lasso.consumeClick()).toBe(false)
    dragSquare(h)
    expect(h.lasso.consumeClick()).toBe(true)
    expect(h.lasso.consumeClick()).toBe(false)
  })

  it('does nothing with pointer events while disarmed, and consumeClick is false', () => {
    const h = harness()
    h.lasso.setAvailable({ ok: true })
    dragSquare(h)
    expect(h.released).toHaveLength(0)
    expect(h.tooSmall).toBe(0)
    expect(h.panListener).toHaveBeenCalled()
    expect(h.lasso.consumeClick()).toBe(false)
    expect(methods(h.calls)).not.toContain('stroke')
  })

  it('dispose removes every listener, the button and the overlay canvas', () => {
    const h = harness()
    arm(h)
    h.lasso.dispose()
    expect(h.area.querySelector('canvas.lasso-overlay')).toBeNull()
    expect(h.host.querySelector('.lasso-button')).toBeNull()
    expect(h.area.classList.contains('lasso-armed')).toBe(false)
    dragSquare(h)
    expect(h.released).toHaveLength(0)
    expect(h.panListener).toHaveBeenCalled()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  })
})
