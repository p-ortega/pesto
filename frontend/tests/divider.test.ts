// @vitest-environment jsdom
//
// D-09/D-11's draggable divider: the split moves on every pointer move, the
// new fraction is written exactly once on drag end, a failed persist costs
// the user nothing on screen, and neither side can be dragged to zero
// width.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderDivider } from '../src/ui/divider'
import * as client from '../src/data/client'

function mountFrame(): { container: HTMLElement; before: HTMLElement; divider: HTMLElement; after: HTMLElement } {
  const container = document.createElement('div')
  const before = document.createElement('div')
  const divider = document.createElement('div')
  const after = document.createElement('div')
  container.appendChild(before)
  container.appendChild(divider)
  container.appendChild(after)
  document.body.appendChild(container)
  container.getBoundingClientRect = () =>
    ({ left: 0, right: 800, width: 800, top: 0, bottom: 1, height: 1, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
  return { container, before, divider, after }
}

function pointerEvent(type: string, clientX: number): PointerEvent {
  return new PointerEvent(type, { clientX, pointerId: 1, bubbles: true })
}

describe('renderDivider', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('moves the split on every pointer move and commits once, on drag end', () => {
    const { container, before, divider, after } = mountFrame()
    const onCommit = vi.fn()
    renderDivider(divider, { container, before, after, initialFraction: 0.5, onCommit })

    divider.dispatchEvent(pointerEvent('pointerdown', 400))
    divider.dispatchEvent(pointerEvent('pointermove', 200))
    expect(before.style.flex).toContain('0.25')
    expect(onCommit).not.toHaveBeenCalled()

    divider.dispatchEvent(pointerEvent('pointermove', 600))
    expect(before.style.flex).toContain('0.75')
    expect(onCommit).not.toHaveBeenCalled()

    divider.dispatchEvent(pointerEvent('pointerup', 600))
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith(0.75)
  })

  it('a rejected persist leaves the divider at its new on-screen position and surfaces no error', async () => {
    const { container, before, divider, after } = mountFrame()
    vi.spyOn(client, 'writeViewState').mockRejectedValue(new Error('offline'))
    const onCommit = vi.fn((fraction: number) => {
      // Fire-and-forget, exactly as the view wires it -- a rejection here
      // must never throw back into the divider's own event handler.
      void client
        .writeViewState({ divider: fraction, colormap: 'viridis', reverse: false, scale: 'linear', limitsMode: 'robust', group: null, stat: 'value' })
        .catch(() => {})
    })
    renderDivider(divider, { container, before, after, initialFraction: 0.5, onCommit })

    divider.dispatchEvent(pointerEvent('pointerdown', 400))
    divider.dispatchEvent(pointerEvent('pointermove', 600))
    expect(() => divider.dispatchEvent(pointerEvent('pointerup', 600))).not.toThrow()

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(before.style.flex).toContain('0.75')
    expect(client.writeViewState).toHaveBeenCalledTimes(1)
  })

  it('applies the initial fraction at mount, default or recorded', () => {
    const recorded = mountFrame()
    renderDivider(recorded.divider, { ...recorded, initialFraction: 0.6, onCommit: vi.fn() })
    expect(recorded.before.style.flex).toContain('0.6')

    const defaulted = mountFrame()
    renderDivider(defaulted.divider, { ...defaulted, initialFraction: 0.72, onCommit: vi.fn() })
    expect(defaulted.before.style.flex).toContain('0.72')
  })

  it('carries aria-label="Resize panel" and is focusable', () => {
    const { container, before, divider, after } = mountFrame()
    renderDivider(divider, { container, before, after, initialFraction: 0.5, onCommit: vi.fn() })

    expect(divider.getAttribute('aria-label')).toBe('Resize panel')
    expect(divider.tabIndex).toBe(0)
  })

  it('clamps the fraction so neither side can be dragged to zero width', () => {
    const { container, before, after, divider } = mountFrame()
    const onCommit = vi.fn()
    renderDivider(divider, { container, before, after, initialFraction: 0.5, onCommit })

    divider.dispatchEvent(pointerEvent('pointerdown', 400))
    divider.dispatchEvent(pointerEvent('pointermove', -500))
    divider.dispatchEvent(pointerEvent('pointerup', -500))
    expect(onCommit).toHaveBeenLastCalledWith(0.1)

    divider.dispatchEvent(pointerEvent('pointerdown', 400))
    divider.dispatchEvent(pointerEvent('pointermove', 5000))
    divider.dispatchEvent(pointerEvent('pointerup', 5000))
    expect(onCommit).toHaveBeenLastCalledWith(0.9)
  })
})
