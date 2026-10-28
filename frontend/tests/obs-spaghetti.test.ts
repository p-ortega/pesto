// @vitest-environment jsdom
//
// The spaghetti plot: what it fetches, what it hands the line layer and what it draws on the two
// 2D layers. jsdom has no WebGL2 and no 2D context, so a recording GL and two recording 2D
// contexts stand in, and a test asks which calls were made.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ObsSitePayload } from '../src/data/obs'
import { emptySelection } from '../src/state/rules'
import { createSelectionStore, type SelectionStore } from '../src/state/selection'
import { BASE_STYLE } from '../src/ui/charts/base-style'
import { MAX_BOLD_REALS, renderSpaghetti, type SpaghettiHandle, type SpaghettiOptions } from '../src/ui/obs-spaghetti'
import { createRecording2d, type RecordedCall as Call2d } from './support/recording-2d'
import { createRecordingGl, type RecordedCall as CallGl } from './support/recording-gl'
import { expectNoRunTogetherText, loadRealStylesheet } from './support/run-together'

const obsApi = vi.hoisted(() => ({
  fetchObsSite: vi.fn(),
  fetchObsSeries: vi.fn(),
  fetchObsTimes: vi.fn(),
  fetchObsReals: vi.fn(),
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
  nSentinel?: number
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
    nSentinel: over.nSentinel ?? 0,
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
  obsApi.fetchObsReals.mockReset()
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
  it('is one bold polyline per iteration in that iteration colour, with the one base style', async () => {
    const m = mount()
    await drawn(m)

    const bold = boldLines(m.front)
    expect(bold.map((b) => b.colour)).toEqual([INK_MUTED, SERIES_1])
    expect(legendText(m.host)).toContain(BASE_STYLE.legend)
    for (const line of bold) {
      expect(line.width).toBe(BASE_STYLE.lineWidth)
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

describe('a site with a very long record', () => {
  it('is drawn, however many observations it has', async () => {
    const n = 300_000
    const fill = <T>(v: T): T[] => new Array<T>(n).fill(v)
    answerSite(
      sitePayload({
        n_obs: n,
        time: Array.from({ length: n }, (_, i) => 19000 + i),
        obsval: fill(1),
        no_value: fill(false),
        sentinel: fill(false),
        weighted: fill(true),
      }),
      () => ({ count: n, nReal: 1 }),
    )
    const { store, gl } = mount()
    select(store, [7])

    await vi.waitFor(() => expect(count(gl, 'drawElements')).toBe(2))
    expect(count(gl, 'drawElements')).toBe(2)
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

  it('counts a sentinel simulated value apart from a missing one', async () => {
    answerSite(sitePayload(), () => ({ nSentinel: 3 }))
    const m = mount()
    await drawn(m)

    expect(legendText(m.host)).toContain(
      '6 simulated values are a sentinel (a dry or no-flow placeholder) and left out; their lines break there',
    )
  })

  it('does not run its text together', async () => {
    loadRealStylesheet()
    answerSite(sitePayload({ weighted: [true, false, true, true], inequality: 'less' }), () => ({ nNaN: 1 }))
    const m = mount()
    await drawn(m)

    expectNoRunTogetherText(m.host, 'obs-spaghetti')
  })
})

describe('several sites', () => {
  it('draws 8 of 10 selected sites top to bottom and counts the rest', async () => {
    const m = mount()
    select(m.store, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    await vi.waitFor(() => expect(count(m.gl, 'scissor')).toBe(8))

    expect(count(m.gl, 'viewport')).toBe(8)
    expect(count(m.gl, 'drawElements')).toBe(16)
    expect(obsApi.fetchObsSite).toHaveBeenCalledTimes(8)
    expect(m.host.textContent).toContain('2 more selected sites are not drawn')
    // The viewport's y counts from the bottom, so a panel lower on the page has a smaller y.
    const ys = m.gl.filter((c) => c.method === 'viewport').map((c) => c.args[1] as number)
    expect(ys).toEqual([...ys].sort((a, b) => b - a))
    expect(new Set(ys).size).toBe(8)
  })

  it('says "1 more selected site is not drawn" for one over', async () => {
    const m = mount()
    select(m.store, [1, 2, 3, 4, 5, 6, 7, 8, 9])
    await vi.waitFor(() => expect(count(m.gl, 'scissor')).toBe(8))

    expect(m.host.textContent).toContain('1 more selected site is not drawn')
  })

  it('removes a deselected site from the layer', async () => {
    const m = mount()
    select(m.store, [7])
    await vi.waitFor(() => expect(count(m.gl, 'drawElements')).toBe(2))
    expect(count(m.gl, 'deleteTexture')).toBe(0)

    select(m.store, [])
    expect(count(m.gl, 'deleteTexture')).toBe(2)
    expect(count(m.gl, 'deleteBuffer')).toBe(4)
    expect(m.host.querySelectorAll('.obs-spaghetti-panel')).toHaveLength(0)
  })

  it('keeps a site it already holds when another is added, and asks only for the new one', async () => {
    const m = mount()
    select(m.store, [7])
    await vi.waitFor(() => expect(count(m.gl, 'drawElements')).toBe(2))

    select(m.store, [7, 8])
    // One panel at once for the first site, one when the new site starts loading, two when it arrives.
    await vi.waitFor(() => expect(count(m.gl, 'scissor')).toBe(4))

    expect(obsApi.fetchObsSite.mock.calls.map((c) => c[0])).toEqual([7, 8])
  })

  it('shows a site the server refused with its reason, beside the others', async () => {
    obsApi.fetchObsSite.mockImplementation(async (id: number) =>
      id === 8
        ? { ok: false, artifact: 'obs_index', reason: 'no such site' }
        : { ok: true, payload: sitePayload({ site_id: id }) },
    )
    const m = mount()
    select(m.store, [7, 8])
    await vi.waitFor(() => expect(m.host.textContent).toContain('obs_index: no such site'))

    expect(count(m.gl, 'scissor')).toBe(1)
  })

  it('refuses an answer that names a different site than the one asked for', async () => {
    obsApi.fetchObsSite.mockResolvedValue({ ok: true, payload: sitePayload({ site_id: 99 }) })
    const m = mount()
    select(m.store, [7])
    await vi.waitFor(() => expect(m.host.textContent).toContain('the server answered for site 99, not site 7'))

    expect(count(m.gl, 'drawElements')).toBe(0)
  })
})

describe('the cursor at the map time', () => {
  function timesAnswer(times: number[]) {
    return { ok: true, payload: { group: 'gw_head', times, refused: null, notes: [] } }
  }

  // Cursor strokes are the only 1 px strokes in the accent colour.
  function cursors(calls: Call2d[]): Call2d[] {
    return calls.filter((c) => c.method === 'stroke' && c.state.strokeStyle === ACCENT)
  }

  function cursorX(calls: Call2d[]): number[] {
    const out: number[] = []
    calls.forEach((c, i) => {
      if (c.method === 'stroke' && c.state.strokeStyle === ACCENT) out.push(calls[i - 2].args[0] as number)
    })
    return out
  }

  beforeEach(() => {
    obsApi.fetchObsTimes.mockResolvedValue(timesAnswer([19000, 19010, 19020, 19030]))
    obsApi.fetchObsSite.mockImplementation(async (id: number) => ({
      ok: true,
      payload: sitePayload({ site_id: id, group: id === 7 ? 'gw_head' : 'surface_flow' }),
    }))
  })

  it('shows for a site of the group colouring the map, and not for a site of another group', async () => {
    const m = mount()
    select(m.store, [7, 8], { colour: { source: 'obs', stat: 'rmse' }, obsGroups: new Set(['gw_head']), timeIdx: 1 })
    await vi.waitFor(() => expect(cursors(m.front)).toHaveLength(1))

    expect(obsApi.fetchObsTimes).toHaveBeenCalledTimes(1)
    expect(obsApi.fetchObsTimes.mock.calls[0][0]).toBe('gw_head')
  })

  it('does not show when the map is coloured by a parameter', async () => {
    const m = mount()
    select(m.store, [7], { colour: { source: 'par', stat: 'value' }, obsGroups: new Set(['gw_head']), timeIdx: 1 })
    await vi.waitFor(() => expect(count(m.gl, 'drawElements')).toBe(2))

    expect(cursors(m.front)).toHaveLength(0)
    expect(obsApi.fetchObsTimes).not.toHaveBeenCalled()
  })

  it('moves with the time index and redraws only the front layer, with no new request', async () => {
    const m = mount()
    select(m.store, [7], { colour: { source: 'obs', stat: 'rmse' }, obsGroups: new Set(['gw_head']), timeIdx: 1 })
    await vi.waitFor(() => expect(cursors(m.front)).toHaveLength(1))
    const before = { back: m.back.length, gl: m.gl.length, seriesAsks: obsApi.fetchObsSeries.mock.calls.length }
    const x1 = cursorX(m.front)[0]

    m.store.set({ timeIdx: 3 }, 'test')
    m.store.flush()

    const xs = cursorX(m.front)
    expect(xs).toHaveLength(2)
    expect(xs[1]).toBeGreaterThan(x1)
    expect(m.back.length).toBe(before.back)
    expect(m.gl.length).toBe(before.gl)
    expect(obsApi.fetchObsSeries.mock.calls.length).toBe(before.seriesAsks)
    expect(obsApi.fetchObsSite).toHaveBeenCalledTimes(1)
    expect(obsApi.fetchObsTimes).toHaveBeenCalledTimes(1)
  })

  it('says why when the times cannot be read, instead of silently drawing no cursor', async () => {
    obsApi.fetchObsTimes.mockResolvedValue({ ok: false, artifact: 'obs_index', reason: 'no times' })
    const m = mount()
    select(m.store, [7], { colour: { source: 'obs', stat: 'rmse' }, obsGroups: new Set(['gw_head']), timeIdx: 1 })
    await vi.waitFor(() => expect(m.host.textContent).toContain('The map-time cursor is not drawn: obs_index: no times'))

    expect(cursors(m.front)).toHaveLength(0)
  })
})

describe('a hidden tab and a lost context', () => {
  it('fetches and draws nothing while hidden, and once when shown', async () => {
    const m = mount({ startHidden: true })
    select(m.store, [7])
    expect(obsApi.fetchObsSite).not.toHaveBeenCalled()
    expect(m.host.querySelector('canvas')).toBeNull()

    m.handle.onShow()
    await vi.waitFor(() => expect(count(m.gl, 'drawElements')).toBe(2))
    expect(obsApi.fetchObsSite).toHaveBeenCalledTimes(1)
  })

  it('fetches nothing for a change made while hidden after it was shown, until it is shown again', async () => {
    const m = mount()
    select(m.store, [7])
    await vi.waitFor(() => expect(count(m.gl, 'drawElements')).toBe(2))

    m.handle.onHide()
    select(m.store, [7, 8])
    expect(obsApi.fetchObsSite).toHaveBeenCalledTimes(1)
    const quiet = m.gl.length

    m.handle.onShow()
    await vi.waitFor(() => expect(obsApi.fetchObsSite).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(m.gl.length).toBeGreaterThan(quiet))
    expect(obsApi.fetchObsSite.mock.calls.map((c) => c[0])).toEqual([7, 8])
  })

  it('draws the same lines after the context is lost and restored, with no new request', async () => {
    const m = mount()
    select(m.store, [7])
    await vi.waitFor(() => expect(count(m.gl, 'drawElements')).toBe(2))
    const firstDraw = m.gl.filter((c) => c.method === 'drawElements').map((c) => c.args)
    const uploads = count(m.gl, 'bufferData')
    const seriesAsks = obsApi.fetchObsSeries.mock.calls.length

    m.glCanvas().dispatchEvent(new Event('webglcontextlost'))
    m.glCanvas().dispatchEvent(new Event('webglcontextrestored'))

    expect(count(m.gl, 'bufferData')).toBe(uploads * 2)
    const draws = m.gl.filter((c) => c.method === 'drawElements').map((c) => c.args)
    expect(draws).toEqual([...firstDraw, ...firstDraw])
    expect(obsApi.fetchObsSeries.mock.calls.length).toBe(seriesAsks)
    expect(obsApi.fetchObsSite).toHaveBeenCalledTimes(1)
  })

  it('draws no lines while the context is lost', async () => {
    const m = mount()
    select(m.store, [7])
    await vi.waitFor(() => expect(count(m.gl, 'drawElements')).toBe(2))

    m.glCanvas().dispatchEvent(new Event('webglcontextlost'))
    m.handle.onHide()
    m.handle.onShow()

    expect(count(m.gl, 'drawElements')).toBe(2)
  })

  it('says so, and still draws the markers, when the browser has no WebGL2', async () => {
    const m = mount({ createGl: () => null })
    select(m.store, [7])
    await vi.waitFor(() => expect(count(m.front, 'arc')).toBe(4))

    expect(m.host.textContent).toContain('The realization lines could not be drawn')
  })

  it('stops following the selection once disposed', async () => {
    const m = mount()
    m.handle.dispose()
    select(m.store, [7])

    expect(obsApi.fetchObsSite).not.toHaveBeenCalled()
  })
})

describe('a named realization selection', () => {
  const DIM = 0.35
  const N = 10
  // Iteration 0 has no r7; iteration 6 holds the same names in another order, so a match by
  // position would land on the wrong columns.
  const NAMES: Record<number, string[]> = {
    0: ['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r8', 'r9', 'r10'],
    6: Array.from({ length: N }, (_, j) => `r${(j + 3) % N}`),
  }

  function answerNames(names: Record<number, string[]> = NAMES): void {
    obsApi.fetchObsReals.mockImplementation(async (iteration: number) => ({
      ok: true,
      payload: { iteration, names: names[iteration], base_index: [1], base_note: null },
    }))
  }

  function setReals(store: SelectionStore, reals: ReadonlySet<string> | 'all'): void {
    store.set({ reals }, 'header')
    store.flush()
  }

  interface Line {
    colour: unknown
    width: number
    points: Array<[number, number]>
  }

  // Every stroked path of the last frame drawn on the front layer, in drawing order.
  function lastFrame(calls: Call2d[]): Line[] {
    const start = calls.map((c) => c.method).lastIndexOf('setTransform')
    const out: Line[] = []
    let points: Array<[number, number]> = []
    for (const call of calls.slice(start)) {
      if (call.method === 'beginPath') points = []
      else if (call.method === 'moveTo' || call.method === 'lineTo') points.push(call.args as [number, number])
      else if (call.method === 'stroke') out.push({ colour: call.state.strokeStyle, width: call.state.lineWidth, points })
    }
    return out
  }

  function selectedLines(calls: Call2d[], colour?: string): Line[] {
    return lastFrame(calls).filter((l) => l.width === 1.25 && (colour === undefined || l.colour === colour))
  }

  // Values are 10 + row + 0.5 * column, so a line's column follows from its first y against
  // base's (column 1) first two rows, which are one value unit apart.
  function columnOf(line: Line, base: Line): number {
    const unit = base.points[1][1] - base.points[0][1]
    return Math.round(1 + (2 * (line.points[0][1] - base.points[0][1])) / unit)
  }

  function stripAlphas(gl: CallGl[]): number[] {
    return gl.filter((c) => c.method === 'uniform4f').map((c) => (c.args as number[])[4])
  }

  beforeEach(() => {
    document.documentElement.style.setProperty('--dim-alpha', String(DIM))
    answerSite(sitePayload(), () => ({ nReal: N }))
    answerNames()
  })

  it('asks nothing and fades nothing while every realization is selected', async () => {
    const m = mount()
    await drawn(m)
    await vi.waitFor(() => expect(count(m.gl, 'drawElements')).toBe(2))

    expect(obsApi.fetchObsReals).not.toHaveBeenCalled()
    stripAlphas(m.gl).forEach((a) => expect(a).toBeCloseTo(0.15, 5))
    expect(selectedLines(m.front)).toHaveLength(0)
  })

  it('fades the strips and draws the selected ones over them, found by name in each iteration', async () => {
    const m = mount()
    await drawn(m)
    setReals(m.store, new Set(['r2', 'r7']))
    await vi.waitFor(() => expect(selectedLines(m.front)).toHaveLength(3))

    expect(obsApi.fetchObsReals.mock.calls.map((c) => c[0]).sort()).toEqual([0, 6])
    stripAlphas(m.gl).slice(-2).forEach((a) => expect(a).toBeCloseTo(0.15 * DIM, 5))

    const frame = lastFrame(m.front)
    const base = (colour: string) => frame.find((l) => l.width === BASE_STYLE.lineWidth && l.colour === colour)!
    // Iteration 0 holds r2 in column 2 and no r7.
    expect(selectedLines(m.front, INK_MUTED).map((l) => columnOf(l, base(INK_MUTED)))).toEqual([2])
    // Iteration 6 holds r2 in column 9 and r7 in column 4.
    expect(selectedLines(m.front, SERIES_1).map((l) => columnOf(l, base(SERIES_1))).sort()).toEqual([4, 9])
    // Base goes on top: every selected line is stroked before the first base line.
    const firstBase = frame.findIndex((l) => l.width === BASE_STYLE.lineWidth)
    const lastSelected = frame.map((l) => l.width).lastIndexOf(1.25)
    expect(lastSelected).toBeLessThan(firstBase)
    expect(legendText(m.host)).toContain('selected realizations: drawn in the colour of their iteration over the faded rest')
  })

  it('counts the selected realizations an iteration does not hold', async () => {
    const m = mount()
    await drawn(m)
    setReals(m.store, new Set(['r2', 'r7']))
    await vi.waitFor(() => expect(legendText(m.host)).toContain('1 of 2 selected realizations is not in iteration 0'))

    expect(legendText(m.host).some((line) => line.includes('not in iteration 6'))).toBe(false)
  })

  it('draws at most 50 over the strips and says how many more were not', async () => {
    const names = Array.from({ length: 60 }, (_, j) => `r${j}`)
    answerSite(sitePayload(), () => ({ nReal: 60 }))
    answerNames({ 0: names, 6: names })
    const m = mount()
    await drawn(m)
    setReals(m.store, new Set(names))
    await vi.waitFor(() =>
      expect(legendText(m.host)).toContain('10 more selected realizations are not drawn bold: at most 50 are'),
    )

    expect(MAX_BOLD_REALS).toBe(50)
    expect(selectedLines(m.front)).toHaveLength(2 * 50)
  })

  it('does not fade the strips when the names cannot be read, and says why', async () => {
    obsApi.fetchObsReals.mockResolvedValue({ ok: false, artifact: 'obs_ens/0', reason: 'no names were recorded' })
    const m = mount()
    await drawn(m)
    setReals(m.store, new Set(['r2']))
    await vi.waitFor(() =>
      expect(legendText(m.host)).toContain('the selection cannot be shown: obs_ens/0: no names were recorded'),
    )

    stripAlphas(m.gl).slice(-2).forEach((a) => expect(a).toBeCloseTo(0.15, 5))
    expect(selectedLines(m.front)).toHaveLength(0)
  })

  it('refuses names that answer for another iteration', async () => {
    obsApi.fetchObsReals.mockImplementation(async () => ({
      ok: true,
      payload: { iteration: 3, names: NAMES[0], base_index: [1], base_note: null },
    }))
    const m = mount()
    await drawn(m)
    setReals(m.store, new Set(['r2']))
    await vi.waitFor(() =>
      expect(legendText(m.host)).toContain(
        'the selection cannot be shown: the server answered with the names of iteration 3, not 0',
      ),
    )
    expect(selectedLines(m.front)).toHaveLength(0)
  })

  it('refuses names that do not match the series column for column', async () => {
    answerNames({ 0: NAMES[0].slice(0, 9), 6: NAMES[6] })
    const m = mount()
    await drawn(m)
    setReals(m.store, new Set(['r2']))
    await vi.waitFor(() =>
      expect(legendText(m.host)).toContain(
        'the selection cannot be shown: iteration 0 has 9 realization names but its series has 10 columns',
      ),
    )
    // Iteration 6 still draws its own.
    expect(selectedLines(m.front, SERIES_1)).toHaveLength(1)
    expect(selectedLines(m.front, INK_MUTED)).toHaveLength(0)
  })

  it('reads each iteration once, however often the selection changes, and restores the strips on all', async () => {
    const m = mount()
    await drawn(m)
    setReals(m.store, new Set(['r2', 'r7']))
    await vi.waitFor(() => expect(selectedLines(m.front)).toHaveLength(3))
    setReals(m.store, new Set(['r2']))
    await vi.waitFor(() => expect(selectedLines(m.front)).toHaveLength(2))
    expect(obsApi.fetchObsReals).toHaveBeenCalledTimes(2)

    setReals(m.store, 'all')
    stripAlphas(m.gl).slice(-2).forEach((a) => expect(a).toBeCloseTo(0.15, 5))
    expect(selectedLines(m.front)).toHaveLength(0)
    expect(legendText(m.host).some((line) => line.startsWith('selected realizations'))).toBe(false)
  })

  it('asks nothing while hidden, and follows a change made while hidden once shown', async () => {
    const m = mount()
    await drawn(m)
    m.handle.onHide()
    setReals(m.store, new Set(['r2']))
    expect(obsApi.fetchObsReals).not.toHaveBeenCalled()

    m.handle.onShow()
    await vi.waitFor(() => expect(selectedLines(m.front)).toHaveLength(2))
    expect(obsApi.fetchObsReals).toHaveBeenCalledTimes(2)
  })

  it('does not run its text together', async () => {
    loadRealStylesheet()
    const m = mount()
    await drawn(m)
    setReals(m.store, new Set(['r2', 'r7']))
    await vi.waitFor(() => expect(legendText(m.host)).toContain('1 of 2 selected realizations is not in iteration 0'))

    expectNoRunTogetherText(m.host, 'obs-spaghetti')
  })
})
