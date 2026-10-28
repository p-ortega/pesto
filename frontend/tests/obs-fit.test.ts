// @vitest-environment jsdom
//
// The group fit area of the Obs tab: the two 1:1 density panels. The fetchers are mocked, the
// chart kit's density drawer is wrapped so a test can read the spec each panel was drawn with,
// and the canvas is a recording context.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Obs1to1Payload, ObsBrushPayload, ObsResidHistPayload, SitePoints } from '../src/data/obs'
import { emptySelection } from '../src/state/rules'
import { createSelectionStore, type SelectionStore } from '../src/state/selection'
import { renderGroupFit, type GroupFitHandle } from '../src/ui/obs-fit'
import type { DensitySpec } from '../src/ui/charts/density'
import type { HistogramSpec } from '../src/ui/charts/histogram'
import { createRecording2d, type RecordedCall } from './support/recording-2d'
import { expectNoRunTogetherText, loadRealStylesheet } from './support/run-together'

const obsApi = vi.hoisted(() => ({
  fetchObs1to1: vi.fn(),
  fetchObsPoints: vi.fn(),
  fetchObsResidHist: vi.fn(),
  fetchObsBrush: vi.fn(),
}))
vi.mock('../src/data/obs', async () => ({
  ...(await vi.importActual<typeof import('../src/data/obs')>('../src/data/obs')),
  ...obsApi,
}))

const density = vi.hoisted(() => ({ drawDensity: vi.fn() }))
vi.mock('../src/ui/charts/density', async () => {
  const actual = await vi.importActual<typeof import('../src/ui/charts/density')>('../src/ui/charts/density')
  density.drawDensity.mockImplementation(actual.drawDensity)
  return { ...actual, drawDensity: density.drawDensity }
})

const histogram = vi.hoisted(() => ({ drawHistogram: vi.fn() }))
vi.mock('../src/ui/charts/histogram', async () => {
  const actual = await vi.importActual<typeof import('../src/ui/charts/histogram')>('../src/ui/charts/histogram')
  histogram.drawHistogram.mockImplementation(actual.drawHistogram)
  return { ...actual, drawHistogram: histogram.drawHistogram }
})

const N_BINS = 4

function grid(iteration: number, peak: number, over: Partial<Obs1to1Payload['grids'][number]> = {}) {
  const counts = new Array<number>(N_BINS * N_BINS).fill(0)
  counts[5] = peak
  counts[10] = 1
  return { iteration, counts, n_points: peak + 1, n_outside: 0, n_no_valid: 0, n_nonfinite: 0, ...over }
}

function payload(over: Partial<Obs1to1Payload> = {}): Obs1to1Payload {
  return {
    group: 'gw_head',
    n_bins: N_BINS,
    lo: -2,
    hi: 12,
    x_label: 'observed (obsval)',
    y_label: 'simulated',
    grids: [grid(0, 7), grid(1, 30)],
    n_with_target: 20,
    n_zero_weight: 3,
    left_out: { no_value: 1, sentinel: 0 },
    outlying: [],
    ranking_rule: 'the 10 sites with the largest RMSE of the ensemble-mean residual at the last iteration',
    rmse_rule: 'root mean square of the ensemble-mean residual',
    refused: null,
    notes: [],
    ...over,
  }
}

function answer(over: Partial<Obs1to1Payload> = {}) {
  return { ok: true, payload: payload(over) }
}

function setTokens(): void {
  const style = document.documentElement.style
  style.setProperty('--ink-muted', '#aabbcc')
  style.setProperty('--series-1', '#ff8800')
  style.setProperty('--series-2', '#445566')
  style.setProperty('--ink-primary', '#010203')
  style.setProperty('--axis', '#070809')
  style.setProperty('--gridline', '#0a0b0c')
  style.setProperty('--dim-alpha', '0.3')
}

function makeStore(sites: number[] = []): SelectionStore {
  return createSelectionStore({ initial: { ...emptySelection('run', 0), sites: new Set(sites) }, schedule: () => {} })
}

interface Mounted {
  host: HTMLElement
  store: SelectionStore
  handle: GroupFitHandle
  calls: RecordedCall[]
}

function mount(over: { startHidden?: boolean; store?: SelectionStore } = {}): Mounted {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const store = over.store ?? makeStore()
  const { ctx, calls } = createRecording2d()
  const handle = renderGroupFit(host, { store, startHidden: over.startHidden, context2d: () => ctx })
  return { host, store, handle, calls }
}

function densitySpecs(): DensitySpec[] {
  return density.drawDensity.mock.calls.map((call) => call[1] as DensitySpec)
}

beforeEach(() => {
  setTokens()
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(400)
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(280)
  obsApi.fetchObs1to1.mockReset()
  obsApi.fetchObs1to1.mockResolvedValue(answer())
  obsApi.fetchObsPoints.mockReset()
  obsApi.fetchObsResidHist.mockReset()
  obsApi.fetchObsBrush.mockReset()
  // Refused unless a test asks for a histogram, so the 1:1 tests count only their own canvases.
  obsApi.fetchObsResidHist.mockResolvedValue({ ok: false, artifact: 'obs_agg', reason: 'no histogram in this test' })
  density.drawDensity.mockClear()
  histogram.drawHistogram.mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
  document.documentElement.removeAttribute('style')
  document.body.textContent = ''
})

