// The click readout (D-08/D-06): the value with its full identity, a
// contested cell's every parameter rather than one invented colour's
// worth, and a named refusal when the join cannot say what a row is.
// Resolves synchronously from state the client already holds; an
// interpolated cell's contributors arrive later and the caller re-renders.

import type { Contributor } from '../data/fields'
import type { CellClass, ParIdentity } from '../data/parmap'

const CONTESTED_ROW_CAP = 20
const SITE_CAP = 20

export interface SiteReadoutEntry {
  name: string
  group: string
  /** World coordinates; the caller adds the mesh origin back. */
  x: number
  y: number
  xySource: 'own' | 'cell_centre'
  layer: number | null
  cell: number
  rule: string
  /** Already formatted in the site's time kind. */
  timeText: string
  observed:
    | { kind: 'value'; value: number }
    | { kind: 'zero_weight'; value: number }
    | { kind: 'no_value' }
    | { kind: 'no_observation' }
    | { kind: 'loading' }
  stat: { label: string; value: number | null; iteration: number }
}

export type ReadoutPick =
  | { kind: 'none' }
  | {
      kind: 'cell'
      cellId: number
      layer: number
      /** The realization name, or the statistic label when no realization
       *  applies -- whichever the footer's "{realization or statistic
       *  label}" slot names. */
      selectionLabel: string
      classification: CellClass
    }
  | { kind: 'point'; row: number; layer: number; x: number; y: number; selectionLabel: string }
  | { kind: 'sites'; entries: SiteReadoutEntry[]; total: number }

export interface ReadoutOptions {
  pick: ReadoutPick
  /** The drawn group's name, for the no-parameter copy. */
  group: string
  /** The D-05 join: block row `i`'s identity, or `null` when the join does
   *  not cover it. */
  joined: Array<ParIdentity | null>
  /** The raw block-order field the drawn group's values are read from. */
  field: Float32Array
  /** Set when the picked cell's value came from interpolation: there is no
   *  block row to read, so the value and the points behind it come from
   *  the field and the contributors route. `contributors` is `null` while
   *  that route has not answered, `'failed'` when it could not. */
  interpolated?: { value: number; nPoints: number; contributors: Contributor[] | null | { failed: string } }
}

function formatValue(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return value.toPrecision(4)
}

function appendLine(el: HTMLElement, text: string, ...classes: string[]): HTMLElement {
  const line = document.createElement('div')
  line.classList.add(...classes)
  line.textContent = text
  el.appendChild(line)
  return line
}

// One block row's line: `{parname} ({group}): {value}`, or a named refusal
// when the join does not cover it -- a value with no identity is not a
// readout (CLAUDE.md's second and third hard rules).
function appendRow(el: HTMLElement, row: number, joined: Array<ParIdentity | null>, field: Float32Array): void {
  const identity = joined[row]
  const text =
    identity === null
      ? `Parameter identity unavailable for block row ${row}: the permutation entry points outside the parameter table.`
      : `${identity.parnme} (${identity.pargp}): ${formatValue(field[row])}`
  const line = appendLine(el, text, 'body', 'truncate')
  line.title = text
}

function appendFooter(el: HTMLElement, layer: number, cellId: number, selectionLabel: string): void {
  appendLine(el, `layer ${layer}, cell ${cellId} · ${selectionLabel}`, 'label')
}

function appendSite(el: HTMLElement, site: SiteReadoutEntry): void {
  const block = document.createElement('div')
  const name = appendLine(block, `${site.name} (${site.group})`, 'body', 'truncate')
  name.title = site.name
  const where = site.xySource === 'own' ? 'own coordinates' : "centre of the cell's vertices"
  appendLine(block, `x ${site.x.toFixed(0)}, y ${site.y.toFixed(0)} (${where})`, 'label')
  const layer = site.layer === null ? 'layer unknown' : `layer ${site.layer}`
  appendLine(block, `${layer}, cell ${site.cell} · placed by ${site.rule}`, 'label', 'truncate').title = site.rule
  appendLine(block, site.timeText, 'label')
  const obs = site.observed
  if (obs.kind === 'value') {
    appendLine(block, `observed ${formatValue(obs.value)}`, 'label')
  } else if (obs.kind === 'zero_weight') {
    appendLine(block, `observed ${formatValue(obs.value)} — zero weight: a model output, not fitted`, 'label', 'wrap-note')
  } else if (obs.kind === 'no_value') {
    appendLine(block, 'no measured value', 'label')
  } else if (obs.kind === 'no_observation') {
    appendLine(block, 'no observation at this time', 'label')
  } else {
    appendLine(block, 'reading the observed value…', 'label').style.color = 'var(--ink-muted)'
  }
  const { label, value, iteration } = site.stat
  const stat = value === null ? 'no value at this time' : formatValue(value)
  appendLine(block, `${label}, iteration ${iteration}: ${stat}`, 'label', 'truncate')
  el.appendChild(block)
}

