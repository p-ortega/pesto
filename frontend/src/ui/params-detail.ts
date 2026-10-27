// What the Params tab shows under the group table: one group's prior and
// posterior histograms, its change, its sigma ratio and every figure that was
// left out, and one parameter's own distribution. Every string that came from a
// run file goes in through textContent. The histograms use the Canvas 2D chart
// kit, one canvas each, and a hidden tab draws nothing.

import type { ParGroupRow, ParGroupsPayload, ParHistPayload, ParHistResult, ParValuesPayload, ParValuesResult, SigmaRatio } from '../data/par'
import { createCanvasHost } from './charts/canvas-host'
import { drawHistogram, type Chart2D } from './charts/histogram'
import { readChartTokens, type ChartTokens } from './charts/tokens'
import { renderNotice, type RenderNoticeOptions } from './chrome'

/** What the panel calls when its tab hides or shows, and when the detail is replaced. */
export interface DetailHandle {
  onShow(): void
  onHide(): void
  destroy(): void
}

interface ChartOptions {
  isHidden: () => boolean
  /** Only for tests: the 2D context to draw into. */
  context?: () => Chart2D | null
  /** Only for tests: the colours to draw with. jsdom has no theme to read. */
  tokens?: () => ChartTokens
}

export interface GroupDetailOptions extends ChartOptions {
  row: ParGroupRow
  /** null while the histograms are still loading. */
  hist: ParHistResult | null
  single: boolean
  left_out: ParGroupsPayload['left_out']
  /** What the reinflation check found; shown beside a ratio that was shown. */
  reinflationNotes?: string[]
}

/** Everything a group detail needs except the histogram answer, so it can be drawn first and again when that arrives. */
export type GroupDetailBase = Omit<GroupDetailOptions, 'hist'>

export interface ParameterDetailOptions extends ChartOptions {
  parameter: string
  values: ParValuesResult
}

const NO_FIGURE = '—'

export function formatChange(value: number): string {
  return `${Number(value.toPrecision(3))}%`
}

// Two decimals for an ordinary figure, two significant digits for a small one so it never rounds to 0.00.
export function formatRatio(value: number): string {
  if (value === 0) return '0.00'
  return Math.abs(value) >= 0.1 ? value.toFixed(2) : value.toPrecision(2)
}

// pestpp's own source label already says pestpp; a bare file name does not.
function pestppLabel(source: string | null): string {
  if (source === null) return 'pestpp'
  return source.toLowerCase().startsWith('pestpp') ? source : `pestpp (${source})`
}

function line(parent: HTMLElement, text: string, opts: { muted?: boolean; title?: string } = {}): HTMLElement {
  const el = document.createElement('div')
  el.classList.add('label', 'wrap-note')
  if (opts.muted) el.style.color = 'var(--ink-muted)'
  el.textContent = text
  if (opts.title) el.title = opts.title
  parent.appendChild(el)
  return el
}

function notice(parent: HTMLElement, opts: RenderNoticeOptions): void {
  const slot = document.createElement('div')
  parent.appendChild(slot)
  renderNotice(slot, opts)
}