describe('the 1:1 density panels', () => {
  it('draws one panel per iteration, both with the payload range and one shared shading top', async () => {
    const { handle } = mount()
    handle.setGroup('gw_head')
    await vi.waitFor(() => expect(densitySpecs().length).toBeGreaterThanOrEqual(2))

    const specs = densitySpecs()
    expect(obsApi.fetchObs1to1).toHaveBeenCalledWith('gw_head', expect.anything())
    expect(specs.map((s) => s.title)).toEqual(['iteration 0', 'iteration 1'])
    expect(specs.map((s) => [s.lo, s.hi])).toEqual([
      [-2, 12],
      [-2, 12],
    ])
    expect(specs.map((s) => s.shadeMax)).toEqual([30, 30])
    expect(specs.map((s) => s.nBins)).toEqual([N_BINS, N_BINS])
  })

  it('labels the axes observed and simulated', async () => {
    const { handle } = mount()
    handle.setGroup('gw_head')
    await vi.waitFor(() => expect(densitySpecs().length).toBe(2))

    for (const spec of densitySpecs()) {
      expect(spec.xLabel).toBe('observed (obsval)')
      expect(spec.yLabel).toBe('simulated')
    }
  })

  it('puts the two panels side by side', async () => {
    const { host, handle } = mount()
    handle.setGroup('gw_head')
    await vi.waitFor(() => expect(host.querySelectorAll('canvas').length).toBe(2))

    const row = host.querySelector('canvas')!.parentElement!.parentElement!.parentElement!
    expect(row.style.display).toBe('flex')
    expect(row.querySelectorAll('canvas').length).toBe(2)
  })

  it('draws one panel and says so when only one iteration has an ensemble', async () => {
    obsApi.fetchObs1to1.mockResolvedValue(answer({ grids: [grid(3, 9)] }))
    const { host, handle } = mount()
    handle.setGroup('gw_head')
    await vi.waitFor(() => expect(densitySpecs().length).toBe(1))

    expect(host.querySelectorAll('canvas').length).toBe(1)
    expect(host.textContent).toContain('only iteration 3 has an observation ensemble')
  })

  it('shows the reason in place of the panels when the 1:1 is refused', async () => {
    obsApi.fetchObs1to1.mockResolvedValue(answer({ refused: 'no observation of this group has a target', grids: [], lo: null, hi: null }))
    const { host, handle } = mount()
    handle.setGroup('gw_head')
    await vi.waitFor(() => expect(host.querySelector('.notice-parts')).not.toBeNull())

    expect(host.textContent).toContain('no observation of this group has a target')
    expect(host.querySelector('canvas')).toBeNull()
  })

  it('shows the server reason when the answer is a refusal', async () => {
    obsApi.fetchObs1to1.mockResolvedValue({ ok: false, artifact: 'obs_1to1', reason: 'the 1:1 grid was built from a different observation table' })
    const { host, handle } = mount()
    handle.setGroup('gw_head')
    await vi.waitFor(() => expect(host.querySelector('.notice-parts')).not.toBeNull())

    expect(host.textContent).toContain('obs_1to1: the 1:1 grid was built from a different observation table')
  })

  it('refuses an answer for another group instead of drawing it', async () => {
    obsApi.fetchObs1to1.mockResolvedValue(answer({ group: 'other' }))
    const { host, handle } = mount()
    handle.setGroup('gw_head')
    await vi.waitFor(() => expect(host.querySelector('.notice-parts')).not.toBeNull())

    expect(host.textContent).toContain('the server answered for group other, not gw_head')
    expect(densitySpecs().length).toBe(0)
  })

  it('writes a group name through textContent, so markup in it stays text', async () => {
    const name = '<img src=x onerror=alert(1)>'
    obsApi.fetchObs1to1.mockResolvedValue(answer({ group: name }))
    const { host, handle } = mount()
    handle.setGroup(name)
    await vi.waitFor(() => expect(densitySpecs().length).toBe(2))

    expect(host.querySelector('img')).toBeNull()
    expect(host.querySelector('.obs-fit-title')!.textContent).toBe(`Fit of group ${name}`)
  })

  it('clears the area when the group is cleared', async () => {
    const { host, handle } = mount()
    handle.setGroup('gw_head')
    await vi.waitFor(() => expect(host.querySelectorAll('canvas').length).toBe(2))

    handle.setGroup(null)

    expect(host.textContent).toBe('')
  })
})

// ---- points on top of the panels ----

// The density's square plot area in a 400 by 280 canvas, worked out here from its margins.
const AREA = { left: 114, top: 28, side: 212 }
const LO = -2
const HI = 12

function px(value: number): number {
  return AREA.left + ((value - LO) / (HI - LO)) * AREA.side
}

function py(value: number): number {
  return AREA.top + AREA.side - ((value - LO) / (HI - LO)) * AREA.side
}

function sitePoints(id: number, name: string, over: Partial<SitePoints['series'][number]> = {}, rmse: number | null = 2.5): SitePoints {
  const series = (iteration: number) => ({
    iteration,
    obsval: [2, 6],
    mean: [3, 5],
    q05: [1, 4],
    q95: [4, 8],
    weighted: [true, true],
    ...over,
  })
  return { site_id: id, site: name, rmse_last: rmse, series: [series(0), series(1)] }
}

function pointsAnswer(sites: SitePoints[], extra: { not_in_group?: number[]; unknown?: number[] } = {}) {
  return { ok: true, payload: { group: 'gw_head', sites, not_in_group: extra.not_in_group ?? [], unknown: extra.unknown ?? [] } }
}

// The calls of the last full draw: every panel starts with a clearRect.
function lastDraw(calls: RecordedCall[], panels = 2): RecordedCall[] {
  const starts = calls.flatMap((c, i) => (c.method === 'clearRect' ? [i] : []))
  return calls.slice(starts[starts.length - panels])
}

function markers(calls: RecordedCall[], shape: 'arc' | 'rect'): { call: RecordedCall; colour: unknown }[] {
  const found: { call: RecordedCall; colour: unknown }[] = []
  calls.forEach((call, i) => {
    const isMarker = shape === 'arc' ? call.method === 'arc' : call.method === 'rect' && call.args[2] === 6
    if (!isMarker) return
    const stroke = calls.slice(i).find((c) => c.method === 'stroke')
    found.push({ call, colour: stroke?.state.strokeStyle })
  })
  return found
}

function legendText(host: HTMLElement): string {
  return host.querySelector('.obs-fit-legend')?.textContent ?? ''
}

async function drawn(m: Mounted, group = 'gw_head'): Promise<void> {
  m.handle.setGroup(group)
  await vi.waitFor(() => expect(m.host.querySelectorAll('canvas').length).toBeGreaterThan(0))
  await vi.waitFor(() => expect(m.host.querySelector('.obs-fit-legend')).not.toBeNull())
}

