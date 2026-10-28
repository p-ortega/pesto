// What the Obs tab shows for the chosen group: its 1:1 plot as one density
// panel per iteration on shared axes, with the most outlying sites and the
// selected sites drawn on top, then its residual histogram, and every count of
// what was left out. Every string that came from a run goes in
// through textContent. A hidden tab fetches and draws nothing, and a group
// change while an answer is out draws only the newest group.

import { ApiError } from '../data/client'
import { LatestWins } from '../data/latest-wins'
import {
  fetchObs1to1,
  fetchObsPoints,
  fetchObsResidHist,
  MAX_POINT_SITES,
  TABLE_RMSE_LABEL,
  type Obs1to1Payload,
  type Obs1to1Result,
  type ObsPointsResult,
  type ObsResidHistPayload,
  type ObsResidHistResult,
  type SitePoints,
} from '../data/obs'
import type { SelectionStore } from '../state/selection'
import { linearAxis } from './charts/axes'
import { createCanvasHost, type CanvasHost } from './charts/canvas-host'
import { densityPlotArea, drawDensity, type DensitySpec } from './charts/density'
import { drawHistogram, type Chart2D, type ChartSize, type HistogramSpec } from './charts/histogram'
import { drawMarkers, drawRangeBars } from './charts/marks'
import { readChartTokens, type ChartTokens } from './charts/tokens'
import { renderNotice } from './chrome'

export interface GroupFitOptions {
  store: SelectionStore
  /** True when the tab is not the open one: nothing is fetched or drawn until onShow. */
  startHidden?: boolean
  /** Only for tests: the 2D context to draw into. */
  context2d?: () => Chart2D | null
}

export interface GroupFitHandle {
  setGroup(group: string | null): void
  onShow(): void
  onHide(): void
  dispose(): void
}

const PANEL_HEIGHT = 280
const HIST_HEIGHT = 220
const MARKER_RADIUS = 3
const BAR_WIDTH = 1.5

/** The selected sites' answer, with how many ids were asked for and how many of those were over the cap. */
interface SelectedState {
  answer: ObsPointsResult | { ok: false; artifact: string; reason: string }
  notAsked: number
}

type HistState =
  | { kind: 'loading' }
  | { kind: 'failed'; artifact: string; reason: string }
  | { kind: 'answered'; payload: ObsResidHistPayload }

