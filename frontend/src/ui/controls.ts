// The layer, realization, statistic, colour and scale controls: a set of
// keyboard-reachable form elements that name their own current value and
// tell onSelectionChange what changed. This module computes nothing,
// fetches nothing and draws nothing -- the view (views/map.ts) owns the
// redraw discipline that reacts to the selection this file reports.

import type { RealNamesResult } from '../data/reals'
import { STOPS, type ColormapName, type LimitsMode, type ValueScale } from '../gl/colormap'

export const STATISTICS = ['value', 'mean', 'std', 'q05', 'q25', 'q50', 'q75', 'q95'] as const
export type Statistic = (typeof STATISTICS)[number]

// The nine ramp names, in the order the picker lists them. A plain literal
// array rather than `Object.keys(STOPS)` so the names are typed and
// spelled out once, matching STOPS's own keys.
const COLORMAP_NAMES: readonly ColormapName[] = [
  'viridis',
  'magma',
  'cividis',
  'greys',
  'RdBu',
  'coolwarm',
  'BrBG',
  'turbo',
  'jet',
]

// jet's three lightness reversals invent boundaries the data does not
// have (visual contract §4) -- flagged in the picker, not removed, since
// existing reports use it and clients ask for it.
const JET_REASON = 'A ramp whose lightness reverses three times invents boundaries that are not in the data.'

const LOG_WARNING_ID = 'scale-log10-warning'

export interface FieldChoice {
  iteration: number
  layer: number
  stat: Statistic
  realization: string | null
  colormap: ColormapName
  reverseColormap: boolean
  scale: ValueScale
  /** True until the user explicitly changes the scale control -- the
   *  legend states "inferred from partrans" only while this holds. */
  scaleInferred: boolean
  limitsMode: LimitsMode
  manualLimits: [number, number] | null
}

export interface SelectionControlsOptions {
  /** The grid's layer count -- the layer slider's range is `[0, nlay - 1]`. */
  nlay: number
  /** The iteration every emitted selection carries; `setIteration` moves it. */
  iteration: number
  /** Already resolved by `fetchRealNames` -- this module reads it, it does
   * not fetch it. */
  realNames: RealNamesResult
  /** The drawn group's own `partrans`, straight from the control file --
   * matched case-insensitively after trimming; anything unrecognised
   * defaults to linear, never a crash and never a guess. */
  partrans: string | null
  /** The already-committed colormap, reverse, scale and limits state to
   *  show at construction -- a restored view state, say -- instead of the
   *  fresh-run defaults (viridis, not reversed, robust limits, scale from
   *  `partrans`). Omitted, this control still falls back to exactly those
   *  defaults, so every existing caller keeps its old behaviour (WINDOWS.md
   *  #8: the checkbox used to never learn what the view already knew). */
  initial?: Pick<FieldChoice, 'colormap' | 'reverseColormap' | 'scale' | 'scaleInferred' | 'limitsMode' | 'manualLimits'> & {
    stat?: Statistic
  }
  onSelectionChange: (selection: FieldChoice) => void
  /** MAP-11/D-15: the one button-shaped primary action this map surface
   *  has. Calls the same `camera.fit(bounds)` the `Home` key triggers. */
  onFitToExtent: () => void
}

export interface SelectionControlsHandle {
  /** Called by the view every time a new field lands, so the scale
   *  control's log availability reflects the field actually on screen
   *  (D-03). `count` is the number of finite, zero-or-negative cells. */
  setLogUsability(count: number): void
  /** Pushes a colormap/reverse/scale/limits state into the displayed
   *  controls without emitting onSelectionChange -- for the view to call
   *  whenever it changes one of these fields on the control's behalf (a
   *  group change re-inferring the scale, say), so the control the user
   *  sees never disagrees with what is actually drawn (WINDOWS.md #5, #8). */
  sync(selection: Pick<FieldChoice, 'colormap' | 'reverseColormap' | 'scale' | 'scaleInferred' | 'limitsMode' | 'manualLimits'>): void
  /** Moves the layer slider without emitting onSelectionChange. */
  setLayer(layer: number): void
  /** The iteration the emitted selections carry from now on. Emits nothing. */
  setIteration(iteration: number): void
  /**
   * Rebuilds the realization slider from another iteration's names and moves
   * it to `wanted`, matched exactly by name. Returns the new index, or null
   * when `wanted` is not there (or no names were recorded): the slider then
   * reads "—" and emits no realization until the user picks one. An old slider
   * position is never reused. Emits nothing.
   */
  setRealizations(names: RealNamesResult, wanted: string | null): number | null
}

function isStatistic(value: string): value is Statistic {
  return (STATISTICS as readonly string[]).includes(value)
}

