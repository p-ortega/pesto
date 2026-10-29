// The map's lasso (D-11 to D-13): a button that arms it, the freehand gesture on the map canvas,
// and the dashed outline over the map. It picks nothing itself; the map view turns the released
// path into sites. Every word reaches the DOM through textContent.

import { MIN_LASSO_POINTS, thinPath, type LassoPoint } from '../data/lasso'
import { readColorToken } from '../gl/color-token'
import type { Chart2D } from './charts/histogram'

// Path points closer than this are dropped, so a slow drag does not make a huge outline (CSS px).
const THIN_CSS_PX = 3

export type LassoAvailability = { ok: true } | { ok: false; reason: string }

export interface LassoKeys {
  shiftKey: boolean
  altKey: boolean
}

export interface LassoOptions {
  /** The positioned box holding the map canvas; the outline canvas goes in it. */
  area: HTMLElement
  canvas: HTMLCanvasElement
  buttonHost: HTMLElement
  /** Where the reason line goes; the button's host when absent. */
  reasonHost?: HTMLElement
  /** Client CSS pixels to the map canvas's own pixels. */
  canvasPoint(event: { clientX: number; clientY: number }): [number, number]
  screenToWorld(x: number, y: number): [number, number]
  worldToScreen(x: number, y: number): [number, number]
  /** The released path in world units, with the modifier keys held at release. */
  onRelease(path: [number, number][], keys: LassoKeys): void
  /** A release whose path has fewer than 3 points after thinning. */
  onTooSmall(): void
  /** Told when the button arms the lasso, so the map can disarm any other armed tool. */
  onArm?(): void
  /** The outline's 2D context; tests pass a recording one, since jsdom has none. */
  context?: (overlay: HTMLCanvasElement) => Chart2D | null
}

export interface LassoHandle {
  armed(): boolean
  /** Stops an armed lasso; the outline it left stays. */
  disarm(): void
  setAvailable(state: LassoAvailability): void
  /** True once right after an armed gesture ends, so the click it fires selects nothing. */
  consumeClick(): boolean
  clearOutline(): void
  /** Draws the outline again from its world points, after a pan or zoom. */
  redraw(): void
  dispose(): void
}

