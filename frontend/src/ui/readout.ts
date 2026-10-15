// The click readout (D-08/D-06): the value with its full identity, a
// contested cell's every parameter rather than one invented colour's
// worth, and a named refusal when the join cannot say what a row is.
// Resolves synchronously from state the client already holds -- there is
// no fetch and no loading state in this module.

import type { CellClass, ParIdentity } from '../data/parmap'

const CONTESTED_ROW_CAP = 20

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

export interface ReadoutOptions {
  pick: ReadoutPick
  /** The drawn group's name, for the no-parameter copy. */
  group: string
  /** The D-05 join: block row `i`'s identity, or `null` when the join does
   *  not cover it. */
  joined: Array<ParIdentity | null>
  /** The raw block-order field the drawn group's values are read from. */
  field: Float32Array
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

export function renderReadout(el: HTMLElement, opts: ReadoutOptions): void {
  el.textContent = ''
  el.classList.add('floating')

  if (opts.pick.kind === 'none') {
    const line = appendLine(el, 'Click a cell to see its value.', 'label')
    line.style.color = 'var(--ink-muted)'
    return
  }

  const { cellId, layer, selectionLabel, classification } = opts.pick

  if (classification.kind === 'no-parameter' || classification.kind === 'outside-model') {
    appendLine(el, `No parameter of ${opts.group} sits on this cell.`, 'body')
    appendFooter(el, layer, cellId, selectionLabel)
    return
  }

  if (classification.kind === 'valued') {
    appendRow(el, classification.row, opts.joined, opts.field)
    appendFooter(el, layer, cellId, selectionLabel)
    return
  }

  if (classification.kind === 'interpolated') {
    appendLine(el, `${opts.group}: ${opts.field[cellId]}`, 'body')
    appendFooter(el, layer, cellId, selectionLabel)
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