function isColormap(value: string): value is ColormapName {
  return (COLORMAP_NAMES as readonly string[]).includes(value)
}

function defaultScale(partrans: string | null): ValueScale {
  return partrans !== null && partrans.trim().toLowerCase() === 'log' ? 'log10' : 'linear'
}

/**
 * Builds the layer slider, the statistic select, the realization slider,
 * the colormap picker with its reverse switch, and the scale/limits
 * controls, into a `.floating` panel. Every control is a real
 * `<input>`/`<select>` with an `aria-label`, so each is keyboard reachable
 * by construction; no `tabindex` above zero is ever set here.
 */
export function renderSelectionControls(
  el: HTMLElement,
  opts: SelectionControlsOptions,
): SelectionControlsHandle {
  el.textContent = ''
  el.classList.add('floating')
  // WINDOWS.md #13's sweep: the fit button, each label and the two
  // manual-limit inputs are inline-level elements with no separation of
  // their own -- a flex row that wraps, with a real gap on both axes,
  // keeps the same shrink-to-fit packing (and roughly the same panel
  // height) the browser's own default inline wrapping already gave this
  // panel, but now with a real gap between every pair instead of nothing.
  // A plain flex COLUMN was tried first and rejected: it puts one control
  // per line unconditionally, which more than quadruples the panel's
  // height and, on this app's fixed 800x480 canvas, covers cells that used
  // to be visible underneath it.
  el.style.display = 'flex'
  el.style.flexWrap = 'wrap'
  el.style.gap = 'var(--space-sm)'

  // Fit to extent (D-15/MAP-11): a real button, the one button-shaped
  // primary action on this map surface, calling the same fit(bounds) the
  // Home key triggers.
  const fitButton = document.createElement('button')
  fitButton.type = 'button'
  fitButton.textContent = 'Fit to extent'
  fitButton.addEventListener('click', () => {
    opts.onFitToExtent()
  })

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
  // 'value' would only ever fail to load when no realization can be named,
  // so a run with no recorded names defaults to an aggregate statistic
  // instead -- matching the initial fetch views/map.ts issues.
  statSelect.value = opts.initial?.stat ?? (opts.realNames.ok ? 'value' : 'mean')
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
  let iteration = opts.iteration
  // True while the wanted realization is not in the shown iteration: the slider
  // position then means nothing and no name is emitted.
  let realMissing = false

  function notRecordedText(forIteration: number): string {
    return (
      `Realization names weren't recorded for iteration ${forIteration}, ` +
      "so a realization can't be named."
    )
  }

  // The label and what assistive technology hears always agree, and neither is ever a position.
  function showReal(): void {
    const name = realMissing ? null : (realNames[Number(realInput.value)] ?? null)
    realValue.textContent = name ?? '—'
    realInput.setAttribute('aria-valuetext', name ?? (realNames.length === 0 ? 'names not recorded' : 'none picked'))
  }

  function updateRealDisabled(): void {
    realInput.disabled = realNames.length <= 1 || statSelect.value !== 'value'
  }

  if (opts.realNames.ok) {
    realNames = opts.realNames.names
    const lastIndex = Math.max(realNames.length - 1, 0)
    realInput.min = '0'
    realInput.max = String(lastIndex)
    realInput.step = '1'
    realInput.value = '0'
    updateRealDisabled()
    showReal()
  } else {
    realInput.min = '0'
    realInput.max = '0'
    realInput.value = '0'
    realInput.disabled = true
    showReal()
    warningLine = document.createElement('div')
    warningLine.classList.add('label')
    warningLine.style.color = 'var(--status-warning)'
    warningLine.textContent = notRecordedText(opts.realNames.iteration)
  }

  // Colormap: the nine names colormap.ts's STOPS declares. jet is offered,
  // not removed, but flagged -- the reason lives in its option title.
  const colormapLabel = document.createElement('label')
  colormapLabel.classList.add('label')
  colormapLabel.textContent = 'Colormap'
  const colormapSelect = document.createElement('select')
  colormapSelect.setAttribute('aria-label', 'Colormap')
  for (const name of COLORMAP_NAMES) {
    const option = document.createElement('option')
    option.setAttribute('value', name)
    if (name === 'jet') {
      option.textContent = 'jet ⚠'
      option.title = JET_REASON
    } else {
      option.textContent = name
    }
    colormapSelect.appendChild(option)
  }
  // No diverging quantity is servable at M0 (every statistic the cache
  // holds is a magnitude, not a signed difference), so viridis is the
  // default whatever is being shown -- the visual contract's own table
  // agrees for a field and for spread ("matches the field") -- unless
  // `opts.initial` names an already-committed colormap (a restored view
  // state), which wins over that fresh-run default.
  colormapSelect.value = opts.initial ? opts.initial.colormap : 'viridis'
  colormapLabel.appendChild(colormapSelect)

  // Reverse: applies to whichever ramp is chosen, a plain on/off switch
  // rather than a reversed duplicate of every ramp in the list.
  const reverseLabel = document.createElement('label')
  reverseLabel.classList.add('label')
  const reverseInput = document.createElement('input')
  reverseInput.type = 'checkbox'
  reverseInput.setAttribute('aria-label', 'Reverse colormap')
  reverseInput.checked = opts.initial?.reverseColormap ?? false
  reverseLabel.textContent = 'Reverse'
  reverseLabel.appendChild(reverseInput)

  // Scale: defaulted from the drawn group's own partrans, matched
  // case-insensitively after trimming; anything this code has never seen
  // is treated as linear by a named default, never a crash and never a
  // guess (D-03).
  const scaleLabel = document.createElement('label')
  scaleLabel.classList.add('label')
  scaleLabel.textContent = 'Value scale'
  const scaleSelect = document.createElement('select')
  scaleSelect.setAttribute('aria-label', 'Value scale')
  const linearOption = document.createElement('option')
  linearOption.setAttribute('value', 'linear')
  linearOption.textContent = 'Linear'
  const log10Option = document.createElement('option')
  log10Option.setAttribute('value', 'log10')
  log10Option.textContent = 'Log₁₀'
  scaleSelect.appendChild(linearOption)
  scaleSelect.appendChild(log10Option)
  // A restored, explicitly-chosen scale (scaleInferred: false) means the
  // user already touched this control in an earlier session -- the legend
  // must not then claim it as "inferred from partrans" on the next change
  // this control itself emits.
  let scaleTouchedByUser = opts.initial ? !opts.initial.scaleInferred : false
  scaleSelect.value = opts.initial ? opts.initial.scale : defaultScale(opts.partrans)
  scaleLabel.appendChild(scaleSelect)

  // The log10-unavailable line: hidden until setLogUsability reports a
  // non-zero count. UI-SPEC's exact copy, warning ink, no icon.
  const logWarningLine = document.createElement('div')
  logWarningLine.classList.add('label')
  logWarningLine.id = LOG_WARNING_ID
  logWarningLine.style.color = 'var(--status-warning)'
  logWarningLine.style.display = 'none'
  scaleLabel.appendChild(logWarningLine)

  // Limits mode: robust 2-98% by default, with min-max and manual as the
  // two alternatives. The manual pair is two number inputs, revealed only
  // in manual mode.
  const limitsLabel = document.createElement('label')
  limitsLabel.classList.add('label')
  limitsLabel.textContent = 'Limits'
  const limitsSelect = document.createElement('select')
  limitsSelect.setAttribute('aria-label', 'Limits')
  const LIMITS_OPTIONS: Array<[LimitsMode, string]> = [
    ['robust', 'Robust 2-98%'],
    ['minmax', 'Min-max'],
    ['manual', 'Manual'],
  ]
  for (const [value, label] of LIMITS_OPTIONS) {
    const option = document.createElement('option')
    option.setAttribute('value', value)
    option.textContent = label
    limitsSelect.appendChild(option)
  }
  limitsSelect.value = opts.initial ? opts.initial.limitsMode : 'robust'
  limitsLabel.appendChild(limitsSelect)

  const manualLower = document.createElement('input')
  manualLower.type = 'number'
  manualLower.setAttribute('aria-label', 'Lower limit')
  manualLower.style.display = 'none'
  if (opts.initial?.manualLimits) manualLower.value = String(opts.initial.manualLimits[0])
  const manualUpper = document.createElement('input')
  manualUpper.type = 'number'
  manualUpper.setAttribute('aria-label', 'Upper limit')
  if (opts.initial?.manualLimits) manualUpper.value = String(opts.initial.manualLimits[1])
  manualUpper.style.display = 'none'

  function updateManualVisibility(): void {
    const isManual = limitsSelect.value === 'manual'
    manualLower.style.display = isManual ? '' : 'none'
    manualUpper.style.display = isManual ? '' : 'none'
  }
  updateManualVisibility()

  function currentManualLimits(): [number, number] | null {
    if (limitsSelect.value !== 'manual') return null
    const lower = Number(manualLower.value)
    const upper = Number(manualUpper.value)
    return [Number.isFinite(lower) ? lower : 0, Number.isFinite(upper) ? upper : 1]
  }

  function currentSelection(): FieldChoice {
    const stat = isStatistic(statSelect.value) ? statSelect.value : 'value'
    const realization = stat === 'value' && !realMissing ? (realNames[Number(realInput.value)] ?? null) : null
    const colormap = isColormap(colormapSelect.value) ? colormapSelect.value : 'viridis'
    const scale: ValueScale = scaleSelect.value === 'log10' ? 'log10' : 'linear'
    const limitsMode: LimitsMode =
      limitsSelect.value === 'minmax' ? 'minmax' : limitsSelect.value === 'manual' ? 'manual' : 'robust'
    return {
      iteration,
      layer: Number(layerInput.value),
      stat,
      realization,
      colormap,
      reverseColormap: reverseInput.checked,
      scale,
      scaleInferred: !scaleTouchedByUser,
      limitsMode,
      manualLimits: currentManualLimits(),
    }
  }

  layerInput.addEventListener('input', () => {
    layerValue.textContent = layerInput.value
    opts.onSelectionChange(currentSelection())
  })

  statSelect.addEventListener('change', () => {
    updateRealDisabled()
    opts.onSelectionChange(currentSelection())
  })

  realInput.addEventListener('input', () => {
    realMissing = false
    showReal()
    opts.onSelectionChange(currentSelection())
  })

  // A range input fires no input event when its thumb is clicked without moving,
  // so the position it already sits on could never be picked while it reads "—".
  realInput.addEventListener('click', () => {
    if (!realMissing || realNames.length === 0) return
    realMissing = false
    showReal()
    opts.onSelectionChange(currentSelection())
  })

  colormapSelect.addEventListener('change', () => {
    opts.onSelectionChange(currentSelection())
  })

  reverseInput.addEventListener('change', () => {
    opts.onSelectionChange(currentSelection())
  })

  scaleSelect.addEventListener('change', () => {
    scaleTouchedByUser = true
    opts.onSelectionChange(currentSelection())
  })

  limitsSelect.addEventListener('change', () => {
    updateManualVisibility()
    opts.onSelectionChange(currentSelection())
  })

  manualLower.addEventListener('input', () => {
    opts.onSelectionChange(currentSelection())
  })

  manualUpper.addEventListener('input', () => {
    opts.onSelectionChange(currentSelection())
  })

  el.appendChild(fitButton)
  el.appendChild(layerLabel)
  el.appendChild(statLabel)
  el.appendChild(realLabel)
  if (warningLine) {
    el.appendChild(warningLine)
  }
  el.appendChild(colormapLabel)
  el.appendChild(reverseLabel)
  el.appendChild(scaleLabel)
  el.appendChild(limitsLabel)
  el.appendChild(manualLower)
  el.appendChild(manualUpper)

  return {
    setLogUsability(count: number): void {
      log10Option.disabled = count > 0
      if (count > 0) {
        if (scaleSelect.value === 'log10') {
          scaleSelect.value = 'linear'
        }
        logWarningLine.textContent = `Log₁₀ unavailable — ${count} cells are zero or negative. Showing linear.`
        logWarningLine.style.display = ''
        scaleSelect.setAttribute('aria-describedby', LOG_WARNING_ID)
      } else {
        logWarningLine.style.display = 'none'
        scaleSelect.removeAttribute('aria-describedby')
      }
    },
    sync(selection): void {
      colormapSelect.value = selection.colormap
      reverseInput.checked = selection.reverseColormap
      scaleSelect.value = selection.scale
      scaleTouchedByUser = !selection.scaleInferred
      limitsSelect.value = selection.limitsMode
      updateManualVisibility()
      if (selection.manualLimits) {
        manualLower.value = String(selection.manualLimits[0])
        manualUpper.value = String(selection.manualLimits[1])
      }
    },
    setLayer(layer): void {
      layerInput.value = String(layer)
      layerValue.textContent = layerInput.value
    },
    setIteration(next): void {
      iteration = next
    },
    setRealizations(names, wanted): number | null {
      realMissing = false
      if (!names.ok) {
        realNames = []
        realInput.min = '0'
        realInput.max = '0'
        realInput.value = '0'
        realInput.disabled = true
        realValue.textContent = '—'
        const text = notRecordedText(names.iteration)
        if (warningLine === null) {
          warningLine = document.createElement('div')
          warningLine.classList.add('label')
          warningLine.style.color = 'var(--status-warning)'
          realLabel.after(warningLine)
        }
        warningLine.textContent = text
        realMissing = true
        showReal()
        return null
      }
      warningLine?.remove()
      warningLine = null
      realNames = names.names
      realInput.min = '0'
      realInput.max = String(Math.max(realNames.length - 1, 0))
      realInput.step = '1'
      const index = wanted === null ? -1 : realNames.indexOf(wanted)
      realInput.value = '0'
      updateRealDisabled()
      if (index < 0) {
        realMissing = true
        showReal()
        return null
      }
      realInput.value = String(index)
      showReal()
      return index
    },
  }
}
