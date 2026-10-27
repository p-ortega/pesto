// @vitest-environment jsdom
//
// The group detail and the parameter detail: what they draw, what they say
// about whose figure each number is, and what they say when a figure is not
// shown. The canvas is a recording context, so a test asks what was drawn.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ParGroupRow, ParHistPayload, ParValuesPayload, SigmaRatio } from '../src/data/par'
import type { ChartTokens } from '../src/ui/charts/tokens'
import { renderGroupDetail, renderParameterDetail, type GroupDetailOptions } from '../src/ui/params-detail'
import { createRecording2d, type RecordedCall } from './support/recording-2d'
import { expectNoRunTogetherText, loadRealStylesheet } from './support/run-together'

const TOKENS: ChartTokens = {
  axis: 'tok-axis',
  gridline: 'tok-gridline',
  inkPrimary: 'tok-ink-primary',
  inkMuted: 'tok-ink-muted',
  series1: 'tok-series-1',
  series2: 'tok-series-2',
}

const N_BINS = 50
const EDGES = Array.from({ length: N_BINS + 1 }, (_, i) => -2 + i * 0.1)
const DENSITY_A = Array.from({ length: N_BINS }, (_, i) => 0.1 + (i % 5) * 0.05)
const DENSITY_B = Array.from({ length: N_BINS }, (_, i) => 0.2 + (i % 3) * 0.04)

beforeEach(() => {
  loadRealStylesheet()
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(400)
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(200)
})

afterEach(() => {
  vi.restoreAllMocks()
  document.head.textContent = ''
  document.body.textContent = ''
})

function sigma(over: Partial<SigmaRatio> = {}): SigmaRatio {
  return { state: 'shown', median: 0.42, p10: 0.3, p90: 0.61, n_used: 20, n_no_spread: 1, reason: null, ...over }
}

function row(over: Partial<ParGroupRow> = {}): ParGroupRow {
  return {
    group: 'hk',
    n_par: 24,
    n_included: 20,
    excluded: { fixed: 0, tied: 0, nonpositive_log: 0, no_values: 0, unknown_transform: 0 },
    type: { value: 'array', source: 'parameter name', note: null },
    layer: { value: 0, source: 'placement rule grid', note: null },
    change: {
      pesto: {
        mean_change_pct: 12.3,
        sd_change_pct: -40.2,
        mean_shift_sd_median: 0.34,
        n_used: 20,
        n_refused_near_zero: 0,
        n_no_spread: 0,
        label: 'pesto, over the 294 realizations present in both iterations',
      },
      pestpp: {
        mean_change: 15.1,
        std_change: -38,
        num_at_near_lbound: 0,
        num_at_near_ubound: 0,
        source: 'pl253.6.pcs.csv',
        note: null,
      },
      reason: null,
    },
    sigma_ratio: sigma(),
    at_bounds_last: { near_lower: 0, near_upper: 0, n_counted: 20 },
    drill_down: { offered: true, reason: null },
    notes: [],
    ...over,
  }
}

function hist(over: Partial<ParHistPayload> = {}): ParHistPayload {
  return {
    group: 'hk',
    space: 'log10',
    edges: EDGES,
    first: { iteration: 0, n: 294, counts: DENSITY_A.map(() => 1), density: DENSITY_A },
    last: { iteration: 6, n: 294, counts: DENSITY_B.map(() => 1), density: DENSITY_B },
    n_common: 294,
    left_out: { count: 0, reason: null },
    excluded: {},
    refused: null,
    notes: [],
    ...over,
  }
}

const NO_LEFT_OUT = { count: 0, n_only_first: 0, n_only_last: 0, only_first: [], only_last: [], reason: null }

interface Mounted {
  host: HTMLElement
  calls: RecordedCall[]
  options: GroupDetailOptions
}

function mountGroup(over: Partial<GroupDetailOptions> = {}): Mounted {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const { ctx, calls } = createRecording2d()
  const options: GroupDetailOptions = {
    row: row(),
    hist: { ok: true, payload: hist() },
    single: false,
    left_out: NO_LEFT_OUT,
    isHidden: () => false,
    context: () => ctx,
    tokens: () => TOKENS,
    ...over,
  }
  renderGroupDetail(host, options)
  return { host, calls, options }
}

function barsOf(calls: RecordedCall[], colour: string): RecordedCall[] {
  // The legend swatch is 10 by 10 at y 8; every other filled rectangle is a bar.
  return calls.filter(
    (c) => c.method === 'fillRect' && c.state.fillStyle === colour && !((c.args[1] as number) === 8 && (c.args[2] as number) === 10),
  )
}

function drawnTexts(calls: RecordedCall[]): string[] {
  return calls.filter((c) => c.method === 'fillText').map((c) => String(c.args[0]))
}