type FitState =
  | { kind: 'loading' }
  | { kind: 'failed'; artifact: string; reason: string }
  | { kind: 'answered'; payload: Obs1to1Payload }

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`
}

function describeFailure(error: unknown, fallback: string): { artifact: string; reason: string } {
  if (error instanceof ApiError) {
    return { artifact: error.problem.artifact ?? fallback, reason: error.problem.detail ?? error.problem.title }
  }
  return { artifact: fallback, reason: error instanceof Error ? error.message : String(error) }
}

function line(parent: HTMLElement, text: string, muted = false): HTMLElement {
  const el = document.createElement('div')
  el.classList.add('label', 'wrap-note')
  if (muted) el.style.color = 'var(--ink-muted)'
  el.textContent = text
  parent.appendChild(el)
  return el
}

function notice(parent: HTMLElement, title: string, detail: string): void {
  const slot = document.createElement('div')
  parent.appendChild(slot)
  renderNotice(slot, { title, detail, tone: 'warning' })
}

// One top for the shading in every panel, so the same count looks the same in both.
function largestCount(payload: Obs1to1Payload): number {
  let top = 0
  for (const grid of payload.grids) {
    for (const count of grid.counts) if (count > top) top = count
  }
  return top
}

interface PlacedPoint {
  obsval: number
  mean: number
  q05: number | null
  q95: number | null
  hollow: boolean
}

interface Placed {
  points: PlacedPoint[]
  /** Points whose observed or simulated value lies off the drawn range. */
  outside: number
  noMean: number
  /** Sites with no series for this panel's iteration. */
  noSeries: number
}

function finiteOrNull(value: number | null | undefined): number | null {
  return value !== null && value !== undefined && Number.isFinite(value) ? value : null
}

// A point off the range is counted, never moved onto the edge; a missing mean is counted, never drawn at zero.
function placePoints(sites: readonly SitePoints[], iteration: number, lo: number, hi: number): Placed {
  const placed: Placed = { points: [], outside: 0, noMean: 0, noSeries: 0 }
  for (const site of sites) {
    const series = site.series.find((s) => s.iteration === iteration)
    if (series === undefined) {
      placed.noSeries += 1
      continue
    }
    for (let i = 0; i < series.obsval.length; i++) {
      const obsval = finiteOrNull(series.obsval[i])
      const mean = finiteOrNull(series.mean[i])
      if (obsval === null || mean === null) {
        placed.noMean += 1
        continue
      }
      if (obsval < lo || obsval > hi || mean < lo || mean > hi) {
        placed.outside += 1
        continue
      }
      placed.points.push({
        obsval,
        mean,
        q05: finiteOrNull(series.q05[i]),
        q95: finiteOrNull(series.q95[i]),
        hollow: series.weighted[i] !== true,
      })
    }
  }
  return placed
}

interface PointSet {
  points: PlacedPoint[]
  shape: 'circle' | 'square'
  slot: 'series1' | 'series2'
}

// The points sit on the density's own pixels, and a bar that runs off the range is cut at its edge.
function drawPointSets(ctx: Chart2D, size: ChartSize, range: [number, number], tokens: ChartTokens, sets: PointSet[]): void {
  const area = densityPlotArea(size)
  const xAxis = linearAxis(range, [area.left, area.left + area.width])
  const yAxis = linearAxis(range, [area.top + area.height, area.top])
  ctx.save()
  ctx.beginPath()
  ctx.rect(area.left, area.top, area.width, area.height)
  ctx.clip()
  for (const set of sets) {
    const bars = set.points.flatMap((p) =>
      p.q05 === null || p.q95 === null ? [] : [{ x: xAxis.toPx(p.obsval), low: yAxis.toPx(p.q05), high: yAxis.toPx(p.q95) }],
    )
    const colour = tokens[set.slot]
    drawRangeBars(ctx, bars, { colour, width: BAR_WIDTH })
    drawMarkers(
      ctx,
      set.points.map((p) => ({ x: xAxis.toPx(p.obsval), y: yAxis.toPx(p.mean), hollow: p.hollow })),
      { shape: set.shape, radius: MARKER_RADIUS, colour },
    )
  }
  ctx.restore()
}

function formatFigure(value: number | null): string {
  return value === null ? 'no figure' : Number(value.toPrecision(4)).toString()
}

interface Panel {
  grid: Obs1to1Payload['grids'][number]
  outlying: Placed
  chosen: Placed
}

function selectedLines(selected: SelectedState | null): string[] {
  if (selected === null) return []
  const lines: string[] = []
  const { answer } = selected
  if (!answer.ok) {
    lines.push(`The selected sites' points could not be read: ${answer.artifact}: ${answer.reason}`)
  } else {
    const { sites, not_in_group, unknown } = answer.payload
    if (not_in_group.length > 0) lines.push(`${plural(not_in_group.length, 'selected site is', 'selected sites are')} not in this group`)
    if (unknown.length > 0) lines.push(`${plural(unknown.length, 'selected site is', 'selected sites are')} not known to this run`)
    const bare = sites.filter((site) => site.series.every((s) => s.obsval.length === 0)).length
    if (bare > 0) lines.push(`${plural(bare, 'selected site has', 'selected sites have')} no observation with a measured value`)
  }
  if (selected.notAsked > 0) {
    lines.push(`${plural(selected.notAsked, 'more selected site is', 'more selected sites are')} not drawn: at most ${MAX_POINT_SITES} are drawn`)
  }
  return lines
}

