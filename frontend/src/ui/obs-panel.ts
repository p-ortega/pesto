// The Obs panel: the selected sites on top, then the group summary, the chosen
// group's site list and its site plots, and the group fit last. It copies the Params panel's frame --
// one windowed table, a hidden tab that fetches and draws nothing, names
// written through textContent only. A click writes the shared selection with
// the origin 'obs'; this file never reads a site by row position.

import { ApiError } from '../data/client'
import { LatestWins } from '../data/latest-wins'
import {
  fetchObsGroups,
  fetchObsSites,
  shareRead,
  TABLE_RMSE_LABEL,
  type ObsGroupRow,
  type ObsGroupsResult,
  type ObsSiteRow,
  type ObsSitesResult,
} from '../data/obs'
import type { Capability, IngestState } from '../data/client'
import { isDimmed } from '../data/dim'
import { layerCompact } from '../data/layer-words'
import { fetchPdcSites, type PdcSitesAnswer, type PdcSitesResult } from '../data/overlays'
import { modeOf, removeKeyName } from '../state/modifiers'
import { selectSites } from '../state/rules'
import type { SelectionStore } from '../state/selection'
import { makeFocusable, renderNotice } from './chrome'
import { renderGroupFit } from './obs-fit'
import { LAYER_HEADING_TITLE, renderSelectedSites } from './obs-selected'
import { renderSpaghetti } from './obs-spaghetti'
import { paintNote } from './note-line'

export interface ObsPanelOptions {
  store: SelectionStore
  capabilities: IngestState['capabilities']
  /** True when the tab is not the open one: nothing is fetched until onShow. */
  startHidden?: boolean
  /** Reads the group summary. Without one the panel keeps its own shared read. */
  loadGroups?: () => Promise<ObsGroupsResult>
}

export interface ObsPanelHandle {
  /** The right end of the heading row, for controls that act on the Obs plots, such as Select base. */
  headingActions: HTMLElement
  /** Fetches the group summary the first time and redraws the windowed lists at their real height. */
  onShow(): void
  /** Remembers the scroll positions and stops scroll-driven redraws. */
  onHide(): void
  /** Stops following the shared selection. */
  dispose(): void
}

// Fixed row height in px: the spacer's total height is what lets the scrollbar
// tell the truth about thousands of rows without placing them all in the DOM.
const ROW_HEIGHT = 24
const OVERSCAN = 20
const VIEWPORT_HEIGHT = 240

const NO_FIGURE = '—'
const NO_RESIDUAL = 'no observation in this group has a residual at this iteration'

interface GridColumn<T> {
  key: string
  label: string
  /** 'name' takes the stretch, 'figure' is a right-aligned number, 'text' a short word. */
  kind: 'name' | 'figure' | 'text'
  text(row: T): string
  title?(row: T): string
  /** What the column sorts on. null means no value and always sorts last. Without it the column is not sortable. */
  sortValue?(row: T): string | number | null
  /** The heading's tooltip; read again on every refresh. */
  headingTitle?(): string
  /** Adds marks to a drawn cell after its text is set. */
  decorate?(cell: HTMLElement, row: T): void
}

type SortDirection = 'ascending' | 'descending'

interface GridOptions<T> {
  ariaLabel: string
  dataKey: string
  columns: GridColumn<T>[]
  rowId(row: T): string
  isSelected(row: T): boolean
  /** A drawn row that answers true is drawn faint; it stays in the list and stays clickable. */
  isDimmed?(row: T): boolean
  pick(row: T, event: MouseEvent | KeyboardEvent): void
  isHidden(): boolean
}

interface Grid<T> {
  el: HTMLElement
  pane: HTMLElement
  setRows(rows: readonly T[]): void
  redraw(): void
  /** Re-reads which rows are chosen and which are dimmed, without rebuilding them. */
  markRows(): void
  /** Position in the shown order of the first chosen row, or -1. */
  firstSelected(): number
  /** Scrolls so the row at `index` of the shown order is at the top. */
  scrollToIndex(index: number): void
  /** Re-sorts and redraws after a column's figures changed, and re-reads the heading titles. */
  refresh(): void
}

function describeFailure(error: unknown, fallback: string): { artifact: string; reason: string } {
  if (error instanceof ApiError) {
    return { artifact: error.problem.artifact ?? fallback, reason: error.problem.detail ?? error.problem.title }
  }
  return { artifact: fallback, reason: error instanceof Error ? error.message : String(error) }
}

