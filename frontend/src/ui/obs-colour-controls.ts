// The map's "colour by" switch with its observation controls (group, statistic, all layers) and
// the observation legend. Controls write the shared selection and nothing else; the map view
// draws. Every name and sentence reaches the DOM through textContent.

import { OBS_STATS, OBS_STAT_LABEL, type ObsGroupsResult, type ObsStat } from '../data/obs'
import { ramp } from '../gl/colormap'
import { layerWords } from '../data/layer-words'
import type { DataCardRows } from './data-card'
import { paintNote } from './note-line'
import type { SelectionStore } from '../state/selection'
import type { ObsDotCounts, TimeCounts } from '../views/observation-stat-source'

/** The residual is signed, so it gets a diverging ramp; the rest are magnitudes. */
export const OBS_RAMP: Record<ObsStat, 'RdBu' | 'viridis'> = {
  resid_mean: 'RdBu',
  rmse: 'viridis',
  std: 'viridis',
  mean: 'viridis',
}

export function isObsStat(value: string): value is ObsStat {
  return (OBS_STATS as readonly string[]).includes(value)
}

export interface ObsColourControlsOptions {
  store: SelectionStore
  loadGroups: () => Promise<ObsGroupsResult>
  /** Told when the all-layers box is ticked by the user; setAllLayers does not call it. */
  onAllLayersChange?: (on: boolean) => void
}

/** The Data card rows the controls fill instead of one host of their own. */
export type ObsColourRows = Pick<DataCardRows, 'colourBy' | 'group' | 'statistic' | 'allLayers'>

export interface ObsColourControlsHandle {
  setAllLayers(on: boolean): void
  allLayers(): boolean
  dispose(): void
}

function labelled(text: string, control: HTMLElement): HTMLLabelElement {
  const label = document.createElement('label')
  label.classList.add('label')
  label.textContent = text
  label.appendChild(control)
  return label
}

function obsOnly<T extends HTMLElement>(el: T): T {
  el.setAttribute('data-colour-source', 'obs')
  return el
}