describe('the group detail histograms', () => {
  it('draws the prior and the posterior on the same x positions', () => {
    const { calls } = mountGroup()
    const first = barsOf(calls, 'tok-series-1').map((c) => c.args[0])
    const last = barsOf(calls, 'tok-series-2').map((c) => c.args[0])

    expect(first.length).toBe(N_BINS)
    expect(last).toEqual(first)
  })

  it('names each series in words with its iteration', () => {
    const { calls } = mountGroup()
    const texts = drawnTexts(calls)

    expect(texts).toContain('prior, iteration 0')
    expect(texts).toContain('posterior, iteration 6')
  })

  it('draws on one canvas that is an image named for the group and states the sigma ratio', () => {
    const { host } = mountGroup()
    const canvases = host.querySelectorAll('canvas')

    expect(canvases.length).toBe(1)
    expect(canvases[0].getAttribute('role')).toBe('img')
    const label = canvases[0].getAttribute('aria-label') ?? ''
    expect(label).toContain('hk')
    expect(label).toContain('sigma ratio 0.42 (10th to 90th percentile 0.30 to 0.61)')
  })

  it('states why a refused sigma ratio is not shown in the canvas label', () => {
    const reason = 'Not shown: the ensemble was reinflated at iteration 4 (source: pl253.rec).'
    const { host } = mountGroup({ row: row({ sigma_ratio: sigma({ state: 'refused', median: null, p10: null, p90: null, reason }) }) })

    expect(host.querySelector('canvas')!.getAttribute('aria-label')).toContain(reason)
  })

  it('draws one series and says only that iteration was ingested when a single iteration was ingested', () => {
    const { host, calls } = mountGroup({
      single: true,
      hist: { ok: true, payload: hist({ last: null }) },
    })

    expect(barsOf(calls, 'tok-series-1').length).toBe(N_BINS)
    expect(barsOf(calls, 'tok-series-2').length).toBe(0)
    expect(host.textContent).toContain('Only iteration 0 was ingested')
    expect(drawnTexts(calls)).toContain('iteration 0')
  })

  it('shows a refused histogram as a notice with the stored reason and draws nothing', () => {
    const reason = '3 log-transformed and 2 untransformed parameters cannot share one axis, so this group has no histogram'
    const { host, calls } = mountGroup({
      hist: { ok: true, payload: hist({ space: null, edges: null, first: null, last: null, refused: reason }) },
    })

    expect(host.textContent).toContain(reason)
    expect(host.querySelector('canvas')).toBeNull()
    expect(calls.filter((c) => c.method === 'fillRect')).toEqual([])
  })

  it('says it is loading while the histograms are on their way, and draws nothing yet', () => {
    const { host, calls } = mountGroup({ hist: null })

    expect(host.textContent).toContain('Loading histograms…')
    expect(calls).toEqual([])
  })

  it('names the artifact and the reason when the histograms could not be read, and still shows the change', () => {
    const { host } = mountGroup({ hist: { ok: false, artifact: 'par_hist', reason: 'par_hist.parquet is not in the cache' } })

    expect(host.textContent).toContain('par_hist: par_hist.parquet is not in the cache')
    expect(host.textContent).toContain('pesto, over the 294 realizations present in both iterations')
  })

  it('says so under the chart when the kit refuses to draw the numbers it was given', () => {
    const bad = hist({ edges: [1, 1, 1].concat(EDGES.slice(3)) })
    const { host } = mountGroup({ hist: { ok: true, payload: bad } })

    expect(host.textContent).toContain('The histogram could not be drawn')
  })

  it('draws nothing while hidden and draws once when shown', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const { ctx, calls } = createRecording2d()
    let hidden = true
    const handle = renderGroupDetail(host, {
      row: row(),
      hist: { ok: true, payload: hist() },
      single: false,
      left_out: NO_LEFT_OUT,
      isHidden: () => hidden,
      context: () => ctx,
      tokens: () => TOKENS,
    })

    expect(calls).toEqual([])
    hidden = false
    handle.onShow()
    expect(barsOf(calls, 'tok-series-1').length).toBe(N_BINS)
  })
})