function heading(parent: HTMLElement, text: string): void {
  const el = document.createElement('div')
  el.classList.add('body', 'params-detail-title')
  el.textContent = text
  parent.appendChild(el)
}

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`
}

/** The sigma ratio as one sentence, or null when it is refused and has no number. */
export function sigmaRatioText(sigma: SigmaRatio): string | null {
  if (sigma.state === 'refused' || sigma.median === null) return null
  const spread =
    sigma.p10 !== null && sigma.p90 !== null
      ? ` (10th to 90th percentile ${formatRatio(sigma.p10)} to ${formatRatio(sigma.p90)})`
      : ''
  return `sigma ratio ${formatRatio(sigma.median)}${spread}`
}

function sigmaLabel(sigma: SigmaRatio): string {
  const text = sigmaRatioText(sigma)
  if (text === null) return `Sigma ratio: ${sigma.reason ?? 'not shown, and no reason was recorded'}`
  return sigma.state === 'unchecked' && sigma.reason ? `${text}. ${sigma.reason}` : text
}

interface HistogramInput {
  space: 'log10' | 'native'
  edges: number[]
  first: { iteration: number; density: number[] }
  last: { iteration: number; density: number[] } | null
}

// Prior is always the first ingested iteration and posterior the last, whatever the map shows.
function histogramSpec(input: HistogramInput) {
  const series = [
    {
      label: input.last === null ? `iteration ${input.first.iteration}` : `prior, iteration ${input.first.iteration}`,
      density: input.first.density,
    },
  ]
  if (input.last !== null) {
    series.push({ label: `posterior, iteration ${input.last.iteration}`, density: input.last.density })
  }
  return {
    space: input.space,
    edges: input.edges,
    series,
    xLabel: input.space === 'log10' ? 'Parameter value (log scale)' : 'Parameter value',
  }
}

// One canvas in its own box. A draw that the kit refuses says so under the chart instead of leaving it blank.
function mountChart(parent: HTMLElement, input: HistogramInput, label: string, opts: ChartOptions): DetailHandle {
  const box = document.createElement('div')
  box.classList.add('params-chart')
  parent.appendChild(box)
  const failure = document.createElement('div')
  failure.classList.add('label', 'wrap-note')
  failure.style.color = 'var(--status-warning)'
  failure.hidden = true
  parent.appendChild(failure)

  const spec = histogramSpec(input)
  const host = createCanvasHost(box, {
    label,
    context: opts.context,
    draw: (ctx, size) => {
      const tokens = opts.tokens ? opts.tokens() : readChartTokens(box)
      const drawn = drawHistogram(ctx, spec, tokens, size)
      failure.hidden = drawn
      failure.textContent = drawn ? '' : 'The histogram could not be drawn: its bin edges or densities were not usable.'
    },
  })
  if (opts.isHidden()) host.onHide()
  else host.redraw()
  return { onShow: host.onShow, onHide: host.onHide, destroy: host.destroy }
}

function drawable(hist: ParHistPayload): hist is ParHistPayload & {
  space: 'log10' | 'native'
  edges: number[]
  first: NonNullable<ParHistPayload['first']>
} {
  return hist.refused === null && hist.space !== null && hist.edges !== null && hist.first !== null
}

const EXCLUSION_REASONS: { kind: string; text: string }[] = [
  { kind: 'fixed', text: 'fixed, so they do not move' },
  { kind: 'tied', text: 'tied, so they follow another parameter' },
  { kind: 'nonpositive_log', text: 'log-transformed with a value that is not positive' },
  { kind: 'no_values', text: 'no value in the ensembles' },
  { kind: 'unknown_transform', text: 'the transform is not known' },
]

function figures(mean: number | null, sd: number | null): string {
  const part = (name: string, value: number | null) => (value === null ? `no ${name}` : `${name} ${formatChange(value)}`)
  return `${part('mean change', mean)}, ${part('sd change', sd)}`
}

function addChange(parent: HTMLElement, row: ParGroupRow): void {
  const { pesto, pestpp, reason } = row.change
  if (pesto === null) {
    line(parent, reason ?? 'pesto has no change figure for this group')
  } else {
    line(parent, `${pesto.label}: ${figures(pesto.mean_change_pct, pesto.sd_change_pct)}`)
    line(
      parent,
      pesto.mean_shift_sd_median === null
        ? 'no mean shift: no parameter had any spread in the first iteration'
        : `mean shift ${formatRatio(pesto.mean_shift_sd_median)} prior sd, median over the parameters`,
      { title: 'How far the mean moved, in units of the prior standard deviation of each parameter' },
    )
  }
  if (pestpp.mean_change === null && pestpp.std_change === null) {
    line(parent, `pestpp: ${pestpp.note ?? 'no change figure for this group'}`)
  } else {
    line(parent, `${pestppLabel(pestpp.source)}: ${figures(pestpp.mean_change, pestpp.std_change)}`)
    if (pestpp.note) line(parent, pestpp.note, { muted: true })
  }
  if (pestpp.record) {
    line(parent, `${pestpp.record.source}: ${figures(pestpp.record.mean_change, pestpp.record.std_change)}`)
  }
}

function addLeftOut(parent: HTMLElement, row: ParGroupRow, left_out: ParGroupsPayload['left_out']): void {
  if (left_out.count > 0) {
    line(parent, `${plural(left_out.count, 'realization', 'realizations')} left out: present in only one iteration`, {
      title: left_out.reason ?? undefined,
    })
  }
  for (const { kind, text } of EXCLUSION_REASONS) {
    const n = (row.excluded as Record<string, number>)[kind] ?? 0
    if (n > 0) line(parent, `${plural(n, 'parameter', 'parameters')} left out: ${text}`)
  }
  const pesto = row.change.pesto
  if (pesto !== null && pesto.n_refused_near_zero > 0) {
    line(parent, `${plural(pesto.n_refused_near_zero, 'parameter has', 'parameters have')} no percent change: the prior mean is too close to zero`)
  }
  if (pesto !== null && pesto.n_no_spread > 0) {
    line(parent, `${plural(pesto.n_no_spread, 'parameter has', 'parameters have')} no spread in the first iteration, so no sd change`)
  }
  for (const note of row.notes) line(parent, note, { muted: true })
}

function addSigma(parent: HTMLElement, sigma: SigmaRatio, reinflationNotes: string[]): void {
  const text = sigmaRatioText(sigma)
  if (text === null) {
    // The stored sentence replaces the number; histograms and change still show.
    notice(parent, { title: 'Sigma ratio', detail: sigma.reason ?? 'not shown, and no reason was recorded', tone: 'warning' })
    return
  }
  line(parent, text, {
    title:
      sigma.n_used === null
        ? undefined
        : `median over ${plural(sigma.n_used, 'parameter', 'parameters')}; ${sigma.n_no_spread ?? 0} had no spread at the first iteration`,
  })
  if (sigma.state === 'unchecked') {
    notice(parent, {
      title: 'This ratio could not be checked for a reinflation',
      detail: sigma.reason ?? 'no reason was recorded',
      tone: 'warning',
    })
  } else {
    for (const note of reinflationNotes) line(parent, note, { muted: true })
  }
}

function addGroupChart(parent: HTMLElement, opts: GroupDetailOptions): DetailHandle | null {
  const { row, hist } = opts
  if (hist === null) {
    line(parent, 'Loading histograms…', { muted: true })
    return null
  }
  if (!hist.ok) {
    notice(parent, {
      title: 'The histograms could not be read',
      detail: `${hist.artifact}: ${hist.reason}`,
      tone: 'serious',
    })
    return null
  }
  const payload = hist.payload
  const extra = payload.notes.filter((note) => !(opts.single && note.startsWith('only iteration')))
  let handle: DetailHandle | null = null
  if (drawable(payload)) {
    const iterations =
      payload.last === null
        ? `iteration ${payload.first.iteration}`
        : `prior, iteration ${payload.first.iteration} and posterior, iteration ${payload.last.iteration}`
    const label = `Histograms of group ${row.group}, ${iterations}, as densities. ${sigmaLabel(row.sigma_ratio)}`
    handle = mountChart(parent, { space: payload.space, edges: payload.edges, first: payload.first, last: payload.last }, label, opts)
  } else {
    notice(parent, {
      title: 'No histogram for this group',
      detail: payload.refused ?? 'the server sent no bin edges and gave no reason',
      tone: 'warning',
    })
  }
  if (opts.single) {
    const only = payload.first === null ? 'one iteration' : `iteration ${payload.first.iteration}`
    line(parent, `Only ${only} was ingested, so there is no before and after.`)
  }
  for (const note of extra) line(parent, note, { muted: true })
  return handle
}

/** Fills `host` with one group's detail and returns the handle that keeps its canvas honest. */
export function renderGroupDetail(host: HTMLElement, opts: GroupDetailOptions): DetailHandle {
  host.textContent = ''
  host.classList.add('params-detail')
  heading(host, `Group ${opts.row.group}`)
  const chart = addGroupChart(host, opts)
  addSigma(host, opts.row.sigma_ratio, opts.reinflationNotes ?? [])
  addChange(host, opts.row)
  addLeftOut(host, opts.row, opts.left_out)
  return {
    onShow: () => chart?.onShow(),
    onHide: () => chart?.onHide(),
    destroy: () => chart?.destroy(),
  }
}

function moments(prefix: string, series: NonNullable<ParValuesPayload['first']>, space: string): string {
  const part = (name: string, value: number | null) => `${name} ${value === null ? NO_FIGURE : Number(value.toPrecision(4))}`
  const scale = space === 'log10' ? ' (of the log10 values)' : ''
  return `${prefix}, iteration ${series.iteration}: ${part('mean', series.mean)}, ${part('sd', series.sd)}${scale}`
}

/** Fills `host` with one parameter's own distribution, or the reason it has none. */
export function renderParameterDetail(host: HTMLElement, opts: ParameterDetailOptions): DetailHandle {
  host.textContent = ''
  host.classList.add('params-detail')
  heading(host, `Parameter ${opts.parameter}`)
  const none: DetailHandle = { onShow: () => undefined, onHide: () => undefined, destroy: () => undefined }
  const { values } = opts
  if (!values.ok) {
    notice(host, { title: 'This parameter has no distribution', detail: values.reason, tone: 'warning' })
    return none
  }
  const payload = values.payload
  if (payload.refused !== null || payload.edges === null || payload.first === null) {
    notice(host, {
      title: 'This parameter has no distribution',
      detail: payload.refused ?? 'the server sent no bin edges and gave no reason',
      tone: 'warning',
    })
    return none
  }
  const iterations =
    payload.last === null
      ? `iteration ${payload.first.iteration}`
      : `prior, iteration ${payload.first.iteration} and posterior, iteration ${payload.last.iteration}`
  const handle = mountChart(
    host,
    { space: payload.space, edges: payload.edges, first: payload.first, last: payload.last },
    `Distribution of parameter ${payload.parameter} in group ${payload.group}, ${iterations}, as densities.`,
    opts,
  )
  line(host, moments(payload.last === null ? 'iteration' : 'prior', payload.first, payload.space))
  if (payload.last !== null) line(host, moments('posterior', payload.last, payload.space))
  for (const note of payload.notes) line(host, note, { muted: true })
  return handle
}
