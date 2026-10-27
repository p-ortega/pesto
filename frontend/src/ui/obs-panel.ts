// The Obs panel: the observation group summary on top, the chosen group's
// plot areas and site list under it. It copies the Params panel's frame --
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
import type { SelectionStore } from '../state/selection'
import { makeFocusable, renderNotice } from './chrome'
import { renderSpaghetti } from './obs-spaghetti'

export interface ObsPanelOptions {
  store: SelectionStore
  capabilities: IngestState['capabilities']
  /** True when the tab is not the open one: nothing is fetched until onShow. */
  startHidden?: boolean
  /** Reads the group summary. Without one the panel keeps its own shared read. */
  loadGroups?: () => Promise<ObsGroupsResult>
}

export interface ObsPanelHandle {
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
}

type SortDirection = 'ascending' | 'descending'

interface GridOptions<T> {
  ariaLabel: string
  dataKey: string
  columns: GridColumn<T>[]
  rowId(row: T): string
  isSelected(row: T): boolean
  pick(row: T): void
  isHidden(): boolean
}

interface Grid<T> {
  el: HTMLElement
  pane: HTMLElement
  setRows(rows: readonly T[]): void
  redraw(): void
  /** Re-reads which rows are chosen without rebuilding them. */
  markRows(): void
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
  cell.textContent = column.text(row)
  const title = column.title ? column.title(row) : column.kind === 'name' ? column.text(row) : ''
  if (title !== '') cell.title = title
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
      rowEl.setAttribute('aria-selected', String(opts.isSelected(row)))
      for (const column of opts.columns) appendCell(rowEl, column, row)
      rowOf.set(rowEl, row)
      rowEl.addEventListener('click', () => opts.pick(row))
      rowEl.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          opts.pick(row)
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
        if (row !== undefined) rowEl.setAttribute('aria-selected', String(opts.isSelected(row)))
      }
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

const LAYER_UNKNOWN = 'unknown'

function layerText(row: ObsSiteRow): string {
  return row.layer === -1 ? LAYER_UNKNOWN : String(row.layer)
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

const SITE_COLUMNS: GridColumn<ObsSiteRow>[] = [
  { key: 'site', label: 'Site', kind: 'name', text: (r) => r.site },
  { key: 'n_obs', label: 'Observations', kind: 'figure', text: (r) => String(r.nObs) },
  { key: 'layer', label: 'Layer', kind: 'figure', text: layerText, title: (r) => (r.layer === -1 ? 'no layer could be worked out for this site' : '') },
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
 * `.obs-notices`, `.obs-groups`, `.obs-fit`, `.obs-sites` and `.obs-spaghetti`;
 * the fit host stays empty until its plan mounts into it.
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

  const title = document.createElement('div')
  title.classList.add('heading')
  title.textContent = 'Obs'
  host.appendChild(title)

  const noticesHost = document.createElement('div')
  noticesHost.classList.add('obs-notices')
  host.appendChild(noticesHost)
  renderCapabilityNotices(noticesHost, opts.capabilities)

  const groupsHost = document.createElement('div')
  groupsHost.classList.add('obs-groups')
  host.appendChild(groupsHost)

  const fitHost = document.createElement('div')
  fitHost.classList.add('obs-fit')
  host.appendChild(fitHost)

  const sitesHost = document.createElement('div')
  sitesHost.classList.add('obs-sites')
  host.appendChild(sitesHost)

  const spaghettiHost = document.createElement('div')
  spaghettiHost.classList.add('obs-spaghetti')
  host.appendChild(spaghettiHost)
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
    renderNotice(sitesHost, { title: 'Choose a group above to list its sites', tone: 'info' })
  }

  function renderSitesFailure(artifact: string, reason: string): void {
    sitesGrid = null
    sitesFor = null
    renderNotice(sitesHost, { title: 'The site list could not be read', detail: `${artifact}: ${reason}`, tone: 'serious' })
  }

  function pickSite(row: ObsSiteRow): void {
    opts.store.set({ sites: new Set([row.siteId]) }, 'obs')
    sitesGrid?.markRows()
  }

  function renderSites(group: string, rows: readonly ObsSiteRow[], notes: readonly string[]): void {
    sitesHost.textContent = ''
    const heading = document.createElement('div')
    heading.classList.add('label', 'obs-sites-title', 'truncate')
    heading.textContent = `${group}: ${rows.length} ${rows.length === 1 ? 'site' : 'sites'}`
    heading.title = heading.textContent
    sitesHost.appendChild(heading)
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
      columns: SITE_COLUMNS,
      rowId: (row) => String(row.siteId),
      isSelected: (row) => opts.store.get().sites.has(row.siteId),
      pick: pickSite,
      isHidden: () => hidden,
    })
    sitesGrid = grid
    sitesHost.appendChild(grid.el)
    grid.setRows(rows)
  }

  // One group at a time: each fetch goes through the same slot, so an older answer is never drawn.
  function loadSites(group: string): void {
    sitesFor = group
    sitesGrid = null
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
        title: (r) => `inequality: ${r.inequality}`,
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
  if (!hidden) requestGroups()

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
    () => sitesGrid?.markRows(),
  )

  return {
    onShow() {
      hidden = false
      spaghetti.onShow()
      requestGroups()
      for (const [pane, top] of savedScroll) pane.scrollTop = top
      savedScroll.clear()
      groupsGrid?.redraw()
      sitesGrid?.redraw()
      if (sitesPending) followSelection()
    },
    onHide() {
      hidden = true
      spaghetti.onHide()
      savedScroll.clear()
      for (const pane of host.querySelectorAll('.scroll-pane')) savedScroll.set(pane, pane.scrollTop)
    },
    dispose() {
      unsubscribeGroups()
      unsubscribeSites()
      sitesSlot.cancel()
      spaghetti.dispose()
    },
  }
}