describe('the points on the panels', () => {
  it('draws the outlying sites as squares in series 2 and the selected sites as circles in series 1', async () => {
    obsApi.fetchObs1to1.mockResolvedValue(answer({ outlying: [sitePoints(1, 'well A')] }))
    obsApi.fetchObsPoints.mockResolvedValue(pointsAnswer([sitePoints(7, 'well B')]))
    const m = mount({ store: makeStore([7]) })
    await drawn(m)
    await vi.waitFor(() => expect(legendText(m.host)).toContain('circles, selected sites: 1'))

    const draw = lastDraw(m.calls)
    const squares = markers(draw, 'rect')
    const circles = markers(draw, 'arc')
    expect(squares.length).toBe(4)
    expect(squares.every((s) => s.colour === '#445566')).toBe(true)
    expect(circles.length).toBe(4)
    expect(circles.every((s) => s.colour === '#ff8800')).toBe(true)
  })

  it('puts each point on the density pixels, the mean as the marker and 5 to 95 percent as the bar', async () => {
    obsApi.fetchObs1to1.mockResolvedValue(answer({ grids: [grid(0, 7)], outlying: [sitePoints(1, 'well A')] }))
    const m = mount()
    await drawn(m)

    const draw = lastDraw(m.calls, 1)
    const first = markers(draw, 'rect')[0].call
    expect(first.args[0] as number).toBeCloseTo(px(2) - 3)
    expect(first.args[1] as number).toBeCloseTo(py(3) - 3)
    const bar = draw.findIndex((c) => c.method === 'moveTo' && Math.abs((c.args[0] as number) - px(2)) < 1e-6)
    expect(draw[bar].args[1] as number).toBeCloseTo(py(1))
    expect(draw[bar + 1].method).toBe('lineTo')
    expect(draw[bar + 1].args[0] as number).toBeCloseTo(px(2))
    expect(draw[bar + 1].args[1] as number).toBeCloseTo(py(4))
  })

  it('draws a zero-weight point hollow and says what hollow means', async () => {
    obsApi.fetchObs1to1.mockResolvedValue(
      answer({ grids: [grid(0, 7)], outlying: [sitePoints(1, 'well A', { weighted: [true, false] })] }),
    )
    const m = mount()
    await drawn(m)

    const draw = lastDraw(m.calls, 1)
    expect(markers(draw, 'rect').length).toBe(2)
    expect(draw.filter((c) => c.method === 'fill').length).toBe(1)
    expect(legendText(m.host)).toContain('hollow marks: zero weight')
  })

  it('does not draw a point outside the range and counts it', async () => {
    obsApi.fetchObs1to1.mockResolvedValue(
      answer({ grids: [grid(0, 7)], outlying: [sitePoints(1, 'well A', { obsval: [2, 50], mean: [3, 5] })] }),
    )
    const m = mount()
    await drawn(m)

    expect(markers(lastDraw(m.calls, 1), 'rect').length).toBe(1)
    expect(legendText(m.host)).toContain('1 point lies outside the drawn range')
  })

  it('does not draw a point with no mean and counts it', async () => {
    obsApi.fetchObs1to1.mockResolvedValue(
      answer({ grids: [grid(0, 7)], outlying: [sitePoints(1, 'well A', { mean: [3, null] })] }),
    )
    const m = mount()
    await drawn(m)

    expect(markers(lastDraw(m.calls, 1), 'rect').length).toBe(1)
    expect(legendText(m.host)).toContain('1 point has no ensemble mean and is not drawn')
  })

  it('draws a point with no band without a bar', async () => {
    obsApi.fetchObs1to1.mockResolvedValue(
      answer({ grids: [grid(0, 7)], outlying: [sitePoints(1, 'well A', { q05: [null, 4], q95: [null, 8] })] }),
    )
    const m = mount()
    await drawn(m)

    const draw = lastDraw(m.calls, 1)
    expect(markers(draw, 'rect').length).toBe(2)
    expect(draw.some((c) => c.method === 'moveTo' && Math.abs((c.args[0] as number) - px(2)) < 1e-6)).toBe(false)
  })

  it('draws each panel from its own iteration series', async () => {
    const site = sitePoints(1, 'well A')
    site.series[1] = { ...site.series[1], obsval: [2], mean: [9], q05: [8], q95: [10], weighted: [true] }
    obsApi.fetchObs1to1.mockResolvedValue(answer({ outlying: [site] }))
    const m = mount()
    await drawn(m)

    const squares = markers(lastDraw(m.calls), 'rect')
    expect(squares.map((s) => Math.round(s.call.args[1] as number))).toEqual(
      [py(3), py(5), py(9)].map((v) => Math.round(v - 3)),
    )
  })
})

describe('the 1:1 legend', () => {
  it('states the ranking rule, the zero-weight count and the left-out counts by reason', async () => {
    obsApi.fetchObs1to1.mockResolvedValue(
      answer({
        outlying: [sitePoints(1, 'well A', {}, 2.5), sitePoints(2, 'well B', {}, null)],
        left_out: { no_value: 4, sentinel: 2 },
        grids: [grid(0, 7, { n_no_valid: 5 }), grid(1, 30, { n_no_valid: 6 })],
      }),
    )
    const m = mount()
    await drawn(m)

    const text = legendText(m.host)
    expect(text).toContain('the 10 sites with the largest RMSE of the ensemble-mean residual at the last iteration')
    expect(text).toContain('zero weight included: 3')
    expect(text).toContain('left out: 4 no measured value, 2 sentinel, 6 no valid realization at iteration 1')
    expect(text).toContain('iteration 0: 5 observations have no valid realization')
    expect(text).toContain('RMSE of the ensemble-mean residual: well A 2.5, well B no figure')
  })

  it('states the realization values outside the range for each iteration', async () => {
    obsApi.fetchObs1to1.mockResolvedValue(
      answer({ grids: [grid(0, 7, { n_outside: 12 }), grid(1, 30, { n_outside: 1, n_nonfinite: 3 })] }),
    )
    const m = mount()
    await drawn(m)

    const text = legendText(m.host)
    expect(text).toContain('iteration 0: 12 realization values lie outside the drawn range')
    expect(text).toContain('iteration 1: 1 realization value lies outside the drawn range')
    expect(text).toContain('iteration 1: 3 simulated values are missing and not counted')
  })

  it('writes a run-derived name through textContent', async () => {
    const name = '<b>bold</b>'
    obsApi.fetchObs1to1.mockResolvedValue(answer({ outlying: [sitePoints(1, name)] }))
    const m = mount()
    await drawn(m)

    expect(m.host.querySelector('b')).toBeNull()
    expect(legendText(m.host)).toContain(name)
  })

  it('keeps its parts from running together under the real stylesheet', async () => {
    loadRealStylesheet()
    obsApi.fetchObs1to1.mockResolvedValue(answer({ outlying: [sitePoints(1, 'well A')] }))
    obsApi.fetchObsPoints.mockResolvedValue(pointsAnswer([sitePoints(7, 'well B')], { not_in_group: [9] }))
    const m = mount({ store: makeStore([7, 9]) })
    await drawn(m)
    await vi.waitFor(() => expect(legendText(m.host)).toContain('not in this group'))

    expectNoRunTogetherText(m.host, 'obs-fit')
  })
})

