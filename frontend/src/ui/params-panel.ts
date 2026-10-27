// The Params panel (D-09): the group summary on top, the chosen group's
// parameters under it, the unmapped-group list the picker's disclosure
// already names, and the per-artifact notes the ingest recorded. The
// parameter list reads the one `/meta?kind=par` answer the map already
// fetched (the bound columns are not in the map's own copy), and this file
// owns its own loading/failed/ready lifecycle the way `dir-picker.ts` and
// `progress.ts` already do for their own screens.

import { tableFromIPC } from 'apache-arrow'
import { ApiError } from '../data/client'
import { fetchParGroups, type ParGroupRow, type ParGroupsPayload, type ParGroupsResult } from '../data/par'
import type { SelectionStore } from '../state/selection'
import { makeFocusable, renderNotice } from './chrome'
import type { UnmappedGroup } from './group-picker'

export interface ParamsPanelOptions {
  /** The same D-07 unmapped list the group picker's disclosure builds --
   *  passed through, never recomputed independently. */
  unmapped: UnmappedGroup[]
  /** Every ingest artifact that left a recorded note, name and reason. */
  artifactNotes: { artifact: string; reason: string }[]
  /** The one parameter table request the map made; the panel reads its answer
   *  instead of asking again. */
  parTable: Promise<ArrayBuffer>
  /** The shared selection: a group row writes `parGroups` here, and the panel follows it. */
  store: SelectionStore
  /** True when the tab is not the open one: nothing is fetched until onShow. */
  startHidden?: boolean
  /** Reads the group summary. The shell passes one that keeps its answer, so a
   *  panel drawn again does not ask again. */
  loadGroups?: () => Promise<ParGroupsResult>
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
//
// Returns `redraw`, the same windowing the scroll handler runs, so the panel
// can recompute the window when it is shown again at its real height.
function renderTable(host: HTMLElement, rows: ParamRow[], isHidden: () => boolean): () => void {
  host.textContent = ''

  // One header row above the windowed table, with the same column rule as
  // every data row (style.css `.param-header`), so the labels line up.
  const headerEl = document.createElement('div')
  headerEl.classList.add('param-header')
  for (const text of ['Parameter', 'Group', 'Lower', 'Upper', 'Transform']) {
    const cell = document.createElement('span')
    cell.classList.add('label')
    cell.textContent = text
    headerEl.appendChild(cell)
  }
  host.appendChild(headerEl)

  const scrollPane = document.createElement('div')
  scrollPane.classList.add('scroll-pane')
  // The pane's height comes from the frame (style.css `.params-table`);
  // VIEWPORT_HEIGHT is only renderVisible's fallback before layout.
  scrollPane.style.position = 'relative'
  makeFocusable(scrollPane, 'Parameter table')

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

  // A hidden panel draws nothing; showing it again redraws once.
  scrollPane.addEventListener('scroll', () => {
    if (!isHidden()) renderVisible()
  })
  renderVisible()
  host.appendChild(scrollPane)
  return renderVisible
}

function renderUnmappedSection(el: HTMLElement, unmapped: UnmappedGroup[]): void {
  if (unmapped.length === 0) return
  const section = document.createElement('div')
  section.classList.add('params-unmapped')
  const heading = document.createElement('div')
  heading.classList.add('label')
  heading.textContent = unmapped.length === 1 ? '1 group unmapped' : `${unmapped.length} groups unmapped`
  section.appendChild(heading)
  // The rows scroll inside their own pane: a real run can have a hundred
  // unmapped groups, and they must not push the table off the panel.
  const list = document.createElement('div')
  list.classList.add('scroll-pane')
  makeFocusable(list, 'Unmapped groups')
  for (const entry of unmapped) {
    const row = document.createElement('div')
    row.classList.add('label', 'truncate')
    const text = entry.note ?? `${entry.group} — no placement rule matched`
    row.textContent = text
    row.title = entry.note ?? entry.group
    list.appendChild(row)
  }
  section.appendChild(list)
  el.appendChild(section)
}

function renderNotesSection(el: HTMLElement, notes: { artifact: string; reason: string }[]): void {
  if (notes.length === 0) return
  const section = document.createElement('div')
  section.classList.add('params-notes', 'scroll-pane')
  makeFocusable(section, 'Notes')
  for (const note of notes) {
    const row = document.createElement('div')
    row.classList.add('label', 'wrap-note')
    row.textContent = `${note.artifact}: ${note.reason}`
    section.appendChild(row)
  }
  el.appendChild(section)
}

const NOT_STATED = 'not stated'
const NO_FIGURE = '—'

function withSource(source: string | null, note: string | null): string {
  if (source && note) return `${source}: ${note}`
  return source ?? note ?? ''
}

function typeText(row: ParGroupRow): string {
  return row.type.value ?? NOT_STATED
}

function layerText(row: ParGroupRow): string {
  const value = row.layer.value
  return value === null ? NOT_STATED : String(value)
}

function formatChange(value: number): string {
  return `${Number(value.toPrecision(3))}%`
}

function pestoText(row: ParGroupRow): string {
  const figure = row.change.pesto
  return figure === null || figure.mean_change_pct === null ? NO_FIGURE : formatChange(figure.mean_change_pct)
}

// The title names the source of the figure, or says why there is none.
function pestoTitle(row: ParGroupRow): string {
  const figure = row.change.pesto
  if (figure === null) return row.change.reason ?? 'pesto has no change figure for this group'
  const counts = `${figure.n_used} parameters used, ${figure.n_refused_near_zero} refused as near zero`
  if (figure.mean_change_pct === null) return `${figure.label}: no parameter had a usable mean change (${counts})`
  return `${figure.label}; ${counts}`
}

function pestppText(row: ParGroupRow): string {
  const value = row.change.pestpp.mean_change
  return value === null ? NO_FIGURE : formatChange(value)
}

function pestppTitle(row: ParGroupRow): string {
  const { source, note, mean_change } = row.change.pestpp
  if (mean_change === null) return note ?? 'pestpp has no change figure for this group'
  return note ? `${source}; ${note}` : (source ?? 'pestpp')
}

function parCountTitle(row: ParGroupRow): string {
  const left = Object.entries(row.excluded)
    .filter(([, n]) => n > 0)
    .map(([kind, n]) => `${n} ${kind.replace(/_/g, ' ')}`)
  const base = `${row.n_included} of ${row.n_par} adjustable`
  return left.length > 0 ? `${base}; left out: ${left.join(', ')}` : base
}

function groupCell(column: string, text: string, title: string, extraClasses: string[] = []): HTMLElement {
  const cell = document.createElement('span')
  cell.setAttribute('role', 'gridcell')
  cell.dataset.column = column
  cell.classList.add('body', ...extraClasses)
  cell.textContent = text
  if (title !== '') cell.title = title
  return cell
}

const COLUMN_HEADINGS: { column: string; label: string }[] = [
  { column: 'group', label: 'Group' },
  { column: 'type', label: 'Type' },
  { column: 'layer', label: 'Layer' },
  { column: 'n_par', label: 'Parameters' },
  { column: 'pesto', label: 'Mean change, pesto' },
  { column: 'pestpp', label: 'Mean change, pestpp' },
]

function renderGroupRow(row: ParGroupRow, chosen: boolean, pick: (group: string) => void): HTMLElement {
  const rowEl = document.createElement('div')
  rowEl.classList.add('group-row')
  rowEl.setAttribute('role', 'row')
  rowEl.setAttribute('aria-selected', String(chosen))
  rowEl.tabIndex = 0
  rowEl.dataset.group = row.group
  rowEl.appendChild(groupCell('group', row.group, row.group, ['truncate']))
  rowEl.appendChild(groupCell('type', typeText(row), withSource(row.type.source, row.type.note), ['truncate']))
  rowEl.appendChild(groupCell('layer', layerText(row), withSource(row.layer.source, row.layer.note)))
  rowEl.appendChild(groupCell('n_par', String(row.n_par), parCountTitle(row), ['tabular-nums']))
  rowEl.appendChild(groupCell('pesto', pestoText(row), pestoTitle(row), ['tabular-nums']))
  rowEl.appendChild(groupCell('pestpp', pestppText(row), pestppTitle(row), ['tabular-nums']))
  rowEl.addEventListener('click', () => pick(row.group))
  rowEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      pick(row.group)
    }
  })
  return rowEl
}

