// @vitest-environment jsdom
//
// The fold button on a floating map card: it folds and unfolds, says so through aria-expanded,
// keeps the viewer's choice in localStorage when it can, and works the same when storage throws.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SHORT_MAP_HEIGHT, isShortMap, renderFold } from '../src/ui/fold'
import { basemapSummary } from '../src/ui/basemap-controls'
import { renderOverlayControls } from '../src/ui/overlay-controls'
import { loadRealStylesheet } from './support/run-together'

// Node's own experimental localStorage shadows jsdom's and is undefined here, so each test brings one.
function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const values = new Map<string, string>()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
  }
}

const button = (el: HTMLElement): HTMLButtonElement => el.querySelector('.fold-button') as HTMLButtonElement
const summary = (el: HTMLElement): HTMLElement => el.querySelector('.fold-summary') as HTMLElement

describe('a foldable card', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    vi.stubGlobal('localStorage', memoryStorage())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('folds and unfolds from a real button that names the card and says whether it is open', () => {
    const fold = renderFold({ key: 'controls', name: 'Controls' })
    document.body.appendChild(fold.el)
    const b = button(fold.el)
    expect(b.tagName).toBe('BUTTON')
    expect(b.type).toBe('button')
    expect(b.getAttribute('aria-label')).toBe('Controls')
    expect(b.getAttribute('aria-controls')).toBe(fold.body.id)
    expect(b.getAttribute('aria-expanded')).toBe('true')
    expect(fold.folded()).toBe(false)

    b.click()
    expect(fold.folded()).toBe(true)
    expect(b.getAttribute('aria-expanded')).toBe('false')
    expect(fold.el.getAttribute('data-folded')).toBe('true')

    b.click()
    expect(fold.folded()).toBe(false)
    expect(b.getAttribute('aria-expanded')).toBe('true')
  })

  it('takes keyboard focus like any button', () => {
    const fold = renderFold({ key: 'controls', name: 'Controls' })
    document.body.appendChild(fold.el)
    button(fold.el).focus()
    expect(document.activeElement).toBe(button(fold.el))
  })

  it('hides the whole body when folded, even a body that sets its own display inline, and shows the named line', () => {
    loadRealStylesheet()
    const fold = renderFold({ key: 'basemap', name: 'Basemap' })
    document.body.appendChild(fold.el)
    fold.body.style.display = 'flex'
    fold.body.textContent = 'Add basemap'
    fold.setSummary('grid.png')
    expect(getComputedStyle(summary(fold.el)).display).toBe('none')

    button(fold.el).click()
    expect(getComputedStyle(fold.body).display).toBe('none')
    expect(getComputedStyle(summary(fold.el)).display).not.toBe('none')
    expect(summary(fold.el).textContent).toBe('Basemap: grid.png')
    fold.setSummary(null)
    expect(summary(fold.el).textContent).toBe('Basemap')
  })

  it('folds the legend to its ramp and group name, hiding only its other text lines', () => {
    loadRealStylesheet()
    const fold = renderFold({ key: 'legend', name: 'Legend', mode: 'lines' })
    document.body.appendChild(fold.el)
    const ramp = document.createElement('div')
    const name = document.createElement('div')
    name.classList.add('label', 'legend-name')
    name.textContent = 'G1'
    const scale = document.createElement('div')
    scale.classList.add('label')
    scale.textContent = 'Scale: Linear'
    fold.body.append(ramp, name, scale)
    // The legend's own lines name it, so its folded line adds no text.
    expect(fold.el.textContent).toBe('G1Scale: Linear')

    button(fold.el).click()
    expect(getComputedStyle(fold.body).display).not.toBe('none')
    expect(getComputedStyle(ramp).display).not.toBe('none')
    expect(getComputedStyle(name).display).not.toBe('none')
    expect(getComputedStyle(scale).display).toBe('none')
  })

  it('shows nothing while its body is empty, such as the legend before the first field', () => {
    loadRealStylesheet()
    const fold = renderFold({ key: 'legend', name: 'Legend', mode: 'lines' })
    document.body.appendChild(fold.el)
    expect(getComputedStyle(fold.el).display).toBe('none')
    fold.body.textContent = 'G1'
    expect(getComputedStyle(fold.el).display).not.toBe('none')
  })

  it('remembers the choice for the next render, and a stored choice beats the default', () => {
    const first = renderFold({ key: 'controls', name: 'Controls' })
    button(first.el).click()
    expect(localStorage.getItem('pesto.fold.controls')).toBe('folded')
    expect(renderFold({ key: 'controls', name: 'Controls' }).folded()).toBe(true)

    const again = renderFold({ key: 'controls', name: 'Controls', startFolded: true })
    button(again.el).click()
    expect(localStorage.getItem('pesto.fold.controls')).toBe('open')
    expect(renderFold({ key: 'controls', name: 'Controls', startFolded: true }).folded()).toBe(false)
  })

  it("keeps one card's choice apart from another's", () => {
    button(renderFold({ key: 'basemap', name: 'Basemap' }).el).click()
    expect(renderFold({ key: 'controls', name: 'Controls' }).folded()).toBe(false)
  })

  it('renders and folds the same with no storage at all', () => {
    vi.stubGlobal('localStorage', undefined)
    const fold = renderFold({ key: 'controls', name: 'Controls' })
    button(fold.el).click()
    expect(fold.folded()).toBe(true)
  })

  it('renders and folds the same when storage throws on every read and write', () => {
    const refuse = (): never => {
      throw new Error('storage disabled')
    }
    vi.stubGlobal('localStorage', { getItem: refuse, setItem: refuse })
    const fold = renderFold({ key: 'controls', name: 'Controls', startFolded: true })
    expect(fold.folded()).toBe(true)
    expect(() => button(fold.el).click()).not.toThrow()
    expect(fold.folded()).toBe(false)
    expect(button(fold.el).getAttribute('aria-expanded')).toBe('true')
    expect(renderFold({ key: 'controls', name: 'Controls' }).folded()).toBe(false)
  })

  it('ignores a stored value it does not recognise', () => {
    localStorage.setItem('pesto.fold.controls', 'sideways')
    expect(renderFold({ key: 'controls', name: 'Controls', startFolded: true }).folded()).toBe(true)
    expect(renderFold({ key: 'controls', name: 'Controls' }).folded()).toBe(false)
  })
})

