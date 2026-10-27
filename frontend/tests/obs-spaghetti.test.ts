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
import { expectNoRunTogetherText, loadRealStylesheet } from './support/run-together'

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

interface Polyline {
  colour: unknown
  width: number
  moves: number
  lines: number
}

// A stroke at 2.5 px or more is a bold base line; the cursor and axes are 1 px.
function boldLines(calls: Call2d[]): Polyline[] {
  const found: Polyline[] = []
  let moves = 0
  let lines = 0
  for (const call of calls) {
    if (call.method === 'beginPath') {
      moves = 0
      lines = 0
    } else if (call.method === 'moveTo') moves += 1
    else if (call.method === 'lineTo') lines += 1
    else if (call.method === 'stroke' && call.state.lineWidth >= 2.5) {
      found.push({ colour: call.state.strokeStyle, width: call.state.lineWidth, moves, lines })
    }
  }
  return found
}

async function drawn(m: Mounted, id = 7): Promise<void> {
  select(m.store, [id])
  await vi.waitFor(() => expect(count(m.front, 'stroke')).toBeGreaterThan(0))
}

describe('base', () => {
  it('is one bold polyline per iteration in that iteration colour', async () => {
    const m = mount()
    await drawn(m)

    const bold = boldLines(m.front)
    expect(bold.map((b) => b.colour)).toEqual([INK_MUTED, SERIES_1])
    for (const line of bold) {
      expect(line.width).toBeGreaterThanOrEqual(2.5)
      expect(line.moves).toBe(1)
      expect(line.lines).toBe(3)
    }
  })

  it('says so in the legend for an iteration that has none, and draws no line for it', async () => {
    answerSite(sitePayload(), (iteration) => (iteration === 6 ? { baseIndex: [] } : {}))
    const m = mount()
    await drawn(m)

    expect(legendText(m.host)).toContain('no base realization in iteration 6')
    expect(legendText(m.host)).not.toContain('no base realization in iteration 0')
    expect(boldLines(m.front)).toHaveLength(1)
  })

  it('breaks at a missing simulated value, which the legend counts', async () => {
    // Row 1, realization 1 is the base column's second value.
    answerSite(sitePayload(), (iteration) => (iteration === 0 ? { nanAt: 4, nNaN: 2 } : {}))
    const m = mount()
    await drawn(m)

    const first = boldLines(m.front)[0]
    expect(first.moves).toBe(2)
    expect(first.lines).toBe(1)
    expect(legendText(m.host)).toContain('2 simulated values are missing; their lines break there, never joined')
    // No index in the line layer's index buffer points at the missing value.
    const indexUpload = m.gl.find((c) => c.method === 'bufferData' && c.args[0] === 'ELEMENT_ARRAY_BUFFER')!
    expect([...(indexUpload.args[1] as Uint32Array)]).not.toContain(4)
  })
})

describe('observed markers', () => {
  it('are hollow for zero weight, and the legend says what zero weight means', async () => {
    answerSite(sitePayload({ weighted: [true, false, true, true] }))
    const m = mount()
    await drawn(m)

    expect(count(m.front, 'arc')).toBe(4)
    expect(count(m.front, 'fill')).toBe(3)
    expect(legendText(m.host)).toContain('hollow marker: zero weight: a model output, not fitted')
  })

  it('draw no hollow words when every observation is weighted', async () => {
    const m = mount()
    await drawn(m)

    expect(legendText(m.host).some((line) => line.includes('zero weight'))).toBe(false)
    expect(legendText(m.host)).toContain('filled marker: observed value, weight above zero')
  })

  it('are left out for an observation with no measured value, and the legend counts them by reason', async () => {
    answerSite(
      sitePayload({
        obsval: [10, null, null, 13],
        sentinel: [false, true, false, false],
        no_value: [false, false, true, false],
      }),
    )
    const m = mount()
    await drawn(m)

    expect(count(m.front, 'arc')).toBe(2)
    expect(legendText(m.host)).toContain(
      '2 observations have no measured value (1 sentinel, 1 not a number), so they have no marker',
    )
  })

  it('say when an observation is an inequality', async () => {
    answerSite(sitePayload({ inequality: 'greater' }))
    const m = mount()
    await drawn(m)

    expect(legendText(m.host)).toContain('observations are inequality constraints (greater)')
  })
})