/** Renders into one host of its own, or, given the Data card's rows, into those rows. */
export function renderObsColourControls(target: HTMLElement | ObsColourRows, opts: ObsColourControlsOptions): ObsColourControlsHandle {
  const { store } = opts

  const switchEl = document.createElement('div')
  switchEl.classList.add('obs-colour-switch')
  switchEl.setAttribute('role', 'group')
  switchEl.setAttribute('aria-label', 'Colour by')
  const parButton = document.createElement('button')
  parButton.type = 'button'
  parButton.textContent = 'Parameters'
  const obsButton = document.createElement('button')
  obsButton.type = 'button'
  obsButton.textContent = 'Observations'
  switchEl.appendChild(parButton)
  switchEl.appendChild(obsButton)

  const groupSelect = document.createElement('select')
  groupSelect.setAttribute('aria-label', 'Observation group')
  const statSelect = document.createElement('select')
  statSelect.setAttribute('aria-label', 'Observation statistic')
  for (const stat of OBS_STATS) {
    const option = document.createElement('option')
    option.setAttribute('value', stat)
    option.textContent = OBS_STAT_LABEL[stat]
    statSelect.appendChild(option)
  }
  const allInput = document.createElement('input')
  allInput.type = 'checkbox'
  allInput.setAttribute('aria-label', 'All layers')
  const allLabel = document.createElement('label')
  allLabel.classList.add('label')
  allLabel.textContent = 'All layers'
  allLabel.appendChild(allInput)
  const groupNote = document.createElement('div')
  groupNote.classList.add('label', 'wrap-note')
  groupNote.setAttribute('role', 'status')
  paintNote(groupNote, null)

  // Each element that shows only while Observations is chosen.
  const obsParts: HTMLElement[] = []
  if (target instanceof HTMLElement) {
    target.textContent = ''
    target.classList.add('floating', 'obs-colour')
    const rows = obsOnly(document.createElement('div'))
    rows.classList.add('obs-colour-rows')
    rows.appendChild(labelled('Observation group', groupSelect))
    rows.appendChild(labelled('Statistic', statSelect))
    rows.appendChild(allLabel)
    rows.appendChild(groupNote)
    target.appendChild(switchEl)
    target.appendChild(rows)
    obsParts.push(rows)
  } else {
    // The map's tests find the observation controls by this class, whichever way they are laid out.
    const groupBox = obsOnly(document.createElement('div'))
    groupBox.classList.add('obs-colour')
    groupBox.append(groupSelect, groupNote)
    target.colourBy.control.appendChild(switchEl)
    target.group.control.appendChild(groupBox)
    target.statistic.control.appendChild(obsOnly(statSelect))
    target.allLayers.control.appendChild(allLabel)
    obsParts.push(groupBox, statSelect, allLabel)
  }

  function warn(text: string | null): void {
    paintNote(groupNote, text === null ? null : { kind: 'warning', text })
  }

  let lastParStat = 'value'
  let lastObsStat: ObsStat = 'resid_mean'
  let groupsRequested = false
  let groupNames: string[] = []
  let disposed = false

  function noteColour(): void {
    const { source, stat } = store.get().colour
    if (source === 'par') lastParStat = stat
    else if (isObsStat(stat)) lastObsStat = stat
  }

  function paintGroups(): void {
    const chosen = [...store.get().obsGroups][0] ?? ''
    groupSelect.value = groupNames.includes(chosen) ? chosen : ''
  }

  function paint(): void {
    noteColour()
    const selection = store.get()
    const source = selection.colour.source
    parButton.setAttribute('aria-pressed', String(source === 'par'))
    obsButton.setAttribute('aria-pressed', String(source === 'obs'))
    for (const part of obsParts) part.hidden = source !== 'obs'
    statSelect.value = isObsStat(selection.colour.stat) ? selection.colour.stat : lastObsStat
    paintGroups()
    if (source === 'obs') requestGroups()
  }

  // The group list is read the first time Observations is chosen, never at mount.
  function requestGroups(): void {
    if (groupsRequested) return
    groupsRequested = true
    groupSelect.disabled = true
    groupSelect.textContent = ''
    const loading = document.createElement('option')
    loading.setAttribute('value', '')
    loading.textContent = 'Loading groups…'
    groupSelect.appendChild(loading)
    void opts.loadGroups().then(
      (answer) => {
        if (disposed) return
        groupSelect.textContent = ''
        if (!answer.ok) {
          groupsRequested = false
          groupNames = []
          warn(`${answer.artifact}: ${answer.reason}`)
          return
        }
        warn(null)
        groupNames = answer.rows.map((row) => row.group)
        const none = document.createElement('option')
        none.setAttribute('value', '')
        none.textContent = '—'
        none.disabled = true
        groupSelect.appendChild(none)
        for (const row of answer.rows) {
          const option = document.createElement('option')
          option.setAttribute('value', row.group)
          option.textContent = `${row.group} · ${row.nPlaced === null ? 'placement unknown' : `${row.nPlaced} placed`}`
          option.title = row.group
          groupSelect.appendChild(option)
        }
        groupSelect.disabled = answer.rows.length === 0
        if (answer.rows.length === 0) warn('obs_index: this run has no observation groups')
        paintGroups()
      },
      (error: unknown) => {
        if (disposed) return
        groupsRequested = false
        groupSelect.textContent = ''
        warn(error instanceof Error ? error.message : String(error))
      },
    )
  }

  parButton.addEventListener('click', () => {
    noteColour()
    store.set({ colour: { source: 'par', stat: lastParStat } }, 'map')
    paint()
  })
  obsButton.addEventListener('click', () => {
    noteColour()
    store.set({ colour: { source: 'obs', stat: lastObsStat } }, 'map')
    paint()
  })
  groupSelect.addEventListener('change', () => {
    if (groupSelect.value === '') return
    store.set({ obsGroups: new Set([groupSelect.value]) }, 'map')
  })
  statSelect.addEventListener('change', () => {
    if (!isObsStat(statSelect.value)) return
    store.set({ colour: { source: 'obs', stat: statSelect.value } }, 'map')
    paint()
  })
  allInput.addEventListener('change', () => opts.onAllLayersChange?.(allInput.checked))

  const unsubscribe = [
    store.subscribe((s) => s.colour, paint),
    store.subscribe((s) => s.obsGroups, paintGroups),
  ]
  paint()

  return {
    setAllLayers(on) {
      allInput.checked = on
    },
    allLayers() {
      return allInput.checked
    },
    dispose() {
      disposed = true
      for (const off of unsubscribe) off()
    },
  }
}

export interface ObsLegendOptions {
  group?: string
  stat: ObsStat
  iteration: number
  /** null when the statistic has no finite value in the group. */
  limits: [number, number] | null
  limitsRule: string
  /** Why the limits are unknown; the dots are then drawn without a colour. */
  limitsRefused?: string | null
  timeText: string
  counts: ObsDotCounts
  /** null while no frame is held, or when the group has no time. */
  atTime: TimeCounts | null
  /** The layer the map moved to because the group had no site on the old one. */
  layerMoved: number | null
  notes: string[]
}

function formatEndValue(value: number): string {
  return Number.isFinite(value) ? value.toPrecision(4) : '—'
}

function sitesText(n: number): string {
  return n === 1 ? '1 site' : `${n} sites`
}

function line(el: HTMLElement, text: string, ...classes: string[]): HTMLElement {
  const row = document.createElement('div')
  row.classList.add('label', ...classes)
  row.textContent = text
  el.appendChild(row)
  return row
}