describe('the legend card', () => {
  it('lets a long section line wrap inside a capped card instead of running past its edge', () => {
    loadRealStylesheet()
    document.body.innerHTML = ''
    const fold = renderFold({ key: 'legend', name: 'Legend', mode: 'lines' })
    fold.el.classList.add('floating-bottom-left')
    document.body.appendChild(fold.el)
    const line = document.createElement('div')
    line.classList.add('label', 'section-legend-line')
    line.textContent = 'group G1 sets layers 1, 2, 3; other layers have no value from this group'
    fold.body.appendChild(line)
    expect(getComputedStyle(line).maxWidth).not.toBe('none')
    expect(getComputedStyle(line).whiteSpace).toBe('normal')
  })
})

describe('the short-map test', () => {
  it('calls a map below the threshold short, and a map with no layout yet not short', () => {
    expect(SHORT_MAP_HEIGHT).toBe(640)
    expect(isShortMap(536)).toBe(true)
    expect(isShortMap(639)).toBe(true)
    expect(isShortMap(640)).toBe(false)
    expect(isShortMap(900)).toBe(false)
    expect(isShortMap(0)).toBe(false)
  })
})

describe('what a folded card says', () => {
  it('names the basemap image, or why there is none', () => {
    expect(basemapSummary({ kind: 'none' })).toBe('none')
    expect(
      basemapSummary({
        kind: 'ready',
        name: 'grid.png',
        placedBy: 'world_file',
        worldFile: 'grid.pgw',
        extent: [0, 1, 0, 1],
        notes: [],
        colour: false,
        opacity: 1,
      }),
    ).toBe('grid.png')
    expect(basemapSummary({ kind: 'failed', reason: 'the image could not be read' })).toBe('the image could not be read')
  })

  it('gives both overlay counts on one line and follows every change', () => {
    document.body.innerHTML = ''
    const seen: string[] = []
    const host = document.createElement('div')
    const handle = renderOverlayControls(host, { onToggle: () => {}, onChange: () => seen.push('changed') })
    expect(handle.summary()).toBe('45° at bounds: reading… · 135° conflict: reading…')
    handle.setStatus('atBounds', { kind: 'shown', label: '45° at bounds: 19 parameters', title: '' })
    handle.setStatus('conflict', { kind: 'off', reason: 'no prior data conflict file' })
    expect(handle.summary()).toBe('45° at bounds: 19 parameters · 135° conflict: no prior data conflict file')
    ;(host.querySelector('[data-overlay="atBounds"]') as HTMLButtonElement).click()
    expect(handle.summary()).toContain('45° at bounds: 19 parameters (turned off)')
    expect(seen.length).toBeGreaterThanOrEqual(4)
  })
})