describe('the noise band', () => {
  const noise = (base: 'excluded' | 'not present') => ({
    available: true as const,
    q05: [9, 10, null, 12],
    q95: [11, 12, 13, 14],
    source: 'pest_noise.csv',
    base,
    n_real_used: 100,
  })

  it('is shaded on the back layer and names its source file and that base was excluded', async () => {
    answerSite(sitePayload({ noise: noise('excluded') }))
    const m = mount()
    await drawn(m)

    // The null at row 2 splits the band into two runs.
    expect(count(m.back, 'fill')).toBe(2)
    expect(legendText(m.host)).toContain('noise band: 5 to 95 percent of pest_noise.csv; base excluded')
  })

  it('says the noise file has no base when it has none', async () => {
    answerSite(sitePayload({ noise: noise('not present') }))
    const m = mount()
    await drawn(m)

    expect(legendText(m.host)).toContain('noise band: 5 to 95 percent of pest_noise.csv; the noise file has no base')
  })

  it('is not drawn when unavailable, and the legend gives the reason', async () => {
    const m = mount()
    await drawn(m)

    expect(count(m.back, 'fill')).toBe(0)
    expect(legendText(m.host)).toContain('no noise band: no noise file was found')
  })

  it('never appears without a legend line that names its source', async () => {
    answerSite(sitePayload({ noise: noise('excluded') }))
    const m = mount()
    await drawn(m)

    expect(count(m.back, 'fill')).toBeGreaterThan(0)
    expect(legendText(m.host).some((line) => line.startsWith('noise band:') && line.includes('pest_noise.csv'))).toBe(true)
  })
})

describe('the x axis', () => {
  it.each([
    ['datetime', 'date'],
    ['numeric', 'model time (days)'],
    ['ordinal (no time found)', 'position in site (no time found)'],
  ])('for a %s site is titled %s, on the canvas and in the legend', async (kind, title) => {
    answerSite(sitePayload({ time_kind: kind }))
    const m = mount()
    await drawn(m)

    expect(m.back.filter((c) => c.method === 'fillText').map((c) => c.args[0])).toContain(title)
    expect(legendText(m.host)).toContain(`x axis: ${title}`)
  })
})

describe('the counts and the legend', () => {
  it('gives each iteration its own realization count', async () => {
    answerSite(sitePayload(), (iteration) => ({ nReal: iteration === 0 ? 4 : 3 }))
    const m = mount()
    await drawn(m)

    expect(legendText(m.host)).toContain('first iteration 0: 4 realizations')
    expect(legendText(m.host)).toContain('last iteration 6: 3 realizations')
  })

  it('says so for an iteration the server refused, and still draws the other', async () => {
    obsApi.fetchObsSeries.mockImplementation(async (id: number, iteration: number) =>
      iteration === 6 ? { ok: false, artifact: 'obs_ens', reason: 'no ensemble' } : seriesAnswer(iteration, { siteId: id }),
    )
    const m = mount()
    select(m.store, [7])
    await vi.waitFor(() => expect(count(m.gl, 'drawElements')).toBe(1))

    expect(legendText(m.host)).toContain('iteration 6: obs_ens: no ensemble')
  })

  it('refuses a series whose rows do not match the site rather than pairing them by position', async () => {
    answerSite(sitePayload(), (iteration) => (iteration === 6 ? { count: 3 } : {}))
    const m = mount()
    select(m.store, [7])
    await vi.waitFor(() => expect(count(m.gl, 'drawElements')).toBe(1))

    expect(legendText(m.host).some((line) => line.includes('the series has 3 observations but the site has 4'))).toBe(true)
  })

  it('says how many observations have no time', async () => {
    answerSite(sitePayload({ time: [19000, Number.NaN, 19020, 19030] }))
    const m = mount()
    await drawn(m)

    expect(legendText(m.host)).toContain('1 observation has no time, so it is not drawn')
  })

  it('does not run its text together', async () => {
    loadRealStylesheet()
    answerSite(sitePayload({ weighted: [true, false, true, true], inequality: 'less' }), () => ({ nNaN: 1 }))
    const m = mount()
    await drawn(m)

    expectNoRunTogetherText(m.host, 'obs-spaghetti')
  })
})
