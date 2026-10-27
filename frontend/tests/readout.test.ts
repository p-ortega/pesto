// @vitest-environment jsdom
//
// D-08/D-06's click readout: the value with its full identity, a contested
// cell's every parameter (never one invented colour's worth), a named
// no-parameter case, and a defensive refusal when a row's identity is
// unavailable -- a value with no name is not a readout.

import { describe, expect, it } from 'vitest'
import type { CellClass, ParIdentity } from '../src/data/parmap'
import { renderReadout, type ReadoutPick, type SiteReadoutEntry } from '../src/ui/readout'
import { expectNoRunTogetherText, loadRealStylesheet } from './support/run-together'

function mount(): HTMLElement {
  const el = document.createElement('div')
  document.body.appendChild(el)
  return el
}

const G1: ParIdentity = { parnme: 'par_one', pargp: 'G1', partrans: 'log' }
const G1B: ParIdentity = { parnme: 'par_two', pargp: 'G1', partrans: 'log' }

describe('renderReadout', () => {
  it('before any click, reads the exact copy in muted ink with no icon', () => {
    const el = mount()
    renderReadout(el, { pick: { kind: 'none' }, group: 'G1', joined: [], field: new Float32Array(0) })

    expect(el.textContent).toBe('Click a cell to see its value.')
    expect(el.querySelector('div')?.style.color).toBe('var(--ink-muted)')
    expect(el.querySelectorAll('svg, img').length).toBe(0)
  })

  it('a valued cell renders one row and the footer, synchronously', () => {
    const el = mount()
    const classification: CellClass = { kind: 'valued', row: 0 }
    const pick: ReadoutPick = { kind: 'cell', cellId: 3, layer: 1, selectionLabel: 'r001', classification }
    renderReadout(el, { pick, group: 'G1', joined: [G1], field: new Float32Array([42.5]) })

    expect(el.textContent).toContain('par_one (G1): 42.50')
    expect(el.textContent).toContain('layer 1, cell 3 · r001')
  })

  it('a contested cell renders the title and one row per parameter', () => {
    const el = mount()
    const classification: CellClass = { kind: 'contested', rows: [0, 1] }
    const pick: ReadoutPick = { kind: 'cell', cellId: 0, layer: 0, selectionLabel: 'base', classification }
    renderReadout(el, { pick, group: 'G1', joined: [G1, G1B], field: new Float32Array([1, 2]) })

    expect(el.textContent).toContain('Contested cell')
    expect(el.textContent).toContain('par_one (G1): 1.000')
    expect(el.textContent).toContain('par_two (G1): 2.000')
  })

  it('a contested cell with 25 parameters renders 20 rows and a "+5 more" line, never a silent drop', () => {
    const el = mount()
    const rows = Array.from({ length: 25 }, (_, i) => i)
    const joined = rows.map((i) => ({ parnme: `p${i}`, pargp: 'G1', partrans: 'none' }) as ParIdentity)
    const field = new Float32Array(rows.map((i) => i))
    const classification: CellClass = { kind: 'contested', rows }
    const pick: ReadoutPick = { kind: 'cell', cellId: 0, layer: 0, selectionLabel: 'base', classification }
    renderReadout(el, { pick, group: 'G1', joined, field })

    const bodyRows = Array.from(el.querySelectorAll('.body'))
    expect(bodyRows.length).toBe(20)
    expect(el.textContent).toContain('+5 more')
  })

  it('a cell with no parameter of the drawn group renders the exact copy', () => {
    const el = mount()
    const classification: CellClass = { kind: 'no-parameter' }
    const pick: ReadoutPick = { kind: 'cell', cellId: 2, layer: 0, selectionLabel: 'base', classification }
    renderReadout(el, { pick, group: 'G2', joined: [], field: new Float32Array(0) })

    expect(el.textContent).toContain('No parameter of G2 sits on this cell.')
  })

  it('names what was tried instead of a bare number when the join does not cover a block row', () => {
    const el = mount()
    // A row whose identity is unavailable (permutation pointed outside the
    // table) -- classifyCells never produces this for a valued/contested
    // row, but the readout still refuses to show a bare number defensively.
    const classification: CellClass = { kind: 'valued', row: 0 }
    const pick: ReadoutPick = { kind: 'cell', cellId: 1, layer: 0, selectionLabel: 'base', classification }
    renderReadout(el, { pick, group: 'G1', joined: [null], field: new Float32Array([7]) })

    expect(el.textContent).not.toContain('7.000')
    expect(el.textContent).toMatch(/identity unavailable/i)
    expect(el.textContent).toContain('block row 0')
  })

  it('an outside-the-model cell reads the same no-parameter copy, never an empty panel', () => {
    const el = mount()
    const classification: CellClass = { kind: 'outside-model' }
    const pick: ReadoutPick = { kind: 'cell', cellId: 5, layer: 0, selectionLabel: 'base', classification }
    renderReadout(el, { pick, group: 'G1', joined: [], field: new Float32Array(0) })

    expect(el.textContent).toContain('No parameter of G1 sits on this cell.')
  })

  it('truncates a long parameter or group name and carries the full string in a title', () => {
    const el = mount()
    const longName = 'p'.repeat(120)
    const identity: ParIdentity = { parnme: longName, pargp: 'G1', partrans: 'none' }
    const classification: CellClass = { kind: 'valued', row: 0 }
    const pick: ReadoutPick = { kind: 'cell', cellId: 0, layer: 0, selectionLabel: 'base', classification }
    renderReadout(el, { pick, group: 'G1', joined: [identity], field: new Float32Array([1]) })

    const row = el.querySelector('.truncate') as HTMLElement
    expect(row.classList.contains('truncate')).toBe(true)
    expect(row.title).toContain(longName)
  })

  it('renders through textContent alone, never innerHTML, for a name carrying markup', () => {
    const el = mount()
    const identity: ParIdentity = { parnme: '<img src=x onerror=alert(1)>', pargp: 'G1', partrans: 'none' }
    const classification: CellClass = { kind: 'valued', row: 0 }
    const pick: ReadoutPick = { kind: 'cell', cellId: 0, layer: 0, selectionLabel: 'base', classification }
    renderReadout(el, { pick, group: 'G1', joined: [identity], field: new Float32Array([1]) })

    expect(el.querySelector('img')).toBeNull()
    expect(el.textContent).toContain('<img src=x onerror=alert(1)>')
  })

  it('an interpolated cell shows its value, the point count, and the largest three contributors', () => {
    const el = document.createElement('div')
    renderReadout(el, {
      pick: { kind: 'cell', cellId: 4, layer: 0, selectionLabel: 'base', classification: { kind: 'interpolated' } },
      group: 'npfklayer1pp',
      joined: [],
      field: new Float32Array(0),
      interpolated: {
        value: 1.5,
        nPoints: 20,
        contributors: [
          { parnme: 'a', weight: 0.5 },
          { parnme: 'b', weight: 0.3 },
          { parnme: 'c', weight: 0.1 },
          { parnme: 'd', weight: 0.1 },
        ],
      },
    })
    const text = el.textContent ?? ''
    expect(text).toContain('npfklayer1pp: 1.500')
    expect(text).toContain('layer 0, cell 4 · base')
    expect(text).toContain('Interpolated from 20 pilot points')
    expect(text).toContain('a (weight 0.50)')
    expect(text).not.toContain('d (weight')
  })

  it('an interpolated cell says it is still loading its contributors while they are null', () => {
    const el = document.createElement('div')
    renderReadout(el, {
      pick: { kind: 'cell', cellId: 4, layer: 0, selectionLabel: 'base', classification: { kind: 'interpolated' } },
      group: 'npfklayer1pp',
      joined: [],
      field: new Float32Array(0),
      interpolated: { value: 1.5, nPoints: 20, contributors: null },
    })
    expect(el.textContent).toContain('Loading the points behind this cell…')
  })

  it('an interpolated cell says so when its contributors could not be read', () => {
    const el = document.createElement('div')
    renderReadout(el, {
      pick: { kind: 'cell', cellId: 4, layer: 0, selectionLabel: 'base', classification: { kind: 'interpolated' } },
      group: 'npfklayer1pp',
      joined: [],
      field: new Float32Array(0),
      interpolated: { value: 1.5, nPoints: 20, contributors: { failed: 'contributors are only read from text factor files' } },
    })
    expect(el.textContent).toContain('The points behind this cell could not be listed: contributors are only read from text factor files')
  })

  it('a point pick renders the identity line and the position footer', () => {
    const el = mount()
    const pick: ReadoutPick = { kind: 'point', row: 0, layer: 0, x: 10, y: 0, selectionLabel: 'base' }
    renderReadout(el, { pick, group: 'G1', joined: [G1], field: new Float32Array([42.5]) })

    expect(el.textContent).toContain('par_one (G1): 42.50')
    expect(el.textContent).toContain('x 10, y 0 · layer 0 · base')
  })

  it('a point pick prints world coordinates at a large northing without losing the metre', () => {
    const el = mount()
    const pick: ReadoutPick = { kind: 'point', row: 0, layer: 0, x: 712345.25, y: 7019873.75, selectionLabel: 'base' }
    renderReadout(el, { pick, group: 'G1', joined: [G1], field: new Float32Array([42.5]) })

    expect(el.textContent).toContain('x 712345, y 7019874 · layer 0 · base')
  })

  describe('sites', () => {
    const site = (over: Partial<SiteReadoutEntry> = {}): SiteReadoutEntry => ({
      name: 'well_a',
      group: 'heads',
      x: 512300,
      y: 7020100,
      xySource: 'own',
      layer: 3,
      cell: 42,
      rule: 'mf6-obs',
      timeText: 'day 120',
      observed: { kind: 'value', value: 12.5 },
      stat: { label: 'Residual', value: 0.25, iteration: 1 },
      ...over,
    })
    const render = (entries: SiteReadoutEntry[], total = entries.length): HTMLElement => {
      const el = mount()
      renderReadout(el, { pick: { kind: 'sites', entries, total }, group: '', joined: [], field: new Float32Array(0) })
      return el
    }
    const lines = (el: HTMLElement) => Array.from(el.querySelectorAll('div > div')).map((d) => d.textContent)

    it('lists two stacked sites, each with every part of its block', () => {
      const el = render([site(), site({ name: 'well_b', xySource: 'cell_centre', layer: null })])
      expect(el.textContent).toContain('2 sites at this spot')
      expect(el.textContent).toContain('well_a (heads)')
      expect(el.textContent).toContain('well_b (heads)')
      expect(el.textContent).toContain('x 512300, y 7020100 (own coordinates)')
      expect(el.textContent).toContain("x 512300, y 7020100 (centre of the cell's vertices)")
      expect(el.textContent).toContain('layer 3, cell 42 · placed by mf6-obs')
      expect(el.textContent).toContain('layer unknown, cell 42 · placed by mf6-obs')
      expect(el.textContent).toContain('day 120')
      expect(el.textContent).toContain('observed 12.50')
      expect(el.textContent).toContain('Residual, iteration 1: 0.2500')
    })

    it('one site shows the full block with no heading', () => {
      const el = render([site()])
      expect(el.textContent).not.toContain('sites at this spot')
      expect(el.textContent).toContain('well_a (heads)')
    })

    it('names the zero-weight case as a model output, not fitted', () => {
      const el = render([site({ observed: { kind: 'zero_weight', value: 2.5 } })])
      expect(el.textContent).toContain('observed 2.500 — zero weight: a model output, not fitted')
    })

    it('says no measured value, no observation at this time, and reading in muted ink', () => {
      expect(render([site({ observed: { kind: 'no_value' } })]).textContent).toContain('no measured value')
      expect(render([site({ observed: { kind: 'no_observation' } })]).textContent).toContain('no observation at this time')
      const el = render([site({ observed: { kind: 'loading' } })])
      const line = lines(el).findIndex((t) => t === 'reading the observed value…')
      expect(line).toBeGreaterThanOrEqual(0)
      const div = Array.from(el.querySelectorAll('div > div')).find((d) => d.textContent === 'reading the observed value…')
      expect((div as HTMLElement).style.color).toBe('var(--ink-muted)')
    })

    it('a null statistic reads no value at this time', () => {
      const el = render([site({ stat: { label: 'Residual', value: null, iteration: 2 } })])
      expect(el.textContent).toContain('Residual, iteration 2: no value at this time')
    })

    it('25 sites show 20 blocks and say how many are not listed', () => {
      const entries = Array.from({ length: 25 }, (_, i) => site({ name: `w${i}` }))
      const el = render(entries)
      expect(el.textContent).toContain('25 sites at this spot')
      expect(el.querySelectorAll('.truncate[title^="w"]').length).toBe(20)
      expect(el.textContent).toContain('w19 (heads)')
      expect(el.textContent).not.toContain('w20 (heads)')
      expect(el.textContent).toContain('5 more sites here are not listed')
    })

    it('a long name with markup is plain text, cut by css, with the full name in the title', () => {
      const name = `<b>${'x'.repeat(125)}</b>`
      expect(name.length).toBe(132)
      const el = render([site({ name, group: '<i>g</i>' })])
      expect(el.querySelector('b, i')).toBeNull()
      const line = el.querySelector('.truncate') as HTMLElement
      expect(line.title).toBe(name)
      expect(line.textContent).toContain(name)
    })

    it('no two lines run together', () => {
      loadRealStylesheet()
      const el = render([site(), site({ name: 'well_b', observed: { kind: 'no_value' } })])
      expectNoRunTogetherText(el, 'sites readout')
    })
  })
})
