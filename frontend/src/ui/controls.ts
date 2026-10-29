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
import { layerCompact } from '../data/layer-words'
import { cardRow, type CardRow } from './card-rows'
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
const LAYER_REASON_ID = 'layer-reason'

const LAYER_ONE_REASON = 'the grid has one layer'
const OBS_LINE = 'Colormap, value scale, limits, colour steps, centring and patterns apply to parameter fields only.'

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
  /** The Data card's rows for the layer, statistic and realization; absent, those rows go first in `el`. */
  dataRows?: { layer: CardRow; statistic: CardRow; realization: CardRow }
  onSelectionChange: (selection: FieldChoice) => void
  /** The Colours card's folded line, after every colour change and every sync. */
  onColoursChange?: (summary: string) => void
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
  /** The colour settings in the controls' own words: `viridis · linear · robust 2–98% · smooth`. */
  coloursSummary(): string
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
  el.classList.add('floating', 'card-rows')
  const ownRows = opts.dataRows === undefined
  const dataRows = opts.dataRows ?? {
    layer: cardRow(el, 'Layer'),
    statistic: cardRow(el, 'Statistic'),
    realization: cardRow(el, 'Realization'),
  }
  parameterOnly(dataRows.realization.row)
  // The Data card's statistic row also holds the observation statistic, so only a row made here hides whole.
  if (ownRows) parameterOnly(dataRows.statistic.row)

  const nlay = Math.max(opts.nlay, 1)

  // Layer: an always-present slider, disabled (not hidden) when the grid
  // has only one layer -- hiding it would make a one-layer run look like a
  // different application.
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
  // Not parameter-only: the layer row stays while the map is coloured by observations.
  const layerReason = document.createElement('div')
  layerReason.classList.add('label', 'wrap-note')
  layerReason.id = LAYER_REASON_ID
  paintNote(layerReason, layerInput.disabled ? { kind: 'reason', text: LAYER_ONE_REASON } : null)
  if (layerInput.disabled) layerInput.setAttribute('aria-describedby', LAYER_REASON_ID)
  dataRows.layer.control.append(layerInput, layerValue, layerReason)

  // The slider's value stays zero-based; only the words shown are one-based with the index alongside (LD-5).
  function showLayer(): void {
    const index = Number(layerInput.value)
    const tip = `Layer ${index + 1}, index ${index}. Layers count from 1 at the top; the index counts from 0.`
    layerValue.textContent = layerCompact(index)
    layerValue.title = tip
    layerInput.title = layerInput.disabled ? LAYER_ONE_REASON : tip
    layerInput.setAttribute('aria-valuetext', `layer ${index + 1}, index ${index}`)
  }
  showLayer()

  // Statistic: exactly the eight servable statistics (enscache.STATS is the
  // authority this list mirrors), never a value this control invents.
  const statSelect = parameterOnly(document.createElement('select'))
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
  dataRows.statistic.control.appendChild(statSelect)

  // Realization: positions are the names fetchRealNames returned, in the
  // order the route served them, never a row number standing in for a
  // missing name.
  const realInput = document.createElement('input')
  realInput.type = 'range'
  realInput.setAttribute('aria-label', 'Realization')
  const realValue = document.createElement('span')
  realValue.classList.add('tabular-nums')

  // Go to: type or pick a realization by name. The text is looked up as a
  // name, exactly as typed -- never read as a slider position.
  const goLabel = parameterOnly(document.createElement('label'))
  goLabel.classList.add('label', 'card-row-full')
  goLabel.textContent = 'Go to'
  const goInput = document.createElement('input')
  goInput.type = 'text'
  goInput.size = 8
  goInput.placeholder = 'type a name'
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

  // An aggregate statistic draws no one realization, so the row has nothing to say.
  function showRealRow(): void {
    dataRows.realization.row.hidden = statSelect.value !== 'value'
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
  const colormapRow = parameterOnly(cardRow(el, 'Colormap').row)
  const colormapControl = colormapRow.lastElementChild as HTMLElement
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
  colormapControl.appendChild(colormapSelect)

  // Reverse: applies to whichever ramp is chosen, a plain on/off switch
  // rather than a reversed duplicate of every ramp in the list.
  const reverseLabel = parameterOnly(document.createElement('label'))
  reverseLabel.classList.add('label')
  const reverseInput = document.createElement('input')
  reverseInput.type = 'checkbox'
  reverseInput.setAttribute('aria-label', 'Reverse colormap')
  reverseInput.checked = opts.initial?.reverseColormap ?? false
  reverseLabel.appendChild(reverseInput)
  reverseLabel.appendChild(document.createTextNode('Reverse'))
  colormapControl.appendChild(reverseLabel)

  // Scale: defaulted from the drawn group's own partrans, matched
  // case-insensitively after trimming; anything this code has never seen
  // is treated as linear by a named default, never a crash and never a
  // guess (D-03).
  const scaleRow = parameterOnly(cardRow(el, 'Value scale').row)
  const scaleControl = scaleRow.lastElementChild as HTMLElement
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
  scaleControl.appendChild(scaleSelect)

  // The log10-unavailable line: hidden until setLogUsability reports a non-zero count.
  const logWarningLine = document.createElement('div')
  logWarningLine.classList.add('label', 'wrap-note')
  logWarningLine.id = LOG_WARNING_ID
  logWarningLine.style.display = 'none'
  scaleControl.appendChild(logWarningLine)

  // Limits mode: robust 2–98% by default, with min–max and manual as the
  // two alternatives. The manual pair is two number inputs, revealed only
  // in manual mode.
  const limitsRow = parameterOnly(cardRow(el, 'Limits').row)
  const limitsControl = limitsRow.lastElementChild as HTMLElement
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
  limitsControl.appendChild(limitsSelect)

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
  // The pair sits under the select, on its own line.
  const manualPair = document.createElement('div')
  manualPair.classList.add('card-row-full', 'manual-limits')
  manualPair.append(manualLower, manualUpper)
  limitsControl.appendChild(manualPair)

  function updateManualVisibility(): void {
    const isManual = limitsSelect.value === 'manual'
    manualLower.style.display = isManual ? '' : 'none'
    manualUpper.style.display = isManual ? '' : 'none'
    manualPair.style.display = isManual ? '' : 'none'
  }
  updateManualVisibility()

  // Colour steps: smooth or 7, 9, 11 equal steps between the limits (D-04).
  const classesRow = cardRow(el, 'Colour steps')
  parameterOnly(classesRow.row)
  classesRow.label.title = STEPS_TITLE
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
  const classesHint = hintLine('Bands values like a contour map.')

  const classesNote = noteLine(CLASSES_NOTE_ID)
  classesNote.style.display = 'none'
  classesRow.control.append(classesSelect, classesHint, classesNote)

  // Centre on zero (D-08): disabled with its reason on log10 or manual limits (D-09, D-10).
  const symmetricRow = cardRow(el, 'Centre on zero')
  parameterOnly(symmetricRow.row)
  symmetricRow.label.title = CENTRE_TITLE
  const symmetricInput = document.createElement('input')
  symmetricInput.type = 'checkbox'
  symmetricInput.setAttribute('aria-label', 'Centre on zero')
  symmetricInput.title = CENTRE_TITLE
  symmetricInput.checked = opts.initial?.style?.symmetric ?? DEFAULT_STYLE.symmetric
  const symmetricHint = hintLine('For changes and residuals.')

  const symmetricReason = noteLine(SYMMETRIC_REASON_ID)
  symmetricReason.setAttribute('role', 'status')
  symmetricRow.control.append(symmetricInput, symmetricHint, symmetricReason)

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
  const textureRow = cardRow(el, 'Patterns')
  parameterOnly(textureRow.row)
  textureRow.label.title = PATTERNS_TITLE
  const textureLabel = parameterOnly(document.createElement('label'))
  textureLabel.classList.add('label')
  textureLabel.title = PATTERNS_TITLE
  const textureInput = document.createElement('input')
  textureInput.type = 'checkbox'
  textureInput.setAttribute('aria-label', 'Patterns instead of colours')
  textureInput.title = PATTERNS_TITLE
  textureInput.checked = opts.initial?.style?.texture ?? DEFAULT_STYLE.texture
  textureLabel.appendChild(textureInput)
  textureLabel.appendChild(document.createTextNode('Patterns instead of colours'))
  const textureHint = hintLine('For print, colour-blind readers, or a basemap underneath.')

  const textureReason = noteLine(TEXTURE_REASON_ID)
  textureReason.setAttribute('role', 'status')
  textureReason.style.display = 'none'
  textureRow.control.append(textureLabel, textureHint, textureReason)

  // Observation dots ignore every Colours row, so one line says so in their place.
  const obsLine = document.createElement('div')
  obsLine.classList.add('label', 'wrap-note', 'colours-obs-line')
  obsLine.setAttribute('data-colour-source', 'obs')
  obsLine.textContent = OBS_LINE
  el.appendChild(obsLine)

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
    showLayer()
    opts.onSelectionChange(currentSelection())
  })

  statSelect.addEventListener('change', () => {
    updateRealDisabled()
    showRealRow()
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
    coloursChanged()
  })

  reverseInput.addEventListener('change', () => {
    opts.onSelectionChange(currentSelection())
    coloursChanged()
  })

  scaleSelect.addEventListener('change', () => {
    scaleTouchedByUser = true
    followScaleAndLimits()
    opts.onSelectionChange(currentSelection())
    coloursChanged()
  })

  limitsSelect.addEventListener('change', () => {
    updateManualVisibility()
    followScaleAndLimits()
    opts.onSelectionChange(currentSelection())
    coloursChanged()
  })

  manualLower.addEventListener('input', () => {
    opts.onSelectionChange(currentSelection())
    coloursChanged()
  })

  manualUpper.addEventListener('input', () => {
    opts.onSelectionChange(currentSelection())
    coloursChanged()
  })

  classesSelect.addEventListener('change', () => {
    raisedNote = null
    showClassesNote()
    opts.onSelectionChange(currentSelection())
    coloursChanged()
  })

  textureInput.addEventListener('change', () => {
    followTexture()
    opts.onSelectionChange(currentSelection())
    coloursChanged()
  })

  symmetricInput.addEventListener('change', () => {
    turnedOffLine = null
    showSymmetricReason()
    opts.onSelectionChange(currentSelection())
    coloursChanged()
  })

  const realControl = dataRows.realization.control
  realControl.append(realInput, realValue, goLabel, namesList, refusalLine)
  if (warningLine) {
    realControl.appendChild(warningLine)
  }
  showRealRow()

  // The option texts, first letter lowered, so the folded line uses the words the controls show.
  function shownText(select: HTMLSelectElement): string {
    const text = select.options[select.selectedIndex]?.textContent ?? select.value
    return text.charAt(0).toLowerCase() + text.slice(1)
  }

  function coloursSummary(): string {
    // The colormap's value, not its text: jet's option carries a warning glyph.
    const parts = [
      colormapSelect.value + (reverseInput.checked ? ' reversed' : ''),
      shownText(scaleSelect),
      shownText(limitsSelect),
      shownText(classesSelect),
    ]
    // A greyed box is not drawn, whatever its tick says.
    if (symmetricInput.checked && !symmetricInput.disabled) parts.push('centred')
    if (textureInput.checked && !textureInput.disabled) parts.push('patterns')
    return parts.join(' · ')
  }

  function coloursChanged(): void {
    opts.onColoursChange?.(coloursSummary())
  }

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
      coloursChanged()
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
      coloursChanged()
    },
    setLayer(layer): void {
      layerInput.value = String(layer)
      showLayer()
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
      coloursChanged()
    },
    coloursSummary,
  }
}
