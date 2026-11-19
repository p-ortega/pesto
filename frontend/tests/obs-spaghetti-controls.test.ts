// @vitest-environment jsdom
//
// The controls of a site's time series: Enlarge, the scale and range switches, the show and
// hide buttons, the drag zoom and the hover readout. A recording GL and two recording 2D
// contexts stand in for the canvases, as in obs-spaghetti.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ObsSitePayload } from '../src/data/obs'
import { emptySelection } from '../src/state/rules'
import { createSelectionStore, type SelectionStore } from '../src/state/selection'
import { chartChoices, resetChartChoices } from '../src/ui/charts/choices'
import { closeEnlarged } from '../src/ui/charts/enlarge'
import { renderSpaghetti, type SpaghettiHandle } from '../src/ui/obs-spaghetti'
import { createRecording2d, type RecordedCall as Call2d } from './support/recording-2d'
import { createRecordingGl, type RecordedCall as CallGl } from './support/recording-gl'
import { expectNoRunTogetherText, loadRealStylesheet } from './support/run-together'

const obsApi = vi.hoisted(() => ({
  fetchObsSite: vi.fn(),
  fetchObsSeries: vi.fn(),
  fetchObsTimes: vi.fn(),
  fetchObsReals: vi.fn(),
  fetchObsGroupSets: vi.fn(),
}))
vi.mock('../src/data/obs', async () => ({
  ...(await vi.importActual<typeof import('../src/data/obs')>('../src/data/obs')),
  ...obsApi,
}))

const INK_MUTED = '#aabbcc'
const PLOT_LEFT = 48
const PLOT_WIDTH = 400 - 48 - 12

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

// Realization j of iteration k at time r is 10 + r + j / 2 + k / 10, so every value is known.
function seriesAnswer(id: number, iteration: number, nReal = 3, wild: number | null = null) {
  const count = 4
  const values = new Float32Array(count * nReal)
  for (let r = 0; r < count; r++) {
    for (let j = 0; j < nReal; j++) values[r * nReal + j] = 10 + r + j * 0.5 + iteration * 0.1
  }
  // One far-off realization: the last column, at every time.
  if (wild !== null) for (let r = 0; r < count; r++) values[r * nReal + nReal - 1] = wild
  return { ok: true, values, count, nReal, siteId: id, iteration, baseIndex: [1], baseNote: null, nNaN: 0, nSentinel: 0 }
}

function answerSite(payload: ObsSitePayload, nReal = 3, wild: number | null = null): void {
  obsApi.fetchObsSite.mockImplementation(async (id: number) => ({ ok: true, payload: { ...payload, site_id: id } }))
  obsApi.fetchObsSeries.mockImplementation(async (id: number, iteration: number) => seriesAnswer(id, iteration, nReal, wild))
}

interface Mounted {
  host: HTMLElement
  map: HTMLElement
  store: SelectionStore
  handle: SpaghettiHandle
  gl: CallGl[]
  back: Call2d[]
  front: Call2d[]
}

function mount(): Mounted {
  const map = document.createElement('div')
  map.classList.add('map-area')
  const host = document.createElement('div')
  document.body.append(map, host)
  const store = createSelectionStore({ initial: emptySelection('run', 0), schedule: () => {} })
  const { gl, calls } = createRecordingGl()
  const back = createRecording2d()
  const front = createRecording2d()
  const handle = renderSpaghetti(host, {
    store,
    createGl: () => gl,
    context2d: (layer) => (layer === 'back' ? back.ctx : front.ctx),
  })
  return { host, map, store, handle, gl: calls, back: back.calls, front: front.calls }
}

function select(store: SelectionStore, sites: number[]): void {
  store.set({ sites: new Set(sites) }, 'test')
  store.flush()
}

async function drawn(m: Mounted, ids = [7]): Promise<void> {
  select(m.store, ids)
  await vi.waitFor(() => expect(m.front.filter((c) => c.method === 'stroke').length).toBeGreaterThan(0))
}

