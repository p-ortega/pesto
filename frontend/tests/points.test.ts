import { afterEach, describe, expect, it, vi } from 'vitest'
import { gridPointXy } from '../src/data/client'
import { isPointGroup, pickPoint, pickPointsWithin, pointsOnLayer } from '../src/data/points'

const id = (parnme: string, pargp: string) => ({ parnme, pargp, partrans: 'log' })
const joined = [id('a', 'k'), id('b', 'k'), id('c', 'k'), id('d', 'ss')]
const xy = new Float32Array([0, 0, 10, 0, 5, 5, Number.NaN, Number.NaN])
const layers = new Int32Array([0, 0, 1, 0])

describe('isPointGroup', () => {
  it('is true for a group with a finite position and false otherwise', () => {
    expect(isPointGroup(joined, xy, 'k')).toBe(true)
    expect(isPointGroup(joined, xy, 'ss')).toBe(false)
    expect(isPointGroup(joined, null, 'k')).toBe(false)
  })
})

describe('pointsOnLayer', () => {
  it('keeps only the drawn group on the drawn layer, in block order', () => {
    const p = pointsOnLayer(joined, layers, xy, 'k', 0)
    expect(Array.from(p.rows)).toEqual([0, 1])
    expect(Array.from(p.xy)).toEqual([0, 0, 10, 0])
  })
})

describe('pickPoint', () => {
  const p = pointsOnLayer(joined, layers, xy, 'k', 0)
  it('returns the nearest point, not the first one', () => {
    expect(pickPoint(p, 9, 0, 3)).toBe(1)
  })
  it('returns null when nothing is close enough', () => {
    expect(pickPoint(p, 5, 0, 3)).toBeNull()
  })
})

describe('pickPointsWithin', () => {
  const stacked = { rows: Int32Array.from([0, 1, 2]), xy: new Float32Array([0, 0, 0, 0, 5, 0]) }
  it('returns both of two dots at the same position, never just one', () => {
    expect(pickPointsWithin(stacked, 0.1, 0, 1)).toEqual([0, 1])
  })
  it('lists every dot in reach, nearest first and equal distances by index', () => {
    expect(pickPointsWithin(stacked, 0.1, 0, 10)).toEqual([0, 1, 2])
    expect(pickPointsWithin(stacked, 4, 0, 10)).toEqual([2, 0, 1])
  })
  it('returns an empty list when nothing is in reach', () => {
    expect(pickPointsWithin(stacked, 2.5, 3, 1)).toEqual([])
  })
})

describe('gridPointXy', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('is null when the server says no positions were recorded, and re-throws other errors', async () => {
    const problem = (title: string) =>
      new Response(JSON.stringify({ type: 'x', title, status: 404 }), { status: 404 })
    vi.stubGlobal('fetch', async () => problem('no point positions were recorded for that iteration'))
    expect(await gridPointXy(0)).toBeNull()
    vi.stubGlobal('fetch', async () => problem('something else'))
    await expect(gridPointXy(0)).rejects.toThrow('something else')
  })
})
