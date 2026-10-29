// The armed section line on the plan (D-01, D-02): a button arms it, the first click sets end A and
// the second end B, and the line is drawn over the plan with A and B labels. It takes no pan and
// no pick while armed, and none at all while disarmed. Every word reaches the DOM through textContent.

import { readColorToken } from '../gl/color-token'
import type { Chart2D } from './charts/histogram'

export type SectionToolAvailability = { ok: true } | { ok: false; reason: string }

// Two clicks closer than this make no line; the server keeps its own floor (D-42). CSS pixels.
export const MIN_END_GAP_CSS_PX = 3
export const SAME_SPOT_REASON = 'the two ends are on the same spot'

export interface SectionToolOptions {
  /** The positioned box holding the map canvas; the line canvas goes in it. */
  area: HTMLElement
  canvas: HTMLCanvasElement
  buttonHost: HTMLElement
  /** Client CSS pixels to the map canvas's own pixels. */
  canvasPoint(event: { clientX: number; clientY: number }): [number, number]
  /** Plan screen to plan world units (relative to the mesh origin), and back. */
  screenToWorld(x: number, y: number): [number, number]
  worldToScreen(x: number, y: number): [number, number]
  /** Both ends in plan world units; the caller adds the mesh origin. */
  onLine(a: [number, number], b: [number, number]): void
  /** Told when the button arms the tool, so the map can disarm any other armed tool. */
  onArm?(): void
  /** The line's 2D context; tests pass a recording one, since jsdom has none. */
  context?: (overlay: HTMLCanvasElement) => Chart2D | null
}

export interface SectionToolHandle {
  armed(): boolean
  disarm(): void
  setAvailable(state: SectionToolAvailability): void
  /** True while armed, and once right after the click that sets B, so that click picks nothing. */
  consumeClick(): boolean
  /** Draws the line again from its world points, after a pan or zoom. */
  redraw(): void
  dispose(): void
}

