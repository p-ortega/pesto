// The chart kit's marks, checked by the calls they make on a recording 2D
// context. Nothing here renders a pixel.

import { describe, expect, it } from 'vitest'
import {
  drawBand,
  drawCursor,
  drawDiagonal,
  drawMarkers,
  drawPolyline,
  drawRangeBars,
} from '../src/ui/charts/marks'
import { createRecording2d, type RecordedCall } from './support/recording-2d'

function methods(calls: RecordedCall[]): string[] {
  return calls.map((c) => c.method).filter((m) => !m.startsWith('set:'))
}

describe('drawMarkers', () => {
  it('fills a weighted marker and only strokes a hollow one', () => {
    const { ctx, calls } = createRecording2d()
    const skipped = drawMarkers(
      ctx,
      [
        { x: 10, y: 10, hollow: false },
        { x: 30, y: 10, hollow: true },
      ],
      { shape: 'circle', radius: 4, colour: 'tok-series-1' },
    )
    expect(skipped).toBe(0)
    const arcs = calls.filter((c) => c.method === 'arc')
    expect(arcs).toHaveLength(2)
    const seq = methods(calls)
    const first = seq.indexOf('arc')
    const second = seq.indexOf('arc', first + 1)
    expect(seq.slice(first, first + 3)).toEqual(['arc', 'fill', 'stroke'])
    expect(seq.slice(second)).toEqual(['arc', 'stroke', 'restore'])
    const fills = calls.filter((c) => c.method === 'fill')
    expect(fills).toHaveLength(1)
    expect(fills[0].state.fillStyle).toBe('tok-series-1')
    const strokes = calls.filter((c) => c.method === 'stroke')
    expect(strokes[1].state.strokeStyle).toBe('tok-series-1')
    expect(strokes[1].state.lineWidth).toBe(1.5)
  })

  it('draws a rect rather than an arc for the square shape', () => {
    const { ctx, calls } = createRecording2d()
    drawMarkers(ctx, [{ x: 20, y: 20, hollow: false }], {
      shape: 'square',
      radius: 3,
      colour: 'tok-series-2',
    })
    expect(calls.filter((c) => c.method === 'arc')).toHaveLength(0)
    expect(calls.find((c) => c.method === 'rect')!.args).toEqual([17, 17, 6, 6])
  })

  it('skips a point with a non-finite position and counts it', () => {
    const { ctx, calls } = createRecording2d()
    const skipped = drawMarkers(
      ctx,
      [
        { x: Number.NaN, y: 5, hollow: false },
        { x: 5, y: 5, hollow: false },
        { x: 5, y: Number.POSITIVE_INFINITY, hollow: true },
      ],
      { shape: 'circle', radius: 4, colour: 'c' },
    )
    expect(skipped).toBe(2)
    expect(calls.filter((c) => c.method === 'arc')).toHaveLength(1)
  })
})

describe('drawPolyline', () => {
  it('never draws a segment into or out of a missing value', () => {
    const { ctx, calls } = createRecording2d()
    const breaks = drawPolyline(ctx, [0, 1, 2, 3, 4], [1, 2, Number.NaN, 4, 5], {
      colour: 'c',
      width: 2,
    })
    expect(breaks).toBe(1)
    const path = calls.filter((c) => c.method === 'moveTo' || c.method === 'lineTo')
    expect(path.map((c) => [c.method, ...(c.args as number[])])).toEqual([
      ['moveTo', 0, 1],
      ['lineTo', 1, 2],
      ['moveTo', 3, 4],
      ['lineTo', 4, 5],
    ])
  })

  it('does not count leading missing values as a break', () => {
    const { ctx } = createRecording2d()
    const breaks = drawPolyline(ctx, [0, 1, 2], [Number.NaN, 1, 2], { colour: 'c', width: 1 })
    expect(breaks).toBe(0)
  })
})

describe('drawBand', () => {
  it('fills one polygon each side of a gap', () => {
    const { ctx, calls } = createRecording2d()
    drawBand(ctx, [0, 1, 2, 3], [0, 0, null, 0], [1, 1, null, 1], 'tok-band', 0.3)
    expect(calls.filter((c) => c.method === 'fill')).toHaveLength(2)
    expect(calls.filter((c) => c.method === 'closePath')).toHaveLength(2)
    const fill = calls.find((c) => c.method === 'fill')!
    expect(fill.state.fillStyle).toBe('tok-band')
    expect(fill.state.globalAlpha).toBe(0.3)
    // No lineTo reaches the x of the missing point.
    const xsDrawn = calls.filter((c) => c.method === 'lineTo' || c.method === 'moveTo').map((c) => c.args[0])
    expect(xsDrawn).not.toContain(2)
  })

  it('breaks at a non-finite bound too', () => {
    const { ctx, calls } = createRecording2d()
    drawBand(ctx, [0, 1, 2], [0, Number.NaN, 0], [1, 1, 1], 'c', 0.3)
    expect(calls.filter((c) => c.method === 'fill')).toHaveLength(2)
  })
})

describe('drawRangeBars', () => {
  it('draws one vertical segment per bar from low to high', () => {
    const { ctx, calls } = createRecording2d()
    drawRangeBars(
      ctx,
      [
        { x: 10, low: 50, high: 20 },
        { x: 30, low: 60, high: 40 },
      ],
      { colour: 'c', width: 1 },
    )
    const path = calls.filter((c) => c.method === 'moveTo' || c.method === 'lineTo')
    expect(path.map((c) => [c.method, ...(c.args as number[])])).toEqual([
      ['moveTo', 10, 50],
      ['lineTo', 10, 20],
      ['moveTo', 30, 60],
      ['lineTo', 30, 40],
    ])
  })
})

describe('drawCursor and drawDiagonal', () => {
  it('draws one vertical line from top to bottom at x', () => {
    const { ctx, calls } = createRecording2d()
    drawCursor(ctx, 120, 10, 200, 'tok-ink')
    const path = calls.filter((c) => c.method === 'moveTo' || c.method === 'lineTo')
    expect(path.map((c) => [c.method, ...(c.args as number[])])).toEqual([
      ['moveTo', 120, 10],
      ['lineTo', 120, 200],
    ])
    expect(calls.find((c) => c.method === 'stroke')!.state.strokeStyle).toBe('tok-ink')
  })

  it('draws a cursor at a non-finite x as nothing', () => {
    const { ctx, calls } = createRecording2d()
    drawCursor(ctx, Number.NaN, 10, 200, 'c')
    expect(calls).toHaveLength(0)
  })

  it('draws a line between the two given points', () => {
    const { ctx, calls } = createRecording2d()
    drawDiagonal(ctx, [0, 100], [100, 0], 'tok-axis')
    const path = calls.filter((c) => c.method === 'moveTo' || c.method === 'lineTo')
    expect(path.map((c) => c.args)).toEqual([
      [0, 100],
      [100, 0],
    ])
  })
})
