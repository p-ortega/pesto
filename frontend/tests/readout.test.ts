// @vitest-environment jsdom
//
// D-08/D-06's click readout: the value with its full identity, a contested
// cell's every parameter (never one invented colour's worth), a named
// no-parameter case, and a defensive refusal when a row's identity is
// unavailable -- a value with no name is not a readout.

import { describe, expect, it } from 'vitest'
import type { CellClass, ParIdentity } from '../src/data/parmap'
import { renderReadout, type ReadoutPick } from '../src/ui/readout'

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
})
