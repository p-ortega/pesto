// The Params panel (D-09): the group summary on top, the chosen group's
// parameters under it, the unmapped-group list the picker's disclosure
// already names, and the per-artifact notes the ingest recorded. The
// parameter list reads the one `/meta?kind=par` answer the map already
// fetched (the bound columns are not in the map's own copy), and this file
// owns its own loading/failed/ready lifecycle the way `dir-picker.ts` and
// `progress.ts` already do for their own screens.

import { tableFromIPC } from 'apache-arrow'
import { ApiError, type Capability } from '../data/client'
import { LatestWins } from '../data/latest-wins'
import {
  fetchParChange,
  fetchParGroups,
  fetchParHist,
  fetchParValues,
  type ParChangeResult,
  type ParChangeRow,
  type ParGroupRow,
  type ParGroupsPayload,
  type ParGroupsResult,
  type ParHistResult,
  type ParValuesResult,
} from '../data/par'
import { isDimmed } from '../data/dim'
import { modeOf } from '../state/modifiers'
import { selectPars } from '../state/rules'
import type { SelectionStore } from '../state/selection'
import { makeFocusable, renderNotice } from './chrome'
import type { UnmappedGroup } from './group-picker'
import {
  formatChange,
  formatRatio,
  renderGroupDetail,
  renderParameterDetail,
  type DetailHandle,
  type GroupDetailBase,
} from './params-detail'

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
  /** What the run's ingest said about the parameter view. When it is not available, the detail names why instead of drawing. */
  parView?: Capability
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

function describeFailure(error: unknown, fallback = 'meta'): { artifact: string; reason: string } {
  if (error instanceof ApiError) {
    return { artifact: error.problem.artifact ?? fallback, reason: error.problem.detail ?? error.problem.title }
  }
  return { artifact: fallback, reason: error instanceof Error ? error.message : String(error) }
}

function renderFailure(host: HTMLElement, artifact: string, reason: string): void {
  host.textContent = ''
  renderNotice(host, {
    title: 'The parameter table could not be read',
    detail: `${artifact}: ${reason}`,
    tone: 'serious',
  })
}

/** One cell of the change columns: the text, and the title that says where it came from or why there is none. */
interface FigureCell {
  text: string
  title: string
}

interface ChangeCells {
  mean: FigureCell
  sd: FigureCell
  shift: FigureCell
}

function figureCell(value: number | null, format: (value: number) => string, whyNot: string | null, fallback: string): FigureCell {
  return value === null ? { text: '—', title: whyNot ?? fallback } : { text: format(value), title: '' }
}

function changeCellsFor(row: ChangeRowState): ChangeCells {
  const same = (cell: FigureCell): ChangeCells => ({ mean: cell, sd: cell, shift: cell })
  if (row.kind === 'loading') return same({ text: '…', title: 'Loading the change figures' })
  if (row.kind === 'none') return same({ text: '—', title: row.reason })
  if (!row.found) return same({ text: '—', title: 'the change table has no row for this parameter' })
  const change = row.change
  if (!change.included) return same({ text: '—', title: change.excluded_reason ?? 'this parameter is left out of the change figures' })
  return {
    mean: figureCell(change.mean_change_pct, formatChange, change.mean_change_refused, 'no mean change figure'),
    sd: figureCell(change.sd_change_pct, formatChange, change.sd_change_refused, 'no sd change figure'),
    shift: figureCell(change.mean_shift_sd, formatRatio, null, 'no shift: the parameter had no spread in the first iteration'),
  }
}

type ChangeRowState =
  | { kind: 'loading' }
  | { kind: 'none'; reason: string }
  | { kind: 'ready'; found: false }
  | { kind: 'ready'; found: true; change: ParChangeRow }

function appendFigure(rowEl: HTMLElement, column: string, cell: FigureCell): void {
  const el = document.createElement('span')
  el.dataset.column = column
  el.classList.add('tabular-nums')
  el.textContent = cell.text
  if (cell.title !== '') el.title = cell.title
  rowEl.appendChild(el)
}

