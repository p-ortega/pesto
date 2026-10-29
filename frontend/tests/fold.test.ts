// @vitest-environment jsdom
//
// The fold button on a floating map card: it folds and unfolds, says so through aria-expanded,
// keeps the viewer's choice in localStorage when it can, and works the same when storage throws.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SHORT_MAP_HEIGHT, foldOthersToFit, isShortMap, renderFold, settleStack, type FoldHandle } from '../src/ui/fold'
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

    button(fold.el).click()
    expect(getComputedStyle(fold.body).display).toBe('none')
    expect(getComputedStyle(summary(fold.el)).display).not.toBe('none')
    expect(summary(fold.el).textContent).toBe('Basemap: grid.png')
    expect(summary(fold.el).title).toBe('Basemap: grid.png')
    fold.setSummary(null)
    expect(summary(fold.el).textContent).toBe('Basemap')
  })

  it('shows its name alone as the title while open, with the body under it, and the full line again when folded', () => {
    loadRealStylesheet()
    const fold = renderFold({ key: 'basemap', name: 'Basemap' })
    document.body.appendChild(fold.el)
    fold.body.textContent = 'Add basemap'
    fold.setSummary('grid.png')
    const title = summary(fold.el)
    expect(title.textContent).toBe('Basemap')
    expect(title.title).toBe('Basemap')
    const style = getComputedStyle(title)
    expect(style.display).not.toBe('none')
    expect(style.fontSize).toBe('14px')
    expect(style.fontWeight).toBe('600')
    expect(style.color).toBe('var(--ink-primary)')
    expect(getComputedStyle(fold.body).gridArea.startsWith('2')).toBe(true)
    expect(getComputedStyle(button(fold.el)).gridArea.startsWith('1')).toBe(true)

    button(fold.el).click()
    expect(title.textContent).toBe('Basemap: grid.png')
    button(fold.el).click()
    expect(title.textContent).toBe('Basemap')
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
    const warning = document.createElement('div')
    warning.classList.add('label', 'legend-keep')
    warning.textContent = '3 cells no value'
    fold.body.append(ramp, name, scale, warning)
    // Open, it carries its title like every card; a detail never joins it, since its lines say what it draws.
    fold.setSummary('ignored')
    expect(fold.el.textContent).toBe('LegendG1Scale: Linear3 cells no value')
    expect(getComputedStyle(summary(fold.el)).display).not.toBe('none')

    button(fold.el).click()
    expect(getComputedStyle(fold.body).display).not.toBe('none')
    expect(getComputedStyle(ramp).display).not.toBe('none')
    expect(getComputedStyle(name).display).not.toBe('none')
    expect(getComputedStyle(scale).display).toBe('none')
    expect(getComputedStyle(warning).display).not.toBe('none')
    // Folded, the ramp and group name say what it is, so the title goes.
    expect(getComputedStyle(summary(fold.el)).display).toBe('none')
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

  it('folds from code and stores it, or opens without storing when told not to remember', () => {
    const fold = renderFold({ key: 'colours', name: 'Colours' })
    expect(fold.chosen()).toBe(false)
    fold.setFolded(true)
    expect(fold.folded()).toBe(true)
    expect(button(fold.el).getAttribute('aria-expanded')).toBe('false')
    expect(localStorage.getItem('pesto.fold.colours')).toBe('folded')
    expect(fold.chosen()).toBe(true)

    const quiet = renderFold({ key: 'overlays', name: 'Overlays', startFolded: true })
    quiet.setFolded(false, { remember: false })
    expect(quiet.folded()).toBe(false)
    expect(quiet.el.getAttribute('data-folded')).toBe('false')
    expect(localStorage.getItem('pesto.fold.overlays')).toBeNull()
    expect(quiet.chosen()).toBe(false)
  })

  it('counts a stored value or a click as chosen', () => {
    localStorage.setItem('pesto.fold.data', 'open')
    expect(renderFold({ key: 'data', name: 'Data' }).chosen()).toBe(true)
    const clicked = renderFold({ key: 'basemap', name: 'Basemap' })
    button(clicked.el).click()
    expect(clicked.chosen()).toBe(true)
  })

  it('tells onUserToggle about a click, with the new state, and not about setFolded', () => {
    const told: boolean[] = []
    const fold = renderFold({ key: 'data', name: 'Data', onUserToggle: (folded) => told.push(folded) })
    button(fold.el).click()
    button(fold.el).click()
    fold.setFolded(true)
    fold.setFolded(false, { remember: false })
    expect(told).toEqual([true, false])
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
    expect(handle.summary()).toBe('At bounds: reading… · Prior-data conflict: reading…')
    handle.setStatus('atBounds', { kind: 'shown', label: 'At bounds: 19 parameters', title: '' })
    handle.setStatus('conflict', { kind: 'off', reason: 'no prior data conflict file' })
    expect(handle.summary()).toBe('At bounds: 19 parameters · Prior-data conflict: no prior data conflict file')
    ;(host.querySelector('[data-overlay="atBounds"]') as HTMLButtonElement).click()
    expect(handle.summary()).toBe('At bounds: 19 parameters (turned off) · Prior-data conflict: no prior data conflict file')
    expect(seen.length).toBeGreaterThanOrEqual(4)
  })
})

