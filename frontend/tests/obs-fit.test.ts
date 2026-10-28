// @vitest-environment jsdom
//
// The group fit area of the Obs tab: the two 1:1 density panels. The fetchers are mocked, the
// chart kit's density drawer is wrapped so a test can read the spec each panel was drawn with,
// and the canvas is a recording context.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Obs1to1Payload } from '../src/data/obs'
import { emptySelection } from '../src/state/rules'
import { createSelectionStore, type SelectionStore } from '../src/state/selection'
import { renderGroupFit, type GroupFitHandle } from '../src/ui/obs-fit'
import type { DensitySpec } from '../src/ui/charts/density'
import { createRecording2d, type RecordedCall } from './support/recording-2d'

const obsApi = vi.hoisted(() => ({
  fetchObs1to1: vi.fn(),
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
  density.drawDensity.mockClear()
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
