// The layer, realization, statistic, colour and scale controls: a set of
// keyboard-reachable form elements that name their own current value and
// tell onSelectionChange what changed. This module computes nothing,
// fetches nothing and draws nothing -- the view (views/map.ts) owns the
// redraw discipline that reacts to the selection this file reports.

import type { RealNamesResult } from '../data/reals'
import { STOPS, type ColormapName, type LimitsMode, type ValueScale } from '../gl/colormap'
import {
  CLASS_CHOICES,
  DEFAULT_STYLE,
  SYMMETRIC_TURNED_OFF_PREFIX,
  TEXTURE_CLASSES_NOTE,
  TEXTURE_DEFAULT_CLASSES,
  followLimits,
  isClassCount,
  symmetricRefusal,
  type EffectiveStyle,
  type FieldStyle,
  type StyleNotes,
} from '../gl/field-style'
import { paintNote } from './note-line'

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
const REAL_NAMES_LIST_ID = 'go-to-realization-names'
const GO_TO_REFUSAL_ID = 'go-to-realization-refusal'
const CLASSES_NOTE_ID = 'classes-note'
const SYMMETRIC_REASON_ID = 'symmetric-reason'
const TEXTURE_REASON_ID = 'texture-reason'

const STEPS_TITLE =
  'Smooth shades every value. Steps split the range into equal bands, like a contour map, so layers can be compared by eye.'
const CENTRE_TITLE = 'Puts zero in the middle of the colour ramp, so values above and below zero get matching colours.'
const PATTERNS_TITLE =
  'Draws each colour step as its own line pattern, for black-and-white printing, colour-blind readers, or seeing a basemap through the field. Uses colour steps.'

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
  /** What the user asked the field to be drawn as; resolveStyle decides what is drawn. */
  style: FieldStyle
}

