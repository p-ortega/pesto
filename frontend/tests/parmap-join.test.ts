// The D-05 join: a block row's identity comes from inside the file (its
// control-table row, found through the permutation), never from its
// position in the block. These tests prove the join against a permutation
// that is deliberately not the identity permutation, and against a
// control table whose column order is reversed.

import { tableFromArrays, tableToIPC } from 'apache-arrow'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchParIdentities, joinBlockToIdentity, type ParIdentity } from '../src/data/parmap'

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