describe('the group detail change and counts', () => {
  it('shows pesto\'s change and pestpp\'s change, each with its own label', () => {
    const { host } = mountGroup()
    const text = host.textContent ?? ''

    expect(text).toContain('pesto, over the 294 realizations present in both iterations: mean change 12.3%, sd change -40.2%')
    expect(text).toContain('pestpp (pl253.6.pcs.csv): mean change 15.1%, sd change -38%')
  })

  it('does not prefix a source that already says pestpp', () => {
    const base = row()
    const { host } = mountGroup({
      row: row({ change: { ...base.change, pestpp: { ...base.change.pestpp, source: 'pestpp, case.3.pcs.csv' } } }),
    })

    expect(host.textContent).toContain('pestpp, case.3.pcs.csv: mean change 15.1%')
    expect(host.textContent).not.toContain('pestpp (pestpp')
  })

  it('shows the run record\'s own figures beside the file\'s when they disagree', () => {
    const base = row()
    const { host } = mountGroup({
      row: row({
        change: {
          ...base.change,
          pestpp: {
            ...base.change.pestpp,
            note: 'pl253.6.pcs.csv and the run record pl253.rec disagree',
            record: { source: 'pl253.rec, from the run record, 4 significant digits', mean_change: 15.2, std_change: -38.1 },
          },
        },
      }),
    })

    expect(host.textContent).toContain('pl253.rec, from the run record, 4 significant digits: mean change 15.2%, sd change -38.1%')
    expect(host.textContent).toContain('disagree')
  })

  it('shows pestpp\'s reason where it has no figure', () => {
    const base = row()
    const { host } = mountGroup({
      row: row({
        change: {
          ...base.change,
          pestpp: {
            mean_change: null,
            std_change: null,
            num_at_near_lbound: null,
            num_at_near_ubound: null,
            source: null,
            note: 'the pcs.csv file for iteration 6 was not found',
          },
        },
      }),
    })

    expect(host.textContent).toContain('pestpp: the pcs.csv file for iteration 6 was not found')
  })

  it('shows pesto\'s reason where it has no figure', () => {
    const base = row()
    const { host } = mountGroup({
      row: row({ change: { ...base.change, pesto: null, reason: 'no adjustable parameters in this group' } }),
    })

    expect(host.textContent).toContain('no adjustable parameters in this group')
  })

  it('shows the shift of the mean in prior standard deviations', () => {
    const { host } = mountGroup()

    expect(host.textContent).toContain('mean shift 0.34 prior sd')
  })

  it('says how many realizations were left out and why', () => {
    const { host } = mountGroup({
      left_out: { ...NO_LEFT_OUT, count: 6, n_only_first: 4, n_only_last: 2, reason: 'a realization present in only one iteration is left out' },
    })

    expect(host.textContent).toContain('6 realizations left out: present in only one iteration')
  })

  it('says nothing about left-out realizations when none were left out', () => {
    const { host } = mountGroup()

    expect(host.textContent).not.toContain('left out: present in only one iteration')
  })

  it('says how many parameters were left out, and for which reason', () => {
    const base = row()
    const { host } = mountGroup({
      row: row({
        excluded: { fixed: 2, tied: 1, nonpositive_log: 0, no_values: 0, unknown_transform: 0 },
        change: { ...base.change, pesto: { ...base.change.pesto!, n_refused_near_zero: 5, n_no_spread: 3 } },
      }),
    })
    const text = host.textContent ?? ''

    expect(text).toContain('2 parameters left out: fixed')
    expect(text).toContain('1 parameter left out: tied')
    expect(text).toContain('5 parameters have no percent change: the prior mean is too close to zero')
    expect(text).toContain('3 parameters have no spread in the first iteration')
  })
})

describe('the group detail sigma ratio', () => {
  it('shows the median with its 10th to 90th percentile spread', () => {
    const { host } = mountGroup()

    expect(host.textContent).toContain('sigma ratio 0.42 (10th to 90th percentile 0.30 to 0.61)')
  })

  it('shows a refused ratio as the stored reason and no ratio number, while the histograms and change still show', () => {
    const reason = 'Not shown: the ensemble was reinflated at iteration 4, so the spread before and after is not comparable (source: pl253.rec).'
    const { host, calls } = mountGroup({
      row: row({ sigma_ratio: sigma({ state: 'refused', median: null, p10: null, p90: null, reason }) }),
    })
    const text = host.textContent ?? ''

    expect(text).toContain(reason)
    expect(text).not.toMatch(/sigma ratio \d/)
    expect(text).toContain('mean change 12.3%')
    expect(barsOf(calls, 'tok-series-1').length).toBe(N_BINS)
  })

  it('shows an unchecked ratio with the stored warning beside it', () => {
    const warning = 'Reinflation could not be checked, so this ratio may compare draws that are not related. Looked for: no run record.'
    const { host } = mountGroup({ row: row({ sigma_ratio: sigma({ state: 'unchecked', reason: warning }) }) })
    const text = host.textContent ?? ''

    expect(text).toContain('sigma ratio 0.42')
    expect(text).toContain(warning)
    expect(host.querySelector('canvas')!.getAttribute('aria-label')).toContain(warning)
  })

  it('writes a small ratio with two significant digits so it never reads 0.00', () => {
    const { host } = mountGroup({ row: row({ sigma_ratio: sigma({ median: 0.0042, p10: 0.0031, p90: 0.0068 }) }) })

    expect(host.textContent).toContain('sigma ratio 0.0042 (10th to 90th percentile 0.0031 to 0.0068)')
  })

  it('shows what the reinflation check found beside a ratio that was shown', () => {
    const note = 'a reinflation at iteration 2 was found, but it lies outside iterations 3 to 6, so it does not touch the ratio'
    const { host } = mountGroup({ reinflationNotes: [note] })

    expect(host.textContent).toContain(note)
  })
})

