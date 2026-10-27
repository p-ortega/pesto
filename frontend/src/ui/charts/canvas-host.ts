// A canvas that sizes itself for the screen and waits while its tab is
// hidden. Hidden tabs stay mounted and have no size, so a hidden chart draws
// nothing and onShow draws once. Canvas 2D only; no chart gets a WebGL context.

import type { Chart2D, ChartSize } from './histogram'

export interface CanvasHostOptions {
  label: string
  draw: (ctx: Chart2D, size: ChartSize) => void
  context?: () => Chart2D | null
}

export interface CanvasHost {
  redraw(): void
  onShow(): void
  onHide(): void
  setLabel(text: string): void
  destroy(): void
}

export function createCanvasHost(container: HTMLElement, options: CanvasHostOptions): CanvasHost {
  const canvas = document.createElement('canvas')
  canvas.setAttribute('role', 'img')
  canvas.setAttribute('aria-label', options.label)
  canvas.style.display = 'block'
  canvas.style.width = '100%'
  canvas.style.height = '100%'
  container.appendChild(canvas)

  const getContext =
    options.context ?? (() => canvas.getContext('2d') as Chart2D | null)
  let hidden = false

  const redraw = () => {
    if (hidden) return
    const width = container.clientWidth
    const height = container.clientHeight
    if (width <= 0 || height <= 0) return
    const ratio = window.devicePixelRatio || 1
    canvas.width = Math.round(width * ratio)
    canvas.height = Math.round(height * ratio)
    const ctx = getContext()
    if (ctx === null) return
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    options.draw(ctx, { width, height })
  }

  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => redraw())
  observer?.observe(container)

  return {
    redraw,
    onShow() {
      hidden = false
      redraw()
    },
    onHide() {
      hidden = true
    },
    setLabel(text) {
      canvas.setAttribute('aria-label', text)
    },
    destroy() {
      observer?.disconnect()
      canvas.remove()
    },
  }
}