describe('the selected sites', () => {
  it('asks for the points of the selected ids of the chosen group', async () => {
    obsApi.fetchObsPoints.mockResolvedValue(pointsAnswer([]))
    const m = mount({ store: makeStore([7, 8]) })
    await drawn(m)

    expect(obsApi.fetchObsPoints).toHaveBeenCalledWith('gw_head', [7, 8], expect.anything())
  })

  it('asks for nothing when no site is selected', async () => {
    const m = mount()
    await drawn(m)

    expect(obsApi.fetchObsPoints).not.toHaveBeenCalled()
  })

  it('says how many selected sites are not in the group and does not draw them', async () => {
    obsApi.fetchObs1to1.mockResolvedValue(answer({ grids: [grid(0, 7)] }))
    obsApi.fetchObsPoints.mockResolvedValue(pointsAnswer([], { not_in_group: [9], unknown: [10, 11] }))
    const m = mount({ store: makeStore([9, 10, 11]) })
    await drawn(m)
    await vi.waitFor(() => expect(legendText(m.host)).toContain('1 selected site is not in this group'))

    expect(legendText(m.host)).toContain('2 selected sites are not known to this run')
    expect(markers(lastDraw(m.calls, 1), 'arc').length).toBe(0)
  })

  it('asks for at most 20 selected sites and counts the rest', async () => {
    obsApi.fetchObsPoints.mockResolvedValue(pointsAnswer([]))
    const ids = Array.from({ length: 25 }, (_, i) => i + 1)
    const m = mount({ store: makeStore(ids) })
    await drawn(m)
    await vi.waitFor(() => expect(legendText(m.host)).toContain('5 more selected sites are not drawn'))

    expect(obsApi.fetchObsPoints.mock.calls[0][1]).toEqual(ids.slice(0, 20))
  })

  it('says a selected site has no measured observation', async () => {
    obsApi.fetchObsPoints.mockResolvedValue(
      pointsAnswer([sitePoints(7, 'well B', { obsval: [], mean: [], q05: [], q95: [], weighted: [] })]),
    )
    const m = mount({ store: makeStore([7]) })
    await drawn(m)

    await vi.waitFor(() => expect(legendText(m.host)).toContain('1 selected site has no observation with a measured value'))
  })

  it('shows the reason when the selected points are refused, and the panels still draw', async () => {
    obsApi.fetchObsPoints.mockResolvedValue({ ok: false, artifact: 'obs_index', reason: 'the group is not in the index' })
    const m = mount({ store: makeStore([7]) })
    await drawn(m)

    await vi.waitFor(() =>
      expect(legendText(m.host)).toContain("The selected sites' points could not be read: obs_index: the group is not in the index"),
    )
    expect(m.host.querySelectorAll('canvas').length).toBe(2)
  })

  it('asks again when the selection changes', async () => {
    obsApi.fetchObsPoints.mockResolvedValue(pointsAnswer([]))
    const m = mount({ store: makeStore([7]) })
    await drawn(m)

    m.store.set({ sites: new Set([8]) }, 'map')
    m.store.flush()

    await vi.waitFor(() => expect(obsApi.fetchObsPoints).toHaveBeenLastCalledWith('gw_head', [8], expect.anything()))
  })

  it('drops the circles when the selection is emptied', async () => {
    obsApi.fetchObs1to1.mockResolvedValue(answer({ grids: [grid(0, 7)] }))
    obsApi.fetchObsPoints.mockResolvedValue(pointsAnswer([sitePoints(7, 'well B')]))
    const m = mount({ store: makeStore([7]) })
    await drawn(m)
    await vi.waitFor(() => expect(markers(lastDraw(m.calls, 1), 'arc').length).toBe(2))

    m.store.set({ sites: new Set() }, 'map')
    m.store.flush()

    await vi.waitFor(() => expect(markers(lastDraw(m.calls, 1), 'arc').length).toBe(0))
  })

  it('does not ask while hidden and asks once on show', async () => {
    obsApi.fetchObsPoints.mockResolvedValue(pointsAnswer([]))
    const m = mount({ store: makeStore([7]) })
    await drawn(m)
    expect(obsApi.fetchObsPoints).toHaveBeenCalledTimes(1)
    m.handle.onHide()

    m.store.set({ sites: new Set([8]) }, 'map')
    m.store.flush()
    expect(obsApi.fetchObsPoints).toHaveBeenCalledTimes(1)

    m.handle.onShow()
    await vi.waitFor(() => expect(obsApi.fetchObsPoints).toHaveBeenCalledTimes(2))
  })

  it('draws only the newest answer when the selection changes while one is out', async () => {
    let release: (value: unknown) => void = () => undefined
    obsApi.fetchObsPoints
      .mockImplementationOnce(() => new Promise((resolve) => (release = resolve)))
      .mockResolvedValueOnce(pointsAnswer([sitePoints(8, 'well C')]))
    const m = mount({ store: makeStore([7]) })
    await drawn(m)

    m.store.set({ sites: new Set([8]) }, 'map')
    m.store.flush()
    await vi.waitFor(() => expect(legendText(m.host)).toContain('circles, selected sites: 1'))
    release(pointsAnswer([sitePoints(7, 'well B'), sitePoints(6, 'well Z')]))
    await Promise.resolve()
    await Promise.resolve()

    expect(legendText(m.host)).toContain('circles, selected sites: 1')
  })
})

// ---- the residual histogram ----

const EDGES = Array.from({ length: 6 }, (_, i) => -5 + i * 2)

function residPayload(over: Partial<ObsResidHistPayload> = {}): ObsResidHistPayload {
  return {
    group: 'gw_head',
    residual: 'simulated minus observed',
    inequality: 'none',
    inequality_note: null,
    edges: EDGES,
    first: { iteration: 0, n: 20, counts: [1, 2, 10, 5, 2], density: [0.025, 0.05, 0.25, 0.125, 0.05] },
    last: { iteration: 1, n: 20, counts: [0, 1, 15, 3, 1], density: [0, 0.025, 0.375, 0.075, 0.025] },
    n_outside: { first: 0, last: 0 },
    left_out: { no_value: 1, sentinel: 0, no_valid_realization: { first: 0, last: 2 } },
    n_zero_weight: 3,
    refused: null,
    notes: [],
    ...over,
  }
}

function residAnswer(over: Partial<ObsResidHistPayload> = {}) {
  return { ok: true, payload: residPayload(over) }
}

function histSpecs(): HistogramSpec[] {
  return histogram.drawHistogram.mock.calls.map((call) => call[1] as HistogramSpec)
}