describe('the group detail text', () => {
  it('sets every run-derived string as text, never as markup', () => {
    const reason = '<img src=x onerror=alert(1)>'
    const { host } = mountGroup({
      row: row({
        notes: ['<b>note</b>'],
        sigma_ratio: sigma({ state: 'refused', median: null, p10: null, p90: null, reason }),
      }),
      hist: { ok: true, payload: hist({ notes: ['<i>hist note</i>'] }) },
    })

    expect(host.querySelector('img')).toBeNull()
    expect(host.querySelector('b')).toBeNull()
    expect(host.querySelector('i')).toBeNull()
    expect(host.textContent).toContain(reason)
    expect(host.textContent).toContain('<b>note</b>')
  })

  it('never runs two figures together', () => {
    const base = row()
    const { host } = mountGroup({
      row: row({
        excluded: { fixed: 2, tied: 0, nonpositive_log: 1, no_values: 0, unknown_transform: 0 },
        change: { ...base.change, pesto: { ...base.change.pesto!, n_refused_near_zero: 5 } },
        sigma_ratio: sigma({ state: 'unchecked', reason: 'Reinflation could not be checked.' }),
      }),
      left_out: { ...NO_LEFT_OUT, count: 3 },
    })

    expectNoRunTogetherText(host, 'params-detail.ts renderGroupDetail')
  })
})

function values(over: Partial<ParValuesPayload> = {}): ParValuesPayload {
  return {
    parameter: 'hk_0001',
    group: 'hk',
    space: 'log10',
    n_common: 294,
    left_out: { count: 0, reason: null },
    edges: EDGES,
    first: { iteration: 0, n: 294, counts: DENSITY_A.map(() => 1), density: DENSITY_A, mean: 0.5, sd: 0.25 },
    last: { iteration: 6, n: 294, counts: DENSITY_B.map(() => 1), density: DENSITY_B, mean: 0.7, sd: 0.1 },
    refused: null,
    notes: [],
    ...over,
  }
}

function mountParameter(result: Parameters<typeof renderParameterDetail>[1]['values']) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const { ctx, calls } = createRecording2d()
  renderParameterDetail(host, {
    parameter: 'hk_0001',
    values: result,
    isHidden: () => false,
    context: () => ctx,
    tokens: () => TOKENS,
  })
  return { host, calls }
}

describe('the parameter detail', () => {
  it('draws the parameter\'s own prior and posterior with the same legend words', () => {
    const { host, calls } = mountParameter({ ok: true, payload: values() })

    expect(drawnTexts(calls)).toContain('prior, iteration 0')
    expect(drawnTexts(calls)).toContain('posterior, iteration 6')
    expect(barsOf(calls, 'tok-series-1').length).toBe(N_BINS)
    expect(host.querySelector('canvas')!.getAttribute('aria-label')).toContain('hk_0001')
  })

  it('says the means and standard deviations are of the log10 values for a log parameter', () => {
    const { host } = mountParameter({ ok: true, payload: values() })

    expect(host.textContent).toContain('prior, iteration 0: mean 0.5, sd 0.25 (of the log10 values)')
    expect(host.textContent).toContain('posterior, iteration 6: mean 0.7, sd 0.1 (of the log10 values)')
  })

  it('shows an excluded parameter\'s stored reason and draws nothing', () => {
    const reason = 'fixed: the parameter does not move'
    const { host, calls } = mountParameter({
      ok: true,
      payload: values({ edges: null, first: null, last: null, refused: reason }),
    })

    expect(host.textContent).toContain(reason)
    expect(host.querySelector('canvas')).toBeNull()
    expect(calls).toEqual([])
  })

  it('shows the problem\'s detail for a group over the drill-down limit', () => {
    const reason = 'This group has 12,000 parameters. Drill-down is offered up to 10,000.'
    const { host, calls } = mountParameter({ ok: false, artifact: 'par_groups', reason })

    expect(host.textContent).toContain(reason)
    expect(calls).toEqual([])
  })

  it('draws one series for a single ingested iteration', () => {
    const { calls } = mountParameter({
      ok: true,
      payload: values({ last: null, notes: ['only iteration 0 was ingested, so one series is drawn and there is no before and after'] }),
    })

    expect(barsOf(calls, 'tok-series-1').length).toBe(N_BINS)
    expect(barsOf(calls, 'tok-series-2').length).toBe(0)
  })
})
