// The layer, realization and statistic controls: three keyboard-reachable
// form elements that name their own current value and tell
// onSelectionChange what changed. This module computes nothing, fetches
// nothing and draws nothing -- the view (views/map.ts) owns the redraw
// discipline that reacts to the selection this file reports.

import type { RealNamesResult } from '../data/reals'

export const STATISTICS = ['value', 'mean', 'std', 'q05', 'q25', 'q50', 'q75', 'q95'] as const
export type Statistic = (typeof STATISTICS)[number]

export interface Selection {
  iteration: number
  layer: number
  stat: Statistic
  realization: string | null
}

export interface SelectionControlsOptions {
  /** The grid's layer count -- the layer slider's range is `[0, nlay - 1]`. */
  nlay: number
  /** Fixed for this plan; no iteration selector exists yet, so every
   * emitted selection carries it through unchanged. */
  iteration: number
  /** Already resolved by `fetchRealNames` -- this module reads it, it does
   * not fetch it. */
  realNames: RealNamesResult
  onSelectionChange: (selection: Selection) => void
}

function isStatistic(value: string): value is Statistic {
  return (STATISTICS as readonly string[]).includes(value)
}

/**
 * Builds the layer slider, the statistic select and the realization slider
 * into a `.floating` panel. Every control is a real `<input>`/`<select>`
 * with an `aria-label`, so each is keyboard reachable by construction; no
 * `tabindex` above zero is ever set here.
 */
export function renderSelectionControls(el: HTMLElement, opts: SelectionControlsOptions): void {
  el.textContent = ''
  el.classList.add('floating')

  const nlay = Math.max(opts.nlay, 1)

  // Layer: an always-present slider, disabled (not hidden) when the grid
  // has only one layer -- hiding it would make a one-layer run look like a
  // different application.
  const layerLabel = document.createElement('label')
  layerLabel.classList.add('label')
  layerLabel.textContent = 'Layer'
  const layerInput = document.createElement('input')
  layerInput.type = 'range'
  layerInput.min = '0'
  layerInput.max = String(nlay - 1)
  layerInput.step = '1'
  layerInput.value = '0'
  layerInput.setAttribute('aria-label', 'Layer')
  layerInput.disabled = nlay <= 1
  const layerValue = document.createElement('span')
  layerValue.classList.add('tabular-nums')
  layerValue.textContent = '0'
  layerLabel.appendChild(layerInput)
  layerLabel.appendChild(layerValue)

  // Statistic: exactly the eight servable statistics (enscache.STATS is the
  // authority this list mirrors), never a value this control invents.
  const statLabel = document.createElement('label')
  statLabel.classList.add('label')
  statLabel.textContent = 'Statistic'
  const statSelect = document.createElement('select')
  statSelect.setAttribute('aria-label', 'Statistic')
  for (const stat of STATISTICS) {
    const option = document.createElement('option')
    option.setAttribute('value', stat)
    option.textContent = stat
    statSelect.appendChild(option)
  }
  statSelect.value = 'value'
  statLabel.appendChild(statSelect)

  // Realization: positions are the names fetchRealNames returned, in the
  // order the route served them, never a row number standing in for a
  // missing name.
  const realLabel = document.createElement('label')
  realLabel.classList.add('label')
  realLabel.textContent = 'Realization'
  const realInput = document.createElement('input')
  realInput.type = 'range'
  realInput.setAttribute('aria-label', 'Realization')
  const realValue = document.createElement('span')
  realValue.classList.add('tabular-nums')
  realLabel.appendChild(realInput)
  realLabel.appendChild(realValue)

  let realNames: string[] = []
  let warningLine: HTMLElement | null = null

  if (opts.realNames.ok) {
    realNames = opts.realNames.names
    const lastIndex = Math.max(realNames.length - 1, 0)
    realInput.min = '0'
    realInput.max = String(lastIndex)
    realInput.step = '1'
    realInput.value = '0'
    realInput.disabled = realNames.length <= 1 || statSelect.value !== 'value'
    realValue.textContent = realNames[0] ?? '—'
  } else {
    realInput.min = '0'
    realInput.max = '0'
    realInput.value = '0'
    realInput.disabled = true
    realValue.textContent = '—'
    warningLine = document.createElement('div')
    warningLine.classList.add('label')
    warningLine.style.color = 'var(--status-warning)'
    warningLine.textContent =
      `Realization names weren't recorded for iteration ${opts.realNames.iteration}, ` +
      "so a realization can't be named."
  }

  function currentSelection(): Selection {
    const stat = isStatistic(statSelect.value) ? statSelect.value : 'value'
    const realization = stat === 'value' ? (realNames[Number(realInput.value)] ?? null) : null
    return {
      iteration: opts.iteration,
      layer: Number(layerInput.value),
      stat,
      realization,
    }
  }

  layerInput.addEventListener('input', () => {
    layerValue.textContent = layerInput.value
    opts.onSelectionChange(currentSelection())
  })

  statSelect.addEventListener('change', () => {
    const isValueStat = statSelect.value === 'value'
    realInput.disabled = !isValueStat || realNames.length <= 1
    opts.onSelectionChange(currentSelection())
  })

  realInput.addEventListener('input', () => {
    const index = Number(realInput.value)
    realValue.textContent = realNames[index] ?? '—'
    opts.onSelectionChange(currentSelection())
  })

  el.appendChild(layerLabel)
  el.appendChild(statLabel)
  el.appendChild(realLabel)
  if (warningLine) {
    el.appendChild(warningLine)
  }
}
