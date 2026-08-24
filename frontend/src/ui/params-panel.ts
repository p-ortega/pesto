// The Params panel (D-09): the run's own parameter table, the unmapped-
// group list the picker's disclosure already names, and the per-artifact
// notes the ingest recorded. Fetches its own copy of `/meta?kind=par` --
// the same route `data/parmap.ts` reads for the join, but that module
// never carries the bound columns this table needs, and this file owns
// its own loading/failed/ready lifecycle the way `dir-picker.ts` and
// `progress.ts` already do for their own screens.

import { tableFromIPC } from 'apache-arrow'
import { ApiError, runMeta } from '../data/client'
import { renderNotice } from './chrome'
import type { UnmappedGroup } from './group-picker'

export interface ParamsPanelOptions {
  /** The same D-07 unmapped list the group picker's disclosure builds --
   *  passed through, never recomputed independently. */
  unmapped: UnmappedGroup[]
  /** Every ingest artifact that left a recorded note, name and reason. */
  artifactNotes: { artifact: string; reason: string }[]
}

interface ParamRow {
  parnme: string
  pargp: string
  parlbnd: number | null
  parubnd: number | null
  partrans: string | null
}

// Fixed row height in px -- the spacer's total height (`rows.length *
// ROW_HEIGHT`) is what makes the scrollbar tell the truth about a table
// that may hold up to a million rows without ever placing them all in the
// DOM (T-5.1-05).
const ROW_HEIGHT = 24
const OVERSCAN = 20
const VIEWPORT_HEIGHT = 240

function formatBound(value: number | null): string {
  return value === null || !Number.isFinite(value) ? '—' : value.toPrecision(4)
}

function toNullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value)
}

// Every column read by field name, never by a numbered position -- the
// control table's column order is the control file's own order and
// nothing sorts it, so a positional read works against every fixture this
// project owns and breaks against a real run (Test 5).
function readParamRows(buffer: ArrayBuffer): ParamRow[] {
  const table = tableFromIPC(new Uint8Array(buffer))
  const parnme = table.getChild('parnme')
  const pargp = table.getChild('pargp')
  const parlbnd = table.getChild('parlbnd')
  const parubnd = table.getChild('parubnd')
  const partrans = table.getChild('partrans')
  if (!parnme || !pargp) {
    throw new Error('the parameter table is missing parnme or pargp')
  }

  const rows: ParamRow[] = new Array(table.numRows)
  for (let i = 0; i < table.numRows; i++) {
    rows[i] = {
      parnme: String(parnme.get(i)),
      pargp: String(pargp.get(i)),
      parlbnd: toNullableNumber(parlbnd?.get(i)),
      parubnd: toNullableNumber(parubnd?.get(i)),
      partrans: partrans ? String(partrans.get(i)) : null,
    }
  }
  return rows
}

function describeFailure(error: unknown): { artifact: string; reason: string } {
  if (error instanceof ApiError) {
    return { artifact: error.problem.artifact ?? 'meta', reason: error.problem.detail ?? error.problem.title }
  }
  return { artifact: 'meta', reason: error instanceof Error ? error.message : String(error) }
}

function renderFailure(host: HTMLElement, artifact: string, reason: string): void {
  host.textContent = ''
  renderNotice(host, {
    title: 'The parameter table could not be read',
    detail: `${artifact}: ${reason}`,
    tone: 'serious',
  })
}

function appendRowCells(rowEl: HTMLElement, row: ParamRow): void {
  const nameEl = document.createElement('span')
  nameEl.classList.add('body', 'truncate')
  nameEl.textContent = row.parnme
  nameEl.title = row.parnme
  rowEl.appendChild(nameEl)

  const groupEl = document.createElement('span')
  groupEl.classList.add('body', 'truncate')
  groupEl.textContent = row.pargp
  groupEl.title = row.pargp
  rowEl.appendChild(groupEl)

  const lbndEl = document.createElement('span')
  lbndEl.classList.add('tabular-nums')
  lbndEl.textContent = formatBound(row.parlbnd)
  rowEl.appendChild(lbndEl)

  const ubndEl = document.createElement('span')
  ubndEl.classList.add('tabular-nums')
  ubndEl.textContent = formatBound(row.parubnd)
  rowEl.appendChild(ubndEl)

  const partransEl = document.createElement('span')
  partransEl.textContent = row.partrans ?? '—'
  rowEl.appendChild(partransEl)
}