function residText(host: HTMLElement): string {
  return host.querySelector('.obs-fit-resid')?.textContent ?? ''
}

async function histDrawn(m: Mounted, group = 'gw_head'): Promise<void> {
  m.handle.setGroup(group)
  await vi.waitFor(() => expect(histSpecs().length).toBeGreaterThan(0))
}

describe('the residual histogram', () => {
  it('draws the first and last iteration on shared edges as densities in native space', async () => {
    obsApi.fetchObsResidHist.mockResolvedValue(residAnswer())
    const m = mount()
    await histDrawn(m)

    expect(obsApi.fetchObsResidHist).toHaveBeenCalledWith('gw_head', expect.anything())
    const spec = histSpecs()[0]
    expect(spec.space).toBe('native')
    expect(spec.edges).toEqual(EDGES)
    expect(spec.xLabel).toBe('residual: simulated minus observed')
    expect(spec.series.map((s) => s.label)).toEqual(['first, iteration 0', 'last, iteration 1'])
    expect(spec.series[0].density).toEqual([0.025, 0.05, 0.25, 0.125, 0.05])
    expect(spec.series[1].density).toEqual([0, 0.025, 0.375, 0.075, 0.025])
  })

  it('states the sign, the zero-weight count, the left-out counts by reason and the values outside the range', async () => {
    obsApi.fetchObsResidHist.mockResolvedValue(residAnswer({ n_outside: { first: 0, last: 4 } }))
    const m = mount()
    await histDrawn(m)

    const text = residText(m.host)
    expect(text).toContain('simulated minus observed')
    expect(text).toContain('zero weight included: 3')
    expect(text).toContain('left out: 1 no measured value, 0 sentinel, 2 with no valid realization at the last iteration')
    expect(text).toContain('first, iteration 0: 0 outside the drawn range')
    expect(text).toContain('last, iteration 1: 4 outside the drawn range')
  })

  it('counts the observations with no valid realization at the first iteration too', async () => {
    obsApi.fetchObsResidHist.mockResolvedValue(
      residAnswer({ left_out: { no_value: 0, sentinel: 0, no_valid_realization: { first: 5, last: 2 } } }),
    )
    const m = mount()
    await histDrawn(m)

    expect(residText(m.host)).toContain('5 with no valid realization at the first iteration')
  })

  it('draws one series and says which iteration when only one has an ensemble', async () => {
    obsApi.fetchObsResidHist.mockResolvedValue(
      residAnswer({ last: null, left_out: { no_value: 0, sentinel: 1, no_valid_realization: { first: 3, last: 0 } } }),
    )
    const m = mount()
    await histDrawn(m)

    expect(histSpecs()[0].series.map((s) => s.label)).toEqual(['iteration 0'])
    expect(residText(m.host)).toContain('0 no measured value, 1 sentinel, 3 with no valid realization at iteration 0')
  })

  it('shows the inequality note for an inequality group', async () => {
    const note = 'this is an inequality group; the residual shown is plain simulated minus observed, not one-sided'
    obsApi.fetchObsResidHist.mockResolvedValue(residAnswer({ inequality: 'greater', inequality_note: note }))
    const m = mount()
    await histDrawn(m)

    expect(residText(m.host)).toContain(note)
  })

  it('shows no inequality note for a group that has none', async () => {
    obsApi.fetchObsResidHist.mockResolvedValue(residAnswer())
    const m = mount()
    await histDrawn(m)

    expect(residText(m.host)).not.toContain('inequality')
  })

  it('shows the reason in place of the chart when the histogram is refused, and the 1:1 panels still draw', async () => {
    obsApi.fetchObsResidHist.mockResolvedValue(
      residAnswer({ refused: 'no observation in this group has a residual (1 sentinel)', edges: [], first: null, last: null }),
    )
    const m = mount()
    m.handle.setGroup('gw_head')
    await vi.waitFor(() => expect(m.host.querySelector('.obs-fit-resid .notice-parts')).not.toBeNull())

    expect(residText(m.host)).toContain('no observation in this group has a residual (1 sentinel)')
    expect(residText(m.host)).toContain('zero weight included: 3')
    expect(m.host.querySelector('.obs-fit-resid canvas')).toBeNull()
    expect(m.host.querySelectorAll('.obs-fit-1to1 canvas').length).toBe(2)
  })

  it('shows the server reason when the histogram answer is a refusal', async () => {
    obsApi.fetchObsResidHist.mockResolvedValue({ ok: false, artifact: 'obs_agg', reason: 'obs_agg is not in the cache' })
    const m = mount()
    m.handle.setGroup('gw_head')
    await vi.waitFor(() => expect(m.host.querySelector('.obs-fit-resid .notice-parts')).not.toBeNull())

    expect(residText(m.host)).toContain('obs_agg: obs_agg is not in the cache')
  })

  it('shows a refused 1:1 and a drawn histogram side by side', async () => {
    obsApi.fetchObs1to1.mockResolvedValue({ ok: false, artifact: 'obs_1to1', reason: 'no 1:1 grid' })
    obsApi.fetchObsResidHist.mockResolvedValue(residAnswer())
    const m = mount()
    await histDrawn(m)

    expect(m.host.querySelector('.obs-fit-1to1')!.textContent).toContain('obs_1to1: no 1:1 grid')
    expect(m.host.querySelectorAll('canvas').length).toBe(1)
  })

  it('draws only the newest group when the group changes while answers are out', async () => {
    const waiting: Array<(value: unknown) => void> = []
    obsApi.fetchObsResidHist.mockImplementation(
      (name: string) =>
        new Promise((resolve) => {
          waiting.push(() => resolve(residAnswer({ group: name, n_zero_weight: name === 'old' ? 111 : 222 })))
        }),
    )
    obsApi.fetchObs1to1.mockImplementation(async (name: string) => answer({ group: name }))
    const m = mount()
    m.handle.setGroup('old')
    m.handle.setGroup('new')
    expect(waiting.length).toBe(2)

    waiting[1](undefined)
    await vi.waitFor(() => expect(histSpecs().length).toBe(1))
    waiting[0](undefined)
    await Promise.resolve()
    await Promise.resolve()

    expect(histSpecs().length).toBe(1)
    expect(residText(m.host)).toContain('zero weight included: 222')
    expect(residText(m.host)).not.toContain('111')
    expect(m.host.querySelector('.obs-fit-title')!.textContent).toBe('Fit of group new')
  })

  it('fetches and draws nothing while hidden, and fetches once on show', async () => {
    obsApi.fetchObsResidHist.mockResolvedValue(residAnswer())
    const m = mount({ startHidden: true })

    m.handle.setGroup('gw_head')
    await Promise.resolve()
    expect(obsApi.fetchObs1to1).not.toHaveBeenCalled()
    expect(obsApi.fetchObsResidHist).not.toHaveBeenCalled()
    expect(m.calls.length).toBe(0)

    m.handle.onShow()
    await vi.waitFor(() => expect(histSpecs().length).toBe(1))
    m.handle.onHide()
    m.handle.onShow()

    expect(obsApi.fetchObs1to1).toHaveBeenCalledTimes(1)
    expect(obsApi.fetchObsResidHist).toHaveBeenCalledTimes(1)
  })

  it('draws nothing when an answer arrives after the tab was hidden, and draws on show', async () => {
    let release: (value: unknown) => void = () => undefined
    obsApi.fetchObsResidHist.mockImplementation(() => new Promise((resolve) => (release = resolve)))
    const m = mount()
    m.handle.setGroup('gw_head')
    m.handle.onHide()

    release(residAnswer())
    await vi.waitFor(() => expect(m.host.querySelector('.obs-fit-resid canvas')).not.toBeNull())
    expect(histSpecs().length).toBe(0)

    m.handle.onShow()
    expect(histSpecs().length).toBe(1)
  })
})

