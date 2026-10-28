// The lasso hit test (D-12): a Flatbush box search, then the exact even-odd
// crossing test, with hits in ascending dot order.

import { describe, expect, it } from 'vitest'
import { MIN_LASSO_POINTS, buildDotIndex, dotsInPolygon, pointInPolygon, thinPath } from '../src/data/lasso'

type Poly = [number, number][]

// Five dots; 1 and 3 sit inside the unit square around (5, 5).
const FIVE = Float32Array.from([0, 0, 5, 5, 10, 10, 5.5, 4.5, 20, 0])
const SQUARE: Poly = [
  [4, 4],
  [6, 4],
  [6, 6],
  [4, 6],
]

describe('buildDotIndex and dotsInPolygon', () => {
  it('builds no index for no dots, and an absent index catches nothing', () => {
    expect(buildDotIndex(new Float32Array(0))).toBeNull()
    expect(dotsInPolygon(null, new Float32Array(0), SQUARE)).toEqual([])
  })

  it('returns the dots inside a square, the same either way round', () => {
    const tree = buildDotIndex(FIVE)
    expect(dotsInPolygon(tree, FIVE, SQUARE)).toEqual([1, 3])
    expect(dotsInPolygon(tree, FIVE, [...SQUARE].reverse())).toEqual([1, 3])
  })

  it('catches nothing with fewer than three points', () => {
    const tree = buildDotIndex(FIVE)
    expect(MIN_LASSO_POINTS).toBe(3)
    expect(
      dotsInPolygon(tree, FIVE, [
        [4, 4],
        [6, 6],
      ]),
    ).toEqual([])
  })

  it('uses the even-odd rule on a figure-eight, catching a dot in either lobe', () => {
    // Crosses itself at (2, 1): the left lobe holds (1, 1), the right lobe (3, 1).
    const eight: Poly = [
      [0, 0],
      [4, 2],
      [4, 0],
      [0, 2],
    ]
    const xy = Float32Array.from([1, 1, 3, 1, 2, 3])
    expect(dotsInPolygon(buildDotIndex(xy), xy, eight)).toEqual([0, 1])
  })

  it('gives a dot on the edge two squares share to exactly one of them', () => {
    const left: Poly = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ]
    const right: Poly = [
      [1, 0],
      [2, 0],
      [2, 1],
      [1, 1],
    ]
    const below: Poly = [
      [0, -1],
      [1, -1],
      [1, 0],
      [0, 0],
    ]
    // One dot on the shared vertical edge, one on the shared horizontal edge.
    const xy = Float32Array.from([1, 0.5, 0.5, 0])
    const tree = buildDotIndex(xy)
    const inLeft = dotsInPolygon(tree, xy, left)
    const inRight = dotsInPolygon(tree, xy, right)
    const inBelow = dotsInPolygon(tree, xy, below)
    expect(inLeft.includes(0) !== inRight.includes(0)).toBe(true)
    expect(inLeft.includes(1) !== inBelow.includes(1)).toBe(true)
  })

  it('returns hits in ascending dot order whatever the index hands back', () => {
    // Dots laid out so the tree's own order is not the index order.
    const n = 200
    const xy = new Float32Array(2 * n)
    for (let i = 0; i < n; i++) {
      xy[2 * i] = (i * 37) % 50
      xy[2 * i + 1] = (i * 53) % 50
    }
    const box: Poly = [
      [-1, -1],
      [51, -1],
      [51, 51],
      [-1, 51],
    ]
    const hits = dotsInPolygon(buildDotIndex(xy), xy, box)
    expect(hits).toHaveLength(n)
    expect(hits).toEqual([...hits].sort((a, b) => a - b))
  })

  it('handles 9,000 dots and a 400-point polygon in under 50 ms', () => {
    const n = 9000
    const xy = new Float32Array(2 * n)
    for (let i = 0; i < n; i++) {
      xy[2 * i] = (i % 100) / 100
      xy[2 * i + 1] = Math.floor(i / 100) / 90
    }
    const circle: Poly = []
    for (let k = 0; k < 400; k++) {
      const t = (2 * Math.PI * k) / 400
      circle.push([0.5 + 0.4 * Math.cos(t), 0.5 + 0.4 * Math.sin(t)])
    }
    const tree = buildDotIndex(xy)
    const start = performance.now()
    const hits = dotsInPolygon(tree, xy, circle)
    const elapsed = performance.now() - start
    expect(hits.length).toBeGreaterThan(0)
    expect(elapsed).toBeLessThan(50)
  })
})

describe('pointInPolygon', () => {
  it('is false for fewer than three points', () => {
    expect(
      pointInPolygon(0, 0, [
        [-1, -1],
        [1, 1],
      ]),
    ).toBe(false)
  })

  it('is true inside a triangle and false outside it', () => {
    const tri: Poly = [
      [0, 0],
      [4, 0],
      [0, 4],
    ]
    expect(pointInPolygon(1, 1, tri)).toBe(true)
    expect(pointInPolygon(3, 3, tri)).toBe(false)
  })
})

describe('thinPath', () => {
  it('drops points closer than the spacing to the last kept one, keeping both ends', () => {
    const path: Poly = [
      [0, 0],
      [1, 0],
      [2, 0],
      [3.5, 0],
      [4, 0],
      [4.5, 0],
    ]
    expect(thinPath(path, 3)).toEqual([
      [0, 0],
      [3.5, 0],
      [4.5, 0],
    ])
  })

  it('keeps a path of one or two points as it is', () => {
    expect(thinPath([[1, 1]], 3)).toEqual([[1, 1]])
    expect(
      thinPath(
        [
          [0, 0],
          [0.1, 0],
        ],
        3,
      ),
    ).toEqual([
      [0, 0],
      [0.1, 0],
    ])
    expect(thinPath([], 3)).toEqual([])
  })
})
