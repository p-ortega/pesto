// The spaghetti plot of the Obs tab: every realization of the first and last
// iteration of each selected site. The lines go through one WebGL2 line layer
// on one shared canvas, one viewport per panel. The axes and noise band sit on
// a Canvas 2D layer behind it; base, markers and the map-time cursor sit on a
// Canvas 2D layer in front. Titles and legends are DOM text, and every string
// that came from a run goes in through textContent.

import { LatestWins } from '../data/latest-wins'
import {
  fetchObsGroupSets,
  fetchObsReals,
  fetchObsSeries,
  fetchObsSite,
  fetchObsTimes,
  resolveObsTarget,
  shareRead,
  targetGroups,
  targetKey,
  type ObsGroupSet,
  type ObsGroupSetsResult,
  type ObsRealsResult,
  type ObsTarget,
  type ObsSeriesResult,
  type ObsSitePayload,
  type ObsTimesResult,
} from '../data/obs'
import { readColorToken } from '../gl/color-token'
import { createContext, type GlContext } from '../gl/context'
import { LineLayer, type LinePanel, type LineSeries } from '../gl/line-layer'
import type { SelectionStore } from '../state/selection'
import { linearAxis, logAxis } from './charts/axes'
import { BASE_STYLE, baseLegendFor } from './charts/base-style'
import { attachBrush, drawBrushBand, type BrushHandle } from './charts/brush'
import { createCanvasHost, type CanvasHost } from './charts/canvas-host'
import { chartChoices, type RangeKind, type ScaleKind, type SeriesPart } from './charts/choices'
import { chartSwitch, chartToggle, chartToolbar, enlargeButton, focusedControl, refocusControl } from './charts/controls'
import { enlargeChart, type EnlargeHandle } from './charts/enlarge'
import type { Chart2D, ChartSize } from './charts/histogram'
import { drawBand, drawCursor, drawMarkers, drawPolyline, type MarkerPoint } from './charts/marks'
import { formatTimeValue, timeAxis, timeAxisTitle } from './charts/time-axis'
import { readChartTokens, readDimAlpha, type ChartTokens } from './charts/tokens'

export interface SpaghettiOptions {
  store: SelectionStore
  /** True when the tab is not the open one: nothing is fetched or drawn until onShow. */
  startHidden?: boolean
  /** Reads the group sets, shared with the panel. Without one the plot keeps its own shared read. */
  loadGroupSets?: () => Promise<ObsGroupSetsResult>
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

const PANEL_HEIGHT = 240
// Room inside a panel's box for tick labels (left) and ticks plus the axis title (bottom).
const MARGIN = { left: 48, right: 12, top: 8, bottom: 34 }
const MIN_INNER_PX = 20
const FONT = '11px system-ui, sans-serif'
const MARKER_RADIUS = 3
const BAND_ALPHA = 0.2
const STRIP_ALPHA = 0.15
// More realizations than this are drawn fainter, so a dense ensemble stays readable.
const ALPHA_FULL_UNTIL = 300
const MIN_STRIP_ALPHA = 0.02
// Selected realizations are drawn over the faded strips one polyline each, so their number is capped.
export const MAX_BOLD_REALS = 50
const SELECTED_WIDTH = 1.25

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
  nSentinel: number
  line: LineSeries
  /** The same series as log10 values, made the first time a log axis draws it. */
  logLine?: LineSeries
  /** Per observation time, made the first time the range or the readout needs it. */
  stats?: SeriesStats
}

interface SeriesStats {
  mean: Float64Array
  q05: Float64Array
  q95: Float64Array
}

/** How one site's panel is drawn under the current choices and zoom. */
interface Drawn {
  key: string
  log: boolean
  /** Why this site cannot take a log axis, or null when it can. */
  logRefusal: string | null
  xDomain: [number, number]
  zoomed: boolean
  /** Observation times inside the x range. */
  inView: number
  /** Native units on a linear axis, log10 on a log axis. */
  yDomain: [number, number]
  /** Realization values in view that lie beyond the y range and run off the plot. */
  beyond: number
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
  /** The lowest and highest value of anything the site draws; not a number when it draws nothing. */
  valueMin: number
  valueMax: number
  noTime: number
  unordered: boolean
}

type SiteEntry = { ok: true; prepared: PreparedSite } | { ok: false; reason: string }

/** One iteration's realization names, in column order, or why they could not be read. */
type RealsEntry = { ok: true; names: readonly string[] } | { ok: false; reason: string }

/** What a named realization selection means for one series: the columns drawn over the faded strips, or why it cannot be shown. */
type SeriesPick =
  | { ok: true; columns: number[]; asked: number; missing: number; notDrawn: number }
  | { ok: false; reason: string }

