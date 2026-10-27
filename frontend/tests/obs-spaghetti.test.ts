// @vitest-environment jsdom
//
// The spaghetti plot: what it fetches, what it hands the line layer and what it draws on the two
// 2D layers. jsdom has no WebGL2 and no 2D context, so a recording GL and two recording 2D
// contexts stand in, and a test asks which calls were made.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ObsSitePayload } from '../src/data/obs'
import { emptySelection } from '../src/state/rules'
import { createSelectionStore, type SelectionStore } from '../src/state/selection'
import { renderSpaghetti, type SpaghettiHandle, type SpaghettiOptions } from '../src/ui/obs-spaghetti'
import { createRecording2d, type RecordedCall as Call2d } from './support/recording-2d'
import { createRecordingGl, type RecordedCall as CallGl } from './support/recording-gl'

const obsApi = vi.hoisted(() => ({
  fetchObsSite: vi.fn(),
  fetchObsSeries: vi.fn(),
  fetchObsTimes: vi.fn(),
}))
vi.mock('../src/data/obs', async () => ({
  ...(await vi.importActual<typeof import('../src/data/obs')>('../src/data/obs')),
  ...obsApi,
}))

const INK_MUTED = '#aabbcc'
const SERIES_1 = '#ff8800'
const ACCENT = '#112233'
const PANEL_STEP = 260

function setTokens(): void {
  const style = document.documentElement.style
  style.setProperty('--ink-muted', INK_MUTED)
  style.setProperty('--series-1', SERIES_1)
  style.setProperty('--series-2', '#445566')
  style.setProperty('--ink-primary', '#010203')
  style.setProperty('--axis', '#070809')
  style.setProperty('--gridline', '#0a0b0c')
  style.setProperty('--accent', ACCENT)
}

function sitePayload(over: Partial<ObsSitePayload> = {}): ObsSitePayload {
  return {
    site_id: 7,
    site: 'well A',
    group: 'gw_head',
    time_kind: 'datetime',
    inequality: 'none',
    n_obs: 4,
    time: [19000, 19010, 19020, 19030],
    obsval: [10, 11, 12, 13],
    no_value: [false, false, false, false],
    sentinel: [false, false, false, false],
    weighted: [true, true, true, true],
    noise: { available: false, artifact: 'noise_agg', reason: 'no noise file was found' },
    placement: { available: false, artifact: 'obs_cell', reason: 'no cell' },
    iterations: [0, 6],
    notes: [],
    ...over,
  }
}

interface SeriesOver {
  nReal?: number
  count?: number
  baseIndex?: number[]
  baseNote?: string | null
  nNaN?: number
  nanAt?: number
  siteId?: number
}

function seriesAnswer(iteration: number, over: SeriesOver = {}) {
  const count = over.count ?? 4
  const nReal = over.nReal ?? 3
  const values = new Float32Array(count * nReal)
  for (let r = 0; r < count; r++) {
    for (let j = 0; j < nReal; j++) values[r * nReal + j] = 10 + r + j * 0.5 + iteration * 0.1
  }
  if (over.nanAt !== undefined) values[over.nanAt] = Number.NaN
  return {
    ok: true,
    values,
    count,
    nReal,
    siteId: over.siteId ?? 7,
    iteration,
    baseIndex: over.baseIndex ?? [1],
    baseNote: over.baseNote ?? null,
    nNaN: over.nNaN ?? 0,
  }
}

function answerSite(payload: ObsSitePayload, series: (iteration: number) => SeriesOver = () => ({})): void {
  obsApi.fetchObsSite.mockImplementation(async (id: number) => ({
    ok: true,
    payload: { ...payload, site_id: id, site: payload.site },
  }))
  obsApi.fetchObsSeries.mockImplementation(async (id: number, iteration: number) =>
    seriesAnswer(iteration, { siteId: id, ...series(iteration) }),
  )
}

function makeStore(over: Partial<ReturnType<typeof emptySelection>> = {}): SelectionStore {
  return createSelectionStore({ initial: { ...emptySelection('run', 0), ...over }, schedule: () => {} })
}

interface Mounted {
  host: HTMLElement
  store: SelectionStore
  handle: SpaghettiHandle
  gl: CallGl[]
  back: Call2d[]
  front: Call2d[]
  glCanvas: () => HTMLCanvasElement
}

function mount(over: Partial<SpaghettiOptions> = {}): Mounted {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const store = over.store ?? makeStore()
  const { gl, calls: glCalls } = createRecordingGl()
  const back = createRecording2d()
  const front = createRecording2d()
  let canvas: HTMLCanvasElement | null = null
  const handle = renderSpaghetti(host, {
    store,
    createGl: (c) => {
      canvas = c
      return gl
    },
    context2d: (layer) => (layer === 'back' ? back.ctx : front.ctx),
    ...over,
  })
  return { host, store, handle, gl: glCalls, back: back.calls, front: front.calls, glCanvas: () => canvas! }
}

