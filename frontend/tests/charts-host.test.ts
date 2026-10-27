// @vitest-environment jsdom
// The chart kit's canvas host and its colour tokens: a hidden chart draws
// nothing, onShow draws once at the real size, the backing store follows the
// device pixel ratio, and colours come from the theme's custom properties.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCanvasHost } from '../src/ui/charts/canvas-host'
import { readChartTokens } from '../src/ui/charts/tokens'
import { createRecording2d } from './support/recording-2d'

function sizedContainer(width: number, height: number): HTMLElement {
  const el = document.createElement('div')
  Object.defineProperty(el, 'clientWidth', { value: width, configurable: true })
  Object.defineProperty(el, 'clientHeight', { value: height, configurable: true })
  document.body.appendChild(el)
  return el
}

beforeEach(() => {
  vi.stubGlobal('devicePixelRatio', 2)
})

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

describe('readChartTokens', () => {
  it('returns the resolved value of each chart custom property', () => {
    const el = document.createElement('div')
    el.style.setProperty('--axis', 'tok-axis')
    el.style.setProperty('--gridline', 'tok-gridline')
    el.style.setProperty('--ink-primary', ' tok-ink-primary ')
    el.style.setProperty('--ink-muted', 'tok-ink-muted')
    el.style.setProperty('--series-1', 'tok-series-1')
    el.style.setProperty('--series-2', 'tok-series-2')
    document.body.appendChild(el)
    expect(readChartTokens(el)).toEqual({
      axis: 'tok-axis',
      gridline: 'tok-gridline',
      inkPrimary: 'tok-ink-primary',
      inkMuted: 'tok-ink-muted',
      series1: 'tok-series-1',
      series2: 'tok-series-2',
    })
  })
})

describe('createCanvasHost', () => {
  it('appends one canvas with role img and the label, and setLabel changes it', () => {
    const container = sizedContainer(300, 200)
    const host = createCanvasHost(container, { label: 'first', draw: () => {} })
    const canvases = container.querySelectorAll('canvas')
    expect(canvases).toHaveLength(1)
    expect(canvases[0].getAttribute('role')).toBe('img')
    expect(canvases[0].getAttribute('aria-label')).toBe('first')
    host.setLabel('second')
    expect(canvases[0].getAttribute('aria-label')).toBe('second')
    host.destroy()
    expect(container.querySelectorAll('canvas')).toHaveLength(0)
  })

  it('draws nothing while hidden, and onShow draws once at the box size', () => {
    const container = sizedContainer(300, 200)
    const { ctx, calls } = createRecording2d()
    const draw = vi.fn()
    const host = createCanvasHost(container, { label: 'x', draw, context: () => ctx })
    host.onHide()
    host.redraw()
    host.redraw()
    expect(draw).not.toHaveBeenCalled()

    host.onShow()
    expect(draw).toHaveBeenCalledTimes(1)
    expect(draw).toHaveBeenCalledWith(ctx, { width: 300, height: 200 })
    const canvas = container.querySelector('canvas')!
    expect(canvas.width).toBe(600)
    expect(canvas.height).toBe(400)
    expect(calls.find((c) => c.method === 'setTransform')?.args).toEqual([2, 0, 0, 2, 0, 0])
  })

  it('draws nothing when the container has no size', () => {
    const container = sizedContainer(0, 0)
    const { ctx } = createRecording2d()
    const draw = vi.fn()
    const host = createCanvasHost(container, { label: 'x', draw, context: () => ctx })
    host.redraw()
    host.onShow()
    expect(draw).not.toHaveBeenCalled()
  })

  it('draws nothing when no 2D context is available', () => {
    const container = sizedContainer(300, 200)
    const draw = vi.fn()
    const host = createCanvasHost(container, { label: 'x', draw, context: () => null })
    host.redraw()
    expect(draw).not.toHaveBeenCalled()
  })

  it('does not throw where ResizeObserver is missing, and uses it where it exists', () => {
    expect(typeof ResizeObserver).toBe('undefined')
    const container = sizedContainer(300, 200)
    expect(() => createCanvasHost(container, { label: 'x', draw: () => {} })).not.toThrow()

    const observe = vi.fn()
    const disconnect = vi.fn()
    let notify: () => void = () => {}
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          notify = callback
        }
        observe = observe
        disconnect = disconnect
      },
    )
    const { ctx } = createRecording2d()
    const draw = vi.fn()
    const host = createCanvasHost(container, { label: 'x', draw, context: () => ctx })
    expect(observe).toHaveBeenCalledWith(container)
    notify()
    expect(draw).toHaveBeenCalledTimes(1)
    host.onHide()
    notify()
    expect(draw).toHaveBeenCalledTimes(1)
    host.destroy()
    expect(disconnect).toHaveBeenCalled()
  })
})