function describeGroupsFailure(artifact: string, reason: string): { title: string; detail: string } {
  return { title: 'The group summary could not be read', detail: `${artifact}: ${reason}` }
}

/** What a tab bar calls when it hides or shows the panel. */
export interface ParamsPanelHandle {
  /** Restores the scroll positions, redraws the table for the panel's real height, and fetches the group summary the first time. */
  onShow(): void
  /** Remembers the scroll positions and stops scroll-driven redraws. */
  onHide(): void
  /** Stops following the shared selection. Called when a newer panel replaces this one. */
  dispose(): void
}

/**
 * Fills `el` with the Params panel: the group summary, the chosen group's
 * windowed parameter list, the unmapped-group list and the per-artifact
 * notes, in one `.surface` panel. The parameter list reads the map's own
 * `/meta?kind=par` answer and owns the loading/failed/ready states for it --
 * no skeleton rows, and a failure names the artifact and the reason in place
 * of the list (E8).
 */
export function renderParamsPanel(el: HTMLElement, opts: ParamsPanelOptions): ParamsPanelHandle {
  el.textContent = ''
  el.classList.add('surface', 'params-panel')

  let hidden = opts.startHidden === true
  let redrawTable: (() => void) | null = null
  // A browser drops the scroll offset of a box that is not displayed, so the
  // offsets are kept here while the panel is hidden.
  const savedScroll = new Map<Element, number>()
  const loadGroups = opts.loadGroups ?? (() => fetchParGroups())

  const title = document.createElement('div')
  title.classList.add('heading')
  title.textContent = 'Params'
  el.appendChild(title)

  const groupsHost = document.createElement('div')
  groupsHost.classList.add('params-groups')
  el.appendChild(groupsHost)

  const tableHost = document.createElement('div')
  tableHost.classList.add('params-table')
  el.appendChild(tableHost)

  let groups: ParGroupsPayload | null = null
  let groupsRequested = false
  let rows: ParamRow[] | null = null
  let tableFailure: { artifact: string; reason: string } | null = null

  function chosenGroups(): ReadonlySet<string> {
    return opts.store.get().parGroups
  }

  function pick(group: string): void {
    opts.store.set({ parGroups: new Set([group]) }, 'params')
  }

  function markRows(): void {
    const chosen = chosenGroups()
    for (const rowEl of groupsHost.querySelectorAll<HTMLElement>('.group-row')) {
      rowEl.setAttribute('aria-selected', String(chosen.has(rowEl.dataset.group ?? '')))
    }
  }

  function renderGroups(payload: ParGroupsPayload): void {
    groupsHost.textContent = ''
    const grid = document.createElement('div')
    grid.setAttribute('role', 'grid')
    grid.setAttribute('aria-label', 'Parameter groups')
    const header = document.createElement('div')
    header.classList.add('group-header')
    header.setAttribute('role', 'row')
    for (const { column, label } of COLUMN_HEADINGS) {
      const heading = document.createElement('span')
      heading.setAttribute('role', 'columnheader')
      heading.dataset.column = column
      heading.classList.add('label')
      heading.textContent = label
      header.appendChild(heading)
    }
    grid.appendChild(header)

    const pane = document.createElement('div')
    pane.classList.add('scroll-pane')
    makeFocusable(pane, 'Parameter groups')
    const chosen = chosenGroups()
    for (const row of payload.groups) pane.appendChild(renderGroupRow(row, chosen.has(row.group), pick))
    grid.appendChild(pane)
    groupsHost.appendChild(grid)
  }

  function renderGroupsFailure(artifact: string, reason: string): void {
    groupsHost.textContent = ''
    const { title: noticeTitle, detail } = describeGroupsFailure(artifact, reason)
    renderNotice(groupsHost, { title: noticeTitle, detail, tone: 'serious' })
  }

  // The first show asks once; a hidden panel draws and fetches nothing.
  function requestGroups(): void {
    if (groupsRequested) return
    groupsRequested = true
    const loading = document.createElement('div')
    loading.classList.add('label')
    loading.style.color = 'var(--ink-muted)'
    loading.textContent = 'Loading groups…'
    groupsHost.appendChild(loading)
    void loadGroups().then(
      (answer) => {
        if (answer.ok) {
          groups = answer.payload
          renderGroups(answer.payload)
        } else {
          renderGroupsFailure(answer.artifact, answer.reason)
        }
        renderDetail()
      },
      (error: unknown) => {
        const { artifact, reason } = describeFailure(error)
        renderGroupsFailure(artifact, reason)
        renderDetail()
      },
    )
  }

  function renderDetail(): void {
    redrawTable = null
    tableHost.textContent = ''
    if (tableFailure !== null) {
      renderFailure(tableHost, tableFailure.artifact, tableFailure.reason)
      return
    }
    if (rows === null) {
      const loading = document.createElement('div')
      loading.classList.add('label')
      loading.style.color = 'var(--ink-muted)'
      loading.textContent = 'Loading parameters…'
      tableHost.appendChild(loading)
      return
    }
    const chosen = chosenGroups()
    if (chosen.size === 0) {
      renderNotice(tableHost, {
        title: 'Choose a group above to list its parameters',
        tone: 'info',
      })
      return
    }
    const shown = rows.filter((row) => chosen.has(row.pargp))
    redrawTable = renderTable(tableHost, shown, () => hidden)
  }

  renderDetail()
  void opts.parTable.then(
    (buffer) => {
      try {
        rows = readParamRows(buffer)
      } catch (error) {
        tableFailure = describeFailure(error)
      }
      renderDetail()
    },
    (error: unknown) => {
      tableFailure = describeFailure(error)
      renderDetail()
    },
  )

  const unsubscribe = opts.store.subscribe(
    (selection) => selection.parGroups,
    () => {
      markRows()
      renderDetail()
    },
  )

  renderUnmappedSection(el, opts.unmapped)
  renderNotesSection(el, opts.artifactNotes)

  if (!hidden) requestGroups()

  return {
    onHide() {
      hidden = true
      savedScroll.clear()
      for (const pane of el.querySelectorAll('.scroll-pane')) savedScroll.set(pane, pane.scrollTop)
    },
    onShow() {
      hidden = false
      requestGroups()
      for (const [pane, top] of savedScroll) pane.scrollTop = top
      savedScroll.clear()
      redrawTable?.()
    },
    dispose() {
      unsubscribe()
    },
  }
}