describe('keeping the stack in sight', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const stack = () => ['data', 'colours', 'overlays', 'basemap'].map((key) => renderFold({ key, name: key }))
  // Too tall while more than `room` cards are open.
  const openMoreThan = (cards: FoldHandle[], room: number) => () => cards.filter((c) => !c.folded()).length > room

  it('folds the other open cards while the stack is too tall, stores each, and keeps the opened one open', () => {
    const [data, colours, overlays, basemap] = stack()
    basemap.setFolded(true, { remember: false })
    const folded = foldOthersToFit(colours, [data, colours, overlays, basemap], () => true)
    expect(folded).toEqual([overlays, data])
    expect(colours.folded()).toBe(false)
    expect([data, overlays].map((c) => c.folded())).toEqual([true, true])
    expect(localStorage.getItem('pesto.fold.data')).toBe('folded')
    expect(localStorage.getItem('pesto.fold.overlays')).toBe('folded')
    expect(localStorage.getItem('pesto.fold.basemap')).toBeNull()
  })

  it('folds nothing when the stack fits, and stops as soon as it does', () => {
    const cards = stack()
    expect(foldOthersToFit(cards[0], cards, () => false)).toEqual([])
    expect(cards.every((c) => !c.folded())).toBe(true)
    const folded = foldOthersToFit(cards[0], cards, openMoreThan(cards, 2))
    expect(folded).toEqual([cards[3], cards[2]])
    expect(cards.map((c) => c.folded())).toEqual([false, false, true, true])
  })

  it('folds nothing and ends when the opened card is the only one open', () => {
    const cards = stack()
    for (const card of cards.slice(1)) card.setFolded(true)
    expect(foldOthersToFit(cards[0], cards, () => true)).toEqual([])
  })

  it('at first look folds the lowest unchosen cards quietly, never the first, and stops when it fits', () => {
    const cards = stack()
    const folded = settleStack(cards, openMoreThan(cards, 2))
    expect(folded).toEqual([cards[3], cards[2]])
    expect(cards.map((c) => c.folded())).toEqual([false, false, true, true])
    for (const key of ['data', 'colours', 'overlays', 'basemap']) expect(localStorage.getItem(`pesto.fold.${key}`)).toBeNull()
  })

  it('at first look leaves a card the viewer chose, and the first card, open even when nothing fits', () => {
    localStorage.setItem('pesto.fold.overlays', 'open')
    const cards = stack()
    const folded = settleStack(cards, () => true)
    expect(folded).toEqual([cards[3], cards[1]])
    expect(cards.map((c) => c.folded())).toEqual([false, true, false, true])
    expect(cards[1].chosen()).toBe(false)
  })
})
