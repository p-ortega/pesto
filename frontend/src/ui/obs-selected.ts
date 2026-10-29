// The Obs tab's 'Selected sites' section, always shown under that one name. After a cell click
// it says where the sites were found (the cell and its first ring), what the cap left out and
// why other sites are missing (D-06, D-07). Sites chosen any other way are looked up by id.

import { recentCellLink, type CellLinkAnswer } from '../data/link'
import { fetchLinkSites, MAX_LINK_SITES, type SitesWhereResult } from '../data/link-targets'
import { LatestWins } from '../data/latest-wins'
import { layerCompact, layerWords } from '../data/layer-words'
import { sameSet } from '../state/rules'
import type { SelectionStore } from '../state/selection'
import { makeFocusable, renderNotice } from './chrome'
import { paintNote } from './note-line'

export interface SelectedSitesOptions {
  store: SelectionStore
  isHidden: () => boolean
  /** A row click with its modifiers; the panel turns it into a sites write. */
  onPick: (siteId: number, event: MouseEvent | KeyboardEvent) => void
  loadWhere?: typeof fetchLinkSites
}

export interface SelectedSitesHandle {
  /** Re-reads the selection; while hidden it only notes that something changed. */
  refresh(): void
  onShow(): void
  dispose(): void
}

// The same fixed height as `.obs-grid-row` (24px), so the spacer tells the scrollbar the truth.
const ROW_HEIGHT = 24
const OVERSCAN = 20
const VIEWPORT_HEIGHT = 240

const NO_GROUP = '—'
const TITLE = 'Selected sites'
const EMPTY_HINT = 'Click a cell, lasso sites on the map, or brush a residual histogram to select sites.'
export const LAYER_HEADING_TITLE = 'Layer counted from 1; the index from 0 is in brackets.'

interface SectionRow {
  siteId: number
  site: string
  group: string | null
  layer: number
  where: string
  whereTitle: string
}

interface SectionColumn {
  key: string
  label: string
  kind: 'name' | 'figure' | 'text'
  text(row: SectionRow): string
  title(row: SectionRow): string
  headingTitle?: string
}

const COLUMNS: SectionColumn[] = [
  { key: 'site', label: 'Site', kind: 'name', text: (r) => r.site, title: (r) => r.site },
  {
    key: 'group',
    label: 'Group',
    kind: 'text',
    text: (r) => r.group ?? NO_GROUP,
    title: (r) => r.group ?? 'no group was recorded for this site',
  },
  {
    key: 'layer',
    label: 'Layer',
    kind: 'figure',
    text: (r) => layerCompact(r.layer),
    title: (r) => (r.layer === -1 ? 'no layer could be worked out for this site' : ''),
    headingTitle: LAYER_HEADING_TITLE,
  },
  { key: 'where', label: 'Where', kind: 'name', text: (r) => r.where, title: (r) => r.whereTitle },
]

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

function cellList(cells: readonly number[]): string {
  if (cells.length > 5) return `${cells.length} cells`
  if (cells.length === 1) return `cell ${cells[0]}`
  return `cells ${cells.slice(0, -1).join(', ')} and ${cells[cells.length - 1]}`
}

/** "Sites in cell 1234 and its 8 neighbouring cells on layer 4 (index 3)". */
function reachText(answer: CellLinkAnswer): string {
  const these = cellList(answer.cells)
  const whose = answer.cells.length === 1 ? 'its' : 'their'
  const n = answer.ring.length
  const layer = layerWords(answer.layer)
  if (n === 0) return `Sites in ${these} on ${layer}; no cell borders ${answer.cells.length === 1 ? 'it' : 'them'}`
  return `Sites in ${these} and ${whose} ${plural(n, 'neighbouring cell', 'neighbouring cells')} on ${layer}`
}

function countLines(answer: CellLinkAnswer): string[] {
  const out: string[] = []
  const shown = answer.sites.length
  if (answer.sitesTotal > shown) out.push(`${shown} of ${answer.sitesTotal} sites shown; zoom in or lasso to pick fewer`)
  const { unknownLayerIncluded, otherLayerLeftOut, unplacedInRun } = answer.siteCounts
  if (unknownLayerIncluded > 0) out.push(`${plural(unknownLayerIncluded, 'site', 'sites')} of unknown layer included`)
  if (otherLayerLeftOut > 0) {
    out.push(`${plural(otherLayerLeftOut, 'site on another layer', 'sites on other layers')} in these cells left out`)
  }
  if (unplacedInRun > 0) {
    out.push(
      unplacedInRun === 1
        ? '1 site in this run is not placed, so no cell click can find it'
        : `${unplacedInRun} sites in this run are not placed, so no cell click can find them`,
    )
  }
  return out
}