function button(root: ParentNode, text: string): HTMLButtonElement {
  const found = [...root.querySelectorAll('button')].find((b) => b.textContent === text)
  if (!found) throw new Error(`no button reads "${text}"`)
  return found
}

function legendText(root: ParentNode): string[] {
  return [...root.querySelectorAll('.obs-spaghetti-legend > div')].map((el) => el.textContent ?? '')
}

/** The x and y range the line layer was last given, in its own units. */
function lastDomains(gl: CallGl[]): { x: [number, number]; y: [number, number] } {
  const sent = gl.filter((c) => c.method === 'uniform2f').slice(-2)
  return { x: [sent[0].args[1], sent[0].args[2]] as [number, number], y: [sent[1].args[1], sent[1].args[2]] as [number, number] }
}

function stripsInLastDraw(m: Mounted): number {
  const from = m.gl.map((c) => c.method).lastIndexOf('clear')
  return m.gl.slice(from).filter((c) => c.method === 'drawElements').length
}

function timePx(time: number): number {
  return PLOT_LEFT + ((time - 19000) / 30) * PLOT_WIDTH
}

function plot(root: ParentNode): HTMLElement {
  return root.querySelector<HTMLElement>('.obs-spaghetti-plot')!
}

function pointer(type: string, clientX: number): PointerEvent {
  return new PointerEvent(type, { clientX, clientY: 60, pointerId: 1, bubbles: true })
}

function dragAcross(el: HTMLElement, from: number, to: number): void {
  el.dispatchEvent(pointer('pointerdown', from))
  el.dispatchEvent(pointer('pointermove', to))
  el.dispatchEvent(pointer('pointerup', to))
}

beforeEach(() => {
  const style = document.documentElement.style
  style.setProperty('--ink-muted', INK_MUTED)
  style.setProperty('--series-1', '#ff8800')
  style.setProperty('--series-2', '#445566')
  style.setProperty('--ink-primary', '#010203')
  style.setProperty('--axis', '#070809')
  style.setProperty('--gridline', '#0a0b0c')
  style.setProperty('--accent', '#112233')
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(400)
  // A chart over the map is 600 px tall; in the side panel it keeps its 200 px.
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(function (this: Element) {
    return this.closest('.chart-enlarged') ? 600 : 200
  })
  vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockReturnValue(30)
  vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockReturnValue(0)
  for (const fn of Object.values(obsApi)) fn.mockReset()
  obsApi.fetchObsGroupSets.mockResolvedValue({ ok: true, orderDigest: 'd', rule: 'one value per group', sets: [], notes: [] })
  answerSite(sitePayload())
  // Most tests press the switches, so they start with the row of switches open.
  chartChoices.series.options = true
})

afterEach(() => {
  closeEnlarged()
  resetChartChoices()
  vi.restoreAllMocks()
  document.documentElement.removeAttribute('style')
  document.head.textContent = ''
  document.body.textContent = ''
})