function panelLines(panel: Panel): string[] {
  const where = `iteration ${panel.grid.iteration}`
  const lines = [`${where}: ${plural(panel.grid.n_outside, 'realization value lies', 'realization values lie')} outside the drawn range`]
  if (panel.grid.n_nonfinite > 0) {
    lines.push(`${where}: ${plural(panel.grid.n_nonfinite, 'simulated value is', 'simulated values are')} missing and not counted`)
  }
  const outside = panel.outlying.outside + panel.chosen.outside
  if (outside > 0) lines.push(`${where}: ${plural(outside, 'point lies', 'points lie')} outside the drawn range and not drawn`)
  const noMean = panel.outlying.noMean + panel.chosen.noMean
  if (noMean > 0) lines.push(`${where}: ${plural(noMean, 'point has', 'points have')} no ensemble mean and ${noMean === 1 ? 'is' : 'are'} not drawn`)
  const noSeries = panel.outlying.noSeries + panel.chosen.noSeries
  if (noSeries > 0) lines.push(`${where}: ${plural(noSeries, 'site has', 'sites have')} no points at this iteration`)
  return lines
}

// What the 1:1 legend says besides the colours: the rule, the shapes and every count left out.
function fitLegend(payload: Obs1to1Payload, panels: Panel[], selected: SelectedState | null): string[] {
  const lines: string[] = []
  if (payload.grids.length === 1) lines.push(`only iteration ${payload.grids[0].iteration} has an observation ensemble`)
  if (payload.outlying.length > 0) {
    lines.push(`squares, outlying sites: ${payload.ranking_rule}`)
    const named = payload.outlying.map((site) => `${site.site} ${formatFigure(site.rmse_last)}`)
    lines.push(`outlying sites and their ${TABLE_RMSE_LABEL}: ${named.join(', ')}`)
  }
  const chosen = selected !== null && selected.answer.ok ? selected.answer.payload.sites.length : 0
  if (chosen > 0) lines.push(`circles, selected sites: ${chosen}`)
  const anyPoint = panels.some((p) => p.outlying.points.length + p.chosen.points.length > 0)
  if (anyPoint) lines.push('bars: 5th to 95th percentile of the realizations')
  if (panels.some((p) => [...p.outlying.points, ...p.chosen.points].some((point) => point.hollow))) {
    lines.push('hollow marks: zero weight, a model output that is not fitted')
  }
  lines.push(`zero weight included: ${payload.n_zero_weight.toLocaleString('en-US')}`)
  const last = payload.grids[payload.grids.length - 1]
  lines.push(
    `left out: ${payload.left_out.no_value.toLocaleString('en-US')} no measured value, ${payload.left_out.sentinel.toLocaleString('en-US')} sentinel, ${last.n_no_valid.toLocaleString('en-US')} no valid realization at iteration ${last.iteration}`,
  )
  const first = payload.grids[0]
  if (payload.grids.length > 1 && first.n_no_valid > 0) {
    lines.push(`iteration ${first.iteration}: ${plural(first.n_no_valid, 'observation has', 'observations have')} no valid realization`)
  }
  for (const panel of panels) lines.push(...panelLines(panel))
  lines.push(...selectedLines(selected))
  return lines
}

function count(n: number): string {
  return n.toLocaleString('en-US')
}

type DrawableHist = ObsResidHistPayload & { first: NonNullable<ObsResidHistPayload['first']> }

function drawableHist(payload: ObsResidHistPayload): payload is DrawableHist {
  return payload.refused === null && payload.edges.length >= 2 && payload.first !== null
}

function histSpec(payload: DrawableHist): HistogramSpec {
  const series =
    payload.last === null
      ? [{ label: `iteration ${payload.first.iteration}`, density: payload.first.density }]
      : [
          { label: `first, iteration ${payload.first.iteration}`, density: payload.first.density },
          { label: `last, iteration ${payload.last.iteration}`, density: payload.last.density },
        ]
  return { space: 'native', edges: payload.edges, series, xLabel: 'residual: simulated minus observed' }
}