// ---- brushing the residual histogram ----

// The histogram canvas is 400 by 280 here; its plot runs from 44 to 388 css px over edges -5 to 5.
function hpx(value: number): number {
  return 44 + ((value + 5) / 10) * 344
}

function histCanvas(host: HTMLElement): HTMLCanvasElement {
  return host.querySelector('.obs-fit-resid canvas') as HTMLCanvasElement
}

function pointer(type: string, clientX: number, init: PointerEventInit = {}): PointerEvent {
  return new PointerEvent(type, { clientX, clientY: 100, pointerId: 1, bubbles: true, ...init })
}

function dragPx(canvas: HTMLCanvasElement, from: number, to: number, up: PointerEventInit = {}): void {
  canvas.dispatchEvent(pointer('pointerdown', from))
  canvas.dispatchEvent(pointer('pointermove', to))
  canvas.dispatchEvent(pointer('pointerup', to, up))
}

function dragHist(m: Mounted, from: number, to: number, up: PointerEventInit = {}): void {
  dragPx(histCanvas(m.host), hpx(from), hpx(to), up)
}

function brushAnswer(over: Partial<ObsBrushPayload> = {}) {
  const payload: ObsBrushPayload = {
    group: 'gw_head',
    iteration: 1,
    lo: -1,
    hi: 1,
    sites: [4, 5],
    n_obs_in_range: 3,
    left_out: { no_target: 2, sentinel: 1, no_valid_realization: 0 },
    other: { iteration: 0, counts: [0, 1, 1, 0, 0], density: [0, 0.025, 0.025, 0, 0], n_sites: 2, n_obs: 2 },
    ...over,
  }
  return { ok: true, payload }
}

function lastHistSpec(): HistogramSpec {
  const specs = histSpecs()
  return specs[specs.length - 1]
}

function switchButtons(host: HTMLElement): HTMLButtonElement[] {
  return [...host.querySelectorAll<HTMLButtonElement>('.brush-switch button')]
}

async function brushReady(m: Mounted): Promise<void> {
  obsApi.fetchObsResidHist.mockImplementation(async (name: string) => residAnswer({ group: name }))
  obsApi.fetchObsPoints.mockResolvedValue(pointsAnswer([]))
  m.handle.setGroup('gw_head')
  await vi.waitFor(() => expect(histCanvas(m.host)).not.toBeNull())
  await vi.waitFor(() => expect(histSpecs().length).toBeGreaterThan(0))
}

describe('the brush switch', () => {
  it('offers first and last under the histogram, last pressed', async () => {
    const m = mount()
    await brushReady(m)

    const buttons = switchButtons(m.host)
    expect(buttons.map((b) => b.textContent)).toEqual(['first (iteration 0)', 'last (iteration 1)'])
    expect(buttons.map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'true'])
  })

  it('offers only the one iteration a one-series histogram has, and says why the other is off', async () => {
    const m = mount()
    obsApi.fetchObsResidHist.mockResolvedValue(residAnswer({ last: null }))
    m.handle.setGroup('gw_head')
    await vi.waitFor(() => expect(switchButtons(m.host).length).toBe(2))

    const [first, last] = switchButtons(m.host)
    expect(first.getAttribute('aria-pressed')).toBe('true')
    expect(last.disabled).toBe(true)
    expect(residText(m.host)).toContain('only iteration 0 has observation statistics')
  })

  it('brushes the one iteration a one-series histogram has', async () => {
    obsApi.fetchObsBrush.mockResolvedValue(brushAnswer({ iteration: 0, other: null }))
    obsApi.fetchObsPoints.mockResolvedValue(pointsAnswer([]))
    const m = mount()
    obsApi.fetchObsResidHist.mockResolvedValue(residAnswer({ last: null }))
    m.handle.setGroup('gw_head')
    await vi.waitFor(() => expect(histCanvas(m.host)).not.toBeNull())

    dragHist(m, -1, 1)
    await vi.waitFor(() => expect([...m.store.get().sites]).toEqual([4, 5]))
    expect(obsApi.fetchObsBrush.mock.calls[0][1]).toBe(0)
    expect(lastHistSpec().overlay ?? null).toBeNull()
  })
})

