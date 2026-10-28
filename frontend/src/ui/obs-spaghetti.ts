// The spaghetti plot of the Obs tab: every realization of the first and last
// iteration of each selected site. The lines go through one WebGL2 line layer
// on one shared canvas, one viewport per panel. The axes and noise band sit on
// a Canvas 2D layer behind it; base, markers and the map-time cursor sit on a
// Canvas 2D layer in front. Titles and legends are DOM text, and every string
// that came from a run goes in through textContent.

import { LatestWins } from '../data/latest-wins'
import {
  fetchObsSeries,
  fetchObsSite,
  fetchObsTimes,
  shareRead,
  type ObsSeriesResult,
  type ObsSitePayload,
  type ObsTimesResult,
} from '../data/obs'
import { readColorToken } from '../gl/color-token'
import { createContext, type GlContext } from '../gl/context'
import { LineLayer, type LinePanel, type LineSeries } from '../gl/line-layer'
import type { SelectionStore } from '../state/selection'
import { linearAxis } from './charts/axes'
import { createCanvasHost, type CanvasHost } from './charts/canvas-host'
import type { Chart2D, ChartSize } from './charts/histogram'
import { drawBand, drawCursor, drawMarkers, drawPolyline, type MarkerPoint } from './charts/marks'
import { timeAxis, timeAxisTitle } from './charts/time-axis'
import { readChartTokens, type ChartTokens } from './charts/tokens'

export interface SpaghettiOptions {
  store: SelectionStore
  /** True when the tab is not the open one: nothing is fetched or drawn until onShow. */
  startHidden?: boolean
  /** Only for tests: the graphics context to draw lines with. */
  createGl?: (canvas: HTMLCanvasElement) => WebGL2RenderingContext | null
  /** Only for tests: the 2D context of the layer behind or in front of the lines. */
  context2d?: (layer: 'back' | 'front') => Chart2D | null
}

export interface SpaghettiHandle {
  onShow(): void
  onHide(): void
  dispose(): void
}

export const MAX_SPAGHETTI_PANELS = 8

const PANEL_HEIGHT = 200
// Room inside a panel's box for tick labels (left) and ticks plus the axis title (bottom).
const MARGIN = { left: 48, right: 12, top: 8, bottom: 34 }
const MIN_INNER_PX = 20
const FONT = '11px system-ui, sans-serif'
const BASE_WIDTH = 2.5
const MARKER_RADIUS = 3
const BAND_ALPHA = 0.2
const STRIP_ALPHA = 0.15
// More realizations than this are drawn fainter, so a dense ensemble stays readable.
const ALPHA_FULL_UNTIL = 300
const MIN_STRIP_ALPHA = 0.02

type Role = 'first' | 'last' | 'only'

interface PreparedSeries {
  iteration: number
  role: Role
  key: string
  nReal: number
  count: number
  values: Float32Array
  baseIndex: number[]
  baseNote: string | null
  nNaN: number
  line: LineSeries
}

interface PreparedSite {
  site: ObsSitePayload
  series: PreparedSeries[]
  /** Series the server refused, or that did not fit the site, each with its reason. */
  problems: string[]
  xLo: number
  xHi: number
  /** Subtracted from every time before it becomes a float32 x offset. */
  t0: number
  yDomain: [number, number]
  noTime: number
  unordered: boolean
}

type SiteEntry = { ok: true; prepared: PreparedSite } | { ok: false; reason: string }

interface PanelView {
  id: number
  entry: SiteEntry | undefined
  plot: HTMLElement | null
}