// A virtual scroll over a `.scroll-pane`: a spacer sized to the full row
// count holds a thin, absolutely-positioned `rowsHost` that only ever
// carries the rows a scroll position exposes plus a small overscan --
// never all of them, however large the run.
function renderTable(host: HTMLElement, rows: ParamRow[]): void {
  host.textContent = ''

  const scrollPane = document.createElement('div')
  scrollPane.classList.add('scroll-pane')
  scrollPane.style.height = `${VIEWPORT_HEIGHT}px`
  scrollPane.style.position = 'relative'

  const spacer = document.createElement('div')
  spacer.style.position = 'relative'
  spacer.style.height = `${rows.length * ROW_HEIGHT}px`
  scrollPane.appendChild(spacer)

  const rowsHost = document.createElement('div')
  spacer.appendChild(rowsHost)

  function renderVisible(): void {
    rowsHost.textContent = ''
    const scrollTop = scrollPane.scrollTop
    const viewportHeight = scrollPane.clientHeight || VIEWPORT_HEIGHT
    const firstIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
    const rowBudget = Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN * 2
    const lastIndex = Math.min(rows.length, firstIndex + rowBudget)

    for (let i = firstIndex; i < lastIndex; i++) {
      const rowEl = document.createElement('div')
      rowEl.classList.add('param-row')
      rowEl.style.position = 'absolute'
      rowEl.style.top = `${i * ROW_HEIGHT}px`
      rowEl.style.left = '0'
      rowEl.style.right = '0'
      rowEl.style.display = 'flex'
      rowEl.style.gap = 'var(--space-sm)'
      appendRowCells(rowEl, rows[i])
      rowsHost.appendChild(rowEl)
    }
  }

  scrollPane.addEventListener('scroll', renderVisible)
  renderVisible()
  host.appendChild(scrollPane)
}

function renderUnmappedSection(el: HTMLElement, unmapped: UnmappedGroup[]): void {
  if (unmapped.length === 0) return
  const section = document.createElement('div')
  const heading = document.createElement('div')
  heading.classList.add('label')
  heading.textContent = unmapped.length === 1 ? '1 group unmapped' : `${unmapped.length} groups unmapped`
  section.appendChild(heading)
  for (const entry of unmapped) {
    const row = document.createElement('div')
    row.classList.add('label', 'truncate')
    const text = entry.note ?? `${entry.group} — no placement rule matched`
    row.textContent = text
    row.title = entry.note ?? entry.group
    section.appendChild(row)
  }
  el.appendChild(section)
}

function renderNotesSection(el: HTMLElement, notes: { artifact: string; reason: string }[]): void {
  if (notes.length === 0) return
  const section = document.createElement('div')
  for (const note of notes) {
    const row = document.createElement('div')
    row.classList.add('label', 'wrap-note')
    row.textContent = `${note.artifact}: ${note.reason}`
    section.appendChild(row)
  }
  el.appendChild(section)
}

/**
 * Fills `el` with the Params panel: the windowed parameter table, the
 * unmapped-group list and the per-artifact notes, in one `.surface` panel.
 * Fetches `/meta?kind=par` itself and owns the loading/failed/ready states
 * for that fetch -- no skeleton rows, and a failure names the artifact and
 * the reason in place of the table (E8).
 */
export function renderParamsPanel(el: HTMLElement, opts: ParamsPanelOptions): void {
  el.textContent = ''
  el.classList.add('surface')

  const title = document.createElement('div')
  title.classList.add('heading')
  title.textContent = 'Params'
  el.appendChild(title)

  const tableHost = document.createElement('div')
  el.appendChild(tableHost)

  const loading = document.createElement('div')
  loading.classList.add('label')
  loading.style.color = 'var(--ink-muted)'
  loading.textContent = 'Loading parameters…'
  tableHost.appendChild(loading)

  void runMeta('par').then(
    (buffer) => {
      let rows: ParamRow[]
      try {
        rows = readParamRows(buffer)
      } catch (error) {
        const { artifact, reason } = describeFailure(error)
        renderFailure(tableHost, artifact, reason)
        return
      }
      renderTable(tableHost, rows)
    },
    (error: unknown) => {
      const { artifact, reason } = describeFailure(error)
      renderFailure(tableHost, artifact, reason)
    },
  )

  renderUnmappedSection(el, opts.unmapped)
  renderNotesSection(el, opts.artifactNotes)
}
