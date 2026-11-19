// @vitest-environment jsdom
//
// The log choices of the chart kit: a histogram's density axis and both axes of the 1:1
// density panel. A log axis that cannot be drawn is refused with a reason, never bent.

import { describe, expect, it } from 'vitest'
import { densityLogRefusal, drawDensity, type DensitySpec } from '../src/ui/charts/density'
import { drawHistogram, histogramLogRefusal, type HistogramSpec } from '../src/ui/charts/histogram'
import type { ChartTokens } from '../src/ui/charts/tokens'
import { createRecording2d, type RecordedCall } from './support/recording-2d'

const TOKENS: ChartTokens = { axis: 'axis', gridline: 'grid', inkPrimary: 'ink', inkMuted: 'muted', series1: 's1', series2: 's2' }
const SIZE = { width: 400, height: 240 }

function hist(over: Partial<HistogramSpec> = {}): HistogramSpec {
  return { space: 'native', edges: [0, 1, 2, 3], series: [{ label: 'iteration 0', density: [0.001, 0, 0.9] }], xLabel: 'value', ...over }
}

function bars(calls: RecordedCall[]): number[][] {
  // The legend swatch is 10 by 10 at y 8; every other filled rectangle is a bar.
  return calls
    .filter((c) => c.method === 'fillRect' && !(c.args[1] === 8 && c.args[2] === 10))
    .map((c) => c.args as number[])
}

describe('a histogram with a log density axis', () => {
  it('gives a low bin a visible height that a linear axis does not', () => {
    const linear = createRecording2d()
    const log = createRecording2d()
    expect(drawHistogram(linear.ctx, hist(), TOKENS, SIZE)).toBe(true)
    expect(drawHistogram(log.ctx, hist({ yScale: 'log' }), TOKENS, SIZE)).toBe(true)

    expect(bars(linear.calls)[0][3]).toBeLessThan(1)
    expect(bars(log.calls)[0][3]).toBeGreaterThan(10)
  })

  it('draws a bin that holds nothing with no height, standing on the axis', () => {
    const { ctx, calls } = createRecording2d()
    drawHistogram(ctx, hist({ yScale: 'log' }), TOKENS, SIZE)
    const empty = bars(calls)[1]

    expect(empty.every(Number.isFinite)).toBe(true)
    expect(empty[3]).toBe(0)
    expect(empty[1]).toBe(SIZE.height - 40)
  })

  it('is refused with a reason when no bin holds a value, and then draws on a linear axis', () => {
    const empty = hist({ series: [{ label: 'iteration 0', density: [0, 0, 0] }] })
    expect(histogramLogRefusal(empty)).toContain('no bin holds a value')
    expect(histogramLogRefusal(hist())).toBeNull()

    const { ctx, calls } = createRecording2d()
    expect(drawHistogram(ctx, { ...empty, yScale: 'log' }, TOKENS, SIZE)).toBe(true)
    expect(bars(calls).every((bar) => bar.every(Number.isFinite))).toBe(true)
  })
})

function density(over: Partial<DensitySpec> = {}): DensitySpec {
  return { nBins: 2, counts: [1, 0, 0, 3], lo: 1, hi: 100, shadeMax: 3, title: 'iteration 0', xLabel: 'observed', yLabel: 'simulated', ...over }
}

function cells(calls: RecordedCall[]): number[][] {
  return calls.filter((c) => c.method === 'fillRect').map((c) => c.args as number[])
}

describe('a 1:1 panel with log axes', () => {
  it('draws each cell between its own two edges, so the lower bin is the wider one', () => {
    const { ctx, calls } = createRecording2d()
    expect(drawDensity(ctx, density({ scale: 'log' }), TOKENS, { width: 400, height: 280 })).toBe(true)
    const [low, high] = cells(calls)

    // 1 to 50.5 is most of two decades; 50.5 to 100 is a sliver of one.
    expect(low[2]).toBeGreaterThan(high[2] * 4)
    expect(low[2]).toBeCloseTo(low[3], 6)
    // The two cells meet at the shared edge and stay on the diagonal.
    expect(low[0] + low[2]).toBeCloseTo(high[0], 6)
    expect(high[1] + high[3]).toBeCloseTo(low[1], 6)
  })

  it('keeps the linear cells equal squares', () => {
    const { ctx, calls } = createRecording2d()
    drawDensity(ctx, density(), TOKENS, { width: 400, height: 280 })
    const [low, high] = cells(calls)
    expect(low[2]).toBeCloseTo(high[2], 6)
  })

  it('is refused with the range start in the reason when the range reaches zero or below', () => {
    expect(densityLogRefusal(-2)).toBe('A log axis needs every value above zero, and the drawn range starts at -2.')
    expect(densityLogRefusal(0)).not.toBeNull()
    expect(densityLogRefusal(0.5)).toBeNull()

    const { ctx, calls } = createRecording2d()
    expect(drawDensity(ctx, density({ lo: -2, scale: 'log' }), TOKENS, { width: 400, height: 280 })).toBe(false)
    expect(calls).toEqual([])
  })
})