function cssColour(name: string): string {
  const [r, g, b, a] = readColorToken(name)
  return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a})`
}

export function renderSectionTool(opts: SectionToolOptions): SectionToolHandle {
  const { area, canvas } = opts

  const wrap = document.createElement('div')
  wrap.classList.add('floating', 'section-tool')
  const button = document.createElement('button')
  button.type = 'button'
  button.classList.add('section-button')
  button.textContent = 'Section'
  button.setAttribute('aria-label', 'Draw a section line')
  button.setAttribute('aria-pressed', 'false')
  const reasonEl = document.createElement('div')
  reasonEl.classList.add('label', 'wrap-note')
  reasonEl.hidden = true
  wrap.appendChild(button)
  wrap.appendChild(reasonEl)
  opts.buttonHost.appendChild(wrap)

  const overlay = document.createElement('canvas')
  overlay.classList.add('section-line-overlay')
  overlay.setAttribute('aria-hidden', 'true')
  area.appendChild(overlay)
  const getContext = opts.context ?? ((el: HTMLCanvasElement) => el.getContext('2d') as Chart2D | null)

  let isArmed = false
  let available = false
  let unavailableReason: string | null = null
  // A refusal of the last click, shown under the button while the tool stays armed.
  let notice: string | null = null
  let swallowClick = false
  let disposed = false
  // End A of a line being drawn, and where the pointer is, both in plan world units.
  let pendingA: [number, number] | null = null
  // Where A was clicked, in client CSS pixels, for the too-close check.
  let pendingClient: [number, number] | null = null
  let pointerAt: [number, number] | null = null
  // The line last finished; it stays until a new one replaces it (D-03).
  let line: { a: [number, number]; b: [number, number] } | null = null

  function paintReason(): void {
    const text = unavailableReason ?? notice
    reasonEl.textContent = text ?? ''
    reasonEl.hidden = text === null
  }

  function setArmed(on: boolean): void {
    isArmed = on
    button.setAttribute('aria-pressed', String(on))
    area.classList.toggle('section-armed', on)
    notice = null
    paintReason()
    if (!on) {
      pendingA = null
      pendingClient = null
      pointerAt = null
      paint()
    }
  }

  function worldAt(event: { clientX: number; clientY: number }): [number, number] {
    const [x, y] = opts.canvasPoint(event)
    return opts.screenToWorld(x, y)
  }

  function paint(): void {
    if (overlay.width !== canvas.width) overlay.width = canvas.width
    if (overlay.height !== canvas.height) overlay.height = canvas.height
    const ctx = getContext(overlay)
    if (ctx === null) return
    ctx.clearRect(0, 0, overlay.width, overlay.height)
    const ends = pendingA !== null ? (pointerAt !== null ? { a: pendingA, b: pointerAt } : null) : line
    if (ends === null) return
    const ratio = window.devicePixelRatio || 1
    const [ax, ay] = opts.worldToScreen(ends.a[0], ends.a[1])
    const [bx, by] = opts.worldToScreen(ends.b[0], ends.b[1])
    const ink = cssColour('--ink-primary')
    ctx.save()
    ctx.strokeStyle = ink
    ctx.lineWidth = 2 * ratio
    // The rubber line is dashed until B is set.
    ctx.setLineDash(pendingA !== null ? [4 * ratio, 3 * ratio] : [])
    ctx.beginPath()
    ctx.moveTo(ax, ay)
    ctx.lineTo(bx, by)
    ctx.stroke()
    ctx.fillStyle = ink
    ctx.font = `${12 * ratio}px sans-serif`
    ctx.textBaseline = 'bottom'
    const lift = 4 * ratio
    ctx.fillText('A', ax + lift, ay - lift)
    if (pendingA === null) ctx.fillText('B', bx + lift, by - lift)
    ctx.restore()
  }

  function onPointerDown(event: PointerEvent): void {
    if (!isArmed) {
      // A new press starts a new gesture, so the click that set B can no longer be swallowed.
      swallowClick = false
      return
    }
    // Stops the pan handler on the same canvas from seeing an armed press at all.
    event.stopImmediatePropagation()
    event.preventDefault()
  }

  function onPointerMove(event: PointerEvent): void {
    if (!isArmed) return
    event.stopImmediatePropagation()
    if (pendingA === null) return
    pointerAt = worldAt(event)
    paint()
  }

  function onClick(event: MouseEvent): void {
    if (!isArmed) {
      swallowClick = false
      return
    }
    // The plan's own click handler never sees a click that places an end.
    event.stopImmediatePropagation()
    event.preventDefault()
    const point = worldAt(event)
    if (pendingA === null || pendingClient === null) {
      pendingA = point
      pendingClient = [event.clientX, event.clientY]
      pointerAt = null
      notice = null
      paintReason()
      paint()
      return
    }
    const gap = Math.hypot(event.clientX - pendingClient[0], event.clientY - pendingClient[1])
    if (gap < MIN_END_GAP_CSS_PX) {
      // A is kept and the tool stays armed, so only B needs clicking again.
      notice = SAME_SPOT_REASON
      paintReason()
      return
    }
    const a = pendingA
    line = { a, b: point }
    setArmed(false)
    swallowClick = true
    opts.onLine(a, point)
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (!isArmed || event.key !== 'Escape') return
    setArmed(false)
  }

  function onButtonClick(): void {
    if (disposed || !available) return
    const arming = !isArmed
    setArmed(arming)
    if (arming) opts.onArm?.()
  }

  const capture = { capture: true }
  canvas.addEventListener('pointerdown', onPointerDown, capture)
  canvas.addEventListener('pointermove', onPointerMove, capture)
  canvas.addEventListener('click', onClick, capture)
  document.addEventListener('keydown', onKeyDown)
  button.addEventListener('click', onButtonClick)

  function setAvailable(state: SectionToolAvailability): void {
    if (disposed) return
    available = state.ok
    button.disabled = !state.ok
    unavailableReason = state.ok ? null : state.reason
    button.title = state.ok ? 'Click two points on the plan to draw a section line; Esc stops' : state.reason
    if (!state.ok && isArmed) setArmed(false)
    paintReason()
  }
  setAvailable({ ok: false, reason: 'the map is still loading' })

  return {
    armed: () => isArmed,
    disarm() {
      if (isArmed) setArmed(false)
    },
    setAvailable,
    consumeClick() {
      if (isArmed) return true
      if (!swallowClick) return false
      swallowClick = false
      return true
    },
    redraw() {
      if (line === null && pendingA === null) return
      paint()
    },
    dispose() {
      disposed = true
      canvas.removeEventListener('pointerdown', onPointerDown, capture)
      canvas.removeEventListener('pointermove', onPointerMove, capture)
      canvas.removeEventListener('click', onClick, capture)
      document.removeEventListener('keydown', onKeyDown)
      button.removeEventListener('click', onButtonClick)
      area.classList.remove('section-armed')
      overlay.remove()
      wrap.remove()
    },
  }
}
