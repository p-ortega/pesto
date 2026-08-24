// The D-05 join: a block row's identity comes from inside the file (its
// control-table row, found through the permutation), never from its
// position in the block. These tests prove the join against a permutation
// that is deliberately not the identity permutation, and against a
// control table whose column order is reversed.

import { tableFromArrays, tableToIPC } from 'apache-arrow'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { classifyCells, fetchParIdentities, joinBlockToIdentity, type ParIdentity } from '../src/data/parmap'

vi.mock('../src/data/client', () => ({
  runMeta: vi.fn(),
  gridParmap: vi.fn(),
}))

describe('joinBlockToIdentity', () => {
  it('maps block row i to the identity at control row parmap[i], not identity[i]', () => {
    // A permutation that is deliberately not the identity permutation: block
    // row 0 comes from control row 2, block row 1 from control row 0, block
    // row 2 from control row 1.
    const parmap = new Int32Array([2, 0, 1])
    const identities: ParIdentity[] = [
      { parnme: 'p0', pargp: 'G1', partrans: 'log' },
      { parnme: 'p1', pargp: 'G1', partrans: 'log' },
      { parnme: 'p2', pargp: 'G2', partrans: 'none' },
    ]

    const joined = joinBlockToIdentity(parmap, identities)

    expect(joined).toEqual([
      { parnme: 'p2', pargp: 'G2', partrans: 'none' },
      { parnme: 'p0', pargp: 'G1', partrans: 'log' },
      { parnme: 'p1', pargp: 'G1', partrans: 'log' },
    ])
  })

  it('records a block row as unidentifiable, never a guess, when parmap points outside the table', () => {
    const parmap = new Int32Array([0, 99, -1])
    const identities: ParIdentity[] = [{ parnme: 'p0', pargp: 'G1', partrans: 'log' }]

    const joined = joinBlockToIdentity(parmap, identities)

    expect(joined).toEqual([{ parnme: 'p0', pargp: 'G1', partrans: 'log' }, null, null])
  })
})

// D-06's four marks, classified from the join and the block-order
// cell/layer companions -- never from a value, since classifyCells is
// never given one.
describe('classifyCells', () => {
  const G1: ParIdentity = { parnme: 'p1', pargp: 'G1', partrans: 'log' }
  const G1B: ParIdentity = { parnme: 'p2', pargp: 'G1', partrans: 'log' }
  const G2: ParIdentity = { parnme: 'p3', pargp: 'G2', partrans: 'none' }

  it('classifies a cell with one row of the drawn group as valued, one with two as contested, one with none as no-parameter, and one never referenced as outside the model', () => {
    // cell 0: p1 (G1) alone -- valued. cell 1: p1B, p2 both G1 -- contested.
    // cell 2: only G2's row -- in the model, no G1 row -- no-parameter.
    // cell 3: referenced by nothing -- outside the model.
    const joined = [G1, G1B, G1, G2]
    const cells = new Int32Array([0, 1, 1, 2])
    const layers = new Int32Array([0, 0, 0, 0])

    const result = classifyCells(joined, cells, layers, 'G1', 0, 4)

    expect(result.classes[0]).toEqual({ kind: 'valued', row: 0 })
    expect(result.classes[1]).toEqual({ kind: 'contested', rows: [1, 2] })
    expect(result.classes[2]).toEqual({ kind: 'no-parameter' })
    expect(result.classes[3]).toEqual({ kind: 'outside-model' })
    expect(result.contestedCount).toBe(1)
    expect(result.noValueCount).toBe(1)
  })

  it('marks two rows of the drawn group on the same cell and layer as contested, never averaged or first-wins', () => {
    const joined = [G1, G1B]
    const cells = new Int32Array([5, 5])
    const layers = new Int32Array([1, 1])

    const result = classifyCells(joined, cells, layers, 'G1', 1, 6)

    expect(result.classes[5]).toEqual({ kind: 'contested', rows: [0, 1] })
    // Never resolved to a single "valued" row for a contested cell.
    expect(result.classes[5]).not.toHaveProperty('row')
  })

  it('keeps both rows and their block-scan order even when their values would compare equal -- equality is never a tiebreak', () => {
    // classifyCells never sees a value at all, so two rows that would
    // compare exactly equal classify no differently than any other pair --
    // this proves the rows are kept in scan order, not reordered or deduped.
    const joined = [G1B, G1]
    const cells = new Int32Array([2, 2])
    const layers = new Int32Array([0, 0])

    const result = classifyCells(joined, cells, layers, 'G1', 0, 3)

    expect(result.classes[2]).toEqual({ kind: 'contested', rows: [0, 1] })
  })

  it('classifies a cell in the grid with no row of the chosen group as no-parameter, distinct from outside-the-model', () => {
    // cell 1 carries a G2 row -- it is active, just not in G1 (the drawn
    // group). cell 2 carries no row of any group -- outside the model.
    const joined = [G1, G2]
    const cells = new Int32Array([0, 1])
    const layers = new Int32Array([0, 0])

    const result = classifyCells(joined, cells, layers, 'G1', 0, 3)

    expect(result.classes[1]).toEqual({ kind: 'no-parameter' })
    expect(result.classes[2]).toEqual({ kind: 'outside-model' })
  })
})

describe('fetchParIdentities', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('reads parnme, pargp and partrans by field name, even with the column order reversed', async () => {
    // The control table's column order is the control file's own order and
    // nothing sorts it -- this table is built with a reversed column order
    // on purpose, so a positional reader would silently swap the fields.
    const table = tableFromArrays({
      partrans: ['log', 'none'],
      pargp: ['G1', 'G2'],
      parnme: ['p1', 'p2'],
    })
    const bytes = tableToIPC(table, 'stream')

    const client = await import('../src/data/client')
    vi.mocked(client.runMeta).mockResolvedValue(bytes.buffer as ArrayBuffer)

    const identities = await fetchParIdentities()

    expect(identities).toEqual([
      { parnme: 'p1', pargp: 'G1', partrans: 'log' },
      { parnme: 'p2', pargp: 'G2', partrans: 'none' },
    ])
  })
})