interface PanelView {
  id: number
  entry: SiteEntry | undefined
  plot: HTMLElement | null
  readout?: HTMLElement | null
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

/** True when the observation has a measured value that can be drawn as a marker. */
function hasMarker(site: ObsSitePayload, i: number): boolean {
  const value = site.obsval[i]
  return value !== null && Number.isFinite(value) && !site.sentinel[i] && !site.no_value[i]
}

function stripAlpha(nReal: number): number {
  return Math.max(MIN_STRIP_ALPHA, STRIP_ALPHA * Math.min(1, ALPHA_FULL_UNTIL / Math.max(1, nReal)))
}

// Names only: a selected realization is found by its name in this iteration's own list, never by position.
function pickColumns(reals: ReadonlySet<string>, entry: RealsEntry, s: { iteration: number; nReal: number }): SeriesPick {
  if (!entry.ok) return { ok: false, reason: entry.reason }
  if (entry.names.length !== s.nReal) {
    return {
      ok: false,
      reason: `iteration ${s.iteration} has ${entry.names.length} realization names but its series has ${s.nReal} columns`,
    }
  }
  const columnOf = new Map<string, number>()
  for (let j = 0; j < entry.names.length; j++) {
    const name = entry.names[j]
    if (columnOf.has(name)) {
      return { ok: false, reason: `iteration ${s.iteration} names realization ${name} more than once` }
    }
    columnOf.set(name, j)
  }
  const found: number[] = []
  let missing = 0
  for (const name of reals) {
    const column = columnOf.get(name)
    if (column === undefined) missing += 1
    else found.push(column)
  }
  const columns = found.slice(0, MAX_BOLD_REALS)
  return { ok: true, columns, asked: reals.size, missing, notDrawn: found.length - columns.length }
}

function selectionLines(series: PreparedSeries[], pickOf: (s: PreparedSeries) => SeriesPick | null | undefined): string[] {
  const lines: string[] = []
  let drawnOver = false
  for (const s of series) {
    const pick = pickOf(s)
    if (pick === null) continue
    if (pick === undefined) {
      lines.push(`reading the realization names of iteration ${s.iteration}`)
      continue
    }
    if (!pick.ok) {
      lines.push(`the selection cannot be shown: ${pick.reason}`)
      continue
    }
    if (pick.columns.length > 0) drawnOver = true
    if (pick.missing > 0) {
      lines.push(
        `${pick.missing} of ${plural(pick.asked, 'selected realization', 'selected realizations')} ${pick.missing === 1 ? 'is' : 'are'} not in iteration ${s.iteration}`,
      )
    }
    if (pick.notDrawn > 0) {
      lines.push(
        `${plural(pick.notDrawn, 'more selected realization is', 'more selected realizations are')} not drawn bold: at most ${MAX_BOLD_REALS} are`,
      )
    }
  }
  if (drawnOver) lines.unshift('selected realizations: drawn in the colour of their iteration over the faded rest')
  // Two iterations can give the same sentence; the legend says it once.
  return [...new Set(lines)]
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
      nSentinel: result.nSentinel,
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
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) lo = hi = Number.NaN
  return { site, series, problems, xLo, xHi, t0, yDomain, valueMin: lo, valueMax: hi, noTime, unordered }
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

type Shown = Record<SeriesPart, boolean>

const PARTS: SeriesPart[] = ['first', 'last', 'observed', 'noise', 'base']

/** 'only' is the one ingested iteration; it goes with the last-iteration switch. */
function roleShown(role: Role, show: Shown): boolean {
  return role === 'first' ? show.first : show.last
}

function figure(value: number): string {
  return Number.isFinite(value) ? Number(value.toPrecision(5)).toString() : 'no value'
}

function quantile(sorted: Float32Array, p: number): number {
  const at = (sorted.length - 1) * p
  const below = Math.floor(at)
  const above = Math.ceil(at)
  return sorted[below] + (sorted[above] - sorted[below]) * (at - below)
}

function statsOf(s: PreparedSeries): SeriesStats {
  if (s.stats) return s.stats
  const stats: SeriesStats = {
    mean: new Float64Array(s.count).fill(Number.NaN),
    q05: new Float64Array(s.count).fill(Number.NaN),
    q95: new Float64Array(s.count).fill(Number.NaN),
  }
  const row = new Float32Array(s.nReal)
  for (let r = 0; r < s.count; r++) {
    let n = 0
    let sum = 0
    for (let j = 0; j < s.nReal; j++) {
      const v = s.values[r * s.nReal + j]
      if (!Number.isFinite(v)) continue
      row[n++] = v
      sum += v
    }
    if (n === 0) continue
    const sorted = row.subarray(0, n).sort()
    stats.mean[r] = sum / n
    stats.q05[r] = quantile(sorted, 0.05)
    stats.q95[r] = quantile(sorted, 0.95)
  }
  s.stats = stats
  return stats
}

function logLineOf(s: PreparedSeries): LineSeries {
  if (!s.logLine) {
    const values = new Float32Array(s.values.length)
    // Only used when every value is above zero; a gap stays a gap.
    for (let i = 0; i < values.length; i++) values[i] = Math.log10(s.values[i])
    s.logLine = { ...s.line, values }
  }
  return s.logLine
}

function logRefusalOf(prepared: PreparedSite): string | null {
  if (prepared.valueMin > 0) return null
  if (!Number.isFinite(prepared.valueMin)) return 'A log axis needs a value above zero, and this site has no value to draw.'
  return `A log axis needs every value above zero, and this site's lowest value is ${figure(prepared.valueMin)}.`
}

function drawnKey(zoom: [number, number] | null, choices: typeof chartChoices.series): string {
  return [choices.scale, choices.range, ...PARTS.map((part) => Number(choices.show[part])), zoom?.join(',') ?? ''].join('|')
}

function describeDrawn(prepared: PreparedSite, zoom: [number, number] | null, choices: typeof chartChoices.series): Drawn {
  const { site, series } = prepared
  const show = choices.show
  const logRefusal = logRefusalOf(prepared)
  const log = choices.scale === 'log' && logRefusal === null
  const xDomain: [number, number] = zoom ?? [prepared.xLo, prepared.xHi]
  const key = drawnKey(zoom, choices)

  const rows: number[] = []
  for (let i = 0; i < site.time.length; i++) {
    const t = site.time[i]
    if (Number.isFinite(t) && t >= xDomain[0] && t <= xDomain[1]) rows.push(i)
  }
  const base = { key, log, logRefusal, xDomain, zoomed: zoom !== null, inView: rows.length }
  // Nothing changed from the first draw: the whole site, every part, a linear axis.
  if (!log && zoom === null && choices.range === 'all' && PARTS.every((part) => show[part])) {
    return { ...base, yDomain: prepared.yDomain, beyond: 0 }
  }

  let lo = Number.POSITIVE_INFINITY
  let hi = Number.NEGATIVE_INFINITY
  const widen = (value: number | null): void => {
    if (value === null || !Number.isFinite(value)) return
    if (value < lo) lo = value
    if (value > hi) hi = value
  }
  const drawn = series.filter((s) => roleShown(s.role, show))
  for (const s of drawn) {
    if (choices.range === 'all') {
      for (const r of rows) for (let j = 0; j < s.nReal; j++) widen(s.values[r * s.nReal + j])
    } else {
      const stats = statsOf(s)
      for (const r of rows) {
        widen(stats.q05[r])
        widen(stats.q95[r])
        if (show.base) for (const j of s.baseIndex) widen(s.values[r * s.nReal + j])
      }
    }
  }
  if (show.observed) for (const r of rows) if (hasMarker(site, r)) widen(site.obsval[r])
  if (show.noise && site.noise.available) {
    for (const r of rows) {
      widen(site.noise.q05[r])
      widen(site.noise.q95[r])
    }
  }
  // Nothing shown in view: keep the whole site's range so the axis still reads.
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    lo = prepared.valueMin
    hi = prepared.valueMax
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { ...base, yDomain: prepared.yDomain, beyond: 0 }

  let a = log ? Math.log10(lo) : lo
  let b = log ? Math.log10(hi) : hi
  const pad = a === b ? (log ? 0.5 : 1) : (b - a) * 0.05
  a -= pad
  b += pad
  let beyond = 0
  if (choices.range === 'observed') {
    const low = log ? 10 ** a : a
    const high = log ? 10 ** b : b
    for (const s of drawn) {
      for (const r of rows) {
        for (let j = 0; j < s.nReal; j++) {
          const v = s.values[r * s.nReal + j]
          if (Number.isFinite(v) && (v < low || v > high)) beyond += 1
        }
      }
    }
  }
  return { ...base, yDomain: [a, b], beyond }
}

/** Every line the legend shows for one site, in the order they are read. A hidden part has no line. */
function legendLines(
  prepared: PreparedSite,
  pickOf: (s: PreparedSeries) => SeriesPick | null | undefined,
  show: Shown = chartChoices.series.show,
): string[] {
  const lines: string[] = []
  const series = prepared.series.filter((s) => roleShown(s.role, show))
  for (const s of series) {
    const count = plural(s.nReal, 'realization', 'realizations')
    if (s.role === 'first') lines.push(`first iteration ${s.iteration}: ${count}`)
    else if (s.role === 'last') lines.push(`last iteration ${s.iteration}: ${count}`)
    else lines.push(`only iteration ${s.iteration} was ingested: ${count}`)
  }
  lines.push(...prepared.problems)
  lines.push(...selectionLines(series, pickOf))

  if (show.base) {
    if (series.some((s) => s.baseIndex.length > 0)) lines.push(BASE_STYLE.legend)
    for (const s of series) {
      if (s.baseIndex.length === 0) lines.push(baseLegendFor(s.iteration, false))
      if (s.baseNote) lines.push(s.baseNote)
    }
  }

  const site = prepared.site
  if (show.observed) {
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
  }

  if (site.noise.available) {
    const base = site.noise.base === 'not present' ? 'the noise file has no base' : 'base excluded'
    if (show.noise) lines.push(`noise band: 5 to 95 percent of ${site.noise.source}; ${base}`)
  } else {
    lines.push(`no noise band: ${site.noise.reason}`)
  }

  const missing = series.reduce((sum, s) => sum + s.nNaN, 0)
  if (missing > 0) {
    lines.push(`${plural(missing, 'simulated value is', 'simulated values are')} missing; their lines break there, never joined`)
  }
  const sentinels = series.reduce((sum, s) => sum + s.nSentinel, 0)
  if (sentinels > 0) {
    lines.push(`${plural(sentinels, 'simulated value is', 'simulated values are')} a sentinel (a dry or no-flow placeholder) and left out; their lines break there`)
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

/** What the legend adds once the scale, range or zoom is not the default. */
function viewLines(prepared: PreparedSite, drawn: Drawn, choices: typeof chartChoices.series): string[] {
  const lines: string[] = []
  if (drawn.log) lines.push('value axis: log scale')
  else if (choices.scale === 'log' && drawn.logRefusal !== null) lines.push(`value axis: linear. ${drawn.logRefusal}`)
  if (choices.range === 'observed') {
    lines.push(
      `value range: fits the observed values, the noise band, base and the 5th to 95th percentile of the realizations; ${plural(drawn.beyond, 'realization value lies', 'realization values lie')} beyond it and ${drawn.beyond === 1 ? 'runs' : 'run'} off the plot`,
    )
  }
  if (drawn.zoomed) {
    const kind = prepared.site.time_kind
    const total = prepared.site.time.length - prepared.noTime
    lines.push(
      `zoomed to ${formatTimeValue(kind, drawn.xDomain[0])} to ${formatTimeValue(kind, drawn.xDomain[1])}: ${drawn.inView.toLocaleString('en-US')} of ${plural(total, 'observation time', 'observation times')} in view; double-click the plot to see all`,
    )
  }
  return lines
}

const PART_BUTTONS: Array<{ part: SeriesPart; text: string; title: string }> = [
  { part: 'first', text: 'first iteration', title: 'Show or hide the realizations of the first iteration' },
  { part: 'last', text: 'last iteration', title: 'Show or hide the realizations of the last iteration' },
  { part: 'observed', text: 'observed', title: 'Show or hide the markers of the observed values' },
  { part: 'noise', text: 'noise band', title: 'Show or hide the 5 to 95 percent band of the observation noise' },
  { part: 'base', text: 'base', title: 'Show or hide the bold line of the base realization' },
]

/** The parts this site has, so a switch is only offered for something that can be drawn. */
function partsOf(prepared: PreparedSite): Set<SeriesPart> {
  const parts = new Set<SeriesPart>()
  for (const s of prepared.series) {
    parts.add(s.role === 'first' ? 'first' : 'last')
    if (s.baseIndex.length > 0) parts.add('base')
  }
  const counts = markerCounts(prepared.site)
  if (counts.filled + counts.hollow > 0) parts.add('observed')
  if (prepared.site.noise.available) parts.add('noise')
  return parts
}

/** The observation with a time nearest to `t` inside the drawn range, or -1. */
function nearestRow(times: readonly number[], t: number, range: [number, number]): number {
  let best = -1
  let gap = Number.POSITIVE_INFINITY
  for (let i = 0; i < times.length; i++) {
    const at = times[i]
    if (!Number.isFinite(at) || at < range[0] || at > range[1]) continue
    const d = Math.abs(at - t)
    if (d < gap) {
      gap = d
      best = i
    }
  }
  return best
}

/** What the readout says for one observation time: the time, then each shown part's value there. */
function readoutLines(prepared: PreparedSite, row: number, show: Shown): string[] {
  const { site } = prepared
  const lines = [formatTimeValue(site.time_kind, site.time[row])]
  if (show.observed) {
    if (hasMarker(site, row)) lines.push(`observed ${figure(site.obsval[row] as number)}${site.weighted[row] ? '' : ' (zero weight)'}`)
    else lines.push('observed: no measured value')
  }
  // The last iteration first: it is the answer; the first iteration is what it started from.
  const series = prepared.series.filter((s) => roleShown(s.role, show)).reverse()
  for (const s of series) {
    const name = s.role === 'first' ? 'first iteration' : s.role === 'last' ? 'last iteration' : 'iteration'
    const stats = statsOf(s)
    if (!Number.isFinite(stats.mean[row])) {
      lines.push(`${name} ${s.iteration}: no simulated value`)
      continue
    }
    lines.push(
      `${name} ${s.iteration}: mean ${figure(stats.mean[row])}, 5th to 95th percentile ${figure(stats.q05[row])} to ${figure(stats.q95[row])}`,
    )
    if (show.base) for (const j of s.baseIndex) lines.push(`base, iteration ${s.iteration}: ${figure(s.values[row * s.nReal + j])}`)
  }
  if (show.noise && site.noise.available) {
    const low = site.noise.q05[row]
    const high = site.noise.q95[row]
    if (low !== null && high !== null && Number.isFinite(low) && Number.isFinite(high)) {
      lines.push(`noise band: ${figure(low)} to ${figure(high)}`)
    }
  }
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

  // ---- how each panel is drawn: choices shared by every site, zoom and hover per site ----

  const zooms = new Map<number, [number, number]>()
  const drawnOf = new WeakMap<PreparedSite, Drawn>()
  let hover: { id: number; row: number } | null = null
  let dragBand: { id: number; range: [number, number] } | null = null
  let brushes: BrushHandle[] = []
  let enlargedId: number | null = null
  let enlarged: EnlargeHandle | null = null
  let disposed = false

  function drawnFor(id: number, prepared: PreparedSite): Drawn {
    const zoom = zooms.get(id) ?? null
    const cached = drawnOf.get(prepared)
    if (cached?.key === drawnKey(zoom, chartChoices.series)) return cached
    const next = describeDrawn(prepared, zoom, chartChoices.series)
    drawnOf.set(prepared, next)
    return next
  }

  // ---- the realization selection, matched by name per iteration ----

  const realsOf = new Map<number, RealsEntry>()
  const realsReads = new Map<number, () => Promise<ObsRealsResult>>()
  const picks = new Map<string, SeriesPick>()
  let dimProblem: string | null = null

  /** null: all realizations, nothing faded. undefined: the names are still being read. */
  function pickOf(s: PreparedSeries): SeriesPick | null | undefined {
    const reals = store.get().reals
    if (reals === 'all' || reals.size === 0) return null
    const cached = picks.get(s.key)
    if (cached) return cached
    const entry = realsOf.get(s.iteration)
    if (!entry) return undefined
    const pick = pickColumns(reals, entry, s)
    picks.set(s.key, pick)
    return pick
  }

  function dimAlpha(): number {
    try {
      dimProblem = null
      return readDimAlpha(document.documentElement)
    } catch (error) {
      dimProblem = `The unselected realizations are not faded: ${describeError(error)}`
      return 1
    }
  }

  function ensureReals(): void {
    const reals = store.get().reals
    if (hidden || reals === 'all' || reals.size === 0) return
    const iterations = new Set<number>()
    for (const view of views) {
      if (view.entry?.ok === true) for (const s of view.entry.prepared.series) iterations.add(s.iteration)
    }
    const runId = store.get().runId
    for (const iteration of iterations) {
      if (realsOf.has(iteration)) continue
      let read = realsReads.get(iteration)
      if (!read) {
        read = shareRead(() => fetchObsReals(iteration))
        realsReads.set(iteration, read)
      }
      read().then(
        (result) => settleReals(runId, iteration, readEntry(iteration, result)),
        (error: unknown) => settleReals(runId, iteration, { ok: false, reason: describeError(error) }),
      )
    }
  }

  function readEntry(iteration: number, result: ObsRealsResult): RealsEntry {
    if (!result.ok) return { ok: false, reason: `${result.artifact}: ${result.reason}` }
    if (result.payload.iteration !== iteration) {
      return { ok: false, reason: `the server answered with the names of iteration ${result.payload.iteration}, not ${iteration}` }
    }
    return { ok: true, names: result.payload.names }
  }

  function settleReals(runId: string, iteration: number, entry: RealsEntry): void {
    if (store.get().runId !== runId || realsOf.has(iteration)) return
    realsOf.set(iteration, entry)
    picks.clear()
    if (hidden) {
      stale = true
      return
    }
    renderPanels()
    redrawAll()
  }

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
      const log = drawnFor(view.id, view.entry.prepared).log
      for (const s of view.entry.prepared.series) {
        if (log) wanted.set(`${s.key}:log`, logLineOf(s))
        else wanted.set(s.key, s.line)
      }
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

    const dim = dimAlpha()
    const panels: LinePanel[] = []
    for (const view of views) {
      if (view.entry?.ok !== true || view.plot === null) continue
      const g = geometryOf(view.plot)
      if (g === null) continue
      const prepared = view.entry.prepared
      const drawn = drawnFor(view.id, prepared)
      const show = chartChoices.series.show
      panels.push({
        viewport: [
          Math.round(g.x0 * ratio),
          Math.round((height - g.y1) * ratio),
          Math.round((g.x1 - g.x0) * ratio),
          Math.round((g.y1 - g.y0) * ratio),
        ],
        xDomain: [drawn.xDomain[0] - prepared.t0, drawn.xDomain[1] - prepared.t0],
        yDomain: drawn.yDomain,
        strips: prepared.series
          .filter((s) => roleShown(s.role, show))
          .map((s) => {
            const faded = pickOf(s)?.ok === true
            return { key: drawn.log ? `${s.key}:log` : s.key, rgba: roleColour(s.role, stripAlpha(s.nReal) * (faded ? dim : 1)) }
          }),
      })
    }
    lines.draw(panels)
  }

  // ---- the two 2D layers ----

  function axesOf(prepared: PreparedSite, drawn: Drawn, g: Geometry) {
    const x = timeAxis(prepared.site.time_kind, drawn.xDomain, [g.x0, g.x1])
    const logY = drawn.log ? logAxis([10 ** drawn.yDomain[0], 10 ** drawn.yDomain[1]], [g.y1, g.y0]) : null
    const y = logY ?? linearAxis(drawn.yDomain, [g.y1, g.y0])
    return { x: x.axis, y, title: x.title }
  }

  function drawBack(ctx: Chart2D, _size: ChartSize): void {
    const tokens = readChartTokens(document.documentElement)
    for (const view of views) {
      if (view.entry?.ok !== true || view.plot === null) continue
      const g = geometryOf(view.plot)
      if (g === null) continue
      drawPanelBack(ctx, tokens, view.entry.prepared, drawnFor(view.id, view.entry.prepared), g)
    }
  }

  function drawPanelBack(ctx: Chart2D, tokens: ChartTokens, prepared: PreparedSite, drawn: Drawn, g: Geometry): void {
    const { x, y, title } = axesOf(prepared, drawn, g)
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
    if (noise.available && chartChoices.series.show.noise) {
      const xs = prepared.site.time.map((t) => (Number.isFinite(t) ? x.toPx(t) : Number.NaN))
      const px = (v: number | null): number | null => (v === null || !Number.isFinite(v) ? null : y.toPx(v))
      // Only a changed range can push the band past the plot; the first draw fits it whole.
      const clip = drawn.yDomain !== prepared.yDomain
      if (clip) {
        ctx.save()
        ctx.beginPath()
        ctx.rect(g.x0, g.y0, g.x1 - g.x0, g.y1 - g.y0)
        ctx.clip()
      }
      drawBand(ctx, xs, noise.q05.map(px), noise.q95.map(px), tokens.series2, BAND_ALPHA)
      if (clip) ctx.restore()
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
      drawPanelFront(ctx, tokens, accent, view, view.entry.prepared, g)
    }
  }

  function drawPanelFront(ctx: Chart2D, tokens: ChartTokens, accent: string, view: PanelView, prepared: PreparedSite, g: Geometry): void {
    const { x, y } = axesOf(prepared, drawnFor(view.id, prepared), g)
    const { site } = prepared
    const show = chartChoices.series.show
    const series = prepared.series.filter((s) => roleShown(s.role, show))
    ctx.save()
    ctx.beginPath()
    ctx.rect(g.x0, g.y0, g.x1 - g.x0, g.y1 - g.y0)
    ctx.clip()

    const xs = site.time.map((t) => (Number.isFinite(t) ? x.toPx(t) : Number.NaN))
    const column = (s: PreparedSeries, j: number, width: number): void => {
      const ys: number[] = new Array(s.count)
      for (let r = 0; r < s.count; r++) ys[r] = y.toPx(s.values[r * s.nReal + j])
      drawPolyline(ctx, xs, ys, { colour: s.role === 'first' ? tokens.inkMuted : tokens.series1, width })
    }
    // Every selected line goes down before any base line, so base stays on top in both iterations.
    for (const s of series) {
      const pick = pickOf(s)
      if (pick?.ok === true) for (const j of pick.columns) column(s, j, SELECTED_WIDTH)
    }
    if (show.base) for (const s of series) for (const j of s.baseIndex) column(s, j, BASE_STYLE.lineWidth)

    if (show.observed) {
      const points: MarkerPoint[] = []
      for (let i = 0; i < site.time.length; i++) {
        if (!hasMarker(site, i)) continue
        points.push({ x: xs[i], y: y.toPx(site.obsval[i] as number), hollow: !site.weighted[i] })
      }
      drawMarkers(ctx, points, { shape: 'circle', radius: MARKER_RADIUS, colour: tokens.inkPrimary })
    }

    if (dragBand !== null && dragBand.id === view.id) {
      drawBrushBand(ctx, { top: g.y0, bottom: g.y1 }, dragBand.range, x.toPx, tokens)
    }
    // The hover line is muted ink; the accent line below is the map's time.
    if (hover !== null && hover.id === view.id) drawCursor(ctx, xs[hover.row], g.y0, g.y1, tokens.inkMuted)

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

  // Keyed by targetKey, so a group and a set never share times.
  const timesReads = new Map<string, () => Promise<ObsTimesResult>>()
  const timesOf = new Map<string, number[]>()
  let cursorProblem: string | null = null
  const loadGroupSets = opts.loadGroupSets ?? shareRead(() => fetchObsGroupSets())
  // null until read; read only once the map draws more than one group.
  let groupSets: readonly ObsGroupSet[] | null = null
  let setsAsked = false

  // T-14-29: a set's time is taken only when obsGroups is exactly that set's groups.
  function cursorTarget(): ObsTarget | null {
    const s = store.get()
    if (s.colour.source !== 'obs') return null
    const resolved = resolveObsTarget(s.obsGroups, groupSets)
    return resolved.kind === 'target' ? resolved.target : null
  }

  function cursorTime(group: string): number | null {
    const target = cursorTarget()
    if (target === null || !targetGroups(target).includes(group)) return null
    const times = timesOf.get(targetKey(target))
    if (!times) return null
    const t = times[store.get().timeIdx]
    return t !== undefined && Number.isFinite(t) ? t : null
  }

  function ensureSets(): void {
    if (setsAsked) return
    setsAsked = true
    const failed = (why: string): void => {
      // A refused read is asked again on the next change of the map's groups.
      setsAsked = false
      cursorProblem = `The map-time cursor is not drawn: ${why}`
      renderNote()
    }
    loadGroupSets().then(
      (answer) => {
        if (!answer.ok) return failed(`${answer.artifact}: ${answer.reason}`)
        groupSets = answer.sets
        ensureTimes()
        if (!hidden) front?.redraw()
      },
      (error: unknown) => failed(describeError(error)),
    )
  }

  function ensureTimes(): void {
    if (hidden || store.get().colour.source !== 'obs') return
    if (store.get().obsGroups.size > 1 && groupSets === null) {
      ensureSets()
      return
    }
    const target = cursorTarget()
    if (target === null) return
    const key = targetKey(target)
    if (timesOf.has(key)) return
    const members = new Set(targetGroups(target))
    if (!views.some((v) => v.entry?.ok === true && members.has(v.entry.prepared.site.group))) return
    let read = timesReads.get(key)
    if (!read) {
      // One group is asked for by its name, as before; a set by its column and value.
      const asked = target.kind === 'group' ? target.group : target
      read = shareRead(() => fetchObsTimes(asked))
      timesReads.set(key, read)
    }
    read().then(
      (result) => {
        if (result.ok) {
          timesOf.set(key, result.payload.times)
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
    if (dimProblem !== null) textLine(note, dimProblem)
  }

  // A choice changes every panel, so all are rebuilt; focus goes back to the control that was pressed.
  function rebuild(): void {
    const panels = [...panelsEl.children] as HTMLElement[]
    const at = panels.findIndex((panel) => panel.contains(document.activeElement))
    const key = at < 0 ? null : focusedControl(panels[at])
    renderPanels()
    redrawAll()
    const again = panelsEl.children[at]
    if (again instanceof HTMLElement) refocusControl(again, key)
  }

  function setZoom(id: number, range: [number, number] | null): void {
    if (range === null) zooms.delete(id)
    else zooms.set(id, range)
    rebuild()
  }

  function showReadout(view: PanelView): void {
    const el = view.readout
    if (!el) return
    el.textContent = ''
    const at = hover !== null && hover.id === view.id && view.entry?.ok === true ? hover.row : -1
    el.hidden = at < 0
    if (at < 0 || view.entry?.ok !== true) return
    for (const text of readoutLines(view.entry.prepared, at, chartChoices.series.show)) textLine(el, text)
  }

  function setHover(view: PanelView, row: number): void {
    const next = row < 0 ? null : { id: view.id, row }
    if (next?.id === hover?.id && next?.row === hover?.row) return
    hover = next
    showReadout(view)
    if (!hidden) front?.redraw()
  }

  // The plot's own box takes the pointer: a drag across zooms the time axis, a move reads values.
  function wirePlot(view: PanelView, plot: HTMLElement, prepared: PreparedSite): void {
    const left = (): number => MARGIN.left
    const right = (): number => plot.clientWidth - MARGIN.right
    const axis = () => timeAxis(prepared.site.time_kind, drawnFor(view.id, prepared).xDomain, [left(), right()]).axis
    brushes.push(
      attachBrush(plot, {
        plotLeft: left,
        plotRight: right,
        invert: (px) => axis().invert(px),
        onDrag: (range) => {
          dragBand = range === null ? null : { id: view.id, range }
          if (!hidden) front?.redraw()
        },
        onBrush: (range) => {
          if (range[1] > range[0]) setZoom(view.id, range)
        },
      }),
    )
    plot.addEventListener('pointermove', (event) => {
      // A drag is choosing a range; the readout waits until it ends.
      if (dragBand !== null) return
      const px = event.clientX - plot.getBoundingClientRect().left
      if (px < left() || px > right()) return setHover(view, -1)
      setHover(view, nearestRow(prepared.site.time, axis().invert(px), drawnFor(view.id, prepared).xDomain))
    })
    plot.addEventListener('pointerleave', () => setHover(view, -1))
    plot.addEventListener('dblclick', () => {
      if (zooms.has(view.id)) setZoom(view.id, null)
    })
  }

  function renderToolbar(panel: HTMLElement, view: PanelView, prepared: PreparedSite, drawn: Drawn): void {
    const choices = chartChoices.series
    const toolbar = chartToolbar()
    // In the narrow side panel the switches stay folded away until asked for, so the plot keeps its room.
    toolbar.hidden = !choices.options && enlargedId === null
    panel.appendChild(toolbar)
    toolbar.append(
      chartSwitch<ScaleKind>({
        key: 'scale',
        label: 'Scale',
        ariaLabel: 'Scale of the value axis',
        value: drawn.log ? 'log' : 'linear',
        options: [
          { value: 'linear', text: 'linear', title: 'Value axis on a linear scale' },
          { value: 'log', text: 'log', title: 'Value axis on a log scale', refused: drawn.logRefusal },
        ],
        onPick: (value) => {
          choices.scale = value
          rebuild()
        },
      }).el,
      chartSwitch<RangeKind>({
        key: 'range',
        label: 'Range',
        ariaLabel: 'What the value axis fits',
        value: choices.range,
        options: [
          { value: 'all', text: 'fit all', title: 'The value axis fits every realization' },
          {
            value: 'observed',
            text: 'fit observed',
            title:
              'The value axis fits the observed values, the noise band, base and the 5th to 95th percentile of the realizations, so one far-off realization does not flatten the plot',
          },
        ],
        onPick: (value) => {
          choices.range = value
          rebuild()
        },
      }).el,
    )
    const parts = partsOf(prepared)
    const showGroup = document.createElement('div')
    showGroup.classList.add('chart-switch')
    showGroup.setAttribute('role', 'group')
    showGroup.setAttribute('aria-label', 'Parts of the plot that are shown')
    const showLabel = document.createElement('span')
    showLabel.classList.add('label')
    showLabel.textContent = 'Show:'
    showGroup.appendChild(showLabel)
    for (const { part, text, title } of PART_BUTTONS) {
      if (!parts.has(part)) continue
      const only = part === 'last' && prepared.series.some((s) => s.role === 'only')
      showGroup.appendChild(
        chartToggle({
          key: `show:${part}`,
          text: only ? 'iteration' : text,
          title: only ? 'Show or hide the realizations of the one ingested iteration' : title,
          pressed: choices.show[part],
          onToggle: (pressed) => {
            choices.show[part] = pressed
            rebuild()
          },
        }),
      )
    }
    toolbar.appendChild(showGroup)
    if (drawn.zoomed) {
      const reset = document.createElement('button')
      reset.type = 'button'
      reset.textContent = 'Reset zoom'
      reset.title = 'Show the whole time range again (or double-click the plot)'
      reset.dataset.control = 'reset-zoom'
      reset.addEventListener('click', () => setZoom(view.id, null))
      toolbar.appendChild(reset)
    } else {
      const hint = document.createElement('span')
      hint.classList.add('label', 'chart-hint')
      hint.textContent = 'Drag across the plot to zoom.'
      toolbar.appendChild(hint)
    }
  }

  function renderPanels(): void {
    for (const brush of brushes) brush.dispose()
    brushes = []
    hover = null
    dragBand = null
    panelsEl.textContent = ''
    for (const view of views) {
      const panel = hostDiv(panelsEl, 'obs-spaghetti-panel')
      view.plot = null
      view.readout = null
      const titleRow = hostDiv(panel, 'chart-title-row')
      const title = document.createElement('div')
      title.classList.add('body', 'obs-spaghetti-title')
      titleRow.appendChild(title)
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
      const drawn = drawnFor(view.id, prepared)
      title.textContent = prepared.site.site
      const options = document.createElement('button')
      options.type = 'button'
      options.classList.add('chart-options-button')
      options.textContent = 'Plot options'
      options.title = 'Show or hide the scale, range and show/hide switches of the site plots'
      options.dataset.control = 'options'
      options.setAttribute('aria-expanded', String(chartChoices.series.options))
      options.addEventListener('click', () => {
        chartChoices.series.options = !chartChoices.series.options
        rebuild()
      })
      titleRow.append(options, enlargeButton(() => openEnlarged(view.id, prepared.site.site)))
      renderToolbar(panel, view, prepared, drawn)
      const plot = hostDiv(panel, 'obs-spaghetti-plot')
      // Enlarged, the panel over the map sizes the plot; in the side panel it has its own height.
      if (enlargedId === null) plot.style.height = `${PANEL_HEIGHT}px`
      view.plot = plot
      const readout = hostDiv(plot, 'chart-readout')
      readout.setAttribute('role', 'status')
      readout.hidden = true
      view.readout = readout
      wirePlot(view, plot, prepared)
      const legend = hostDiv(panel, 'obs-spaghetti-legend')
      for (const line of [...legendLines(prepared, pickOf), ...viewLines(prepared, drawn, chartChoices.series)]) textLine(legend, line)
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

  // ---- one site's plot shown large over the map ----

  function openEnlarged(id: number, name: string): void {
    if (hidden) return
    enlargedId = id
    enlarged = enlargeChart({
      title: name,
      frame: stage,
      placeholder: `The plot of ${name} is shown enlarged over the map. The other site plots come back when it is closed.`,
      onResize: () => redrawAll(),
      onClose: () => {
        enlarged = null
        enlargedId = null
        if (!disposed) sync()
      },
    })
    sync()
  }

  function refresh(): void {
    if (views.length > 0) ensureCanvases()
    renderNote()
    renderPanels()
    redrawAll()
    ensureTimes()
    ensureReals()
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
    for (const id of [...zooms.keys()]) if (!ids.includes(id)) zooms.delete(id)
    // An enlarged site that leaves the selection closes its panel; close() comes back here with none enlarged.
    if (enlarged !== null && enlargedId !== null && !ids.includes(enlargedId)) return enlarged.close()
    const listed = ids.slice(0, MAX_SPAGHETTI_PANELS)
    // Enlarged, the stage holds that one site; the others stay loaded for when it closes.
    const shown = enlargedId === null ? listed : [enlargedId]
    moreSites = enlargedId === null ? ids.length - listed.length : 0
    for (const id of [...loaded.keys()]) if (!listed.includes(id) && id !== enlargedId) loaded.delete(id)
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
        zooms.clear()
        loaded.clear()
        timesOf.clear()
        timesReads.clear()
        groupSets = null
        setsAsked = false
        realsOf.clear()
        realsReads.clear()
        picks.clear()
      }
      if (hidden) {
        stale = true
        return
      }
      sync()
    },
  )
  const unsubscribeReals = store.subscribe(
    (s) => s.reals,
    () => {
      picks.clear()
      // A refused read gets another try when the selection changes.
      for (const [iteration, entry] of [...realsOf]) if (!entry.ok) realsOf.delete(iteration)
      if (hidden) {
        stale = true
        return
      }
      refresh()
    },
  )
  const unsubscribeCursor = store.subscribe(
    (s) => ({ source: s.colour.source, groups: s.obsGroups, timeIdx: s.timeIdx }),
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
      // A hidden tab draws nothing, so its plot does not stay up over the map.
      enlarged?.close()
      hidden = true
      back?.onHide()
      front?.onHide()
    },
    dispose() {
      disposed = true
      enlarged?.close()
      for (const brush of brushes) brush.dispose()
      unsubscribeSites()
      unsubscribeReals()
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