function appendCell<T>(rowEl: HTMLElement, column: GridColumn<T>, row: T): void {
  const cell = document.createElement('span')
  cell.setAttribute('role', 'gridcell')
  cell.dataset.column = column.key
  cell.classList.add('obs-col', `obs-col-${column.kind}`)
  if (column.kind === 'name') cell.classList.add('body', 'truncate')
  else if (column.kind === 'figure') cell.classList.add('tabular-nums')
  // A wrapped text cell ran over the rows below it; the full text stays in the title.
  else cell.classList.add('truncate')
  cell.textContent = column.text(row)
  const title = column.title ? column.title(row) : column.kind === 'figure' ? '' : column.text(row)
  if (title !== '') cell.title = title
  column.decorate?.(cell, row)
  rowEl.appendChild(cell)
}

// A virtual scroll over a `.scroll-pane`: the spacer is sized to every row, and
// only the rows a scroll position exposes (plus a small overscan) are placed.
function createGrid<T>(opts: GridOptions<T>): Grid<T> {
  const el = document.createElement('div')
  el.setAttribute('role', 'grid')
  el.setAttribute('aria-label', opts.ariaLabel)
  el.classList.add('obs-grid')

  const header = document.createElement('div')
  header.classList.add('obs-grid-header')
  header.setAttribute('role', 'row')
  let sort: { key: string; direction: SortDirection } | null = null
  const headings = new Map<string, HTMLElement>()
  for (const column of opts.columns) {
    const heading = document.createElement('span')
    heading.setAttribute('role', 'columnheader')
    heading.dataset.column = column.key
    heading.classList.add('obs-col', `obs-col-${column.kind}`)
    if (column.sortValue === undefined) {
      heading.classList.add('label')
      heading.textContent = column.label
    } else {
      heading.setAttribute('aria-sort', 'none')
      const button = document.createElement('button')
      button.type = 'button'
      button.classList.add('label', 'sort-button')
      const text = document.createElement('span')
      text.textContent = column.label
      const mark = document.createElement('span')
      mark.classList.add('sort-mark')
      mark.setAttribute('aria-hidden', 'true')
      button.appendChild(text)
      button.appendChild(mark)
      button.addEventListener('click', () => sortBy(column))
      heading.appendChild(button)
    }
    headings.set(column.key, heading)
    header.appendChild(heading)
  }
  el.appendChild(header)

  function titleHeadings(): void {
    for (const column of opts.columns) {
      if (column.headingTitle === undefined) continue
      headings.get(column.key)!.title = column.headingTitle()
    }
  }
  titleHeadings()

  const pane = document.createElement('div')
  pane.classList.add('scroll-pane')
  pane.style.position = 'relative'
  makeFocusable(pane, opts.ariaLabel)
  const spacer = document.createElement('div')
  spacer.style.position = 'relative'
  const rowsHost = document.createElement('div')
  spacer.appendChild(rowsHost)
  pane.appendChild(spacer)
  el.appendChild(pane)

  let source: readonly T[] = []
  let rows: readonly T[] = []
  const rowOf = new WeakMap<HTMLElement, T>()

  function markRow(rowEl: HTMLElement, row: T): void {
    rowEl.setAttribute('aria-selected', String(opts.isSelected(row)))
    rowEl.classList.toggle('dimmed', opts.isDimmed?.(row) === true)
  }

  function renderVisible(): void {
    rowsHost.textContent = ''
    const firstIndex = Math.max(0, Math.floor(pane.scrollTop / ROW_HEIGHT) - OVERSCAN)
    const rowBudget = Math.ceil((pane.clientHeight || VIEWPORT_HEIGHT) / ROW_HEIGHT) + OVERSCAN * 2
    const lastIndex = Math.min(rows.length, firstIndex + rowBudget)
    for (let i = firstIndex; i < lastIndex; i++) {
      const row = rows[i]
      const rowEl = document.createElement('div')
      rowEl.classList.add('obs-grid-row')
      rowEl.setAttribute('role', 'row')
      rowEl.style.position = 'absolute'
      rowEl.style.top = `${i * ROW_HEIGHT}px`
      rowEl.style.left = '0'
      rowEl.style.right = '0'
      rowEl.tabIndex = 0
      rowEl.dataset[opts.dataKey] = opts.rowId(row)
      markRow(rowEl, row)
      for (const column of opts.columns) appendCell(rowEl, column, row)
      rowOf.set(rowEl, row)
      rowEl.addEventListener('click', (event) => opts.pick(row, event))
      rowEl.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          opts.pick(row, event)
        }
      })
      rowsHost.appendChild(rowEl)
    }
  }

  // Stable over the server's order: a tie keeps its place both ways, and no value sorts last both ways.
  function sorted(): readonly T[] {
    const column = sort === null ? undefined : opts.columns.find((c) => c.key === sort!.key)
    if (sort === null || column?.sortValue === undefined) return source
    const sign = sort.direction === 'ascending' ? 1 : -1
    const valueOf = column.sortValue
    return source
      .map((row, index) => ({ row, index, value: valueOf(row) }))
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

  function markHeadings(): void {
    for (const [key, heading] of headings) {
      const mine = sort !== null && sort.key === key
      if (heading.getAttribute('aria-sort') === null) continue
      heading.setAttribute('aria-sort', mine ? sort!.direction : 'none')
      const mark = heading.querySelector('.sort-mark')
      if (mark) mark.textContent = mine ? (sort!.direction === 'ascending' ? '↑' : '↓') : ''
    }
  }

  function sortBy(column: GridColumn<T>): void {
    sort =
      sort !== null && sort.key === column.key
        ? { key: column.key, direction: sort.direction === 'ascending' ? 'descending' : 'ascending' }
        : { key: column.key, direction: 'ascending' }
    markHeadings()
    rows = sorted()
    if (!opts.isHidden()) renderVisible()
  }

  // A hidden panel draws nothing; showing it again redraws once.
  pane.addEventListener('scroll', () => {
    if (!opts.isHidden()) renderVisible()
  })

  return {
    el,
    pane,
    setRows(next) {
      source = next
      rows = sorted()
      spacer.style.height = `${rows.length * ROW_HEIGHT}px`
      if (!opts.isHidden()) renderVisible()
    },
    redraw: renderVisible,
    markRows() {
      for (const rowEl of rowsHost.querySelectorAll<HTMLElement>('.obs-grid-row')) {
        const row = rowOf.get(rowEl)
        if (row !== undefined) markRow(rowEl, row)
      }
    },
    firstSelected() {
      return rows.findIndex((row) => opts.isSelected(row))
    },
    scrollToIndex(index) {
      pane.scrollTop = index * ROW_HEIGHT
      if (!opts.isHidden()) renderVisible()
    },
    refresh() {
      titleHeadings()
      rows = sorted()
      if (!opts.isHidden()) renderVisible()
    },
  }
}