// The colour at the high end of the ramp, which is what a positive residual is drawn in.
function highEndWord(stat: ObsStat): string {
  const table = ramp(OBS_RAMP[stat], false)
  const last = 255 * 4
  return table[last] > table[last + 2] ? 'red' : 'blue'
}

/** Passing null clears the legend. Counts every site of the group, so none is dropped without a word. */
export function renderObsLegend(el: HTMLElement, opts: ObsLegendOptions | null): void {
  el.textContent = ''
  if (opts === null) return
  el.classList.add('floating')

  // Sampled from the table the GPU draws with, so the swatch cannot differ from the map.
  const table = ramp(OBS_RAMP[opts.stat], false)
  const stops: string[] = []
  for (let i = 0; i < 256; i += 32) {
    stops.push(`rgb(${table[i * 4]}, ${table[i * 4 + 1]}, ${table[i * 4 + 2]}) ${((i / 255) * 100).toFixed(0)}%`)
  }
  const swatch = document.createElement('div')
  swatch.setAttribute('aria-hidden', 'true')
  swatch.style.height = '8px'
  swatch.style.width = '128px'
  swatch.style.background = `linear-gradient(to right, ${stops.join(', ')})`
  el.appendChild(swatch)

  const ends = document.createElement('div')
  ends.classList.add('legend-figures')
  for (const text of opts.limits === null ? ['—', '—'] : [formatEndValue(opts.limits[0]), formatEndValue(opts.limits[1])]) {
    const figure = document.createElement('span')
    figure.classList.add('tabular-nums')
    figure.style.display = 'inline-block'
    figure.style.minWidth = '7ch'
    figure.style.whiteSpace = 'nowrap'
    figure.textContent = text
    ends.appendChild(figure)
  }
  el.appendChild(ends)

  line(el, `${OBS_STAT_LABEL[opts.stat]}, iteration ${opts.iteration}`, 'wrap-note', 'legend-name')
  if (opts.stat === 'resid_mean') {
    line(el, `simulated minus observed; ${highEndWord(opts.stat)} means simulated above observed`, 'wrap-note')
  }
  if (opts.group !== undefined) {
    const group = line(el, opts.group, 'truncate', 'legend-name')
    group.title = opts.group
  }
  line(el, opts.timeText, 'wrap-note')
  if (opts.limitsRefused) {
    line(el, `Limits unknown, so the dots carry no colour: ${opts.limitsRefused}`, 'wrap-note', 'legend-keep')
  } else if (opts.limits === null) {
    line(el, `Limits: none, this statistic has no finite value (${opts.limitsRule})`, 'wrap-note', 'legend-keep')
  } else {
    line(el, `Limits: ${opts.limitsRule}`, 'wrap-note')
  }

  const { counts, atTime } = opts
  if (counts.drawn === 0) {
    line(el, 'No site of this group is drawn', 'wrap-note', 'legend-keep')
  } else {
    if (atTime !== null) {
      const total = atTime.total
      const text =
        total === 1
          ? `${atTime.withValue} of 1 site has a value at this time`
          : `${atTime.withValue} of ${total} sites have a value at this time`
      line(el, text, 'wrap-note', 'tabular-nums')
      if (atTime.withObservationNoValue > 0) {
        const n = atTime.withObservationNoValue
        line(
          el,
          `${n} ${n === 1 ? 'has' : 'have'} an observation at this time but no measured value, counted over the whole group`,
          'wrap-note',
          'legend-keep',
        )
      }
    }
    if (atTime !== null && atTime.rowsHidden > 0) {
      const n = atTime.rowsHidden
      line(
        el,
        `${n} ${n === 1 ? 'observation shares its time' : 'observations share their time'} with a later one of the same site; the last is shown`,
        'wrap-note',
        'legend-keep',
      )
    }
    line(el, `${counts.cellCentre} at the centre of the cell's vertices, ${counts.own} at its own x and y`, 'wrap-note')
  }
  if (counts.unplaced > 0) {
    const reason = counts.unplacedNotes.length > 0 ? counts.unplacedNotes.join('; ') : 'no reason was recorded'
    line(el, `${sitesText(counts.unplaced)} not placed: ${reason}`, 'wrap-note', 'legend-keep')
  }
  if (counts.onOtherLayers > 0) {
    line(el, counts.onOtherLayers === 1 ? '1 site on another layer' : `${counts.onOtherLayers} sites on other layers`, 'wrap-note', 'legend-keep')
  }
  if (counts.unknownLayerHidden > 0) {
    line(el, `${sitesText(counts.unknownLayerHidden)} with an unknown layer, shown only under all layers`, 'wrap-note', 'legend-keep')
  }
  if (opts.layerMoved !== null) {
    line(el, `moved to ${layerWords(opts.layerMoved)}, the lowest layer with a site of this group`, 'wrap-note', 'legend-keep')
  }
  for (const note of opts.notes) line(el, note, 'wrap-note', 'legend-keep')
}
