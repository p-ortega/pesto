// The chart kit's histogram: axes on d3-scale, the pure bar layout, and
// drawHistogram on a recording 2D context. Nothing here renders a pixel;
// the tests assert the calls made and the numbers behind them.

import { describe, expect, it } from 'vitest'
import { linearAxis, logAxis } from '../src/ui/charts/axes'
import { barRects } from '../src/ui/charts/bars'
import { drawHistogram, type HistogramSpec } from '../src/ui/charts/histogram'
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
const SIZE = { width: 400, height: 240 }

function twoSeries(): HistogramSpec {
  return {
    space: 'log10',
    edges: [0, 1, 2, 3],
    series: [
      { label: 'Prior', density: [0.2, 0.5, 0.3] },
      { label: 'Posterior (iteration 3)', density: [0.1, 0.7, 0.2] },
    ],
    xLabel: 'hk (native units)',
  }
}

describe('axes', () => {
  it('a log axis over [1, 1000] puts 1, 10, 100 and 1000 a hundred pixels apart', () => {
    const axis = logAxis([1, 1000], [0, 300])
    expect(axis).not.toBeNull()
    const px = new Map(axis!.ticks.map((t) => [t.value, t.px]))
    for (const [value, expected] of [
      [1, 0],
      [10, 100],
      [100, 200],
      [1000, 300],
    ] as const) {
      expect(px.has(value), `tick ${value}`).toBe(true)
      expect(Math.abs(px.get(value)! - expected)).toBeLessThan(1e-9)
    }
  })

  it('a log axis labels small values in plain or exponent form, never with an SI prefix', () => {
    const axis = logAxis([1e-5, 1], [0, 300])!
    const labels = axis.ticks.map((t) => t.label).filter((l) => l !== '')
    expect(labels).toContain('0.00001')
    expect(labels.some((l) => /[µmkMGn]$/.test(l))).toBe(false)
  })

  it('a log axis refuses a domain that is not strictly positive', () => {
    expect(logAxis([0, 100], [0, 100])).toBeNull()
    expect(logAxis([-1, 100], [0, 100])).toBeNull()
    expect(logAxis([Number.NaN, 100], [0, 100])).toBeNull()
  })

  it('a linear axis asks for fewer ticks on a shorter span', () => {
    const wide = linearAxis([0, 100], [0, 600])
    const narrow = linearAxis([0, 100], [0, 130])
    expect(narrow.ticks.length).toBeLessThan(wide.ticks.length)
    expect(narrow.ticks.length).toBeGreaterThanOrEqual(2)
    expect(linearAxis([0, 100], [0, 600], 3).ticks.length).toBeLessThanOrEqual(4)
  })

  it('a narrow linear axis over a large range keeps labels short enough to sit apart', () => {
    const axis = linearAxis([-1_000_000, 0], [0, 270])
    const labels = axis.ticks.map((t) => t.label)
    const spacing = Math.abs(axis.ticks[1].px - axis.ticks[0].px)
    // About 7 px per character at the 12 px chart font.
    for (const label of labels) expect(label.length * 7).toBeLessThan(spacing)
    expect(labels).toContain('−1e+6')
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('a linear axis over small numbers keeps its plain labels', () => {
    const labels = linearAxis([0, 40], [0, 300]).ticks.map((t) => t.label)
    expect(labels).toEqual(['0', '10', '20', '30', '40'])
  })

  it('a linear axis over [0, 1] ticks from 0 to 1 and labels each tick', () => {
    const axis = linearAxis([0, 1], [0, 100])
    const values = axis.ticks.map((t) => t.value)
    expect(values[0]).toBe(0)
    expect(values[values.length - 1]).toBe(1)
    expect(axis.ticks.every((t) => t.label.length > 0)).toBe(true)
    expect(axis.toPx(0.5)).toBeCloseTo(50, 9)
  })
})

describe('barRects', () => {
  it('log10 edges give equal-width bars whose left edges sit at 1, 10 and 100 on the axis', () => {
    const x = logAxis([1, 1000], [0, 300])!
    const y = linearAxis([0, 1], [200, 0])
    const bars = barRects([0, 1, 2, 3], [0.2, 0.5, 0.3], x, y, 'log10')
    expect(bars).toHaveLength(3)
    for (const bar of bars) expect(bar.w).toBeCloseTo(100, 6)
    expect(bars.map((b) => b.x)).toEqual([x.toPx(1), x.toPx(10), x.toPx(100)])
    expect(bars[1].h).toBeCloseTo(100, 6)
    expect(bars[1].y).toBeCloseTo(100, 6)
  })

  it('returns no bars when the density count does not match the bin count', () => {
    const x = linearAxis([0, 3], [0, 300])
    const y = linearAxis([0, 1], [200, 0])
    expect(barRects([0, 1, 2, 3], [0.2, 0.5], x, y, 'native')).toEqual([])
  })
})

describe('drawHistogram', () => {
  it('draws prior and posterior bars at the same x positions', () => {
    const { ctx, calls } = createRecording2d()
    expect(drawHistogram(ctx, twoSeries(), TOKENS, SIZE)).toBe(true)
    const outlines = calls.filter((c) => c.method === 'strokeRect' && (c.args[2] as number) > 10)
    const prior = outlines.filter((c) => c.state.strokeStyle === TOKENS.series1)
    const posterior = outlines.filter((c) => c.state.strokeStyle === TOKENS.series2)
    expect(prior).toHaveLength(3)
    expect(posterior).toHaveLength(3)
    expect(prior.map((c) => c.args[0])).toEqual(posterior.map((c) => c.args[0]))
    expect(prior.map((c) => c.args[2])).toEqual(posterior.map((c) => c.args[2]))
  })

  it('fills the prior bars with series 1 first, then the posterior bars with series 2', () => {
    const { ctx, calls } = createRecording2d()
    drawHistogram(ctx, twoSeries(), TOKENS, SIZE)
    // Legend swatches are 10 px wide; the bars are far wider at this size.
    const bars = calls.filter((c) => c.method === 'fillRect' && (c.args[2] as number) > 10)
    const fills = bars.map((c) => c.state.fillStyle)
    expect(fills).toEqual([
      TOKENS.series1,
      TOKENS.series1,
      TOKENS.series1,
      TOKENS.series2,
      TOKENS.series2,
      TOKENS.series2,
    ])
  })

  it('tells the series apart without colour: the legend names each in words and the prior outline is dashed', () => {
    const { ctx, calls } = createRecording2d()
    drawHistogram(ctx, twoSeries(), TOKENS, SIZE)
    const texts = calls.filter((c) => c.method === 'fillText')
    const legend = texts.filter((c) => c.state.fillStyle === TOKENS.inkPrimary).map((c) => c.args[0])
    expect(legend).toEqual(['Prior', 'Posterior (iteration 3)'])
    const priorOutline = calls.find(
      (c) => c.method === 'strokeRect' && c.state.strokeStyle === TOKENS.series1,
    )!
    const posteriorOutline = calls.find(
      (c) => c.method === 'strokeRect' && c.state.strokeStyle === TOKENS.series2,
    )!
    expect(priorOutline.state.dash.length).toBeGreaterThan(0)
    expect(posteriorOutline.state.dash).toEqual([])
  })

  it('writes the axis label and the log tick labels in ink tokens', () => {
    const { ctx, calls } = createRecording2d()
    drawHistogram(ctx, twoSeries(), TOKENS, SIZE)
    const muted = calls
      .filter((c) => c.method === 'fillText' && c.state.fillStyle === TOKENS.inkMuted)
      .map((c) => c.args[0])
    expect(muted).toContain('hk (native units)')
    expect(muted).toContain('1')
    expect(muted).toContain('10')
    expect(muted).toContain('100')
  })

  it('draws one series and its label when only one iteration is ingested', () => {
    const spec = twoSeries()
    spec.series = [spec.series[1]]
    const { ctx, calls } = createRecording2d()
    expect(drawHistogram(ctx, spec, TOKENS, SIZE)).toBe(true)
    const legend = calls
      .filter((c) => c.method === 'fillText' && c.state.fillStyle === TOKENS.inkPrimary)
      .map((c) => c.args[0])
    expect(legend).toEqual(['Posterior (iteration 3)'])
    // Slots follow the order given, so a lone series takes slot 1.
    expect(calls.some((c) => c.state.strokeStyle === TOKENS.series2)).toBe(false)
    expect(calls.some((c) => c.state.strokeStyle === TOKENS.series1)).toBe(true)
  })

  it('draws a native-space histogram on a linear axis', () => {
    const { ctx, calls } = createRecording2d()
    const spec: HistogramSpec = {
      space: 'native',
      edges: [-1, 0, 1],
      series: [{ label: 'Prior', density: [0.4, 0.6] }],
      xLabel: 'x',
    }
    expect(drawHistogram(ctx, spec, TOKENS, SIZE)).toBe(true)
    expect(calls.filter((c) => c.method === 'fillText').map((c) => c.args[0])).toContain('0.0')
  })

  it('draws nothing and returns false for an empty spec', () => {
    const { ctx, calls } = createRecording2d()
    const spec: HistogramSpec = { space: 'log10', edges: [], series: [], xLabel: 'x' }
    expect(drawHistogram(ctx, spec, TOKENS, SIZE)).toBe(false)
    expect(calls).toEqual([])
  })

  it('refuses edges that are not ascending rather than drawing them in the wrong order', () => {
    const { ctx, calls } = createRecording2d()
    const spec = twoSeries()
    spec.edges = [3, 2, 1, 0]
    expect(drawHistogram(ctx, spec, TOKENS, SIZE)).toBe(false)
    expect(calls).toEqual([])
  })

  it('refuses a series whose density count does not match the bins, or that holds a non-number', () => {
    const short = twoSeries()
    short.series[1].density = [0.1, 0.7]
    const nan = twoSeries()
    nan.series[0].density = [0.2, Number.NaN, 0.3]
    for (const spec of [short, nan]) {
      const { ctx, calls } = createRecording2d()
      expect(drawHistogram(ctx, spec, TOKENS, SIZE)).toBe(false)
      expect(calls).toEqual([])
    }
  })

  it('draws the series in the order given, whatever the order of the iteration toggle', () => {
    const spec = twoSeries()
    spec.series = [spec.series[1], spec.series[0]]
    const { ctx, calls } = createRecording2d()
    drawHistogram(ctx, spec, TOKENS, SIZE)
    const legend = calls
      .filter((c) => c.method === 'fillText' && c.state.fillStyle === TOKENS.inkPrimary)
      .map((c) => c.args[0])
    expect(legend).toEqual(['Posterior (iteration 3)', 'Prior'])
  })
})
