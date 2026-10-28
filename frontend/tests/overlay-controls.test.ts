// @vitest-environment jsdom
//
// The two overlay toggles: each says what it shows and how many, or why it is off, and keeps
// the user's choice while its data stays available.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderOverlayControls } from '../src/ui/overlay-controls'
import { expectNoRunTogetherText, loadRealStylesheet } from './support/run-together'

function mount(onToggle = vi.fn()) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const handle = renderOverlayControls(host, { onToggle })
  return { host, handle, onToggle }
}

function toggle(host: HTMLElement, kind: 'atBounds' | 'conflict'): HTMLButtonElement {
  const found = host.querySelector(`button[data-overlay="${kind}"]`)
  if (!found) throw new Error(`no ${kind} toggle`)
  return found as HTMLButtonElement
}

const SHOWN = { kind: 'shown' as const, label: '45° at bounds: 412 parameters', title: 'rule; caveat; 3 fixed excluded' }

beforeEach(() => {
  document.body.textContent = ''
})

afterEach(() => {
  document.head.textContent = ''
})

describe('renderOverlayControls', () => {
  it('renders one labelled group with a 45-degree and a 135-degree swatch toggle', () => {
    const { host, handle } = mount()
    const group = host.querySelector('[role="group"]')
    expect(group).toBe(handle.el)
    expect(group?.getAttribute('aria-label')).toBe('Overlays')
    expect(group?.classList.contains('overlay-controls')).toBe(true)
    expect(toggle(host, 'atBounds').querySelector('.hatch-swatch.at-bounds')).not.toBeNull()
    expect(toggle(host, 'conflict').querySelector('.hatch-swatch.conflict')).not.toBeNull()
    for (const b of host.querySelectorAll('button')) {
      expect(b.type).toBe('button')
      expect(b.classList.contains('overlay-toggle')).toBe(true)
    }
  })

  it('starts both toggles as reading and disabled', () => {
    const { host, handle } = mount()
    for (const kind of ['atBounds', 'conflict'] as const) {
      expect(toggle(host, kind).disabled).toBe(true)
      expect(toggle(host, kind).textContent).toContain('reading')
      expect(handle.isOn(kind)).toBe(false)
    }
  })

  it('shows a label and title, enabled and pressed, when the data is there', () => {
    const { host, handle } = mount()
    handle.setStatus('atBounds', SHOWN)
    const b = toggle(host, 'atBounds')
    expect(b.disabled).toBe(false)
    expect(b.querySelector('.overlay-count')?.textContent).toBe('45° at bounds: 412 parameters')
    expect(b.title).toBe('rule; caveat; 3 fixed excluded')
    expect(b.getAttribute('aria-pressed')).toBe('true')
    expect(handle.isOn('atBounds')).toBe(true)
    expect((b.querySelector('.overlay-reason') as HTMLElement).hidden).toBe(true)
  })

  it('flips on click and tells the caller each time', () => {
    const { host, handle, onToggle } = mount()
    handle.setStatus('atBounds', SHOWN)
    const b = toggle(host, 'atBounds')
    b.click()
    expect(b.getAttribute('aria-pressed')).toBe('false')
    expect(onToggle).toHaveBeenLastCalledWith('atBounds', false)
    expect(handle.isOn('atBounds')).toBe(false)
    b.click()
    expect(b.getAttribute('aria-pressed')).toBe('true')
    expect(onToggle).toHaveBeenLastCalledWith('atBounds', true)
    expect(onToggle).toHaveBeenCalledTimes(2)
  })

  it('disables a toggle with no data and shows its reason as visible text and title', () => {
    const { host, handle, onToggle } = mount()
    const reason = 'no prior-data conflict for iteration 3: no pdc file and no obs+noise to compute one'
    handle.setStatus('conflict', { kind: 'off', reason })
    const b = toggle(host, 'conflict')
    expect(b.disabled).toBe(true)
    const shown = b.querySelector('.overlay-reason') as HTMLElement
    expect(shown.hidden).toBe(false)
    expect(shown.textContent).toBe(reason)
    expect(b.title).toBe(reason)
    expect(b.getAttribute('aria-pressed')).toBe('false')
    b.click()
    b.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(onToggle).not.toHaveBeenCalled()
    expect(handle.isOn('conflict')).toBe(false)
  })

  it('keeps a toggle the user turned off across later shown statuses and loading', () => {
    const { host, handle } = mount()
    handle.setStatus('atBounds', SHOWN)
    toggle(host, 'atBounds').click()
    handle.setStatus('atBounds', { kind: 'loading' })
    handle.setStatus('atBounds', { ...SHOWN, label: '45° at bounds: 1 parameter' })
    expect(handle.isOn('atBounds')).toBe(false)
    expect(toggle(host, 'atBounds').getAttribute('aria-pressed')).toBe('false')
    expect(toggle(host, 'atBounds').querySelector('.overlay-count')?.textContent).toBe('45° at bounds: 1 parameter')
  })

  it('starts on again after a stretch with no data', () => {
    const { host, handle } = mount()
    handle.setStatus('atBounds', SHOWN)
    toggle(host, 'atBounds').click()
    handle.setStatus('atBounds', { kind: 'off', reason: 'near-bound counts exist for iterations 0 and 3 only' })
    handle.setStatus('atBounds', SHOWN)
    expect(handle.isOn('atBounds')).toBe(true)
    expect(toggle(host, 'atBounds').getAttribute('aria-pressed')).toBe('true')
  })

  it('keeps the two toggles independent', () => {
    const { host, handle } = mount()
    handle.setStatus('atBounds', SHOWN)
    handle.setStatus('conflict', { kind: 'shown', label: '135° conflict: 86 observations at 31 sites · computed', title: 't' })
    toggle(host, 'conflict').click()
    expect(handle.isOn('atBounds')).toBe(true)
    expect(handle.isOn('conflict')).toBe(false)
  })

  it('writes names and reasons as text, never as markup', () => {
    const { host, handle } = mount()
    handle.setStatus('conflict', { kind: 'off', reason: '<img src=x onerror=alert(1)>' })
    handle.setStatus('atBounds', { kind: 'shown', label: '<b>hk</b>', title: '<i>t</i>' })
    expect(host.querySelector('img')).toBeNull()
    expect(host.querySelector('b')).toBeNull()
    expect(toggle(host, 'conflict').querySelector('.overlay-reason')?.textContent).toBe('<img src=x onerror=alert(1)>')
  })

  it('never runs the swatch, label and reason together', () => {
    loadRealStylesheet()
    const { host, handle } = mount()
    handle.setStatus('atBounds', SHOWN)
    handle.setStatus('conflict', { kind: 'off', reason: 'no prior-data conflict for iteration 3' })
    expectNoRunTogetherText(host, 'overlay-controls')
  })

  it('a suppressed toggle is disabled but keeps its count, and shows the reason as text and title', () => {
    const { host, handle, onToggle } = mount()
    const reason = 'off while texture fill is on: its lines would look like the fill'
    handle.setStatus('atBounds', { kind: 'suppressed', reason, label: '12 at bounds', title: reason })
    const b = toggle(host, 'atBounds')
    expect(b.disabled).toBe(true)
    expect(b.querySelector('.overlay-count')?.textContent).toBe('12 at bounds')
    const shown = b.querySelector('.overlay-reason') as HTMLElement
    expect(shown.hidden).toBe(false)
    expect(shown.textContent).toBe(reason)
    expect(b.title).toBe(reason)
    expect(b.getAttribute('aria-pressed')).toBe('false')
    expect(handle.isOn('atBounds')).toBe(false)
    b.click()
    expect(onToggle).not.toHaveBeenCalled()
  })

  // [edge MAPX-03 restore]
  it('gives back the user choice after a suppressed stretch, off or on', () => {
    const { host, handle } = mount()
    const conflictShown = { kind: 'shown' as const, label: '135° conflict: 86 observations', title: 't' }
    handle.setStatus('atBounds', SHOWN)
    handle.setStatus('conflict', conflictShown)
    toggle(host, 'atBounds').click()
    const suppressed = { kind: 'suppressed' as const, reason: 'r', label: 'kept', title: 'r' }
    handle.setStatus('atBounds', suppressed)
    handle.setStatus('conflict', suppressed)
    handle.setStatus('atBounds', SHOWN)
    handle.setStatus('conflict', conflictShown)
    expect(handle.isOn('atBounds')).toBe(false)
    expect(toggle(host, 'atBounds').getAttribute('aria-pressed')).toBe('false')
    expect(handle.isOn('conflict')).toBe(true)
    expect(toggle(host, 'conflict').getAttribute('aria-pressed')).toBe('true')
  })

  it('empties its host on dispose and ignores later calls', () => {
    const { host, handle, onToggle } = mount()
    handle.setStatus('atBounds', SHOWN)
    const b = toggle(host, 'atBounds')
    handle.dispose()
    expect(host.textContent).toBe('')
    b.click()
    expect(onToggle).not.toHaveBeenCalled()
    handle.setStatus('atBounds', SHOWN)
    expect(host.textContent).toBe('')
  })
})