function formatResidual(value: number): string {
  return value.toPrecision(4)
}

function commonIteration(rows: readonly ObsGroupRow[], pick: (row: ObsGroupRow) => number | null): number | null {
  const first = rows.length > 0 ? pick(rows[0]) : null
  return first !== null && rows.every((row) => pick(row) === first) ? first : null
}

function iterationSuffix(iteration: number | null): string {
  return iteration === null ? '' : ` (iteration ${iteration})`
}

function layerText(row: ObsSiteRow): string {
  return layerCompact(row.layer)
}

function placementText(row: ObsSiteRow): string {
  if (row.xySource === 'none') return 'not placed'
  return row.xySource === 'own' ? 'own position' : 'cell centre'
}

// The title says where the position came from, or why there is none.
function placementTitle(row: ObsSiteRow): string {
  const rule = `rule: ${row.rule}`
  if (row.xySource === 'none') return row.note ?? `no position (${rule})`
  return row.note === null ? rule : `${rule}; ${row.note}`
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

// What the conflict columns show: nothing asked yet, an answer on its way, an answer, or why there is none.
type PdcState =
  | { kind: 'waiting'; iteration: number }
  | { kind: 'answer'; answer: PdcSitesAnswer }
  | { kind: 'off'; iteration: number; reason: string; refused: boolean }

function pdcSourceText(answer: PdcSitesAnswer): string {
  if (answer.source === 'file') return answer.sourceFile === null ? "from pestpp's pdc file" : `from pestpp's pdc file (${answer.sourceFile})`
  if (answer.source === 'computed') return `computed: ${answer.rule ?? 'no rule was recorded'}`
  return 'the source was not recorded'
}

// D-28, D-30: the source sits beside the count, and every row that matched nothing or was left out is counted.
function pdcHeadingTitle(state: PdcState | null): string {
  if (state === null) return 'prior-data conflict for the shown iteration'
  if (state.kind === 'waiting') return `asking for prior-data conflict at iteration ${state.iteration}`
  if (state.kind === 'off') return state.reason
  const { answer } = state
  const parts = [`prior-data conflict at iteration ${answer.iteration}, ${pdcSourceText(answer)}`]
  if (answer.nUnmatched !== null && answer.nUnmatched > 0) {
    parts.push(answer.nUnmatched === 1 ? '1 pdc row matches no observation' : `${answer.nUnmatched} pdc rows match no observation`)
  }
  if (answer.nLeftOut !== null && answer.nLeftOut > 0) {
    parts.push(`${plural(answer.nLeftOut, 'row', 'rows')} left out: a simulated range holds a sentinel`)
  }
  parts.push(...answer.notes)
  return parts.join('; ')
}

const SITE_COLUMNS_REST: GridColumn<ObsSiteRow>[] = [
  { key: 'n_obs', label: 'Observations', kind: 'figure', text: (r) => String(r.nObs) },
  {
    key: 'layer',
    label: 'Layer',
    kind: 'figure',
    text: layerText,
    title: (r) => (r.layer === -1 ? 'no layer could be worked out for this site' : ''),
    headingTitle: () => LAYER_HEADING_TITLE,
  },
  { key: 'placement', label: 'Placement', kind: 'text', text: placementText, title: placementTitle },
]

function blockedReason(capability: Capability): string {
  const why = capability.blockedBy.map((entry) => `${entry.artifact}: ${entry.reason}`).join(' ')
  return why === '' ? 'no reason was recorded' : why
}

// D-04: each capability that is off says why, naming the artifact; a note on one that is on is shown too.
const CAPABILITY_NOTICES: { key: 'obs' | 'obsStats' | 'noise'; title: string }[] = [
  { key: 'obs', title: 'Observations are not available' },
  { key: 'obsStats', title: 'Observation statistics are not available' },
  { key: 'noise', title: 'The noise band is not available' },
]

function renderCapabilityNotices(host: HTMLElement, capabilities: IngestState['capabilities']): void {
  host.textContent = ''
  for (const { key, title } of CAPABILITY_NOTICES) {
    const capability = capabilities[key]
    if (capability === undefined) continue
    if (!capability.available) {
      const item = document.createElement('div')
      item.dataset.capability = key
      renderNotice(item, { title, detail: blockedReason(capability), tone: 'warning' })
      host.appendChild(item)
    }
    for (const note of capability.notes ?? []) appendNote(host, note)
  }
}

function appendNote(host: HTMLElement, note: string): void {
  const line = document.createElement('div')
  line.classList.add('label', 'wrap-note')
  line.textContent = note
  host.appendChild(line)
}

/**
 * Fills `host` with the Obs panel. The panel's sections, top to bottom, are
 * `.obs-heading-row`, `.obs-notices`, `.obs-selected`, `.obs-groups`, `.obs-sites`,
 * `.obs-spaghetti` and `.obs-fit`, so a picked site's plot sits right under the list
 * it was picked from. The fit host stays empty until a group is chosen.
 */
export function renderObsPanel(host: HTMLElement, opts: ObsPanelOptions): ObsPanelHandle {
  host.textContent = ''
  host.classList.add('surface', 'obs-panel')

  let hidden = opts.startHidden === true
  const loadGroups = opts.loadGroups ?? shareRead(() => fetchObsGroups())
  const blocked = opts.capabilities.obs !== undefined && !opts.capabilities.obs.available
  const statsOff = opts.capabilities.obsStats !== undefined && !opts.capabilities.obsStats.available ? opts.capabilities.obsStats : null
  // A browser drops the scroll offset of a box that is not displayed, so the offsets are kept here while hidden.
  const savedScroll = new Map<Element, number>()

  const headingRow = document.createElement('div')
  headingRow.classList.add('obs-heading-row')
  const title = document.createElement('div')
  title.classList.add('heading')
  title.textContent = 'Obs'
  const headingActions = document.createElement('div')
  headingActions.classList.add('obs-heading-actions')
  headingRow.appendChild(title)
  headingRow.appendChild(headingActions)
  host.appendChild(headingRow)

  function section(name: string): HTMLElement {
    const el = document.createElement('div')
    el.classList.add(name)
    host.appendChild(el)
    return el
  }
  const noticesHost = section('obs-notices')
  const selectedHost = section('obs-selected')
  const groupsHost = section('obs-groups')
  const sitesHost = section('obs-sites')
  const spaghettiHost = section('obs-spaghetti')
  const fitHost = section('obs-fit')

  renderCapabilityNotices(noticesHost, opts.capabilities)
  const selected = renderSelectedSites(selectedHost, {
    store: opts.store,
    isHidden: () => hidden,
    onPick: (siteId, event) => pickSiteId(siteId, event),
  })
  const fit = renderGroupFit(fitHost, { store: opts.store, startHidden: hidden })
  const spaghetti = renderSpaghetti(spaghettiHost, { store: opts.store, startHidden: hidden })

  let chosenGroup: string | null = null
  let groupsRequested = false
  let groupsGrid: Grid<ObsGroupRow> | null = null
  let groupNames: ReadonlySet<string> | null = null
  let sitesGrid: Grid<ObsSiteRow> | null = null
  // The group whose sites were asked for, and whether a choice made while hidden is still to be followed.
  let sitesFor: string | null = null
  let sitesPending = false
  const sitesSlot = new LatestWins<ObsSitesResult>()

  function renderSitePrompt(): void {
    sitesGrid = null
    showSelectedButton = null
    renderNotice(sitesHost, { title: 'Click a group above to list its sites.', tone: 'info' })
  }

  function renderSitesFailure(artifact: string, reason: string): void {
    sitesGrid = null
    showSelectedButton = null
    sitesFor = null
    renderNotice(sitesHost, { title: 'The site list could not be read', detail: `${artifact}: ${reason}`, tone: 'serious' })
  }

  let showSelectedButton: HTMLButtonElement | null = null

  const pdcCapability = opts.capabilities.pdc
  const pdcOff = pdcCapability !== undefined && !pdcCapability.available ? pdcCapability : null
  const pdcSlot = new LatestWins<PdcSitesResult>()
  let pdc: PdcState | null = null
  // The iteration the conflict columns were asked for; null asks again on the next show.
  let pdcFor: number | null = null
  let conflicted = new Map<number, number>()
  const pdcNote = document.createElement('div')
  pdcNote.classList.add('label', 'wrap-note')

  const siteColumns: GridColumn<ObsSiteRow>[] = [
    {
      key: 'site',
      label: 'Site',
      kind: 'name',
      text: (r) => r.site,
      decorate: (cell, row) => {
        const n = conflicted.get(row.siteId)
        if (n === undefined || pdc?.kind !== 'answer') return
        const mark = document.createElement('span')
        mark.classList.add('conflict-mark')
        mark.setAttribute('role', 'img')
        mark.title = `prior-data conflict at iteration ${pdc.answer.iteration}: ${plural(n, 'observation', 'observations')}`
        mark.setAttribute('aria-label', mark.title)
        cell.appendChild(mark)
      },
    },
    ...SITE_COLUMNS_REST,
  ]

  function setPdc(state: PdcState): void {
    pdc = state
    conflicted = new Map()
    if (state.kind === 'answer') {
      const { id, nObs } = state.answer.sites
      // A site listed under more than one group adds up.
      for (let i = 0; i < id.length; i++) conflicted.set(id[i], (conflicted.get(id[i]) ?? 0) + nObs[i])
    }
    pdcNote.textContent = state.kind === 'off' && state.refused ? state.reason : ''
    groupsGrid?.refresh()
    if (!hidden) sitesGrid?.redraw()
  }

  // D-23: the columns follow the shown iteration only, and say why when it has no answer.
  function requestPdc(): void {
    if (hidden || blocked) return
    const iteration = opts.store.get().iteration
    if (pdcFor === iteration) return
    pdcFor = iteration
    if (pdcOff !== null) {
      setPdc({ kind: 'off', iteration, reason: blockedReason(pdcOff), refused: false })
      return
    }
    setPdc({ kind: 'waiting', iteration })
    const refuse = (reason: string): void => {
      pdcFor = null
      setPdc({ kind: 'off', iteration, reason: `pdc: ${reason}`, refused: true })
    }
    void pdcSlot.run(String(iteration), (signal) => fetchPdcSites(iteration, { signal })).then(
      (result) => {
        if (result.stale) return
        const value = result.value
        if (!value.ok) refuse(value.reason)
        else if (value.answer.iteration !== iteration) refuse(`the answer was for iteration ${value.answer.iteration}, not ${iteration}`)
        else if (!value.answer.available) {
          const reason = value.answer.reason ?? `no prior-data conflict for iteration ${iteration}; no reason was given`
          setPdc({ kind: 'off', iteration, reason, refused: false })
        } else setPdc({ kind: 'answer', answer: value.answer })
      },
      (error: unknown) => {
        const { artifact, reason } = describeFailure(error, `pdc/${iteration}`)
        refuse(`${artifact}: ${reason}`)
      },
    )
  }

  // D-01: the one modifier rule, so this list never does its own set arithmetic.
  function pickSiteId(siteId: number, event: MouseEvent | KeyboardEvent): void {
    const next = selectSites(opts.store.get(), [siteId], modeOf(event))
    opts.store.set({ sites: next.sites }, 'obs')
    markSites()
  }

  function markSites(): void {
    sitesGrid?.markRows()
    if (showSelectedButton === null || sitesGrid === null) return
    const none = sitesGrid.firstSelected() === -1
    showSelectedButton.disabled = none
    showSelectedButton.title = none ? 'no selected site is in this group' : 'scroll to the first selected site in this list'
  }

  function renderSites(group: string, rows: readonly ObsSiteRow[], notes: readonly string[]): void {
    sitesHost.textContent = ''
    // The count and the button share one line; the count gives way first.
    const heading = document.createElement('div')
    heading.classList.add('obs-sites-title')
    heading.style.display = 'flex'
    heading.style.alignItems = 'baseline'
    heading.style.gap = 'var(--space-sm)'
    const count = document.createElement('span')
    count.classList.add('body', 'obs-sites-count', 'truncate')
    count.style.fontWeight = '600'
    count.style.flex = '1 1 auto'
    count.style.minWidth = '0'
    count.appendChild(document.createTextNode(`Sites in ${group} · `))
    const figure = document.createElement('span')
    figure.classList.add('tabular-nums')
    figure.textContent = String(rows.length)
    count.appendChild(figure)
    count.title = count.textContent ?? ''
    heading.appendChild(count)
    const show = document.createElement('button')
    show.type = 'button'
    show.classList.add('label')
    show.style.flex = 'none'
    show.textContent = 'Show selected'
    show.addEventListener('click', () => {
      const index = sitesGrid?.firstSelected() ?? -1
      if (index >= 0) sitesGrid?.scrollToIndex(index)
    })
    heading.appendChild(show)
    showSelectedButton = show
    sitesHost.appendChild(heading)
    // Users could not tell the list picks; the hint also says where the plot goes, since a pick never scrolls.
    const hint = document.createElement('div')
    hint.classList.add('label', 'wrap-note', 'obs-sites-hint')
    paintNote(hint, {
      kind: 'reason',
      text: `Click a site to select it and draw its plot below. Shift-click adds, ${removeKeyName()}-click removes.`,
    })
    sitesHost.appendChild(hint)
    if (notes.length > 0) {
      const noteBox = document.createElement('div')
      noteBox.classList.add('obs-site-notes', 'scroll-pane')
      makeFocusable(noteBox, 'Site list notes')
      for (const note of notes) appendNote(noteBox, note)
      sitesHost.appendChild(noteBox)
    }
    const grid = createGrid<ObsSiteRow>({
      ariaLabel: `Sites of ${group}`,
      dataKey: 'siteId',
      columns: siteColumns,
      rowId: (row) => String(row.siteId),
      isSelected: (row) => opts.store.get().sites.has(row.siteId),
      isDimmed: (row) => isDimmed(opts.store.get().sites, row.siteId),
      pick: (row, event) => pickSiteId(row.siteId, event),
      isHidden: () => hidden,
    })
    sitesGrid = grid
    sitesHost.appendChild(grid.el)
    grid.setRows(rows)
    markSites()
  }

  // One group at a time: each fetch goes through the same slot, so an older answer is never drawn.
  function loadSites(group: string): void {
    sitesFor = group
    sitesGrid = null
    showSelectedButton = null
    sitesHost.textContent = ''
    const loading = document.createElement('div')
    loading.classList.add('label')
    loading.style.color = 'var(--ink-muted)'
    loading.textContent = 'Loading sites…'
    sitesHost.appendChild(loading)
    void sitesSlot.run(group, (signal) => fetchObsSites(group, { signal })).then(
      (answer) => {
        if (answer.stale) return
        if (answer.value.ok) renderSites(group, answer.value.rows, answer.value.notes)
        else renderSitesFailure(answer.value.artifact, answer.value.reason)
      },
      (error: unknown) => {
        const { artifact, reason } = describeFailure(error, 'obs_cell')
        renderSitesFailure(artifact, reason)
      },
    )
  }

  // The first group of the shared selection that the table holds; any other choice is not this panel's to show.
  function followSelection(): void {
    if (groupNames === null) return
    const wanted = [...opts.store.get().obsGroups][0]
    if (wanted === undefined || !groupNames.has(wanted)) return
    chosenGroup = wanted
    groupsGrid?.markRows()
    fit.setGroup(wanted)
    if (hidden) {
      sitesPending = true
      return
    }
    sitesPending = false
    if (wanted !== sitesFor) loadSites(wanted)
  }

  function pickGroup(group: string): void {
    chosenGroup = group
    groupsGrid?.markRows()
    fit.setGroup(group)
    opts.store.set({ obsGroups: new Set([group]) }, 'obs')
    if (group !== sitesFor) loadSites(group)
  }

  function groupColumns(rows: readonly ObsGroupRow[]): GridColumn<ObsGroupRow>[] {
    const firstText = `${TABLE_RMSE_LABEL}, first${iterationSuffix(commonIteration(rows, (r) => r.firstIteration))}`
    const lastText = `${TABLE_RMSE_LABEL}, last${iterationSuffix(commonIteration(rows, (r) => r.lastIteration))}`
    // With the statistics off, a figure the server did send is not shown: the reason is.
    const rmse = (value: number | null): string => (value === null || statsOff !== null ? NO_FIGURE : formatResidual(value))
    const rmseTitle = (value: number | null, n: number): string => {
      if (statsOff !== null) return blockedReason(statsOff)
      return value === null ? NO_RESIDUAL : `${n} observations with a residual`
    }
    const rmseSort = (value: number | null): number | null => (statsOff !== null ? null : value)
    const conflictCount = (row: ObsGroupRow, key: 'nObs' | 'nSites'): number | null => {
      if (pdc?.kind !== 'answer') return null
      const entry = pdc.answer.byGroup.find((g) => g.group === row.group)
      return entry === undefined ? 0 : entry[key]
    }
    const conflictColumn = (key: 'nObs' | 'nSites', columnKey: string, label: string, noun: [string, string]): GridColumn<ObsGroupRow> => ({
      key: columnKey,
      label,
      kind: 'figure',
      text: (r) => {
        const n = conflictCount(r, key)
        return n === null ? NO_FIGURE : String(n)
      },
      title: (r) => {
        const n = conflictCount(r, key)
        if (n === null || pdc?.kind !== 'answer') return pdcHeadingTitle(pdc)
        return `${plural(n, noun[0], noun[1])} in prior-data conflict at iteration ${pdc.answer.iteration}`
      },
      sortValue: (r) => conflictCount(r, key),
      headingTitle: () => pdcHeadingTitle(pdc),
    })
    return [
      { key: 'group', label: 'Group', kind: 'name', text: (r) => r.group, sortValue: (r) => r.group },
      { key: 'n_obs', label: 'Observations', kind: 'figure', text: (r) => String(r.nObs), sortValue: (r) => r.nObs },
      { key: 'n_sites', label: 'Sites', kind: 'figure', text: (r) => String(r.nSites), sortValue: (r) => r.nSites },
      {
        key: 'n_placed',
        label: 'Placed sites',
        kind: 'figure',
        text: (r) => (r.nPlaced === null ? NO_FIGURE : String(r.nPlaced)),
        sortValue: (r) => r.nPlaced,
        title: (r) =>
          r.nPlaced === null ? 'the site positions (obs_cell) are not available' : `${r.nPlaced} of ${r.nSites} sites have a position`,
      },
      {
        key: 'n_weighted',
        label: 'Weighted',
        kind: 'figure',
        text: (r) => String(r.nWeighted),
        sortValue: (r) => r.nWeighted,
        title: (r) =>
          `${r.nWeighted} with a weight above zero; ${r.nZeroWeight} zero weight; ${r.nSentinel} sentinel value; ${r.nNoValue} with no value`,
      },
      {
        key: 'time_kind',
        label: 'Time kind',
        kind: 'text',
        text: (r) => r.timeKind,
        sortValue: (r) => r.timeKind,
        title: (r) => `${r.timeKind}; inequality: ${r.inequality}`,
      },
      {
        key: 'rmse_first',
        label: firstText,
        kind: 'figure',
        text: (r) => rmse(r.rmseFirst),
        title: (r) => rmseTitle(r.rmseFirst, r.nResidFirst),
        sortValue: (r) => rmseSort(r.rmseFirst),
      },
      {
        key: 'rmse_last',
        label: lastText,
        kind: 'figure',
        text: (r) => rmse(r.rmseLast),
        title: (r) => rmseTitle(r.rmseLast, r.nResidLast),
        sortValue: (r) => rmseSort(r.rmseLast),
      },
      conflictColumn('nObs', 'pdc_obs', 'Conflict obs', ['observation', 'observations']),
      conflictColumn('nSites', 'pdc_sites', 'Conflict sites', ['site', 'sites']),
    ]
  }

  function renderGroupsFailure(artifact: string, reason: string): void {
    groupsGrid = null
    renderNotice(groupsHost, {
      title: 'The group summary could not be read',
      detail: `${artifact}: ${reason}`,
      tone: 'serious',
    })
  }

  function renderGroups(rows: readonly ObsGroupRow[]): void {
    groupsHost.textContent = ''
    const grid = createGrid<ObsGroupRow>({
      ariaLabel: 'Observation groups',
      dataKey: 'group',
      columns: groupColumns(rows),
      rowId: (row) => row.group,
      isSelected: (row) => row.group === chosenGroup,
      pick: (row) => pickGroup(row.group),
      isHidden: () => hidden,
    })
    groupsGrid = grid
    groupsHost.appendChild(grid.el)
    grid.setRows(rows)
  }

  // The first show asks once; a hidden panel draws and fetches nothing.
  function requestGroups(): void {
    if (groupsRequested || blocked) return
    groupsRequested = true
    const loading = document.createElement('div')
    loading.classList.add('label')
    loading.style.color = 'var(--ink-muted)'
    loading.textContent = 'Loading groups…'
    groupsHost.textContent = ''
    groupsHost.appendChild(loading)
    void loadGroups().then(
      (answer) => {
        if (answer.ok) {
          groupNames = new Set(answer.rows.map((row) => row.group))
          for (const note of answer.notes) appendNote(noticesHost, note)
          renderGroups(answer.rows)
          followSelection()
        } else {
          groupsRequested = false
          renderGroupsFailure(answer.artifact, answer.reason)
        }
      },
      (error: unknown) => {
        groupsRequested = false
        const { artifact, reason } = describeFailure(error, 'obs_index')
        renderGroupsFailure(artifact, reason)
      },
    )
  }

  if (!blocked) renderSitePrompt()
  noticesHost.appendChild(pdcNote)
  if (!hidden) requestGroups()
  requestPdc()

  // A choice another view makes is followed; the panel's own echo is not.
  const unsubscribeGroups = opts.store.subscribe(
    (selection) => selection.obsGroups,
    (_next, _prev, origins) => {
      if (origins.size === 1 && origins.has('obs')) return
      followSelection()
    },
  )
  const unsubscribeSites = opts.store.subscribe(
    (selection) => selection.sites,
    () => markSites(),
  )
  // The section lists the selection itself, so the panel's own writes refresh it too.
  const unsubscribeSelected = opts.store.subscribe(
    (selection) => ({ sites: selection.sites, cells: selection.cells, iteration: selection.iteration }),
    () => selected.refresh(),
  )
  selected.refresh()
  const unsubscribeIteration = opts.store.subscribe(
    (selection) => selection.iteration,
    () => requestPdc(),
  )

  return {
    headingActions,
    onShow() {
      hidden = false
      spaghetti.onShow()
      fit.onShow()
      requestGroups()
      requestPdc()
      for (const [pane, top] of savedScroll) pane.scrollTop = top
      savedScroll.clear()
      groupsGrid?.redraw()
      sitesGrid?.redraw()
      selected.onShow()
      if (sitesPending) followSelection()
    },
    onHide() {
      hidden = true
      spaghetti.onHide()
      fit.onHide()
      savedScroll.clear()
      for (const pane of host.querySelectorAll('.scroll-pane')) savedScroll.set(pane, pane.scrollTop)
    },
    dispose() {
      unsubscribeGroups()
      unsubscribeSites()
      unsubscribeSelected()
      unsubscribeIteration()
      pdcSlot.cancel()
      selected.dispose()
      sitesSlot.cancel()
      fit.dispose()
      spaghetti.dispose()
    },
  }
}