function cssColour(name: string): string {
  const [r, g, b, a] = readColorToken(name)
  return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a})`
}

export function renderLasso(opts: LassoOptions): LassoHandle {
  const { area, canvas } = opts

  const button = document.createElement('button')
  button.type = 'button'
  button.classList.add('lasso-button')
  button.textContent = 'Lasso sites'
  button.setAttribute('aria-pressed', 'false')
  const reasonEl = document.createElement('div')
  reasonEl.classList.add('label', 'wrap-note')
  reasonEl.hidden = true
  opts.buttonHost.appendChild(button)
  ;(opts.reasonHost ?? opts.buttonHost).appendChild(reasonEl)

  const overlay = document.createElement('canvas')
  overlay.classList.add('lasso-overlay')
  overlay.setAttribute('aria-hidden', 'true')
  area.appendChild(overlay)
  const getContext = opts.context ?? ((el: HTMLCanvasElement) => el.getContext('2d') as Chart2D | null)

  let isArmed = false
  let available = false
  let swallowClick = false
  let disposed = false
  // The gesture under way: client points for thinning, world points for the outline.
  let pointerId: number | null = null
  let clientPath: LassoPoint[] = []
  let livePath: [number, number][] = []
  // The outline kept after a release, in world units so it follows pan and zoom.
  let outline: [number, number][] | null = null

  function setArmed(on: boolean): void {
    isArmed = on
    button.setAttribute('aria-pressed', String(on))
    if (on) area.classList.add('lasso-armed')
    else area.classList.remove('lasso-armed')
    if (!on) {
      pointerId = null
      clientPath = []
      livePath = []
      swallowClick = false
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
    const path = pointerId !== null ? livePath : outline
    if (path === null || path.length < 2) return
    const ratio = window.devicePixelRatio || 1
    ctx.save()
    ctx.strokeStyle = cssColour('--ink-primary')
    ctx.lineWidth = 1.5 * ratio
    ctx.setLineDash([4 * ratio, 3 * ratio])
    ctx.beginPath()
    path.forEach(([wx, wy], i) => {
      const [x, y] = opts.worldToScreen(wx, wy)
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    if (pointerId === null) ctx.closePath()
    ctx.stroke()
    ctx.restore()
  }

  function onPointerDown(event: PointerEvent): void {
    if (!isArmed) return
    // Stops the pan handler on the same canvas from seeing an armed drag at all.
    event.stopImmediatePropagation()
    event.preventDefault()
    if (event.button !== 0 || pointerId !== null) return
    swallowClick = false
    pointerId = event.pointerId
    clientPath = [[event.clientX, event.clientY]]
    livePath = [worldAt(event)]
    try {
      canvas.setPointerCapture?.(event.pointerId)
    } catch {
      // Capture only helps when the pointer leaves the canvas; the gesture works without it.
    }
    paint()
  }

  function onPointerMove(event: PointerEvent): void {
    if (!isArmed) return
    event.stopImmediatePropagation()
    if (event.pointerId !== pointerId) return
    clientPath.push([event.clientX, event.clientY])
    livePath.push(worldAt(event))
    paint()
  }

  function onPointerUp(event: PointerEvent): void {
    if (!isArmed) return
    event.stopImmediatePropagation()
    if (event.pointerId !== pointerId) return
    // The release usually lands where the last move did; a repeated point would only double a vertex.
    const [lx, ly] = clientPath[clientPath.length - 1]
    if (lx !== event.clientX || ly !== event.clientY) clientPath.push([event.clientX, event.clientY])
    const keys = { shiftKey: event.shiftKey, altKey: event.altKey }
    const thinned = thinPath(clientPath, THIN_CSS_PX)
    pointerId = null
    clientPath = []
    livePath = []
    swallowClick = true
    if (typeof canvas.releasePointerCapture === 'function') {
      try {
        canvas.releasePointerCapture(event.pointerId)
      } catch {
        // Already released.
      }
    }
    if (thinned.length < MIN_LASSO_POINTS) {
      paint()
      opts.onTooSmall()
      return
    }
    const path = thinned.map((point) => worldAt({ clientX: point[0], clientY: point[1] }))
    outline = path
    paint()
    opts.onRelease(path, keys)
  }

  function onPointerCancel(event: PointerEvent): void {
    if (!isArmed) return
    event.stopImmediatePropagation()
    if (event.pointerId !== pointerId) return
    pointerId = null
    clientPath = []
    livePath = []
    paint()
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
  canvas.addEventListener('pointerup', onPointerUp, capture)
  canvas.addEventListener('pointercancel', onPointerCancel, capture)
  document.addEventListener('keydown', onKeyDown)
  button.addEventListener('click', onButtonClick)

  function setAvailable(state: LassoAvailability): void {
    if (disposed) return
    available = state.ok
    button.disabled = !state.ok
    if (state.ok) {
      reasonEl.textContent = ''
      reasonEl.hidden = true
      button.title = 'Drag around site dots to select them; shift adds, option removes; Esc stops'
    } else {
      reasonEl.textContent = state.reason
      reasonEl.hidden = false
      button.title = state.reason
      if (isArmed) setArmed(false)
    }
  }
  setAvailable({ ok: false, reason: 'no observation site dots are drawn; colour the map by observations' })

  return {
    armed: () => isArmed,
    disarm() {
      if (isArmed) setArmed(false)
    },
    setAvailable,
    consumeClick() {
      if (!isArmed || !swallowClick) return false
      swallowClick = false
      return true
    },
    clearOutline() {
      if (outline === null) return
      outline = null
      paint()
    },
    redraw() {
      if (outline === null && pointerId === null) return
      paint()
    },
    dispose() {
      disposed = true
      canvas.removeEventListener('pointerdown', onPointerDown, capture)
      canvas.removeEventListener('pointermove', onPointerMove, capture)
      canvas.removeEventListener('pointerup', onPointerUp, capture)
      canvas.removeEventListener('pointercancel', onPointerCancel, capture)
      document.removeEventListener('keydown', onKeyDown)
      button.removeEventListener('click', onButtonClick)
      area.classList.remove('lasso-armed')
      overlay.remove()
      button.remove()
      reasonEl.remove()
    },
  }
}