function select(store: SelectionStore, sites: number[], more: Partial<ReturnType<typeof emptySelection>> = {}): void {
  store.set({ sites: new Set(sites), ...more }, 'test')
  store.flush()
}

function count<T extends { method: string }>(calls: T[], method: string): number {
  return calls.filter((c) => c.method === method).length
}

function legendText(host: HTMLElement): string[] {
  return [...host.querySelectorAll('.obs-spaghetti-legend > div')].map((el) => el.textContent ?? '')
}

beforeEach(() => {
  setTokens()
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(400)
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(function (this: Element) {
    return this.classList.contains('obs-spaghetti-stage') ? 8 * PANEL_STEP : 200
  })
  vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (this: HTMLElement) {
    const plots = [...document.querySelectorAll('.obs-spaghetti-plot')]
    const at = plots.indexOf(this)
    return at < 0 ? 0 : at * PANEL_STEP + 30
  })
  vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockReturnValue(0)
  obsApi.fetchObsSite.mockReset()
  obsApi.fetchObsSeries.mockReset()
  obsApi.fetchObsTimes.mockReset()
  answerSite(sitePayload())
})

afterEach(() => {
  vi.restoreAllMocks()
  document.documentElement.removeAttribute('style')
  document.head.textContent = ''
  document.body.textContent = ''
})

describe('a site written into the selection', () => {
  it('is fetched, then its first and last iteration are drawn as one strip each in one panel', async () => {
    answerSite(sitePayload({ iterations: [0, 3, 6] }))
    const { store, gl } = mount()
    select(store, [7])

    await vi.waitFor(() => expect(count(gl, 'drawElements')).toBe(2))
    expect(obsApi.fetchObsSite).toHaveBeenCalledTimes(1)
    expect(obsApi.fetchObsSite.mock.calls[0][0]).toBe(7)
    // The middle iteration is never asked for.
    expect(obsApi.fetchObsSeries.mock.calls.map((c) => c[1]).sort()).toEqual([0, 6])
    expect(count(gl, 'viewport')).toBe(1)
    expect(count(gl, 'scissor')).toBe(1)
  })

  it('draws the first iteration in muted ink and the last in series 1, both from colour tokens', async () => {
    const { store, gl } = mount()
    select(store, [7])
    await vi.waitFor(() => expect(count(gl, 'drawElements')).toBe(2))

    // The first argument of uniform4f is the uniform's location.
    const colours = gl.filter((c) => c.method === 'uniform4f').map((c) => (c.args as number[]).slice(1))
    expect(colours).toHaveLength(2)
    const channels = (hex: string) => [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255)
    colours[0].slice(0, 3).forEach((v, k) => expect(v).toBeCloseTo(channels(INK_MUTED)[k], 5))
    colours[1].slice(0, 3).forEach((v, k) => expect(v).toBeCloseTo(channels(SERIES_1)[k], 5))
    expect(colours[0][3]).toBeCloseTo(0.15, 5)
    expect(colours[1][3]).toBeCloseTo(0.15, 5)
  })

  it('draws a fainter strip when the ensemble has more than 300 realizations', async () => {
    answerSite(sitePayload(), () => ({ nReal: 600 }))
    const { store, gl } = mount()
    select(store, [7])
    await vi.waitFor(() => expect(count(gl, 'drawElements')).toBe(2))

    const alphas = gl.filter((c) => c.method === 'uniform4f').map((c) => (c.args as number[])[4])
    expect(alphas[0]).toBeCloseTo(0.075, 5)
  })

  it('puts one filled marker on the front layer for each weighted observation with a real value', async () => {
    const { store, front } = mount()
    select(store, [7])
    await vi.waitFor(() => expect(count(front, 'arc')).toBe(4))

    expect(count(front, 'fill')).toBe(4)
  })

  it('shows the site name from the server as the panel title, as text', async () => {
    answerSite(sitePayload({ site: '<img src=x onerror=alert(1)>' }))
    const { host, store } = mount()
    select(store, [7])
    await vi.waitFor(() => expect(host.querySelector('.obs-spaghetti-title')?.textContent).toBe('<img src=x onerror=alert(1)>'))

    expect(host.querySelector('img')).toBeNull()
  })

  it('draws nothing and asks for nothing when no site is selected', () => {
    const { host, gl } = mount()
    expect(obsApi.fetchObsSite).not.toHaveBeenCalled()
    expect(count(gl, 'drawElements')).toBe(0)
    expect(host.textContent).toContain('Choose a site')
    expect(host.querySelector('canvas')).toBeNull()
  })
})