type ColourFields = Pick<FieldChoice, 'colormap' | 'reverseColormap' | 'scale' | 'scaleInferred' | 'limitsMode' | 'manualLimits'> & {
  /** Absent means DEFAULT_STYLE. */
  style?: FieldStyle
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
  initial?: ColourFields & {
    stat?: Statistic
  }
  /** A turned-off line the view already decided on, such as a restored symmetric a log scale refused. */
  styleNote?: string | null
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
   *  sees never disagrees with what is actually drawn (WINDOWS.md #5, #8).
   *  `styleNote` sets the symmetric turned-off line, null clears it, absent leaves it. */
  sync(selection: ColourFields, styleNote?: string | null): void
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
  /** Shows why a style setting is not drawn as asked, next to its control. Emits nothing. */
  showStyle(effective: EffectiveStyle, notes: StyleNotes): void
}

// The map hides these rows while it is coloured by observations (style.css, .colour-obs).
function parameterOnly<T extends HTMLElement>(el: T): T {
  el.setAttribute('data-colour-source', 'par')
  return el
}

function noteLine(id?: string): HTMLDivElement {
  const line = parameterOnly(document.createElement('div'))
  line.classList.add('label', 'wrap-note')
  if (id !== undefined) line.id = id
  return line
}

function hintLine(text: string): HTMLDivElement {
  const line = parameterOnly(document.createElement('div'))
  line.classList.add('label', 'wrap-note', 'card-hint')
  line.style.color = 'var(--ink-secondary)'
  line.textContent = text
  return line
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
  // Uncapped, the panel wrapped into one band across the whole map (974 px at 1440x900) and hid the northern edge.
  el.style.maxWidth = '32rem'

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
  const statLabel = parameterOnly(document.createElement('label'))
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
  const realLabel = parameterOnly(document.createElement('label'))
  realLabel.classList.add('label')
  realLabel.textContent = 'Realization'
  const realInput = document.createElement('input')
  realInput.type = 'range'
  realInput.setAttribute('aria-label', 'Realization')
  const realValue = document.createElement('span')
  realValue.classList.add('tabular-nums')
  realLabel.appendChild(realInput)
  realLabel.appendChild(realValue)

  // Go to: type or pick a realization by name. The text is looked up as a
  // name, exactly as typed -- never read as a slider position.
  const goLabel = parameterOnly(document.createElement('label'))
  goLabel.classList.add('label')
  goLabel.textContent = 'Go to'
  const goInput = document.createElement('input')
  goInput.type = 'text'
  goInput.size = 8
  goInput.autocomplete = 'off'
  goInput.setAttribute('aria-label', 'Go to realization')
  goInput.setAttribute('list', REAL_NAMES_LIST_ID)
  const namesList = document.createElement('datalist')
  namesList.id = REAL_NAMES_LIST_ID
  goLabel.appendChild(goInput)
  // Always in the page, empty until a refusal, so a screen reader hears the text arrive.
  const refusalLine = noteLine(GO_TO_REFUSAL_ID)
  refusalLine.setAttribute('role', 'status')

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
    goInput.disabled = realInput.disabled
  }

  // The slider is disabled for this reason, so hovering it says so too.
  function showNotRecorded(line: HTMLElement, text: string): void {
    paintNote(line, { kind: 'reason', text })
    realInput.title = text
  }

  function clearRefusal(): void {
    refusalLine.textContent = ''
    goInput.removeAttribute('aria-invalid')
    goInput.removeAttribute('aria-describedby')
  }

  // Options carry a value and no text, so the list adds nothing to the panel's text.
  function rebuildNamesList(): void {
    namesList.textContent = ''
    for (const name of realNames) {
      const option = document.createElement('option')
      option.setAttribute('value', name)
      namesList.appendChild(option)
    }
  }

  if (opts.realNames.ok) {
    realNames = opts.realNames.names
    const lastIndex = Math.max(realNames.length - 1, 0)
    realInput.min = '0'
    realInput.max = String(lastIndex)
    realInput.step = '1'
    realInput.value = '0'
    updateRealDisabled()
    rebuildNamesList()
    showReal()
  } else {
    realInput.min = '0'
    realInput.max = '0'
    realInput.value = '0'
    realInput.disabled = true
    goInput.disabled = true
    showReal()
    warningLine = noteLine()
    showNotRecorded(warningLine, notRecordedText(opts.realNames.iteration))
  }

  // Colormap: the nine names colormap.ts's STOPS declares. jet is offered,
  // not removed, but flagged -- the reason lives in its option title.
  const colormapLabel = parameterOnly(document.createElement('label'))
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
  const reverseLabel = parameterOnly(document.createElement('label'))
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
  const scaleLabel = parameterOnly(document.createElement('label'))
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

  // The log10-unavailable line: hidden until setLogUsability reports a non-zero count.
  const logWarningLine = document.createElement('div')
  logWarningLine.classList.add('label', 'wrap-note')
  logWarningLine.id = LOG_WARNING_ID
  logWarningLine.style.display = 'none'
  scaleLabel.appendChild(logWarningLine)

  // Limits mode: robust 2–98% by default, with min–max and manual as the
  // two alternatives. The manual pair is two number inputs, revealed only
  // in manual mode.
  const limitsLabel = parameterOnly(document.createElement('label'))
  limitsLabel.classList.add('label')
  limitsLabel.textContent = 'Limits'
  const limitsSelect = document.createElement('select')
  limitsSelect.setAttribute('aria-label', 'Limits')
  const LIMITS_OPTIONS: Array<[LimitsMode, string]> = [
    ['robust', 'Robust 2–98%'],
    ['minmax', 'Min–max'],
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

  const manualLower = parameterOnly(document.createElement('input'))
  manualLower.type = 'number'
  manualLower.setAttribute('aria-label', 'Lower limit')
  manualLower.style.display = 'none'
  if (opts.initial?.manualLimits) manualLower.value = String(opts.initial.manualLimits[0])
  const manualUpper = parameterOnly(document.createElement('input'))
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

  // Colour steps: smooth or 7, 9, 11 equal steps between the limits (D-04).
  const classesLabel = parameterOnly(document.createElement('label'))
  classesLabel.classList.add('label')
  classesLabel.textContent = 'Colour steps'
  classesLabel.title = STEPS_TITLE
  const classesSelect = document.createElement('select')
  classesSelect.setAttribute('aria-label', 'Colour steps')
  classesSelect.title = STEPS_TITLE
  for (const n of CLASS_CHOICES) {
    const option = document.createElement('option')
    option.setAttribute('value', String(n))
    option.textContent = n === 0 ? 'Smooth' : `${n} steps`
    classesSelect.appendChild(option)
  }
  classesSelect.value = String(opts.initial?.style?.classes ?? DEFAULT_STYLE.classes)
  classesLabel.appendChild(classesSelect)
  const classesHint = hintLine('Bands values like a contour map.')

  const classesNote = noteLine(CLASSES_NOTE_ID)
  classesNote.style.display = 'none'

  // Centre on zero (D-08): disabled with its reason on log10 or manual limits (D-09, D-10).
  const symmetricLabel = parameterOnly(document.createElement('label'))
  symmetricLabel.classList.add('label')
  symmetricLabel.textContent = 'Centre on zero'
  symmetricLabel.title = CENTRE_TITLE
  const symmetricInput = document.createElement('input')
  symmetricInput.type = 'checkbox'
  symmetricInput.setAttribute('aria-label', 'Centre on zero')
  symmetricInput.title = CENTRE_TITLE
  symmetricInput.checked = opts.initial?.style?.symmetric ?? DEFAULT_STYLE.symmetric
  symmetricLabel.appendChild(symmetricInput)
  const symmetricHint = hintLine('For changes and residuals.')

  const symmetricReason = noteLine(SYMMETRIC_REASON_ID)
  symmetricReason.setAttribute('role', 'status')

  // A "was turned off" line outlives redraws, so a dropped request always leaves a trace; only a user move clears it.
  let turnedOffLine: string | null = opts.styleNote ?? null
  let symmetricNote: string | null = null

  function showSymmetricReason(): void {
    // A turned-off request is a change made for the user; a bare refusal only says why the box is grey.
    const note =
      turnedOffLine !== null
        ? { kind: 'warning' as const, text: turnedOffLine }
        : symmetricNote !== null
          ? { kind: 'reason' as const, text: symmetricNote }
          : null
    paintNote(symmetricReason, note)
    symmetricInput.title = symmetricNote ?? CENTRE_TITLE
    if (note === null) symmetricInput.removeAttribute('aria-describedby')
    else symmetricInput.setAttribute('aria-describedby', SYMMETRIC_REASON_ID)
  }
  showSymmetricReason()

  // Patterns (D-12): need colour steps, so Smooth is off the list while they are on (D-13).
  const textureLabel = parameterOnly(document.createElement('label'))
  textureLabel.classList.add('label')
  textureLabel.textContent = 'Patterns instead of colours'
  textureLabel.title = PATTERNS_TITLE
  const textureInput = document.createElement('input')
  textureInput.type = 'checkbox'
  textureInput.setAttribute('aria-label', 'Patterns instead of colours')
  textureInput.title = PATTERNS_TITLE
  textureInput.checked = opts.initial?.style?.texture ?? DEFAULT_STYLE.texture
  textureLabel.appendChild(textureInput)
  const textureHint = hintLine('For print, colour-blind readers, or a basemap underneath.')

  const textureReason = noteLine(TEXTURE_REASON_ID)
  textureReason.setAttribute('role', 'status')
  textureReason.style.display = 'none'

  const continuousOption = classesSelect.querySelector('option[value="0"]') as HTMLOptionElement
  // The "7 steps are drawn" line outlives redraws (the request already says 7) until the user moves steps or patterns.
  let raisedNote: string | null = null
  let classesReason: string | null = null

  function showClassesNote(): void {
    const text = classesReason ?? raisedNote
    paintNote(classesNote, text === null ? null : { kind: 'warning', text })
    if (text === null) classesSelect.removeAttribute('aria-describedby')
    else classesSelect.setAttribute('aria-describedby', CLASSES_NOTE_ID)
  }

  // Called after the patterns box or the steps select is set from outside or by the user.
  function followTexture(): void {
    if (textureInput.checked && classesSelect.value === '0') {
      classesSelect.value = String(TEXTURE_DEFAULT_CLASSES)
      raisedNote = TEXTURE_CLASSES_NOTE
    }
    if (!textureInput.checked) raisedNote = null
    continuousOption.disabled = textureInput.checked
    showClassesNote()
  }
  followTexture()

  // The rest of the request rides along unchanged until its own control exists.
  let style: FieldStyle = { ...(opts.initial?.style ?? DEFAULT_STYLE) }

  function currentStyle(): FieldStyle {
    const n = Number(classesSelect.value)
    return {
      ...style,
      classes: isClassCount(n) ? n : DEFAULT_STYLE.classes,
      symmetric: symmetricInput.checked,
      texture: textureInput.checked,
    }
  }

  // Run before emitting a scale or limits change, so a refused symmetric is never sent.
  function followScaleAndLimits(): void {
    const scale: ValueScale = scaleSelect.value === 'log10' ? 'log10' : 'linear'
    const limitsMode: LimitsMode =
      limitsSelect.value === 'minmax' ? 'minmax' : limitsSelect.value === 'manual' ? 'manual' : 'robust'
    const followed = followLimits(currentStyle(), scale, limitsMode)
    symmetricNote = symmetricRefusal(scale, limitsMode)
    symmetricInput.disabled = symmetricNote !== null
    if (followed.turnedOff !== null) {
      symmetricInput.checked = false
      turnedOffLine = SYMMETRIC_TURNED_OFF_PREFIX + followed.turnedOff
    } else if (symmetricNote === null) {
      turnedOffLine = null
    }
    showSymmetricReason()
  }

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
      style: currentStyle(),
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
    clearRefusal()
    realMissing = false
    showReal()
    opts.onSelectionChange(currentSelection())
  })

  // Enter or leaving the box fires change; a pick from the list fires input with
  // insertReplacementText. Plain typing commits nothing, so "66" never draws "6".
  function commitGoTo(): void {
    const typed = goInput.value
    if (typed === '') {
      clearRefusal()
      return
    }
    const index = realNames.indexOf(typed)
    if (index < 0) {
      // The quotes make a stray space in the typed name visible.
      paintNote(refusalLine, { kind: 'warning', text: `realization "${typed}" is not in iteration ${iteration}` })
      goInput.setAttribute('aria-invalid', 'true')
      goInput.setAttribute('aria-describedby', GO_TO_REFUSAL_ID)
      return
    }
    clearRefusal()
    realMissing = false
    realInput.value = String(index)
    showReal()
    goInput.value = ''
    opts.onSelectionChange(currentSelection())
  }

  goInput.addEventListener('change', commitGoTo)
  goInput.addEventListener('input', (event) => {
    if ((event as InputEvent).inputType === 'insertReplacementText') commitGoTo()
  })

  // A range input fires no input event when its thumb is clicked without moving,
  // so the position it already sits on could never be picked while it reads "—".
  realInput.addEventListener('click', () => {
    clearRefusal()
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
    followScaleAndLimits()
    opts.onSelectionChange(currentSelection())
  })

  limitsSelect.addEventListener('change', () => {
    updateManualVisibility()
    followScaleAndLimits()
    opts.onSelectionChange(currentSelection())
  })

  manualLower.addEventListener('input', () => {
    opts.onSelectionChange(currentSelection())
  })

  manualUpper.addEventListener('input', () => {
    opts.onSelectionChange(currentSelection())
  })

  classesSelect.addEventListener('change', () => {
    raisedNote = null
    showClassesNote()
    opts.onSelectionChange(currentSelection())
  })

  textureInput.addEventListener('change', () => {
    followTexture()
    opts.onSelectionChange(currentSelection())
  })

  symmetricInput.addEventListener('change', () => {
    turnedOffLine = null
    showSymmetricReason()
    opts.onSelectionChange(currentSelection())
  })

  el.appendChild(fitButton)
  el.appendChild(layerLabel)
  el.appendChild(statLabel)
  el.appendChild(realLabel)
  el.appendChild(goLabel)
  el.appendChild(namesList)
  el.appendChild(refusalLine)
  if (warningLine) {
    el.appendChild(warningLine)
  }
  el.appendChild(colormapLabel)
  el.appendChild(reverseLabel)
  el.appendChild(scaleLabel)
  el.appendChild(limitsLabel)
  el.appendChild(manualLower)
  el.appendChild(manualUpper)
  el.appendChild(classesLabel)
  el.appendChild(classesHint)
  el.appendChild(classesNote)
  el.appendChild(symmetricLabel)
  el.appendChild(symmetricHint)
  el.appendChild(symmetricReason)
  el.appendChild(textureLabel)
  el.appendChild(textureHint)
  el.appendChild(textureReason)

  return {
    setLogUsability(count: number): void {
      log10Option.disabled = count > 0
      if (count > 0) {
        if (scaleSelect.value === 'log10') {
          scaleSelect.value = 'linear'
        }
        paintNote(logWarningLine, { kind: 'warning', text: `Log₁₀ unavailable — ${count} cells are zero or negative. Showing linear.` })
        scaleSelect.setAttribute('aria-describedby', LOG_WARNING_ID)
      } else {
        paintNote(logWarningLine, null)
        scaleSelect.removeAttribute('aria-describedby')
      }
    },
    sync(selection, styleNote): void {
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
      if (selection.style) {
        style = { ...selection.style }
        if (selection.style.classes !== Number(classesSelect.value) || selection.style.texture !== textureInput.checked) {
          raisedNote = null
        }
        classesSelect.value = String(selection.style.classes)
        symmetricInput.checked = selection.style.symmetric
        textureInput.checked = selection.style.texture
        followTexture()
      }
      if (styleNote !== undefined) {
        turnedOffLine = styleNote
        showSymmetricReason()
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
      clearRefusal()
      if (!names.ok) {
        realNames = []
        rebuildNamesList()
        realInput.min = '0'
        realInput.max = '0'
        realInput.value = '0'
        realInput.disabled = true
        goInput.disabled = true
        realValue.textContent = '—'
        const text = notRecordedText(names.iteration)
        if (warningLine === null) {
          warningLine = noteLine()
          refusalLine.after(warningLine)
        }
        showNotRecorded(warningLine, text)
        realMissing = true
        showReal()
        return null
      }
      warningLine?.remove()
      warningLine = null
      realInput.removeAttribute('title')
      realNames = names.names
      rebuildNamesList()
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
    showStyle(_effective, notes): void {
      classesReason = notes.classes
      if (notes.texture === TEXTURE_CLASSES_NOTE) raisedNote = TEXTURE_CLASSES_NOTE
      showClassesNote()
      const refusal = notes.texture === TEXTURE_CLASSES_NOTE ? null : notes.texture
      textureInput.disabled = refusal !== null
      paintNote(textureReason, refusal === null ? null : { kind: 'reason', text: refusal })
      textureInput.title = refusal ?? PATTERNS_TITLE
      if (refusal === null) textureInput.removeAttribute('aria-describedby')
      else textureInput.setAttribute('aria-describedby', TEXTURE_REASON_ID)
      symmetricNote = notes.symmetric
      symmetricInput.disabled = notes.symmetric !== null
      showSymmetricReason()
    },
  }
}