export function renderSelectedSites(host: HTMLElement, opts: SelectedSitesOptions): SelectedSitesHandle {
  host.textContent = ''
  const loadWhere = opts.loadWhere ?? fetchLinkSites
  const slot = new LatestWins<SitesWhereResult>()
  let pending = false
  let drawn: { pane: HTMLElement; render(): void } | null = null
  // Where the grid just cleared was scrolled to, for the grid drawn next.
  let keptTop = 0

  function clear(): void {
    keptTop = drawn?.pane.scrollTop ?? 0
    host.textContent = ''
    drawn = null
  }

  // `Selected sites`, then ` · {count}` once sites are selected or a cell was clicked.
  function appendTitle(count: number | null): void {
    const box = document.createElement('div')
    box.classList.add('obs-selected-title')
    const heading = document.createElement('span')
    heading.classList.add('body')
    heading.style.fontWeight = '600'
    heading.textContent = TITLE
    box.appendChild(heading)
    if (count !== null) {
      box.appendChild(document.createTextNode(' '))
      const countEl = document.createElement('span')
      countEl.classList.add('body', 'tabular-nums')
      countEl.style.fontWeight = '600'
      countEl.textContent = `· ${count}`
      countEl.title = `${plural(count, 'site is', 'sites are')} selected`
      box.appendChild(countEl)
    }
    host.appendChild(box)
  }

  // The sentence under the title: where a cell click looked, or why it found nothing.
  function appendSentence(text: string, fullTitle: string): HTMLElement {
    const line = document.createElement('div')
    line.classList.add('label', 'wrap-note', 'obs-selected-line')
    line.textContent = text
    if (fullTitle !== '') line.title = fullTitle
    host.appendChild(line)
    return line
  }

  function drawEmpty(): void {
    clear()
    appendTitle(null)
    paintNote(appendSentence('', ''), { kind: 'reason', text: EMPTY_HINT })
  }

  function appendLine(text: string): void {
    const line = document.createElement('div')
    line.classList.add('label', 'link-reach')
    line.textContent = text
    host.appendChild(line)
  }

  function appendGrid(rows: readonly SectionRow[]): void {
    if (rows.length === 0) return
    const grid = document.createElement('div')
    grid.setAttribute('role', 'grid')
    grid.setAttribute('aria-label', 'Selected sites')
    grid.classList.add('obs-grid')

    const header = document.createElement('div')
    header.classList.add('obs-grid-header')
    header.setAttribute('role', 'row')
    for (const column of COLUMNS) {
      const heading = document.createElement('span')
      heading.setAttribute('role', 'columnheader')
      heading.dataset.column = column.key
      heading.classList.add('obs-col', `obs-col-${column.kind}`, 'label')
      heading.textContent = column.label
      if (column.headingTitle !== undefined) heading.title = column.headingTitle
      header.appendChild(heading)
    }
    grid.appendChild(header)

    const pane = document.createElement('div')
    pane.classList.add('scroll-pane')
    pane.style.position = 'relative'
    makeFocusable(pane, 'Selected sites')
    const spacer = document.createElement('div')
    spacer.style.position = 'relative'
    spacer.style.height = `${rows.length * ROW_HEIGHT}px`
    const rowsHost = document.createElement('div')
    spacer.appendChild(rowsHost)
    pane.appendChild(spacer)
    grid.appendChild(pane)
    host.appendChild(grid)

    function render(): void {
      rowsHost.textContent = ''
      const first = Math.max(0, Math.floor(pane.scrollTop / ROW_HEIGHT) - OVERSCAN)
      const budget = Math.ceil((pane.clientHeight || VIEWPORT_HEIGHT) / ROW_HEIGHT) + OVERSCAN * 2
      const last = Math.min(rows.length, first + budget)
      for (let i = first; i < last; i++) rowsHost.appendChild(rowElement(rows[i], i))
    }

    pane.addEventListener('scroll', () => {
      if (!opts.isHidden()) render()
    })
    pane.scrollTop = Math.min(keptTop, Math.max(0, rows.length * ROW_HEIGHT - pane.clientHeight))
    drawn = { pane, render }
    render()
  }

  function rowElement(row: SectionRow, index: number): HTMLElement {
    const rowEl = document.createElement('div')
    rowEl.classList.add('obs-grid-row')
    rowEl.setAttribute('role', 'row')
    rowEl.style.position = 'absolute'
    rowEl.style.top = `${index * ROW_HEIGHT}px`
    rowEl.style.left = '0'
    rowEl.style.right = '0'
    rowEl.tabIndex = 0
    rowEl.dataset.siteId = String(row.siteId)
    for (const column of COLUMNS) {
      const cell = document.createElement('span')
      cell.setAttribute('role', 'gridcell')
      cell.dataset.column = column.key
      cell.classList.add('obs-col', `obs-col-${column.kind}`)
      if (column.kind === 'name' || column.kind === 'text') cell.classList.add('truncate')
      if (column.kind === 'name') cell.classList.add('body')
      else if (column.kind === 'figure') cell.classList.add('tabular-nums')
      cell.textContent = column.text(row)
      const title = column.title(row)
      if (title !== '') cell.title = title
      rowEl.appendChild(cell)
    }
    rowEl.addEventListener('click', (event) => opts.onPick(row.siteId, event))
    rowEl.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        opts.onPick(row.siteId, event)
      }
    })
    return rowEl
  }

  function drawCellAnswer(answer: CellLinkAnswer): void {
    clear()
    const reach = reachText(answer)
    const fullReach = `${reach}. ${answer.ringRule}`
    appendTitle(answer.sites.length)
    if (answer.sites.length === 0) {
      // D-07: an empty reach is said in words, never left as an empty section.
      const reason = answer.reasons.sites ?? 'no observation site was found in this cell or its neighbours'
      appendSentence(reason, fullReach)
    } else {
      const cells = answer.cells.length > 5 ? `${reach}. Cells: ${answer.cells.join(', ')}. ${answer.ringRule}` : fullReach
      appendSentence(reach, cells)
      if (answer.reasons.sites !== null) appendLine(answer.reasons.sites)
    }
    for (const line of countLines(answer)) appendLine(line)
    const inClicked = answer.cells.length === 1 ? 'in the cell' : 'in a clicked cell'
    appendGrid(
      answer.sites.map((s) => ({
        siteId: s.siteId,
        site: s.site,
        group: s.group,
        layer: s.layer,
        where: s.inClickedCell ? inClicked : 'in a neighbouring cell',
        whereTitle: `cell ${s.cell}`,
      })),
    )
  }

  function drawRefusal(reason: string): void {
    const box = document.createElement('div')
    renderNotice(box, { title: 'Where the selected sites are could not be read', detail: reason, tone: 'serious' })
    host.appendChild(box)
  }

  function drawWhere(total: number, iteration: number, result: SitesWhereResult): void {
    clear()
    appendTitle(total)
    if (!result.ok) {
      drawRefusal(`${result.artifact}: ${result.reason}`)
      return
    }
    if (result.iteration !== iteration) {
      drawRefusal(`the answer was for iteration ${result.iteration}, not ${iteration}`)
      return
    }
    const notListed = Math.max(result.notAsked, total - MAX_LINK_SITES)
    if (notListed > 0) {
      appendLine(`${notListed} more selected ${notListed === 1 ? 'site is' : 'sites are'} not listed: only the first ${MAX_LINK_SITES} are looked up`)
    }
    if (result.unknown.length > 0) {
      appendLine(
        result.reason !== null
          ? `${plural(result.unknown.length, 'selected site id', 'selected site ids')} could not be looked up: ${result.reason}`
          : `${plural(result.unknown.length, 'selected site id is', 'selected site ids are')} not in this run`,
      )
    }
    for (const note of result.notes) appendLine(note)
    const noValue = result.sites.filter((s) => s.hasValue === false).length
    if (noValue > 0) {
      appendLine(`${noValue} of these sites ${noValue === 1 ? 'has' : 'have'} no observation with a value at iteration ${iteration}`)
    }
    if (result.valueReason !== null) appendLine(result.valueReason)
    appendGrid(
      result.sites.map((s) => ({
        siteId: s.siteId,
        site: s.site,
        // The server sends empty text for a site with no group.
        group: s.group === '' ? null : s.group,
        layer: s.layer,
        where: s.placed ? `cell ${s.cell}` : 'not placed',
        whereTitle: s.placed ? `cell ${s.cell} on ${layerWords(s.layer)}` : 'this site has no position in the model grid',
      })),
    )
  }

  function drawLoading(total: number): void {
    clear()
    appendTitle(total)
    appendLine('Looking up where they are…')
  }

  function lookUp(ids: readonly number[], iteration: number): void {
    const asked = ids.slice(0, MAX_LINK_SITES)
    const key = `${iteration}|${ids.length}|${asked.join(',')}`
    // The same question asked or answered already: nothing new to fetch.
    if (slot.current() === key) return
    // A grid already on screen stays until the new answer lands, so a click does not blink the list.
    if (drawn === null) drawLoading(ids.length)
    void slot.run(key, (signal) => loadWhere(asked, iteration, { signal })).then(
      (answer) => {
        if (answer.stale) return
        drawWhere(ids.length, iteration, answer.value)
        if (!answer.value.ok) slot.cancel()
      },
      (error: unknown) => {
        slot.cancel()
        clear()
        appendTitle(ids.length)
        drawRefusal(`obs_cell: ${error instanceof Error ? error.message : String(error)}`)
      },
    )
  }

  function refresh(): void {
    if (opts.isHidden()) {
      pending = true
      return
    }
    pending = false
    const selection = opts.store.get()
    const answer = selection.cells.size > 0 ? recentCellLink(selection.cells) : null
    if (answer !== null && sameSet(new Set(answer.sites.map((s) => s.siteId)), selection.sites)) {
      slot.cancel()
      drawCellAnswer(answer)
      return
    }
    if (selection.sites.size === 0) {
      slot.cancel()
      drawEmpty()
      return
    }
    lookUp([...selection.sites], selection.iteration)
  }

  return {
    refresh,
    onShow() {
      if (pending) refresh()
      else drawn?.render()
    },
    dispose() {
      slot.cancel()
    },
  }
}
