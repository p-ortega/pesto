import { describe, expect, it } from 'vitest'
import { inactiveLandingNotes, layerActiveMask, referencedMask } from '../src/data/domain'

describe('layerActiveMask', () => {
  it('reads the drawn layer only, with 0 and -1 both outside the model', () => {
    const idomain = new Int32Array([1, 0, -1, /* layer 1 */ 0, 1, 2])
    expect(Array.from(layerActiveMask(idomain, 3, 0))).toEqual([1, 0, 0])
    expect(Array.from(layerActiveMask(idomain, 3, 1))).toEqual([0, 1, 1])
  })
})

describe('referencedMask', () => {
  it('marks every cell a block row names, ignoring -1 and out-of-range cells', () => {
    expect(Array.from(referencedMask(new Int32Array([2, -1, 0, 9]), 3))).toEqual([1, 0, 1])
  })
})

describe('inactiveLandingNotes', () => {
  it('counts each group’s parameters on inactive cells and names the group', () => {
    const joined = [
      { parnme: 'a', pargp: 'k', partrans: 'log' },
      { parnme: 'b', pargp: 'k', partrans: 'log' },
      { parnme: 'c', pargp: 'ss', partrans: 'log' },
    ]
    const idomain = new Int32Array([1, 0, 1, 1])
    const notes = inactiveLandingNotes(joined, new Int32Array([1, 0, 1]), new Int32Array([0, 0, 1]), idomain, 2)
    expect(notes).toEqual([
      'k: 1 parameter(s) sit on cells the grid file marks inactive (idomain 0 or less); they are still drawn',
    ])
  })
})