// What the histogram's legend says besides the colours: the sign, the zero-weight count and every count left out.
function histLegend(payload: ObsResidHistPayload): string[] {
  const lines = ['residual: simulated minus observed']
  lines.push(`zero weight included: ${count(payload.n_zero_weight)}`)
  const { no_value, sentinel, no_valid_realization } = payload.left_out
  const single = payload.last === null
  const noValid = single ? no_valid_realization.first : no_valid_realization.last
  const where = single && payload.first !== null ? `at iteration ${payload.first.iteration}` : 'at the last iteration'
  lines.push(`left out: ${count(no_value)} no measured value, ${count(sentinel)} sentinel, ${count(noValid)} with no valid realization ${where}`)
  if (!single && no_valid_realization.first > 0) {
    lines.push(`${count(no_valid_realization.first)} with no valid realization at the first iteration`)
  }
  if (payload.first !== null) {
    const first = single ? `iteration ${payload.first.iteration}` : `first, iteration ${payload.first.iteration}`
    lines.push(`${first}: ${count(payload.n_outside.first)} outside the drawn range`)
  }
  if (payload.last !== null) lines.push(`last, iteration ${payload.last.iteration}: ${count(payload.n_outside.last)} outside the drawn range`)
  if (payload.inequality_note !== null) lines.push(payload.inequality_note)
  return lines
}

