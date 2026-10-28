// What the Obs tab shows for the chosen group: its 1:1 plot as one density
// panel per iteration on shared axes. Every string that came from a run goes in
// through textContent. A hidden tab fetches and draws nothing, and a group
// change while an answer is out draws only the newest group.

import { ApiError } from '../data/client'
import { LatestWins } from '../data/latest-wins'
import { fetchObs1to1, type Obs1to1Payload, type Obs1to1Result } from '../data/obs'
import type { SelectionStore } from '../state/selection'
import { createCanvasHost, type CanvasHost } from './charts/canvas-host'
import { drawDensity, type DensitySpec } from './charts/density'
import type { Chart2D } from './charts/histogram'
import { readChartTokens } from './charts/tokens'
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

export function renderGroupFit(host: HTMLElement, opts: GroupFitOptions): GroupFitHandle {
  let hidden = opts.startHidden === true
  let group: string | null = null
  // A group chosen while hidden is loaded by the next onShow.
  let pendingLoad = false
  let fit: FitState = { kind: 'loading' }
  let fitHosts: CanvasHost[] = []
  const fitSlot = new LatestWins<Obs1to1Result>()

  let titleEl: HTMLElement | null = null
  let fitSection: HTMLElement | null = null

  function destroyFitHosts(): void {
    for (const canvas of fitHosts) canvas.destroy()
    fitHosts = []
  }

  function mountPanel(row: HTMLElement, spec: DensitySpec, label: string): void {
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
        const drawn = drawDensity(ctx, spec, readChartTokens(document.documentElement), size)
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
      return
    }
    const shadeMax = largestCount(payload)
    const row = document.createElement('div')
    row.style.display = 'flex'
    row.style.gap = 'var(--space-sm)'
    section.appendChild(row)
    for (const grid of payload.grids) {
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
      mountPanel(row, spec, `1:1 plot of group ${payload.group}, iteration ${grid.iteration}, as a density of ensemble values`)
    }
    if (payload.grids.length === 1) {
      line(section, `only iteration ${payload.grids[0].iteration} has an observation ensemble`)
    }
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
  }

  function clear(): void {
    fitSlot.cancel()
    destroyFitHosts()
    fitSection = null
    titleEl = null
    host.textContent = ''
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

  function load(): void {
    if (group === null) return
    pendingLoad = false
    buildSkeleton()
    loadFit(group)
  }

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
      if (pendingLoad) load()
    },
    onHide() {
      hidden = true
      for (const canvas of fitHosts) canvas.onHide()
    },
    dispose() {
      clear()
    },
  }
}
