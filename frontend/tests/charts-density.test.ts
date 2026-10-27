// The density panel on a recording 2D context: bin placement, the log
// shading, the shared range, and every refusal.

import { describe, expect, it } from 'vitest'
import { densityPlotArea, drawDensity, type DensitySpec } from '../src/ui/charts/density'
import type { ChartTokens } from '../src/ui/charts/tokens'
import { createRecording2d } from './support/recording-2d'

const TOKENS: ChartTokens = {
  axis: 'tok-axis',
  gridline: 'tok-gridline',
  inkPrimary: 'tok-ink-primary',
  inkMuted: 'tok-ink-muted',
  series1: 'tok-series-1',
  series2: 'tok-series-2',
}
const SIZE = { width: 400, height: 340 }

function spec(overrides: Partial<DensitySpec> = {}): DensitySpec {
  const counts = new Array<number>(16).fill(0)
  counts[0] = 1 // ix 0, iy 0
  counts[3 * 4 + 3] = 9 // ix 3, iy 3
  return {
    nBins: 4,
    counts,
    lo: 0,
    hi: 40,
    shadeMax: 9,
    title: 'gw_head, iteration 3',
    xLabel: 'observed',
    yLabel: 'simulated',
    ...overrides,
  }
}

describe('drawDensity', () => {
  it('fills one rect per non-empty bin, with (0, 0) bottom left and (3, 3) top right', () => {
    const { ctx, calls } = createRecording2d()
    expect(drawDensity(ctx, spec(), TOKENS, SIZE)).toBe(true)
    const area = densityPlotArea(SIZE)
    const cell = area.width / 4
    const rects = calls.filter((c) => c.method === 'fillRect')
    expect(rects).toHaveLength(2)
    const [low, high] = rects.map((r) => r.args as number[])
    expect(low).toEqual([area.left, area.top + area.height - cell, cell, cell])
    expect(high).toEqual([area.left + 3 * cell, area.top, cell, cell])
  })

  it('reads counts as iy * nBins + ix, so iy runs up the plot', () => {
    const counts = new Array<number>(16).fill(0)
    counts[3 * 4 + 1] = 5 // ix 1, iy 3
    const { ctx, calls } = createRecording2d()
    drawDensity(ctx, spec({ counts }), TOKENS, SIZE)
    const area = densityPlotArea(SIZE)
    const cell = area.width / 4
    const rect = calls.find((c) => c.method === 'fillRect')!.args as number[]
    expect(rect[0]).toBe(area.left + cell)
    expect(rect[1]).toBe(area.top)
  })

  it('gives the larger count the larger alpha, on log(1 + count) / log(1 + shadeMax)', () => {
    const { ctx, calls } = createRecording2d()
    drawDensity(ctx, spec(), TOKENS, SIZE)
    const [low, high] = calls.filter((c) => c.method === 'fillRect')
    expect(low.state.fillStyle).toBe('tok-ink-primary')
    expect(low.state.globalAlpha).toBeCloseTo(Math.log1p(1) / Math.log1p(9), 12)
    expect(high.state.globalAlpha).toBeCloseTo(1, 12)
    expect(high.state.globalAlpha).toBeGreaterThan(low.state.globalAlpha)
  })

  it('shares one shade top between panels, so the same count has the same alpha', () => {
    const a = createRecording2d()
    const b = createRecording2d()
    const smaller = new Array<number>(16).fill(0)
    smaller[0] = 1
    drawDensity(a.ctx, spec({ shadeMax: 100 }), TOKENS, SIZE)
    drawDensity(b.ctx, spec({ counts: smaller, shadeMax: 100 }), TOKENS, SIZE)
    const alphaA = a.calls.find((c) => c.method === 'fillRect')!.state.globalAlpha
    const alphaB = b.calls.find((c) => c.method === 'fillRect')!.state.globalAlpha
    expect(alphaA).toBe(alphaB)
  })

  it('draws nothing for an empty bin', () => {
    const { ctx, calls } = createRecording2d()
    drawDensity(ctx, spec({ counts: new Array<number>(16).fill(0), shadeMax: 0 }), TOKENS, SIZE)
    expect(calls.filter((c) => c.method === 'fillRect')).toHaveLength(0)
  })

  it('draws the 1:1 line from the bottom left to the top right of the plot area', () => {
    const { ctx, calls } = createRecording2d()
    drawDensity(ctx, spec(), TOKENS, SIZE)
    const area = densityPlotArea(SIZE)
    const path = calls
      .filter((c) => c.method === 'moveTo' || c.method === 'lineTo')
      .map((c) => c.args as number[])
    expect(path[0]).toEqual([area.left, area.top + area.height])
    expect(path[1]).toEqual([area.left + area.width, area.top])
  })

  it('puts the same tick values on x and y and draws both labels as text', () => {
    const { ctx, calls } = createRecording2d()
    drawDensity(ctx, spec(), TOKENS, SIZE)
    const area = densityPlotArea(SIZE)
    const texts = calls.filter((c) => c.method === 'fillText').map((c) => c.args as [string, number, number])
    const onX = texts.filter(([, , y]) => y === area.top + area.height + 4).map(([t]) => t)
    const onY = texts.filter(([, x]) => x === area.left - 6).map(([t]) => t)
    expect(onX.length).toBeGreaterThan(1)
    expect(onX).toEqual(onY)
    const words = texts.map(([t]) => t)
    expect(words).toContain('observed')
    expect(words).toContain('simulated')
    expect(words).toContain('gw_head, iteration 3')
  })

  it('refuses, and draws nothing, when the grid or range cannot be drawn honestly', () => {
    const cases: Array<[string, DensitySpec]> = [
      ['wrong length', spec({ counts: [1, 2, 3] })],
      ['lo equals hi', spec({ lo: 5, hi: 5 })],
      ['lo above hi', spec({ lo: 9, hi: 5 })],
      ['non-finite lo', spec({ lo: Number.NaN })],
      ['non-finite hi', spec({ hi: Number.POSITIVE_INFINITY })],
      ['zero shade top with counts', spec({ shadeMax: 0 })],
      ['non-finite shade top', spec({ shadeMax: Number.NaN })],
      ['negative count', spec({ counts: new Array<number>(16).fill(-1) })],
      ['NaN count', spec({ counts: new Array<number>(16).fill(Number.NaN) })],
      ['zero bins', spec({ nBins: 0, counts: [] })],
    ]
    for (const [name, bad] of cases) {
      const { ctx, calls } = createRecording2d()
      expect(drawDensity(ctx, bad, TOKENS, SIZE), name).toBe(false)
      expect(calls.filter((c) => c.method === 'fillRect'), name).toHaveLength(0)
      expect(calls, name).toHaveLength(0)
    }
  })

  it('refuses when the canvas has no room for a plot', () => {
    const { ctx, calls } = createRecording2d()
    expect(drawDensity(ctx, spec(), TOKENS, { width: 40, height: 40 })).toBe(false)
    expect(calls).toHaveLength(0)
  })
})

describe('densityPlotArea', () => {
  it('is square, so a unit on x is as long as a unit on y', () => {
    for (const size of [
      { width: 400, height: 340 },
      { width: 600, height: 300 },
      { width: 300, height: 600 },
    ]) {
      const area = densityPlotArea(size)
      expect(area.width).toBe(area.height)
      expect(area.width).toBeGreaterThan(0)
      expect(area.left + area.width).toBeLessThanOrEqual(size.width)
      expect(area.top + area.height).toBeLessThanOrEqual(size.height)
    }
  })
})