function appendRowCells(rowEl: HTMLElement, row: ParamRow, change: ChangeCells): void {
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

  appendFigure(rowEl, 'mean_change', change.mean)
  appendFigure(rowEl, 'sd_change', change.sd)
  appendFigure(rowEl, 'shift', change.shift)
}

// A virtual scroll over a `.scroll-pane`: a spacer sized to the full row
// count holds a thin, absolutely-positioned `rowsHost` that only ever
// carries the rows a scroll position exposes plus a small overscan --
// never all of them, however large the run.
//
// Returns `redraw`, the same windowing the scroll handler runs, so the panel
// can recompute the window when it is shown again at its real height.
const NO_SELECTED_HERE = 'no selected parameter is in this group'

function renderTable(
  host: HTMLElement,
  rows: ParamRow[],
  isHidden: () => boolean,
  changeFor: (parnme: string) => ChangeRowState,
  selected: () => ReadonlySet<string>,
  pick: (parnme: string, event: MouseEvent | KeyboardEvent) => void,
): () => void {
  host.textContent = ''

  // Selected rows stay where the sort put them (D-03), so this is the way to reach one.
  const showSelected = document.createElement('button')
  showSelected.type = 'button'
  showSelected.classList.add('label', 'show-selected')
  showSelected.textContent = 'Show selected'
  showSelected.style.flex = 'none'
  showSelected.style.alignSelf = 'flex-start'
  showSelected.style.marginBottom = 'var(--space-xs)'
  host.appendChild(showSelected)

  // One header row above the windowed table, with the same column rule as
  // every data row (style.css `.param-header`), so the labels line up.
  const headerEl = document.createElement('div')
  headerEl.classList.add('param-header')
  for (const text of ['Parameter', 'Group', 'Lower', 'Upper', 'Transform', 'Mean change', 'SD change', 'Shift (prior sd)']) {
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

  function firstSelectedIndex(chosen: ReadonlySet<string>): number {
    if (chosen.size === 0) return -1
    return rows.findIndex((row) => chosen.has(row.parnme))
  }

  function renderVisible(): void {
    rowsHost.textContent = ''
    const chosen = selected()
    const first = firstSelectedIndex(chosen)
    showSelected.disabled = first < 0
    showSelected.title = first < 0 ? NO_SELECTED_HERE : 'scroll to the first selected parameter'
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
      rowEl.tabIndex = 0
      rowEl.dataset.parameter = rows[i].parnme
      const name = rows[i].parnme
      rowEl.setAttribute('aria-selected', String(chosen.has(name)))
      if (isDimmed(chosen, name)) rowEl.classList.add('dimmed')
      appendRowCells(rowEl, rows[i], changeCellsFor(changeFor(name)))
      rowEl.addEventListener('click', (event) => pick(name, event))
      rowEl.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          pick(name, event)
        }
      })
      rowsHost.appendChild(rowEl)
    }
  }

  // A hidden panel draws nothing; showing it again redraws once.
  scrollPane.addEventListener('scroll', () => {
    if (!isHidden()) renderVisible()
  })
  showSelected.addEventListener('click', () => {
    const first = firstSelectedIndex(selected())
    if (first < 0) return
    scrollPane.scrollTop = first * ROW_HEIGHT
    renderVisible()
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

function sigmaText(row: ParGroupRow): string {
  const { state, median } = row.sigma_ratio
  if (state === 'refused' || median === null) return 'not shown'
  return state === 'unchecked' ? `${formatRatio(median)} ⚠` : formatRatio(median)
}

// The title is the stored sentence for anything but a plain ratio.
function sigmaTitle(row: ParGroupRow): string {
  const { state, reason, n_used } = row.sigma_ratio
  if (state === 'shown') return n_used === null ? '' : `median over ${n_used} parameters`
  return reason ?? 'no reason was recorded'
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

type SortKey = 'group' | 'type' | 'layer' | 'n_par' | 'pesto' | 'pestpp' | 'sigma'
type SortDirection = 'ascending' | 'descending'

const COLUMN_HEADINGS: { column: SortKey; label: string }[] = [
  { column: 'group', label: 'Group' },
  { column: 'type', label: 'Type' },
  { column: 'layer', label: 'Layer' },
  { column: 'n_par', label: 'Parameters' },
  { column: 'pesto', label: 'Mean change, pesto' },
  { column: 'pestpp', label: 'Mean change, pestpp' },
  { column: 'sigma', label: 'Sigma ratio' },
]

// What a column sorts on. null is "no value" and always sorts last; a layer
// given as "several" sorts after every numbered layer.
function sortValue(row: ParGroupRow, key: SortKey): string | number | null {
  switch (key) {
    case 'group':
      return row.group
    case 'type':
      return row.type.value
    case 'layer':
      return row.layer.value === 'several' ? Number.POSITIVE_INFINITY : row.layer.value
    case 'n_par':
      return row.n_par
    case 'pesto':
      return row.change.pesto?.mean_change_pct ?? null
    case 'pestpp':
      return row.change.pestpp.mean_change
    case 'sigma':
      return row.sigma_ratio.state === 'refused' ? null : row.sigma_ratio.median
  }
}

// Stable over the order the server sent, which is the control file's: a tie keeps its place both ways.
function sortedGroups(
  groups: readonly ParGroupRow[],
  sort: { key: SortKey; direction: SortDirection } | null,
): ParGroupRow[] {
  if (sort === null) return [...groups]
  const sign = sort.direction === 'ascending' ? 1 : -1
  return groups
    .map((row, index) => ({ row, index, value: sortValue(row, sort.key) }))
    .sort((a, b) => {
      if (a.value === null || b.value === null) {
        if (a.value === b.value) return a.index - b.index
        return a.value === null ? 1 : -1
      }
      if (a.value === b.value) return a.index - b.index
      return (a.value < b.value ? -1 : 1) * sign
    })
    .map((entry) => entry.row)
}

function renderGroupRow(
  row: ParGroupRow,
  chosen: boolean,
  offMap: { note: string | null } | null,
  pick: (group: string) => void,
): HTMLElement {
  const rowEl = document.createElement('div')
  rowEl.classList.add('group-row')
  rowEl.setAttribute('role', 'row')
  rowEl.setAttribute('aria-selected', String(chosen))
  rowEl.tabIndex = 0
  rowEl.dataset.group = row.group
  const groupEl = groupCell('group', row.group, row.group, ['truncate'])
  if (offMap !== null) {
    // The name keeps its own span so the second line sits under it.
    groupEl.textContent = ''
    groupEl.classList.remove('truncate')
    groupEl.classList.add('group-name-cell')
    const name = document.createElement('span')
    name.classList.add('truncate')
    name.textContent = row.group
    groupEl.appendChild(name)
    const marker = document.createElement('span')
    marker.classList.add('label')
    marker.textContent = 'not on the map'
    groupEl.appendChild(marker)
    if (offMap.note !== null) {
      const note = document.createElement('span')
      // One line in the row; the full note is in the title and in the unmapped list below.
      note.classList.add('label', 'wrap-note', 'group-row-note')
      note.textContent = offMap.note
      note.title = offMap.note
      groupEl.appendChild(note)
    }
  }
  rowEl.appendChild(groupEl)
  rowEl.appendChild(groupCell('type', typeText(row), withSource(row.type.source, row.type.note), ['truncate']))
  rowEl.appendChild(groupCell('layer', layerText(row), withSource(row.layer.source, row.layer.note)))
  rowEl.appendChild(groupCell('n_par', String(row.n_par), parCountTitle(row), ['tabular-nums']))
  rowEl.appendChild(groupCell('pesto', pestoText(row), pestoTitle(row), ['tabular-nums']))
  rowEl.appendChild(groupCell('pestpp', pestppText(row), pestppTitle(row), ['tabular-nums']))
  rowEl.appendChild(groupCell('sigma', sigmaText(row), sigmaTitle(row), ['tabular-nums']))
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
  // The detail asks the server only for a group that is chosen while the tab is shown.
  let detailPending = false
  let drawnFor: string | null = null
  let detailHandle: DetailHandle | null = null
  let parameterHandle: DetailHandle | null = null
  let selectedParameter: string | null = null
  type ChangeState =
    | { kind: 'none'; reason: string }
    | { kind: 'loading' }
    | { kind: 'ready'; byName: Map<string, ParChangeRow> }
  const NO_CHANGE = 'the change figures are not loaded'
  let changeState: ChangeState = { kind: 'none', reason: NO_CHANGE }
  const histSlot = new LatestWins<ParHistResult>()
  const changeSlot = new LatestWins<ParChangeResult>()
  const valuesSlot = new LatestWins<ParValuesResult>()
  const blocked = opts.parView !== undefined && !opts.parView.available ? opts.parView : null
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

  const detailHost = document.createElement('div')
  detailHost.classList.add('params-detail-host')
  makeFocusable(detailHost, 'Group detail')
  el.appendChild(detailHost)

  const tableHost = document.createElement('div')
  tableHost.classList.add('params-table')
  el.appendChild(tableHost)

  const parameterHost = document.createElement('div')
  parameterHost.classList.add('params-detail-host')
  makeFocusable(parameterHost, 'Parameter detail')
  el.appendChild(parameterHost)

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

  const offMap = new Map(opts.unmapped.map((entry) => [entry.group, entry.note]))
  let sort: { key: SortKey; direction: SortDirection } | null = null
  let groupsPane: HTMLElement | null = null

  function fillRows(): void {
    if (groups === null || groupsPane === null) return
    groupsPane.textContent = ''
    const chosen = chosenGroups()
    for (const row of sortedGroups(groups.groups, sort)) {
      const note = offMap.get(row.group)
      groupsPane.appendChild(
        renderGroupRow(row, chosen.has(row.group), note === undefined ? null : { note }, pick),
      )
    }
  }

  function markHeadings(): void {
    for (const heading of groupsHost.querySelectorAll<HTMLElement>('.group-header [role="columnheader"]')) {
      const mine = sort !== null && heading.dataset.column === sort.key
      heading.setAttribute('aria-sort', mine ? sort!.direction : 'none')
      const mark = heading.querySelector('.sort-mark')
      if (mark) mark.textContent = mine ? (sort!.direction === 'ascending' ? '↑' : '↓') : ''
    }
  }

  function sortBy(key: SortKey): void {
    sort = sort !== null && sort.key === key
      ? { key, direction: sort.direction === 'ascending' ? 'descending' : 'ascending' }
      : { key, direction: 'ascending' }
    markHeadings()
    fillRows()
  }

  function renderGroups(): void {
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
      heading.setAttribute('aria-sort', 'none')
      heading.dataset.column = column
      const button = document.createElement('button')
      button.type = 'button'
      button.classList.add('label', 'sort-button')
      const text = document.createElement('span')
      text.textContent = label
      const mark = document.createElement('span')
      mark.classList.add('sort-mark')
      mark.setAttribute('aria-hidden', 'true')
      button.appendChild(text)
      button.appendChild(mark)
      button.addEventListener('click', () => sortBy(column))
      heading.appendChild(button)
      header.appendChild(heading)
    }
    grid.appendChild(header)

    const pane = document.createElement('div')
    pane.classList.add('scroll-pane')
    makeFocusable(pane, 'Parameter groups')
    grid.appendChild(pane)
    groupsPane = pane
    groupsHost.appendChild(grid)
    fillRows()
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
          renderGroups()
        } else {
          renderGroupsFailure(answer.artifact, answer.reason)
        }
        renderDetail()
        refreshGroupDetail()
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
    const refused = (groups?.groups ?? []).filter((row) => chosen.has(row.group) && !row.drill_down.offered)
    if (refused.length > 0) {
      const reasons = refused.map((row) => row.drill_down.reason ?? 'no reason was recorded')
      renderNotice(tableHost, {
        title: 'No parameter list for this group',
        detail: refused.length === 1 ? reasons[0] : refused.map((row, i) => `${row.group}: ${reasons[i]}`).join(' '),
        tone: 'info',
      })
      return
    }
    const shown = rows.filter((row) => chosen.has(row.pargp))
    redrawTable = renderTable(tableHost, shown, () => hidden, changeFor, () => opts.store.get().pars, pickParameter)
  }

  function changeFor(parnme: string): ChangeRowState {
    if (changeState.kind === 'loading') return { kind: 'loading' }
    if (changeState.kind === 'none') return { kind: 'none', reason: changeState.reason }
    const change = changeState.byName.get(parnme)
    return change === undefined ? { kind: 'ready', found: false } : { kind: 'ready', found: true, change }
  }

  function dropDetail(): void {
    histSlot.cancel()
    changeSlot.cancel()
    detailHandle?.destroy()
    detailHandle = null
    detailHost.textContent = ''
    drawnFor = null
  }

  function dropParameter(): void {
    valuesSlot.cancel()
    parameterHandle?.destroy()
    parameterHandle = null
    parameterHost.textContent = ''
    selectedParameter = null
  }

  function setChange(result: ParChangeResult): void {
    if (result.ok) {
      changeState = { kind: 'ready', byName: new Map(result.payload.map((change) => [change.parnme, change])) }
    } else {
      changeState = { kind: 'none', reason: `${result.artifact}: ${result.reason}` }
      parameterHost.textContent = ''
      renderNotice(parameterHost, {
        title: 'The change figures could not be read',
        detail: `${result.artifact}: ${result.reason}`,
        tone: 'warning',
      })
    }
    if (!hidden) redrawTable?.()
  }

  function drawGroup(base: GroupDetailBase, hist: ParHistResult): void {
    detailHandle?.destroy()
    detailHandle = renderGroupDetail(detailHost, { ...base, hist })
  }

  // One group at a time: a hidden panel only notes the choice, and each fetch
  // goes through its own slot so an older answer is never drawn.
  function refreshGroupDetail(): void {
    if (hidden) {
      detailPending = true
      return
    }
    detailPending = false
    if (blocked !== null) {
      const why = blocked.blockedBy.map((entry) => `${entry.artifact}: ${entry.reason}`).join(' ')
      dropDetail()
      renderNotice(detailHost, {
        title: 'The parameter view is not available',
        detail: why === '' ? 'no reason was recorded' : why,
        tone: 'serious',
      })
      changeState = { kind: 'none', reason: why === '' ? 'the parameter view is not available' : why }
      return
    }
    const chosen = [...chosenGroups()]
    if (chosen.length === 0) {
      dropDetail()
      return
    }
    if (chosen.length > 1) {
      dropDetail()
      renderNotice(detailHost, { title: 'Choose one group to see its histograms and change', tone: 'info' })
      return
    }
    const group = chosen[0]
    if (groups === null || drawnFor === group) return
    const row = groups.groups.find((entry) => entry.group === group)
    if (row === undefined) {
      dropDetail()
      renderNotice(detailHost, {
        title: 'No detail for this group',
        detail: `the group summary holds no group named ${group}`,
        tone: 'info',
      })
      return
    }
    dropDetail()
    drawnFor = group
    const base: GroupDetailBase = {
      row,
      single: groups.single_iteration,
      left_out: groups.left_out,
      reinflationNotes: groups.reinflation?.notes,
      isHidden: () => hidden,
    }
    detailHandle = renderGroupDetail(detailHost, { ...base, hist: null })
    void histSlot.run(group, (signal) => fetchParHist(group, { signal })).then(
      (result) => {
        if (!result.stale) drawGroup(base, result.value)
      },
      (error: unknown) => drawGroup(base, { ok: false, ...describeFailure(error, 'par_hist') }),
    )

    if (row.drill_down.offered) {
      changeState = { kind: 'loading' }
      if (!hidden) redrawTable?.()
      void changeSlot.run(group, (signal) => fetchParChange(group, { signal })).then(
        (result) => {
          if (!result.stale) setChange(result.value)
        },
        (error: unknown) => setChange({ ok: false, ...describeFailure(error, 'par_change') }),
      )
    } else {
      changeState = { kind: 'none', reason: row.drill_down.reason ?? 'drill-down is not offered for this group' }
    }
  }

  function drawParameter(parameter: string, values: ParValuesResult): void {
    parameterHandle?.destroy()
    parameterHandle = renderParameterDetail(parameterHost, { parameter, values, isHidden: () => hidden })
  }

  // The parameter the detail should follow after a click, given the pars it leaves.
  function detailAfter(clicked: string, pars: ReadonlySet<string>): string | null {
    if (pars.has(clicked)) return clicked
    if (selectedParameter !== null && pars.has(selectedParameter)) return selectedParameter
    if (rows === null || pars.size === 0) return null
    for (let i = rows.length - 1; i >= 0; i--) {
      if (pars.has(rows[i].parnme)) return rows[i].parnme
    }
    return null
  }

  // Every parameter click, in the table or the selected list, goes through the one modifier rule (D-01).
  function pickParameter(parameter: string, event: MouseEvent | KeyboardEvent): void {
    const next = selectPars(opts.store.get(), [parameter], modeOf(event))
    opts.store.set({ pars: next.pars }, 'params')
    const follow = detailAfter(parameter, next.pars)
    if (!hidden) redrawTable?.()
    if (follow === null) {
      dropParameter()
      return
    }
    if (follow !== selectedParameter) showParameter(follow)
  }

  function showParameter(parameter: string): void {
    if (blocked !== null) return
    selectedParameter = parameter
    parameterHandle?.destroy()
    parameterHandle = null
    parameterHost.textContent = ''
    const loading = document.createElement('div')
    loading.classList.add('label')
    loading.style.color = 'var(--ink-muted)'
    loading.textContent = 'Loading distribution…'
    parameterHost.appendChild(loading)
    void valuesSlot.run(parameter, (signal) => fetchParValues(parameter, { signal })).then(
      (result) => {
        if (!result.stale) drawParameter(parameter, result.value)
      },
      (error: unknown) => drawParameter(parameter, { ok: false, ...describeFailure(error, 'par_change') }),
    )
  }

  // A new choice drops everything drawn for the old one.
  function selectionChanged(): void {
    changeState = { kind: 'none', reason: NO_CHANGE }
    drawnFor = null
    dropParameter()
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
      selectionChanged()
      renderDetail()
      refreshGroupDetail()
    },
  )

  // Any view's pars change only redraws the marks; drawing never writes back.
  const unsubscribePars = opts.store.subscribe(
    (selection) => selection.pars,
    () => {
      if (!hidden) redrawTable?.()
    },
  )

  renderUnmappedSection(el, opts.unmapped)
  renderNotesSection(el, opts.artifactNotes)

  if (!hidden) requestGroups()

  return {
    onHide() {
      hidden = true
      detailHandle?.onHide()
      parameterHandle?.onHide()
      savedScroll.clear()
      for (const pane of el.querySelectorAll('.scroll-pane')) savedScroll.set(pane, pane.scrollTop)
    },
    onShow() {
      hidden = false
      requestGroups()
      for (const [pane, top] of savedScroll) pane.scrollTop = top
      savedScroll.clear()
      redrawTable?.()
      // A choice made while hidden is fetched now; otherwise the canvases redraw at their real size.
      if (detailPending) refreshGroupDetail()
      else detailHandle?.onShow()
      parameterHandle?.onShow()
    },
    dispose() {
      unsubscribe()
      unsubscribePars()
      histSlot.cancel()
      changeSlot.cancel()
      valuesSlot.cancel()
      detailHandle?.destroy()
      parameterHandle?.destroy()
    },
  }
}
