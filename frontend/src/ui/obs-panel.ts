// The Obs panel: the observation group summary on top, the chosen group's
// plot areas and site list under it. It copies the Params panel's frame --
// one windowed table, a hidden tab that fetches and draws nothing, names
// written through textContent only. A click writes the shared selection with
// the origin 'obs'; this file never reads a site by row position.

import { ApiError } from '../data/client'
import { fetchObsGroups, shareRead, TABLE_RMSE_LABEL, type ObsGroupRow, type ObsGroupsResult } from '../data/obs'
import type { IngestState } from '../data/client'
import type { SelectionStore } from '../state/selection'
import { makeFocusable, renderNotice } from './chrome'

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
}

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
  for (const column of opts.columns) {
    const heading = document.createElement('span')
    heading.setAttribute('role', 'columnheader')
    heading.dataset.column = column.key
    heading.classList.add('obs-col', `obs-col-${column.kind}`, 'label')
    heading.textContent = column.label
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

  // A hidden panel draws nothing; showing it again redraws once.
  pane.addEventListener('scroll', () => {
    if (!opts.isHidden()) renderVisible()
  })

  return {
    el,
    pane,
    setRows(next) {
      rows = next
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

/**
 * Fills `host` with the Obs panel. The panel's sections, top to bottom, are
 * `.obs-notices`, `.obs-groups`, `.obs-fit`, `.obs-sites` and `.obs-spaghetti`;
 * the fit and spaghetti hosts stay empty until the plot plans mount into them.
 */
export function renderObsPanel(host: HTMLElement, opts: ObsPanelOptions): ObsPanelHandle {
  host.textContent = ''
  host.classList.add('surface', 'obs-panel')

  let hidden = opts.startHidden === true
  const loadGroups = opts.loadGroups ?? shareRead(() => fetchObsGroups())
  const blocked = opts.capabilities.obs !== undefined && !opts.capabilities.obs.available

  const title = document.createElement('div')
  title.classList.add('heading')
  title.textContent = 'Obs'
  host.appendChild(title)

  const noticesHost = document.createElement('div')
  noticesHost.classList.add('obs-notices')
  host.appendChild(noticesHost)

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

  let chosenGroup: string | null = null
  let groupsRequested = false
  let groupsGrid: Grid<ObsGroupRow> | null = null

  function pickGroup(group: string): void {
    chosenGroup = group
    groupsGrid?.markRows()
    opts.store.set({ obsGroups: new Set([group]) }, 'obs')
  }

  function groupColumns(rows: readonly ObsGroupRow[]): GridColumn<ObsGroupRow>[] {
    const firstText = `${TABLE_RMSE_LABEL}, first${iterationSuffix(commonIteration(rows, (r) => r.firstIteration))}`
    const lastText = `${TABLE_RMSE_LABEL}, last${iterationSuffix(commonIteration(rows, (r) => r.lastIteration))}`
    const rmse = (value: number | null): string => (value === null ? NO_FIGURE : formatResidual(value))
    return [
      { key: 'group', label: 'Group', kind: 'name', text: (r) => r.group },
      { key: 'n_obs', label: 'Observations', kind: 'figure', text: (r) => String(r.nObs) },
      { key: 'n_sites', label: 'Sites', kind: 'figure', text: (r) => String(r.nSites) },
      {
        key: 'n_placed',
        label: 'Placed sites',
        kind: 'figure',
        text: (r) => (r.nPlaced === null ? NO_FIGURE : String(r.nPlaced)),
        title: (r) =>
          r.nPlaced === null ? 'the site positions (obs_cell) are not available' : `${r.nPlaced} of ${r.nSites} sites have a position`,
      },
      {
        key: 'n_weighted',
        label: 'Weighted',
        kind: 'figure',
        text: (r) => String(r.nWeighted),
        title: (r) =>
          `${r.nWeighted} with a weight above zero; ${r.nZeroWeight} zero weight; ${r.nSentinel} sentinel value; ${r.nNoValue} with no value`,
      },
      {
        key: 'time_kind',
        label: 'Time kind',
        kind: 'text',
        text: (r) => r.timeKind,
        title: (r) => `inequality: ${r.inequality}`,
      },
      {
        key: 'rmse_first',
        label: firstText,
        kind: 'figure',
        text: (r) => rmse(r.rmseFirst),
        title: (r) => (r.rmseFirst === null ? NO_RESIDUAL : `${r.nResidFirst} observations with a residual`),
      },
      {
        key: 'rmse_last',
        label: lastText,
        kind: 'figure',
        text: (r) => rmse(r.rmseLast),
        title: (r) => (r.rmseLast === null ? NO_RESIDUAL : `${r.nResidLast} observations with a residual`),
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
          renderGroups(answer.rows)
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

  if (!hidden) requestGroups()

  return {
    onShow() {
      hidden = false
      requestGroups()
      groupsGrid?.redraw()
    },
    onHide() {
      hidden = true
    },
    dispose() {},
  }
}