describe('Enlarge on a site plot', () => {
  it('moves the plot over the map under the site name and redraws it at the new size', async () => {
    const m = mount()
    await drawn(m)
    const canvas = () => document.querySelector<HTMLCanvasElement>('.obs-spaghetti-front canvas')!
    expect(canvas().height).toBe(200)

    button(m.host, 'Enlarge').click()

    const panel = m.map.querySelector('.chart-enlarged-panel')!
    expect(panel.querySelector('.heading')!.textContent).toBe('well A')
    expect(panel.querySelector('.obs-spaghetti-plot')).not.toBeNull()
    expect(canvas().height).toBe(600)
    // The fixed side-panel height is off, so the plot fills the panel over the map.
    expect(plot(panel).style.height).toBe('')
    expect(m.host.textContent).toContain('The plot of well A is shown enlarged over the map')
    // Its controls came with it.
    expect(button(panel, 'log')).toBeTruthy()
  })

  it('puts the plot back at its side-panel size on Close and on Escape', async () => {
    const m = mount()
    await drawn(m)
    const canvas = () => document.querySelector<HTMLCanvasElement>('.obs-spaghetti-front canvas')!

    button(m.host, 'Enlarge').click()
    button(m.map, 'Close').click()
    expect(m.map.querySelector('.chart-enlarged')).toBeNull()
    expect(m.host.querySelector('.obs-spaghetti-plot')).not.toBeNull()
    expect(canvas().height).toBe(200)
    expect(plot(m.host).style.height).toBe('240px')

    button(m.host, 'Enlarge').click()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(m.map.querySelector('.chart-enlarged')).toBeNull()
    expect(m.host.querySelector('.obs-spaghetti-plot')).not.toBeNull()
  })

  it('shows only the enlarged site, and every selected site again once closed', async () => {
    const m = mount()
    await drawn(m, [7, 8])
    await vi.waitFor(() => expect(m.host.querySelectorAll('.obs-spaghetti-plot').length).toBe(2))

    m.host.querySelectorAll<HTMLButtonElement>('.chart-enlarge-button')[1].click()
    expect(m.map.querySelectorAll('.obs-spaghetti-plot').length).toBe(1)
    expect(m.host.querySelectorAll('.obs-spaghetti-plot').length).toBe(0)

    button(m.map, 'Close').click()
    expect(m.host.querySelectorAll('.obs-spaghetti-plot').length).toBe(2)
    // Nothing was fetched again for the site that was out of view.
    expect(obsApi.fetchObsSite).toHaveBeenCalledTimes(2)
  })

  it('closes when its site leaves the selection, never left showing a site that is not selected', async () => {
    const m = mount()
    await drawn(m, [7, 8])
    await vi.waitFor(() => expect(m.host.querySelectorAll('.obs-spaghetti-plot').length).toBe(2))
    m.host.querySelectorAll<HTMLButtonElement>('.chart-enlarge-button')[0].click()

    select(m.store, [8])

    expect(m.map.querySelector('.chart-enlarged')).toBeNull()
    expect(m.host.querySelectorAll('.obs-spaghetti-plot').length).toBe(1)
  })

  it('stays up, on the same site, when another site is added to the selection', async () => {
    const m = mount()
    await drawn(m)
    button(m.host, 'Enlarge').click()

    select(m.store, [7, 8])

    expect(m.map.querySelector('.heading')!.textContent).toBe('well A')
    expect(m.map.querySelectorAll('.obs-spaghetti-plot').length).toBe(1)
  })

  it('closes when the tab is hidden', async () => {
    const m = mount()
    await drawn(m)
    button(m.host, 'Enlarge').click()
    m.handle.onHide()
    expect(m.map.querySelector('.chart-enlarged')).toBeNull()
  })
})

describe('the scale switch', () => {
  it('draws the value axis on a log scale: the lines go up as log10 values on a log10 range', async () => {
    const m = mount()
    await drawn(m)
    expect(lastDomains(m.gl).y[1]).toBeGreaterThan(14)

    button(m.host, 'log').click()

    // The site's values run from 10 to 14.6, so one to about 1.16 in log10, padded by 5 percent.
    const span = Math.log10(14.6) - 1
    expect(lastDomains(m.gl).y[0]).toBeCloseTo(1 - span * 0.05, 4)
    expect(lastDomains(m.gl).y[1]).toBeCloseTo(Math.log10(14.6) + span * 0.05, 4)
    const uploads = m.gl.filter((c) => c.method === 'bufferData' && c.args[1] instanceof Float32Array)
    expect((uploads[uploads.length - 1].args[1] as Float32Array)[0]).toBeCloseTo(Math.log10(10.6), 5)
    expect(button(m.host, 'log').getAttribute('aria-pressed')).toBe('true')
    expect(button(m.host, 'linear').getAttribute('aria-pressed')).toBe('false')
    expect(legendText(m.host)).toContain('value axis: log scale')
  })

  it('refuses log with the reason as its tooltip when a value is zero or below, and stays linear', async () => {
    answerSite(sitePayload({ obsval: [-1, 11, 12, 13] }))
    const m = mount()
    await drawn(m)
    const before = lastDomains(m.gl).y
    const log = button(m.host, 'log')

    expect(log.getAttribute('aria-disabled')).toBe('true')
    expect(log.title).toBe("A log axis needs every value above zero, and this site's lowest value is -1.")
    log.click()

    expect(lastDomains(m.gl).y).toEqual(before)
    expect(button(m.host, 'linear').getAttribute('aria-pressed')).toBe('true')
    expect(chartChoices.series.scale).toBe('linear')
  })

  it('says in the legend why a site is drawn linear when log was chosen on another site', async () => {
    chartChoices.series.scale = 'log'
    answerSite(sitePayload({ obsval: [0, 11, 12, 13] }))
    const m = mount()
    await drawn(m)

    expect(legendText(m.host)).toContain("value axis: linear. A log axis needs every value above zero, and this site's lowest value is 0.")
    expect(button(m.host, 'linear').getAttribute('aria-pressed')).toBe('true')
  })

  it('is remembered for the next site plot in the same page session', async () => {
    const first = mount()
    await drawn(first)
    button(first.host, 'log').click()
    first.handle.dispose()

    const second = mount()
    await drawn(second)
    expect(button(second.host, 'log').getAttribute('aria-pressed')).toBe('true')
    expect(lastDomains(second.gl).y[1]).toBeLessThan(2)
  })
})

