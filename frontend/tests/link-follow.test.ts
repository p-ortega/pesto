import { describe, expect, it } from 'vitest'
import { selectedDotIndices } from '../src/data/link-follow'

describe('selectedDotIndices', () => {
  const siteOf = (row: number): number => 100 + row

  it('gives the dots whose site is selected, ascending', () => {
    const rows = Int32Array.from([4, 0, 2, 7])
    expect(selectedDotIndices(rows, siteOf, new Set([107, 100]))).toEqual([1, 3])
  })

  it('gives nothing for an empty selection', () => {
    expect(selectedDotIndices(Int32Array.from([0, 1]), siteOf, new Set())).toEqual([])
  })

  it('matches names as written, and never a dot with no name', () => {
    const names: Array<string | null> = ['pa', null, 'PB', 'pb']
    expect(selectedDotIndices([0, 1, 2, 3], (row) => names[row], new Set(['pb', 'pa']))).toEqual([0, 3])
  })

  it('marks every dot of a stacked site', () => {
    expect(selectedDotIndices([5, 5, 6], siteOf, new Set([105]))).toEqual([0, 1])
  })
})