interface Geometry {
  x0: number
  y0: number
  x1: number
  y1: number
}

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`
}

function firstOf(set: ReadonlySet<string>): string | null {
  const first = set.values().next()
  return first.done ? null : first.value
}

/** True when the observation has a measured value that can be drawn as a marker. */
function hasMarker(site: ObsSitePayload, i: number): boolean {
  const value = site.obsval[i]
  return value !== null && Number.isFinite(value) && !site.sentinel[i] && !site.no_value[i]
}

function stripAlpha(nReal: number): number {
  return Math.max(MIN_STRIP_ALPHA, STRIP_ALPHA * Math.min(1, ALPHA_FULL_UNTIL / Math.max(1, nReal)))
}

function pickIterations(iterations: number[]): Array<{ iteration: number; role: Role }> {
  const sorted = [...iterations].sort((a, b) => a - b)
  if (sorted.length === 0) return []
  if (sorted.length === 1) return [{ iteration: sorted[0], role: 'only' }]
  return [
    { iteration: sorted[0], role: 'first' },
    { iteration: sorted[sorted.length - 1], role: 'last' },
  ]
}

function prepare(
  id: number,
  site: ObsSitePayload,
  wanted: Array<{ iteration: number; role: Role }>,
  results: ObsSeriesResult[],
): PreparedSite {
  const times = site.time
  const finiteTimes = times.filter(Number.isFinite)
  const problems: string[] = []
  if (wanted.length === 0) problems.push('the site has no iteration with realizations')

  // A loop, not Math.min(...times): spreading a very long array into arguments overflows the stack.
  let t0 = Number.POSITIVE_INFINITY
  let tMax = Number.NEGATIVE_INFINITY
  for (const t of finiteTimes) {
    if (t < t0) t0 = t
    if (t > tMax) tMax = t
  }
  if (finiteTimes.length === 0) {
    t0 = 0
    tMax = 1
  }
  // One time alone has no span, so it gets a little room either side.
  const xLo = t0 === tMax ? t0 - 0.5 : t0
  const xHi = t0 === tMax ? tMax + 0.5 : tMax
  const x = new Float32Array(times.length)
  let noTime = 0
  for (let i = 0; i < times.length; i++) {
    if (Number.isFinite(times[i])) x[i] = times[i] - t0
    else {
      x[i] = Number.NaN
      noTime += 1
    }
  }
  let unordered = false
  for (let i = 1; i < times.length; i++) {
    if (Number.isFinite(times[i]) && Number.isFinite(times[i - 1]) && times[i] < times[i - 1]) unordered = true
  }

  const series: PreparedSeries[] = []
  let lo = Number.POSITIVE_INFINITY
  let hi = Number.NEGATIVE_INFINITY
  const widen = (value: number | null): void => {
    if (value === null || !Number.isFinite(value)) return
    if (value < lo) lo = value
    if (value > hi) hi = value
  }

  wanted.forEach((want, k) => {
    const result = results[k]
    if (!result.ok) {
      problems.push(`iteration ${want.iteration}: ${result.artifact}: ${result.reason}`)
      return
    }
    if (result.iteration !== want.iteration || result.siteId !== id) {
      problems.push(
        `iteration ${want.iteration}: the server answered for site ${result.siteId}, iteration ${result.iteration}`,
      )
      return
    }
    if (result.count !== times.length) {
      problems.push(
        `iteration ${want.iteration}: the series has ${result.count} observations but the site has ${times.length}, so it is not drawn`,
      )
      return
    }
    // A row with no time cannot sit on the axis, so its values leave the line.
    let values = result.values
    if (noTime > 0) {
      values = new Float32Array(result.values)
      for (let i = 0; i < times.length; i++) {
        if (!Number.isFinite(times[i])) values.fill(Number.NaN, i * result.nReal, (i + 1) * result.nReal)
      }
    }
    for (let i = 0; i < values.length; i++) widen(values[i])
    series.push({
      iteration: want.iteration,
      role: want.role,
      key: `${id}:${want.iteration}`,
      nReal: result.nReal,
      count: result.count,
      values,
      baseIndex: result.baseIndex.filter((c) => Number.isInteger(c) && c >= 0 && c < result.nReal),
      baseNote: result.baseNote,
      nNaN: result.nNaN,
      line: { values, count: result.count, nReal: result.nReal, x },
    })
  })

  for (let i = 0; i < times.length; i++) if (hasMarker(site, i)) widen(site.obsval[i])
  if (site.noise.available) {
    for (const value of site.noise.q05) widen(value)
    for (const value of site.noise.q95) widen(value)
  }
  let yDomain: [number, number]
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    yDomain = [0, 1]
    problems.push('no value in this site could be drawn')
  } else if (lo === hi) {
    yDomain = [lo - 1, hi + 1]
  } else {
    const pad = (hi - lo) * 0.05
    yDomain = [lo - pad, hi + pad]
  }
  return { site, series, problems, xLo, xHi, t0, yDomain, noTime, unordered }
}

function markerCounts(site: ObsSitePayload): { filled: number; hollow: number; sentinel: number; notNumber: number } {
  const counts = { filled: 0, hollow: 0, sentinel: 0, notNumber: 0 }
  for (let i = 0; i < site.time.length; i++) {
    if (hasMarker(site, i)) {
      if (site.weighted[i]) counts.filled += 1
      else counts.hollow += 1
    } else if (site.sentinel[i]) counts.sentinel += 1
    else counts.notNumber += 1
  }
  return counts
}

const ZERO_WEIGHT_WORDS = 'zero weight: a model output, not fitted'

/** Every line the legend shows for one site, in the order they are read. */
function legendLines(prepared: PreparedSite): string[] {
  const lines: string[] = []
  for (const s of prepared.series) {
    const count = plural(s.nReal, 'realization', 'realizations')
    if (s.role === 'first') lines.push(`first iteration ${s.iteration}: ${count}`)
    else if (s.role === 'last') lines.push(`last iteration ${s.iteration}: ${count}`)
    else lines.push(`only iteration ${s.iteration} was ingested: ${count}`)
  }
  lines.push(...prepared.problems)

  if (prepared.series.some((s) => s.baseIndex.length > 0)) {
    lines.push("base: the bold line, in the colour of its iteration")
  }
  for (const s of prepared.series) {
    if (s.baseIndex.length === 0) lines.push(`no base realization in iteration ${s.iteration}`)
    if (s.baseNote) lines.push(s.baseNote)
  }

  const site = prepared.site
  const counts = markerCounts(site)
  if (counts.filled > 0) lines.push('filled marker: observed value, weight above zero')
  if (counts.hollow > 0) lines.push(`hollow marker: ${ZERO_WEIGHT_WORDS}`)
  if (site.inequality !== 'none') lines.push(`observations are inequality constraints (${site.inequality})`)
  const unmarked = counts.sentinel + counts.notNumber
  if (unmarked > 0) {
    const reasons = [
      counts.sentinel > 0 ? `${counts.sentinel} sentinel` : null,
      counts.notNumber > 0 ? `${counts.notNumber} not a number` : null,
    ].filter((reason): reason is string => reason !== null)
    lines.push(
      `${plural(unmarked, 'observation has', 'observations have')} no measured value (${reasons.join(', ')}), so ${unmarked === 1 ? 'it has' : 'they have'} no marker`,
    )
  }

  if (site.noise.available) {
    const base = site.noise.base === 'not present' ? 'the noise file has no base' : 'base excluded'
    lines.push(`noise band: 5 to 95 percent of ${site.noise.source}; ${base}`)
  } else {
    lines.push(`no noise band: ${site.noise.reason}`)
  }

  const missing = prepared.series.reduce((sum, s) => sum + s.nNaN, 0)
  if (missing > 0) {
    lines.push(`${plural(missing, 'simulated value is', 'simulated values are')} missing; their lines break there, never joined`)
  }
  if (prepared.noTime > 0) {
    lines.push(`${plural(prepared.noTime, 'observation has', 'observations have')} no time, so ${prepared.noTime === 1 ? 'it is' : 'they are'} not drawn`)
  }
  if (prepared.unordered) {
    lines.push('observations are not in time order; lines join them in the order the file lists them')
  }
  lines.push(`x axis: ${timeAxisTitle(site.time_kind)}`)
  return lines
}

function hostDiv(parent: HTMLElement, className: string): HTMLDivElement {
  const el = document.createElement('div')
  el.classList.add(className)
  parent.appendChild(el)
  return el
}

function textLine(parent: HTMLElement, text: string, muted = false): HTMLElement {
  const el = document.createElement('div')
  el.classList.add('label', 'wrap-note')
  if (muted) el.style.color = 'var(--ink-muted)'
  el.textContent = text
  parent.appendChild(el)
  return el
}

function absoluteFill(el: HTMLElement, z: number): void {
  el.style.position = 'absolute'
  el.style.left = '0'
  el.style.top = '0'
  el.style.width = '100%'
  el.style.height = '100%'
  el.style.zIndex = String(z)
}

function geometryOf(plot: HTMLElement): Geometry | null {
  const x0 = plot.offsetLeft + MARGIN.left
  const y0 = plot.offsetTop + MARGIN.top
  const x1 = plot.offsetLeft + plot.clientWidth - MARGIN.right
  const y1 = plot.offsetTop + plot.clientHeight - MARGIN.bottom
  if (x1 - x0 < MIN_INNER_PX || y1 - y0 < MIN_INNER_PX) return null
  return { x0, y0, x1, y1 }
}

function readAccent(): string {
  return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// The injected context has no createContext wrapper, so its loss events are wired here.
function wrapInjected(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext): GlContext {
  const lost: Array<() => void> = []
  const restored: Array<() => void> = []
  canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault()
    lost.forEach((fn) => fn())
  })
  canvas.addEventListener('webglcontextrestored', () => restored.forEach((fn) => fn()))
  return { gl, onLost: (fn) => lost.push(fn), onRestored: (fn) => restored.push(fn) }
}

export function renderSpaghetti(host: HTMLElement, opts: SpaghettiOptions): SpaghettiHandle {
  const { store } = opts
  let hidden = opts.startHidden === true
  let stale = true
  let lost = false
  let views: PanelView[] = []
  let moreSites = 0
  const loaded = new Map<number, SiteEntry>()
  const slot = new LatestWins<Map<number, SiteEntry>>()

  const note = hostDiv(host, 'obs-spaghetti-note')
  const stage = hostDiv(host, 'obs-spaghetti-stage')
  stage.style.position = 'relative'
  const backLayer = hostDiv(stage, 'obs-spaghetti-back')
  absoluteFill(backLayer, 0)
  const frontLayer = hostDiv(stage, 'obs-spaghetti-front')
  absoluteFill(frontLayer, 2)
  frontLayer.style.pointerEvents = 'none'
  // The panels' own titles and legends are in normal flow, so they set the stage's height.
  const panelsEl = hostDiv(stage, 'obs-spaghetti-panels')
  panelsEl.style.position = 'relative'
  panelsEl.style.zIndex = '3'

  // ---- the graphics layer ----

  let glCanvas: HTMLCanvasElement | null = null
  let layer: LineLayer | null = null
  let gl: WebGL2RenderingContext | null = null
  let glFailure: string | null = null
  const uploaded = new Set<string>()

  function ensureLayer(): LineLayer | null {
    if (layer) return layer
    if (glFailure !== null || glCanvas === null) return null
    try {
      let context: GlContext
      if (opts.createGl) {
        const injected = opts.createGl(glCanvas)
        if (!injected) throw new Error('the graphics context could not be created')
        context = wrapInjected(glCanvas, injected)
      } else {
        context = createContext(glCanvas)
      }
      gl = context.gl
      layer = new LineLayer(gl)
      context.onLost(() => {
        lost = true
      })
      context.onRestored(() => {
        layer?.reupload()
        lost = false
        drawGl()
      })
    } catch (error) {
      glFailure = `The realization lines could not be drawn: ${describeError(error)}`
      renderNote()
      return null
    }
    return layer
  }

  function syncLayer(lines: LineLayer): void {
    const wanted = new Map<string, LineSeries>()
    for (const view of views) {
      if (view.entry?.ok !== true) continue
      for (const s of view.entry.prepared.series) wanted.set(s.key, s.line)
    }
    for (const key of [...uploaded]) {
      if (!wanted.has(key)) {
        lines.removeSeries(key)
        uploaded.delete(key)
      }
    }
    for (const [key, line] of wanted) {
      if (!uploaded.has(key)) {
        lines.setSeries(key, line)
        uploaded.add(key)
      }
    }
  }

  function roleColour(role: Role, alpha: number): [number, number, number, number] {
    const [r, g, b] = readColorToken(role === 'first' ? '--ink-muted' : '--series-1')
    return [r, g, b, alpha]
  }

  function drawGl(): void {
    if (hidden || lost) return
    const width = stage.clientWidth
    const height = stage.clientHeight
    if (width <= 0 || height <= 0) return
    const lines = ensureLayer()
    if (!lines || !gl || glCanvas === null) return
    const ratio = window.devicePixelRatio || 1
    glCanvas.width = Math.round(width * ratio)
    glCanvas.height = Math.round(height * ratio)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    syncLayer(lines)

    const panels: LinePanel[] = []
    for (const view of views) {
      if (view.entry?.ok !== true || view.plot === null) continue
      const g = geometryOf(view.plot)
      if (g === null) continue
      const prepared = view.entry.prepared
      panels.push({
        viewport: [
          Math.round(g.x0 * ratio),
          Math.round((height - g.y1) * ratio),
          Math.round((g.x1 - g.x0) * ratio),
          Math.round((g.y1 - g.y0) * ratio),
        ],
        xDomain: [prepared.xLo - prepared.t0, prepared.xHi - prepared.t0],
        yDomain: prepared.yDomain,
        strips: prepared.series.map((s) => ({ key: s.key, rgba: roleColour(s.role, stripAlpha(s.nReal)) })),
      })
    }
    lines.draw(panels)
  }

  // ---- the two 2D layers ----

  function axesOf(prepared: PreparedSite, g: Geometry) {
    const x = timeAxis(prepared.site.time_kind, [prepared.xLo, prepared.xHi], [g.x0, g.x1])
    const y = linearAxis(prepared.yDomain, [g.y1, g.y0])
    return { x: x.axis, y, title: x.title }
  }

  function drawBack(ctx: Chart2D, _size: ChartSize): void {
    const tokens = readChartTokens(document.documentElement)
    for (const view of views) {
      if (view.entry?.ok !== true || view.plot === null) continue
      const g = geometryOf(view.plot)
      if (g === null) continue
      drawPanelBack(ctx, tokens, view.entry.prepared, g)
    }
  }

  function drawPanelBack(ctx: Chart2D, tokens: ChartTokens, prepared: PreparedSite, g: Geometry): void {
    const { x, y, title } = axesOf(prepared, g)
    ctx.save()
    ctx.lineWidth = 1
    ctx.strokeStyle = tokens.gridline
    ctx.beginPath()
    for (const tick of y.ticks) {
      ctx.moveTo(g.x0, tick.px)
      ctx.lineTo(g.x1, tick.px)
    }
    for (const tick of x.ticks) {
      ctx.moveTo(tick.px, g.y0)
      ctx.lineTo(tick.px, g.y1)
    }
    ctx.stroke()
    ctx.restore()

    const noise = prepared.site.noise
    if (noise.available) {
      const xs = prepared.site.time.map((t) => (Number.isFinite(t) ? x.toPx(t) : Number.NaN))
      const px = (v: number | null): number | null => (v === null || !Number.isFinite(v) ? null : y.toPx(v))
      drawBand(ctx, xs, noise.q05.map(px), noise.q95.map(px), tokens.series2, BAND_ALPHA)
    }

    ctx.save()
    ctx.strokeStyle = tokens.axis
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(g.x0, g.y0)
    ctx.lineTo(g.x0, g.y1)
    ctx.lineTo(g.x1, g.y1)
    ctx.stroke()
    ctx.fillStyle = tokens.inkMuted
    ctx.font = FONT
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'
    for (const tick of y.ticks) if (tick.label !== '') ctx.fillText(tick.label, g.x0 - 6, tick.px)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    for (const tick of x.ticks) if (tick.label !== '') ctx.fillText(tick.label, tick.px, g.y1 + 4)
    ctx.textBaseline = 'bottom'
    ctx.fillText(title, (g.x0 + g.x1) / 2, g.y1 + MARGIN.bottom - 2)
    ctx.restore()
  }

  function drawFront(ctx: Chart2D, _size: ChartSize): void {
    const tokens = readChartTokens(document.documentElement)
    const accent = readAccent()
    for (const view of views) {
      if (view.entry?.ok !== true || view.plot === null) continue
      const g = geometryOf(view.plot)
      if (g === null) continue
      drawPanelFront(ctx, tokens, accent, view.entry.prepared, g)
    }
  }

  function drawPanelFront(ctx: Chart2D, tokens: ChartTokens, accent: string, prepared: PreparedSite, g: Geometry): void {
    const { x, y } = axesOf(prepared, g)
    const { site } = prepared
    ctx.save()
    ctx.beginPath()
    ctx.rect(g.x0, g.y0, g.x1 - g.x0, g.y1 - g.y0)
    ctx.clip()

    const xs = site.time.map((t) => (Number.isFinite(t) ? x.toPx(t) : Number.NaN))
    for (const s of prepared.series) {
      const colour = s.role === 'first' ? tokens.inkMuted : tokens.series1
      for (const column of s.baseIndex) {
        const ys: number[] = new Array(s.count)
        for (let r = 0; r < s.count; r++) ys[r] = y.toPx(s.values[r * s.nReal + column])
        drawPolyline(ctx, xs, ys, { colour, width: BASE_WIDTH })
      }
    }

    const points: MarkerPoint[] = []
    for (let i = 0; i < site.time.length; i++) {
      if (!hasMarker(site, i)) continue
      points.push({ x: xs[i], y: y.toPx(site.obsval[i] as number), hollow: !site.weighted[i] })
    }
    drawMarkers(ctx, points, { shape: 'circle', radius: MARKER_RADIUS, colour: tokens.inkPrimary })

    const at = cursorTime(site.group)
    if (at !== null) {
      const px = x.toPx(at)
      if (px >= g.x0 && px <= g.x1) drawCursor(ctx, px, g.y0, g.y1, accent)
    }
    ctx.restore()
  }

  // The canvases are made the first time a site is shown, so an empty or hidden tab holds none.
  let back: CanvasHost | null = null
  let front: CanvasHost | null = null

  function ensureCanvases(): void {
    if (back !== null) return
    const canvas = document.createElement('canvas')
    canvas.classList.add('obs-spaghetti-gl')
    canvas.setAttribute('aria-hidden', 'true')
    canvas.style.display = 'block'
    canvas.style.pointerEvents = 'none'
    absoluteFill(canvas, 1)
    stage.appendChild(canvas)
    glCanvas = canvas
    back = createCanvasHost(backLayer, {
      label: 'Axes and noise band of the spaghetti plot',
      draw: drawBack,
      context: opts.context2d ? () => opts.context2d!('back') : undefined,
    })
    front = createCanvasHost(frontLayer, {
      label: 'Spaghetti plot of the realizations of the selected sites',
      draw: drawFront,
      context: opts.context2d ? () => opts.context2d!('front') : undefined,
    })
    backLayer.querySelector('canvas')?.setAttribute('aria-hidden', 'true')
    backLayer.querySelector('canvas')?.removeAttribute('role')
    observer?.observe(stage)
  }

  function redrawAll(): void {
    if (hidden || back === null || front === null) return
    back.redraw()
    front.redraw()
    drawGl()
  }

  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => redrawAll())

  // ---- the cursor at the map's time ----

  const timesReads = new Map<string, () => Promise<ObsTimesResult>>()
  const timesOf = new Map<string, number[]>()
  let cursorProblem: string | null = null

  function cursorGroup(): string | null {
    const s = store.get()
    return s.colour.source === 'obs' ? firstOf(s.obsGroups) : null
  }

  function cursorTime(group: string): number | null {
    if (cursorGroup() !== group) return null
    const times = timesOf.get(group)
    if (!times) return null
    const t = times[store.get().timeIdx]
    return t !== undefined && Number.isFinite(t) ? t : null
  }

  function ensureTimes(): void {
    const group = cursorGroup()
    if (hidden || group === null || timesOf.has(group)) return
    if (!views.some((v) => v.entry?.ok === true && v.entry.prepared.site.group === group)) return
    let read = timesReads.get(group)
    if (!read) {
      read = shareRead(() => fetchObsTimes(group))
      timesReads.set(group, read)
    }
    read().then(
      (result) => {
        if (result.ok) {
          timesOf.set(group, result.payload.times)
          cursorProblem = null
        } else {
          cursorProblem = `The map-time cursor is not drawn: ${result.artifact}: ${result.reason}`
        }
        renderNote()
        if (!hidden) front?.redraw()
      },
      (error: unknown) => {
        cursorProblem = `The map-time cursor is not drawn: ${describeError(error)}`
        renderNote()
      },
    )
  }

  // ---- the DOM text ----

  let loadProblem: string | null = null

  function renderNote(): void {
    note.textContent = ''
    if (views.length === 0 && moreSites === 0) {
      textLine(note, 'Choose a site in the list or on the map to see its realizations.', true)
    }
    if (moreSites > 0) {
      textLine(note, `${plural(moreSites, 'more selected site is', 'more selected sites are')} not drawn`)
    }
    if (glFailure !== null) textLine(note, glFailure)
    if (loadProblem !== null) textLine(note, loadProblem)
    if (cursorProblem !== null) textLine(note, cursorProblem)
  }

  function renderPanels(): void {
    panelsEl.textContent = ''
    for (const view of views) {
      const panel = hostDiv(panelsEl, 'obs-spaghetti-panel')
      view.plot = null
      const title = document.createElement('div')
      title.classList.add('body', 'obs-spaghetti-title')
      panel.appendChild(title)
      if (view.entry === undefined) {
        title.textContent = `Site ${view.id}`
        textLine(panel, 'Loading…', true)
        continue
      }
      if (!view.entry.ok) {
        title.textContent = `Site ${view.id}`
        textLine(panel, view.entry.reason)
        continue
      }
      const prepared = view.entry.prepared
      title.textContent = prepared.site.site
      const plot = hostDiv(panel, 'obs-spaghetti-plot')
      plot.style.height = `${PANEL_HEIGHT}px`
      view.plot = plot
      const legend = hostDiv(panel, 'obs-spaghetti-legend')
      for (const line of legendLines(prepared)) textLine(legend, line)
      const noise = prepared.site.noise
      if (noise.available) legend.title = `${noise.n_real_used} realizations used for the noise band`
    }
    const names = views.flatMap((v) => (v.entry?.ok === true ? [v.entry.prepared.site.site] : []))
    front?.setLabel(
      names.length === 0
        ? 'Spaghetti plot of the realizations of the selected sites'
        : `Spaghetti plot of the realizations of ${names.join(', ')}`,
    )
  }

  function refresh(): void {
    if (views.length > 0) ensureCanvases()
    renderNote()
    renderPanels()
    redrawAll()
    ensureTimes()
  }

  // ---- loading ----

  async function loadOne(id: number, signal: AbortSignal): Promise<SiteEntry> {
    const answer = await fetchObsSite(id, { signal })
    if (!answer.ok) return { ok: false, reason: `${answer.artifact}: ${answer.reason}` }
    if (answer.payload.site_id !== id) {
      return { ok: false, reason: `the server answered for site ${answer.payload.site_id}, not site ${id}` }
    }
    const wanted = pickIterations(answer.payload.iterations)
    const results = await Promise.all(wanted.map((w) => fetchObsSeries(id, w.iteration, { signal })))
    return { ok: true, prepared: prepare(id, answer.payload, wanted, results) }
  }

  function sync(): void {
    const ids = [...store.get().sites]
    const shown = ids.slice(0, MAX_SPAGHETTI_PANELS)
    moreSites = ids.length - shown.length
    for (const id of [...loaded.keys()]) if (!shown.includes(id)) loaded.delete(id)
    views = shown.map((id) => ({ id, entry: loaded.get(id), plot: null }))
    const missing = shown.filter((id) => !loaded.has(id))
    loadProblem = null
    refresh()
    if (missing.length === 0) {
      slot.cancel()
      return
    }
    slot
      .run(missing.join(','), async (signal) => {
        const entries = await Promise.all(missing.map((id) => loadOne(id, signal)))
        return new Map(missing.map((id, k) => [id, entries[k]] as const))
      })
      .then(
        (result) => {
          if (result.stale) return
          for (const [id, entry] of result.value) loaded.set(id, entry)
          views = shown.map((id) => ({ id, entry: loaded.get(id), plot: null }))
          refresh()
        },
        (error: unknown) => {
          loadProblem = `The selected sites could not be read: ${describeError(error)}`
          renderNote()
        },
      )
  }

  // ---- following the selection ----

  const unsubscribeSites = store.subscribe(
    (s) => ({ sites: s.sites, runId: s.runId }),
    (next, prev) => {
      if (next.runId !== prev.runId) {
        loaded.clear()
        timesOf.clear()
        timesReads.clear()
      }
      if (hidden) {
        stale = true
        return
      }
      sync()
    },
  )
  const unsubscribeCursor = store.subscribe(
    (s) => ({ source: s.colour.source, group: firstOf(s.obsGroups), timeIdx: s.timeIdx }),
    () => {
      if (hidden) return
      ensureTimes()
      front?.redraw()
    },
  )

  if (hidden) {
    renderNote()
  } else {
    stale = false
    sync()
  }

  return {
    onShow() {
      hidden = false
      back?.onShow()
      front?.onShow()
      drawGl()
      if (stale) {
        stale = false
        sync()
      } else {
        ensureTimes()
      }
    },
    onHide() {
      hidden = true
      back?.onHide()
      front?.onHide()
    },
    dispose() {
      unsubscribeSites()
      unsubscribeCursor()
      slot.cancel()
      observer?.disconnect()
      back?.destroy()
      front?.destroy()
      layer?.dispose()
      layer = null
      host.textContent = ''
    },
  }
}