describe('brushing the residual histogram', () => {
  it('asks for the sites of the last iteration in the dragged range and writes them with origin obs-fit', async () => {
    const store = makeStore([9])
    const origins: string[][] = []
    store.subscribe(
      (s) => s.sites,
      (_n, _p, o) => origins.push([...o]),
    )
    obsApi.fetchObsBrush.mockResolvedValue(brushAnswer())
    const m = mount({ store })
    await brushReady(m)

    dragHist(m, -1, 1)
    await vi.waitFor(() => expect([...store.get().sites]).toEqual([4, 5]))

    expect(obsApi.fetchObsBrush).toHaveBeenCalledTimes(1)
    const [group, iteration, lo, hi] = obsApi.fetchObsBrush.mock.calls[0]
    expect([group, iteration]).toEqual(['gw_head', 1])
    expect(lo).toBeCloseTo(-1, 9)
    expect(hi).toBeCloseTo(1, 9)
    store.flush()
    expect(origins).toEqual([['obs-fit']])
  })

  it('adds with shift held at release and removes with alt', async () => {
    const store = makeStore([4, 9])
    obsApi.fetchObsBrush.mockResolvedValue(brushAnswer())
    const m = mount({ store })
    await brushReady(m)

    dragHist(m, -1, 1, { shiftKey: true })
    await vi.waitFor(() => expect([...store.get().sites].sort()).toEqual([4, 5, 9]))
    dragHist(m, -1, 1, { altKey: true })
    await vi.waitFor(() => expect([...store.get().sites]).toEqual([9]))
  })

  it('brushes the first iteration once the switch says first', async () => {
    obsApi.fetchObsBrush.mockResolvedValue(
      brushAnswer({ iteration: 0, other: { iteration: 1, counts: [0, 0, 1, 0, 0], density: [0, 0, 0.05, 0, 0], n_sites: 1, n_obs: 1 } }),
    )
    const m = mount()
    await brushReady(m)

    switchButtons(m.host)[0].click()
    expect(switchButtons(m.host).map((b) => b.getAttribute('aria-pressed'))).toEqual(['true', 'false'])
    dragHist(m, -1, 1)
    await vi.waitFor(() => expect([...m.store.get().sites]).toEqual([4, 5]))

    expect(obsApi.fetchObsBrush.mock.calls[0][1]).toBe(0)
    expect(lastHistSpec().overlay).toEqual({ density: [0, 0, 0.05, 0, 0], label: 'the same sites in iteration 1', slot: 1 })
  })

  it('refuses an answer for another iteration than the switch named, and writes nothing', async () => {
    obsApi.fetchObsBrush.mockResolvedValue(brushAnswer({ iteration: 0 }))
    const m = mount({ store: makeStore([9]) })
    await brushReady(m)

    dragHist(m, -1, 1)
    await vi.waitFor(() => expect(residText(m.host)).toContain('the server answered for iteration 0, not 1'))
    expect([...m.store.get().sites]).toEqual([9])
    expect(lastHistSpec().band ?? null).toBeNull()
  })

  it('never writes the answer for an older drag', async () => {
    const waiting: Array<() => void> = []
    obsApi.fetchObsBrush
      .mockImplementationOnce(() => new Promise((resolve) => waiting.push(() => resolve(brushAnswer({ sites: [1] })))))
      .mockImplementationOnce(() => new Promise((resolve) => waiting.push(() => resolve(brushAnswer({ sites: [2] })))))
    const m = mount()
    await brushReady(m)

    dragHist(m, -1, 1)
    dragHist(m, 0, 2)
    expect(waiting.length).toBe(2)
    waiting[1]()
    await vi.waitFor(() => expect([...m.store.get().sites]).toEqual([2]))
    waiting[0]()
    await Promise.resolve()
    await Promise.resolve()

    expect([...m.store.get().sites]).toEqual([2])
  })

  it('keeps the band after release, outlines the same sites in the other iteration, and fades at the dim alpha', async () => {
    obsApi.fetchObsBrush.mockResolvedValue(brushAnswer())
    const m = mount()
    await brushReady(m)

    dragHist(m, -1, 1)
    await vi.waitFor(() => expect(lastHistSpec().overlay ?? null).not.toBeNull())

    const spec = lastHistSpec()
    expect(spec.band![0]).toBeCloseTo(-1, 9)
    expect(spec.band![1]).toBeCloseTo(1, 9)
    expect(spec.overlay).toEqual({ density: [0, 0.025, 0.025, 0, 0], label: 'the same sites in iteration 0', slot: 0 })
    expect(spec.dimAlpha).toBe(0.3)
    m.store.flush()
    expect(lastHistSpec().band).not.toBeNull()
  })

  it('draws the band live while dragging', async () => {
    const m = mount()
    await brushReady(m)

    const canvas = histCanvas(m.host)
    canvas.dispatchEvent(pointer('pointerdown', hpx(-3)))
    canvas.dispatchEvent(pointer('pointermove', hpx(3)))
    expect(lastHistSpec().band![0]).toBeCloseTo(-3, 9)
    expect(lastHistSpec().band![1]).toBeCloseTo(3, 9)
  })

  it('clears the band and outline when another view changes the sites', async () => {
    obsApi.fetchObsBrush.mockResolvedValue(brushAnswer())
    const m = mount()
    await brushReady(m)
    dragHist(m, -1, 1)
    await vi.waitFor(() => expect(lastHistSpec().overlay ?? null).not.toBeNull())
    m.store.flush()

    m.store.set({ sites: new Set([1]) }, 'map')
    m.store.flush()

    expect(lastHistSpec().band ?? null).toBeNull()
    expect(lastHistSpec().overlay ?? null).toBeNull()
  })

  it('clears the band when the group changes', async () => {
    obsApi.fetchObsBrush.mockResolvedValue(brushAnswer())
    const m = mount()
    await brushReady(m)
    dragHist(m, -1, 1)
    await vi.waitFor(() => expect(lastHistSpec().overlay ?? null).not.toBeNull())

    const before = histSpecs().length
    m.handle.setGroup('river')
    await vi.waitFor(() => expect(histSpecs().length).toBeGreaterThan(before))

    expect(obsApi.fetchObsResidHist).toHaveBeenLastCalledWith('river', expect.anything())
    expect(lastHistSpec().band ?? null).toBeNull()
    expect(lastHistSpec().overlay ?? null).toBeNull()
  })

  it('writes nothing when the brush catches no site, and says so with the left-out counts', async () => {
    obsApi.fetchObsBrush.mockResolvedValue(brushAnswer({ sites: [], n_obs_in_range: 0, other: null }))
    const m = mount({ store: makeStore([9]) })
    await brushReady(m)

    dragHist(m, -1, 1)
    await vi.waitFor(() => expect(residText(m.host)).toContain('no site has an observation in that range; the selection is unchanged'))

    expect([...m.store.get().sites]).toEqual([9])
    expect(residText(m.host)).toContain('left out of the histogram at iteration 1: 2 with no target, 1 sentinel, 0 with no valid realization')
  })

  it('shows a refused brush with its artifact and reason and writes nothing', async () => {
    obsApi.fetchObsBrush.mockResolvedValue({ ok: false, artifact: 'obs_agg', reason: 'the residual range is reversed' })
    const m = mount({ store: makeStore([9]) })
    await brushReady(m)

    dragHist(m, -1, 1)
    await vi.waitFor(() => expect(residText(m.host)).toContain('obs_agg: the residual range is reversed'))
    expect([...m.store.get().sites]).toEqual([9])
  })

  it('treats a 2 px press as a click: no request and no change', async () => {
    const m = mount({ store: makeStore([9]) })
    await brushReady(m)

    dragPx(histCanvas(m.host), hpx(0), hpx(0) + 2)
    await Promise.resolve()

    expect(obsApi.fetchObsBrush).not.toHaveBeenCalled()
    expect([...m.store.get().sites]).toEqual([9])
  })

  it('fetches nothing while the tab is hidden', async () => {
    const m = mount()
    await brushReady(m)
    m.handle.onHide()

    dragHist(m, -1, 1)
    await Promise.resolve()

    expect(obsApi.fetchObsBrush).not.toHaveBeenCalled()
  })
})