describe('the range switch', () => {
  it('fits every realization by default, so one far-off realization flattens the rest', async () => {
    answerSite(sitePayload(), 41, 1e6)
    const m = mount()
    await drawn(m)

    expect(button(m.host, 'fit all').getAttribute('aria-pressed')).toBe('true')
    expect(lastDomains(m.gl).y[1]).toBeGreaterThan(1e6)
  })

  it('fits the observed values and the 5th to 95th percentile on "fit observed", and counts what runs off', async () => {
    answerSite(sitePayload(), 41, 1e6)
    const m = mount()
    await drawn(m)

    button(m.host, 'fit observed').click()

    const y = lastDomains(m.gl).y
    expect(y[0]).toBeLessThan(10)
    expect(y[1]).toBeGreaterThan(13)
    expect(y[1]).toBeLessThan(40)
    // The far-off realization is still drawn; it leaves the plot at each of 4 times in 2 iterations.
    expect(stripsInLastDraw(m)).toBe(2)
    expect(legendText(m.host).some((line) => line.includes('8 realization values lie beyond it and run off the plot'))).toBe(true)
    expect(button(m.host, 'fit observed').getAttribute('aria-pressed')).toBe('true')
  })
})

describe('the show and hide buttons', () => {
  it('offers a button only for the parts the site has', async () => {
    const m = mount()
    await drawn(m)
    const shown = [...m.host.querySelectorAll('[aria-label="Parts of the plot that are shown"] button')].map((b) => b.textContent)

    // This site has no noise band, so there is nothing to hide.
    expect(shown).toEqual(['first iteration', 'last iteration', 'observed', 'base'])
  })

  it('hides the first iteration from the plot and from the legend', async () => {
    const m = mount()
    await drawn(m)
    expect(stripsInLastDraw(m)).toBe(2)
    expect(legendText(m.host)).toContain('first iteration 0: 3 realizations')

    button(m.host, 'first iteration').click()

    expect(stripsInLastDraw(m)).toBe(1)
    expect(legendText(m.host).some((line) => line.startsWith('first iteration'))).toBe(false)
    expect(legendText(m.host)).toContain('last iteration 6: 3 realizations')
    expect(button(m.host, 'first iteration').getAttribute('aria-pressed')).toBe('false')

    button(m.host, 'first iteration').click()
    expect(stripsInLastDraw(m)).toBe(2)
    expect(legendText(m.host)).toContain('first iteration 0: 3 realizations')
  })

  it('hides the observed markers and their legend line', async () => {
    const m = mount()
    await drawn(m)
    expect(legendText(m.host)).toContain('filled marker: observed value, weight above zero')

    m.front.length = 0
    button(m.host, 'observed').click()

    expect(m.front.filter((c) => c.method === 'arc').length).toBe(0)
    expect(legendText(m.host).some((line) => line.includes('marker'))).toBe(false)
  })

  it('hides base and its legend line, and the noise band and its line', async () => {
    answerSite(
      sitePayload({
        noise: { available: true, q05: [9, 10, 11, 12], q95: [11, 12, 13, 14], source: 'pest_noise.csv', base: 'excluded', n_real_used: 100 },
      }),
    )
    const m = mount()
    await drawn(m)
    const wide = (calls: Call2d[]) => calls.filter((c) => c.method === 'stroke' && c.state.lineWidth === 2.5).length
    expect(wide(m.front)).toBeGreaterThan(0)
    expect(m.back.filter((c) => c.method === 'fill').length).toBeGreaterThan(0)

    button(m.host, 'base').click()
    m.front.length = 0
    m.back.length = 0
    button(m.host, 'noise band').click()

    expect(wide(m.front)).toBe(0)
    expect(m.back.filter((c) => c.method === 'fill').length).toBe(0)
    expect(legendText(m.host).some((line) => line.startsWith('base:'))).toBe(false)
    expect(legendText(m.host).some((line) => line.startsWith('noise band:'))).toBe(false)
  })

  it('keeps focus on the pressed button when the panel is rebuilt', async () => {
    const m = mount()
    await drawn(m)
    const pressed = button(m.host, 'base')
    pressed.focus()
    pressed.click()

    expect(document.activeElement).toBe(button(m.host, 'base'))
    expect(document.activeElement).not.toBe(pressed)
  })
})