export function renderGroupFit(host: HTMLElement, opts: GroupFitOptions): GroupFitHandle {
  let hidden = opts.startHidden === true
  let group: string | null = null
  // A group chosen while hidden is loaded by the next onShow.
  let pendingLoad = false
  let fit: FitState = { kind: 'loading' }
  let hist: HistState = { kind: 'loading' }
  let selected: SelectedState | null = null
  // A sites change while hidden is followed by the next onShow.
  let pointsStale = false
  let fitHosts: CanvasHost[] = []
  let histHost: CanvasHost | null = null
  const histSlot = new LatestWins<ObsResidHistResult>()
  const fitSlot = new LatestWins<Obs1to1Result>()
  const pointsSlot = new LatestWins<ObsPointsResult>()

  let titleEl: HTMLElement | null = null
  let fitSection: HTMLElement | null = null
  let histSection: HTMLElement | null = null

  function destroyFitHosts(): void {
    for (const canvas of fitHosts) canvas.destroy()
    fitHosts = []
  }

  function destroyHistHost(): void {
    histHost?.destroy()
    histHost = null
  }

  function renderHist(): void {
    if (histSection === null) return
    destroyHistHost()
    const section = histSection
    section.textContent = ''
    if (hist.kind === 'loading') {
      line(section, 'Loading the residual histogram…', true)
      return
    }
    if (hist.kind === 'failed') {
      notice(section, 'The residual histogram could not be read', `${hist.artifact}: ${hist.reason}`)
      return
    }
    const payload = hist.payload
    if (payload.group !== group) {
      notice(section, 'The residual histogram could not be read', `the server answered for group ${payload.group}, not ${group}`)
      return
    }
    if (drawableHist(payload)) {
      const spec = histSpec(payload)
      const box = document.createElement('div')
      box.style.height = `${HIST_HEIGHT}px`
      section.appendChild(box)
      const failure = line(section, '')
      failure.style.color = 'var(--status-warning)'
      failure.hidden = true
      histHost = createCanvasHost(box, {
        label: `Residual histogram of group ${payload.group}, simulated minus observed, as densities`,
        context: opts.context2d,
        draw: (ctx, size) => {
          const ok = drawHistogram(ctx, spec, readChartTokens(document.documentElement), size)
          failure.hidden = ok
          failure.textContent = ok ? '' : 'The histogram could not be drawn: its bin edges or densities were not usable.'
        },
      })
      if (hidden) histHost.onHide()
      else histHost.redraw()
    } else {
      notice(section, 'No residual histogram for this group', payload.refused ?? 'the server sent no bin edges and gave no reason')
    }
    const legend = document.createElement('div')
    legend.classList.add('obs-fit-legend')
    section.appendChild(legend)
    for (const text of histLegend(payload)) line(legend, text)
    for (const note of payload.notes) line(legend, note, true)
  }

  function mountPanel(row: HTMLElement, spec: DensitySpec, label: string, sets: PointSet[]): void {
    const cell = document.createElement('div')
    cell.style.flex = '1 1 0'
    cell.style.minWidth = '0'
    const box = document.createElement('div')
    box.style.height = `${PANEL_HEIGHT}px`
    cell.appendChild(box)
    const failure = line(cell, '')
    failure.style.color = 'var(--status-warning)'
    failure.hidden = true
    row.appendChild(cell)
    const canvas = createCanvasHost(box, {
      label,
      context: opts.context2d,
      draw: (ctx, size) => {
        const tokens = readChartTokens(document.documentElement)
        const drawn = drawDensity(ctx, spec, tokens, size)
        if (drawn) drawPointSets(ctx, size, [spec.lo, spec.hi], tokens, sets)
        failure.hidden = drawn
        failure.textContent = drawn ? '' : 'The 1:1 plot could not be drawn: its grid or range was not usable.'
      },
    })
    fitHosts.push(canvas)
    if (hidden) canvas.onHide()
    else canvas.redraw()
  }

  function renderFit(): void {
    if (fitSection === null) return
    destroyFitHosts()
    const section = fitSection
    section.textContent = ''
    if (fit.kind === 'loading') {
      line(section, 'Loading the 1:1 plot…', true)
      return
    }
    if (fit.kind === 'failed') {
      notice(section, 'The 1:1 plot could not be read', `${fit.artifact}: ${fit.reason}`)
      return
    }
    const payload = fit.payload
    if (payload.group !== group) {
      notice(section, 'The 1:1 plot could not be read', `the server answered for group ${payload.group}, not ${group}`)
      return
    }
    const { lo, hi } = payload
    if (payload.refused !== null || lo === null || hi === null || payload.grids.length === 0) {
      notice(section, 'No 1:1 plot for this group', payload.refused ?? 'the server sent no grid and gave no reason')
      line(section, `zero weight included: ${payload.n_zero_weight.toLocaleString('en-US')}`)
      line(section, `left out: ${payload.left_out.no_value.toLocaleString('en-US')} no measured value, ${payload.left_out.sentinel.toLocaleString('en-US')} sentinel`)
      return
    }
    const chosenSites = selected !== null && selected.answer.ok ? selected.answer.payload.sites : []
    const shadeMax = largestCount(payload)
    const row = document.createElement('div')
    row.style.display = 'flex'
    row.style.gap = 'var(--space-sm)'
    section.appendChild(row)
    const panels: Panel[] = []
    for (const grid of payload.grids) {
      const outlying = placePoints(payload.outlying, grid.iteration, lo, hi)
      const chosen = placePoints(chosenSites, grid.iteration, lo, hi)
      panels.push({ grid, outlying, chosen })
      const spec: DensitySpec = {
        nBins: payload.n_bins,
        counts: grid.counts,
        lo,
        hi,
        shadeMax,
        title: `iteration ${grid.iteration}`,
        xLabel: payload.x_label,
        yLabel: payload.y_label,
      }
      const sets: PointSet[] = [
        { points: outlying.points, shape: 'square', slot: 'series2' },
        { points: chosen.points, shape: 'circle', slot: 'series1' },
      ]
      mountPanel(row, spec, `1:1 plot of group ${payload.group}, iteration ${grid.iteration}, as a density of ensemble values`, sets)
    }
    const legend = document.createElement('div')
    legend.classList.add('obs-fit-legend')
    section.appendChild(legend)
    for (const text of fitLegend(payload, panels, selected)) line(legend, text)
    const shown = payload.notes.filter((note) => !note.startsWith('only iteration') && !/outside the drawn range/.test(note))
    for (const note of shown) line(legend, note, true)
  }

  function buildSkeleton(): void {
    host.textContent = ''
    titleEl = document.createElement('div')
    titleEl.classList.add('body', 'obs-fit-title')
    titleEl.textContent = `Fit of group ${group}`
    host.appendChild(titleEl)
    fitSection = document.createElement('div')
    fitSection.classList.add('obs-fit-1to1')
    host.appendChild(fitSection)
    histSection = document.createElement('div')
    histSection.classList.add('obs-fit-resid')
    host.appendChild(histSection)
  }

  function clear(): void {
    fitSlot.cancel()
    pointsSlot.cancel()
    histSlot.cancel()
    selected = null
    destroyFitHosts()
    destroyHistHost()
    fitSection = null
    histSection = null
    titleEl = null
    host.textContent = ''
  }

  // The ids go to the server in the set's own order, at most MAX_POINT_SITES of them; the rest are counted.
  function loadSelected(): void {
    if (group === null) return
    pointsStale = false
    const name = group
    const ids = [...opts.store.get().sites]
    if (ids.length === 0) {
      pointsSlot.cancel()
      if (selected !== null) {
        selected = null
        renderFit()
      }
      return
    }
    const asked = ids.slice(0, MAX_POINT_SITES)
    const notAsked = ids.length - asked.length
    void pointsSlot.run(`${name}|${asked.join(',')}`, (signal) => fetchObsPoints(name, asked, { signal })).then(
      (answer) => {
        if (answer.stale) return
        selected = { answer: answer.value, notAsked }
        renderFit()
      },
      (error: unknown) => {
        selected = { answer: { ok: false, ...describeFailure(error, 'obs_index') }, notAsked }
        renderFit()
      },
    )
  }

  function loadFit(name: string): void {
    fit = { kind: 'loading' }
    renderFit()
    void fitSlot.run(name, (signal) => fetchObs1to1(name, { signal })).then(
      (answer) => {
        if (answer.stale) return
        fit = answer.value.ok
          ? { kind: 'answered', payload: answer.value.payload }
          : { kind: 'failed', artifact: answer.value.artifact, reason: answer.value.reason }
        renderFit()
      },
      (error: unknown) => {
        fit = { kind: 'failed', ...describeFailure(error, 'obs_1to1') }
        renderFit()
      },
    )
  }

  function loadHist(name: string): void {
    hist = { kind: 'loading' }
    renderHist()
    void histSlot.run(name, (signal) => fetchObsResidHist(name, { signal })).then(
      (answer) => {
        if (answer.stale) return
        hist = answer.value.ok
          ? { kind: 'answered', payload: answer.value.payload }
          : { kind: 'failed', artifact: answer.value.artifact, reason: answer.value.reason }
        renderHist()
      },
      (error: unknown) => {
        hist = { kind: 'failed', ...describeFailure(error, 'obs_agg') }
        renderHist()
      },
    )
  }

  function load(): void {
    if (group === null) return
    pendingLoad = false
    selected = null
    buildSkeleton()
    loadFit(group)
    loadHist(group)
    loadSelected()
  }

  const unsubscribeSites = opts.store.subscribe(
    (s) => s.sites,
    () => {
      if (group === null || pendingLoad) return
      if (hidden) pointsStale = true
      else loadSelected()
    },
  )

  return {
    setGroup(next) {
      if (next === group) return
      group = next
      clear()
      if (next === null) {
        pendingLoad = false
        return
      }
      if (hidden) pendingLoad = true
      else load()
    },
    onShow() {
      hidden = false
      for (const canvas of fitHosts) canvas.onShow()
      histHost?.onShow()
      if (pendingLoad) load()
      else if (pointsStale) loadSelected()
    },
    onHide() {
      hidden = true
      for (const canvas of fitHosts) canvas.onHide()
      histHost?.onHide()
    },
    dispose() {
      unsubscribeSites()
      clear()
    },
  }
}