export function renderReadout(el: HTMLElement, opts: ReadoutOptions): void {
  el.textContent = ''
  el.classList.add('floating')

  if (opts.pick.kind === 'none') {
    const line = appendLine(el, 'Click a cell to see its value.', 'label')
    line.style.color = 'var(--ink-muted)'
    return
  }

  if (opts.pick.kind === 'sites') {
    const { entries, total } = opts.pick
    if (total > 1) appendLine(el, `${total} sites at this spot`, 'heading')
    const shown = entries.slice(0, SITE_CAP)
    for (const site of shown) appendSite(el, site)
    if (total > shown.length) appendLine(el, `${total - shown.length} more sites here are not listed`, 'label')
    return
  }

  if (opts.pick.kind === 'point') {
    const { row, layer, x, y, selectionLabel } = opts.pick
    appendRow(el, row, opts.joined, opts.field)
    // x and y reach this module in world coordinates; the map view adds the mesh origin back.
    appendLine(el, `x ${x.toFixed(0)}, y ${y.toFixed(0)} · layer ${layer} · ${selectionLabel}`, 'label')
    return
  }

  const { cellId, layer, selectionLabel, classification } = opts.pick

  if (classification.kind === 'no-parameter' || classification.kind === 'outside-model') {
    appendLine(el, `No parameter of ${opts.group} sits on this cell.`, 'body')
    appendFooter(el, layer, cellId, selectionLabel)
    return
  }

  if (classification.kind === 'points') {
    const n = classification.rows.length
    const sits = n === 1 ? `1 parameter of ${opts.group} sits` : `${n} parameters of ${opts.group} sit`
    appendLine(el, `${sits} in this cell, drawn as dots. Click a dot to read one.`, 'body', 'wrap-note')
    appendFooter(el, layer, cellId, selectionLabel)
    return
  }

  if (classification.kind === 'valued') {
    appendRow(el, classification.row, opts.joined, opts.field)
    appendFooter(el, layer, cellId, selectionLabel)
    return
  }

  if (classification.kind === 'interpolated') {
    const info = opts.interpolated ?? { value: opts.field[cellId] ?? Number.NaN, nPoints: 0, contributors: null }
    const { value, nPoints, contributors } = info
    appendLine(el, `${opts.group}: ${formatValue(value)}`, 'body')
    appendFooter(el, layer, cellId, selectionLabel)
    appendLine(el, `Interpolated from ${nPoints} pilot point${nPoints === 1 ? '' : 's'}`, 'label')
    if (contributors === null) {
      appendLine(el, 'Loading the points behind this cell…', 'label').style.color = 'var(--ink-muted)'
    } else if ('failed' in contributors) {
      appendLine(el, `The points behind this cell could not be listed: ${contributors.failed}`, 'label', 'wrap-note').style.color =
        'var(--ink-muted)'
    } else {
      for (const { parnme, weight } of contributors.slice(0, 3)) {
        const line = appendLine(el, `${parnme} (weight ${weight.toFixed(2)})`, 'label', 'truncate')
        line.title = parnme
      }
    }
    return
  }

  // Contested: the title, one row per parameter (capped, +K more never a
  // silent drop), then the same footer.
  appendLine(el, 'Contested cell', 'heading')
  const rows = classification.rows
  const shown = rows.slice(0, CONTESTED_ROW_CAP)
  for (const row of shown) {
    appendRow(el, row, opts.joined, opts.field)
  }
  if (rows.length > CONTESTED_ROW_CAP) {
    appendLine(el, `+${rows.length - CONTESTED_ROW_CAP} more`, 'label')
  }
  appendFooter(el, layer, cellId, selectionLabel)
}