describe('zoom on the time axis', () => {
  it('zooms to the dragged time range, says so, and resets on a double-click', async () => {
    const m = mount()
    await drawn(m)
    expect(lastDomains(m.gl).x).toEqual([0, 30])

    dragAcross(plot(m.host), timePx(19005), timePx(19025))

    // The line layer counts days from the site's first time.
    expect(lastDomains(m.gl).x[0]).toBeCloseTo(5, 3)
    expect(lastDomains(m.gl).x[1]).toBeCloseTo(25, 3)
    expect(legendText(m.host).some((line) => line.startsWith('zoomed to 2022-01-13') && line.includes('2 of 4 observation times in view'))).toBe(true)

    plot(m.host).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))

    expect(lastDomains(m.gl).x).toEqual([0, 30])
    expect(legendText(m.host).some((line) => line.startsWith('zoomed to'))).toBe(false)
  })

  it('fits the value axis to what is in view', async () => {
    const m = mount()
    await drawn(m)
    const whole = lastDomains(m.gl).y

    dragAcross(plot(m.host), timePx(19005), timePx(19015))

    // Only day 19010 is in view: values 11 (observed) to 12.6.
    expect(lastDomains(m.gl).y[0]).toBeGreaterThan(whole[0])
    expect(lastDomains(m.gl).y[1]).toBeLessThan(13)
  })

  it('offers a Reset zoom button only while zoomed, for the keyboard', async () => {
    const m = mount()
    await drawn(m)
    expect([...m.host.querySelectorAll('button')].some((b) => b.textContent === 'Reset zoom')).toBe(false)

    dragAcross(plot(m.host), timePx(19005), timePx(19025))
    button(m.host, 'Reset zoom').click()

    expect(lastDomains(m.gl).x).toEqual([0, 30])
    expect([...m.host.querySelectorAll('button')].some((b) => b.textContent === 'Reset zoom')).toBe(false)
  })

  it('shows the band while dragging and treats a press without a drag as nothing', async () => {
    const m = mount()
    await drawn(m)
    const el = plot(m.host)

    m.front.length = 0
    el.dispatchEvent(pointer('pointerdown', timePx(19005)))
    el.dispatchEvent(pointer('pointermove', timePx(19020)))
    const band = m.front.filter((c) => c.method === 'fillRect')
    expect(band.length).toBe(1)
    expect(band[0].args[0]).toBeCloseTo(timePx(19005), 3)
    el.dispatchEvent(pointer('pointercancel', timePx(19020)))

    el.dispatchEvent(pointer('pointerdown', timePx(19005)))
    el.dispatchEvent(pointer('pointerup', timePx(19005) + 1))
    expect(lastDomains(m.gl).x).toEqual([0, 30])
  })
})