// ---- dimmed 1:1 points and clicking a point ----

function click(canvas: HTMLCanvasElement, x: number, y: number, init: MouseEventInit = {}): void {
  canvas.dispatchEvent(new MouseEvent('click', { clientX: x, clientY: y, bubbles: true, ...init }))
}

function fitCanvas(host: HTMLElement): HTMLCanvasElement {
  return host.querySelector('.obs-fit-1to1 canvas') as HTMLCanvasElement
}

describe('dimmed 1:1 points', () => {
  it('draws outlying points of unselected sites at the dim alpha and the selected site at full alpha, all of them drawn', async () => {
    obsApi.fetchObs1to1.mockResolvedValue(answer({ grids: [grid(0, 7)], outlying: [sitePoints(1, 'well A'), sitePoints(2, 'well B')] }))
    obsApi.fetchObsPoints.mockResolvedValue(pointsAnswer([sitePoints(1, 'well A')]))
    const m = mount({ store: makeStore([1]) })
    await drawn(m)
    await vi.waitFor(() => expect(markers(lastDraw(m.calls, 1), 'arc').length).toBe(2))

    const squares = markers(lastDraw(m.calls, 1), 'rect')
    // Two outlying sites with two points each: every point is still drawn.
    expect(squares.length).toBe(4)
    expect(squares.map((s) => s.call.state.globalAlpha).sort()).toEqual([0.3, 0.3, 1, 1])
    const dimmedX = squares.filter((s) => s.call.state.globalAlpha === 0.3).map((s) => s.call.args[0])
    const fullX = squares.filter((s) => s.call.state.globalAlpha === 1).map((s) => s.call.args[0])
    expect(dimmedX).toEqual(fullX)
    expect(markers(lastDraw(m.calls, 1), 'arc').every((c) => c.call.state.globalAlpha === 1)).toBe(true)
    expect(legendText(m.host)).toContain('outlying sites and their RMSE of the ensemble-mean residual: well A 2.5, well B 2.5')
  })

  it('dims nothing when no site is selected', async () => {
    obsApi.fetchObs1to1.mockResolvedValue(answer({ grids: [grid(0, 7)], outlying: [sitePoints(1, 'well A'), sitePoints(2, 'well B')] }))
    const m = mount()
    await drawn(m)

    const squares = markers(lastDraw(m.calls, 1), 'rect')
    expect(squares.length).toBe(4)
    expect(squares.every((s) => s.call.state.globalAlpha === 1)).toBe(true)
  })

  it('redraws the dimming when another view changes the sites', async () => {
    obsApi.fetchObs1to1.mockResolvedValue(answer({ grids: [grid(0, 7)], outlying: [sitePoints(1, 'well A'), sitePoints(2, 'well B')] }))
    obsApi.fetchObsPoints.mockResolvedValue(pointsAnswer([]))
    const m = mount()
    await drawn(m)

    m.store.set({ sites: new Set([2]) }, 'map')
    m.store.flush()

    await vi.waitFor(() =>
      expect(markers(lastDraw(m.calls, 1), 'rect').map((s) => s.call.state.globalAlpha)).toEqual([0.3, 0.3, 1, 1]),
    )
  })
})

describe('clicking a 1:1 point', () => {
  it('selects the site of the point under the click, with origin obs-fit', async () => {
    obsApi.fetchObs1to1.mockResolvedValue(answer({ grids: [grid(0, 7)], outlying: [sitePoints(1, 'well A')] }))
    obsApi.fetchObsPoints.mockResolvedValue(pointsAnswer([]))
    const store = makeStore([9])
    const origins: string[][] = []
    store.subscribe(
      (s) => s.sites,
      (_n, _p, o) => origins.push([...o]),
    )
    const m = mount({ store })
    await drawn(m)

    click(fitCanvas(m.host), px(2) + 3, py(3) - 2)

    expect([...store.get().sites]).toEqual([1])
    store.flush()
    expect(origins).toEqual([['obs-fit']])
  })

  it('adds with shift and removes with alt', async () => {
    obsApi.fetchObs1to1.mockResolvedValue(answer({ grids: [grid(0, 7)], outlying: [sitePoints(1, 'well A')] }))
    obsApi.fetchObsPoints.mockResolvedValue(pointsAnswer([]))
    const m = mount({ store: makeStore([9]) })
    await drawn(m)

    click(fitCanvas(m.host), px(2), py(3), { shiftKey: true })
    expect([...m.store.get().sites].sort()).toEqual([1, 9])
    click(fitCanvas(m.host), px(2), py(3), { altKey: true })
    expect([...m.store.get().sites]).toEqual([9])
  })

  it('selects every site with a point in reach, never one of them silently', async () => {
    obsApi.fetchObs1to1.mockResolvedValue(answer({ grids: [grid(0, 7)], outlying: [sitePoints(1, 'well A'), sitePoints(2, 'well B')] }))
    obsApi.fetchObsPoints.mockResolvedValue(pointsAnswer([]))
    const m = mount()
    await drawn(m)

    click(fitCanvas(m.host), px(2), py(3))

    expect([...m.store.get().sites].sort()).toEqual([1, 2])
  })

  it('does nothing on empty plot space or beyond 6 px of a point', async () => {
    obsApi.fetchObs1to1.mockResolvedValue(answer({ grids: [grid(0, 7)], outlying: [sitePoints(1, 'well A')] }))
    obsApi.fetchObsPoints.mockResolvedValue(pointsAnswer([]))
    const m = mount({ store: makeStore([9]) })
    await drawn(m)

    click(fitCanvas(m.host), px(10), py(0))
    click(fitCanvas(m.host), px(2) + 7, py(3))

    expect([...m.store.get().sites]).toEqual([9])
  })
})