describe('the hover readout', () => {
  it('names the nearest time and gives the observed value and each iteration\'s mean and spread there', async () => {
    const m = mount()
    await drawn(m)
    const readout = m.host.querySelector<HTMLElement>('.chart-readout')!
    expect(readout.hidden).toBe(true)

    m.front.length = 0
    plot(m.host).dispatchEvent(pointer('pointermove', timePx(19011)))

    expect(readout.hidden).toBe(false)
    expect([...readout.children].map((el) => el.textContent)).toEqual([
      '2022-01-18',
      'observed 11',
      'last iteration 6: mean 12.1, 5th to 95th percentile 11.65 to 12.55',
      'base, iteration 6: 12.1',
      'first iteration 0: mean 11.5, 5th to 95th percentile 11.05 to 11.95',
      'base, iteration 0: 11.5',
    ])
    // A hairline in muted ink at that time, apart from the accent line of the map's time.
    const cursor = m.front.filter((c) => c.method === 'moveTo' && Math.abs((c.args[0] as number) - timePx(19010)) < 1e-6)
    expect(cursor.some((c) => c.state.strokeStyle === INK_MUTED && c.args[1] === 38)).toBe(true)
  })

  it('leaves out a hidden part and goes away when the pointer leaves', async () => {
    const m = mount()
    await drawn(m)
    button(m.host, 'first iteration').click()
    button(m.host, 'base').click()
    const readout = () => m.host.querySelector<HTMLElement>('.chart-readout')!

    plot(m.host).dispatchEvent(pointer('pointermove', timePx(19020)))
    expect([...readout().children].map((el) => el.textContent)).toEqual([
      '2022-01-28',
      'observed 12',
      'last iteration 6: mean 13.1, 5th to 95th percentile 12.65 to 13.55',
    ])

    plot(m.host).dispatchEvent(new PointerEvent('pointerleave', { pointerId: 1 }))
    expect(readout().hidden).toBe(true)
  })

  it('says so when the observation at that time has no measured value', async () => {
    answerSite(sitePayload({ obsval: [10, null, 12, 13], no_value: [false, true, false, false] }))
    const m = mount()
    await drawn(m)

    plot(m.host).dispatchEvent(pointer('pointermove', timePx(19010)))

    expect(m.host.querySelector('.chart-readout')!.textContent).toContain('observed: no measured value')
  })
})

describe('the controls of a site plot', () => {
  it('keeps the switches folded away in the side panel until Plot options is pressed, and remembers it', async () => {
    chartChoices.series.options = false
    const m = mount()
    await drawn(m)
    const toolbar = () => m.host.querySelector<HTMLElement>('.chart-toolbar')!
    expect(toolbar().hidden).toBe(true)
    expect(button(m.host, 'Plot options').getAttribute('aria-expanded')).toBe('false')

    button(m.host, 'Plot options').focus()
    button(m.host, 'Plot options').click()

    expect(toolbar().hidden).toBe(false)
    expect(button(m.host, 'Plot options').getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(button(m.host, 'Plot options'))
    expect(chartChoices.series.options).toBe(true)
  })

  it('always shows the switches on the enlarged plot', async () => {
    chartChoices.series.options = false
    const m = mount()
    await drawn(m)

    button(m.host, 'Enlarge').click()

    expect(m.map.querySelector<HTMLElement>('.chart-toolbar')!.hidden).toBe(false)
  })

  it('never run their labels and buttons together', async () => {
    loadRealStylesheet()
    const m = mount()
    await drawn(m)
    plot(m.host).dispatchEvent(pointer('pointermove', timePx(19010)))
    expectNoRunTogetherText(m.host, 'obs-spaghetti.ts controls')
  })

  it('use plain words: no "source", "chip" or "drill-down" on a control or its tooltip', async () => {
    const m = mount()
    await drawn(m)
    const words = [...m.host.querySelectorAll('button')].map((b) => `${b.textContent} ${b.title}`.toLowerCase()).join(' ')
    for (const word of ['source', 'chip', 'drill-down']) expect(words).not.toContain(word)
  })
})
