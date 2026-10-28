// The 'Selected parameters' section of the Params tab (D-05, D-07): what `pars` holds,
// grouped by pargp. When `pars` came from a cell click it also names the cells and layer,
// each pilot point's factor on them, and every group the answer could not list.

import { recentCellLink, type CellLinkAnswer, type CellLinkPar } from '../data/link'
import { sameSet } from '../state/rules'
import type { SelectionStore } from '../state/selection'
import { makeFocusable } from './chrome'

/** Fixed row height in px, shared with the parameter table so both window the same way. */
export const ROW_HEIGHT = 24
export const OVERSCAN = 20
const VIEWPORT_HEIGHT = 240

const NOT_IN_TABLE = 'not in the parameter table'
const NO_GROUP = 'no group recorded'

export interface SelectedParamsOptions {
  store: SelectionStore
  /** The parameter table's group for a name, or null when the table has no such name. */
  pargpOf: (name: string) => string | null
  /** A click or Enter on a parameter row; the panel applies the modifier rule. */
  onPick: (name: string, event: MouseEvent | KeyboardEvent) => void
  isHidden: () => boolean
}

export interface SelectedParamsHandle {
  /** Draws the section again from the store and the latest cell answer. */
  refresh(): void
  dispose(): void
}

type Item =
  | { kind: 'group'; group: string; count: number }
  | { kind: 'par'; name: string; detail: string; title: string }

function formatFactor(weight: number): string {
  return String(Number(weight.toPrecision(3)))
}

function cellsText(cells: readonly number[]): string {
  return cells.length === 1 ? `cell ${cells[0]}` : `cells ${cells.join(', ')}`
}

function parDetail(par: CellLinkPar): { detail: string; title: string } {
  if (par.kind === 'pilot_point' && par.weights.length > 0) {
    const text = par.weights.map((w) => `factor ${formatFactor(w.weight)} on cell ${w.cell}`).join('; ')
    return { detail: text, title: `${text}. ${par.rule}` }
  }
  if (par.kind === 'pilot_point') return { detail: 'pilot point', title: par.rule }
  return { detail: `sets cell ${par.cell}`, title: par.rule }
}

// Groups keep the order their first member arrives in; members keep theirs.
function grouped<T>(entries: readonly T[], groupOf: (entry: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>()
  for (const entry of entries) {
    const group = groupOf(entry)
    const members = out.get(group)
    if (members === undefined) out.set(group, [entry])
    else members.push(entry)
  }
  return out
}

function flatten<T>(groups: Map<string, T[]>, toPar: (entry: T) => Item): Item[] {
  const items: Item[] = []
  for (const [group, members] of groups) {
    items.push({ kind: 'group', group, count: members.length })
    for (const member of members) items.push(toPar(member))
  }
  return items
}

/** The cell answer `pars` came from, when its names are exactly the selected pars. */
function matchingAnswer(pars: ReadonlySet<string>, cells: ReadonlySet<number>): CellLinkAnswer | null {
  const found = recentCellLink(cells)
  if (found === null) return null
  return sameSet(new Set(found.pars.map((p) => p.parnme)), pars) ? found : null
}

function span(text: string, classes: string[] = []): HTMLSpanElement {
  const el = document.createElement('span')
  el.classList.add(...classes)
  el.textContent = text
  return el
}

export function renderSelectedParams(host: HTMLElement, opts: SelectedParamsOptions): SelectedParamsHandle {
  let disposed = false

  function drawRows(scrollPane: HTMLElement, rowsHost: HTMLElement, items: Item[]): void {
    rowsHost.textContent = ''
    const viewportHeight = scrollPane.clientHeight || VIEWPORT_HEIGHT
    const firstIndex = Math.max(0, Math.floor(scrollPane.scrollTop / ROW_HEIGHT) - OVERSCAN)
    const lastIndex = Math.min(items.length, firstIndex + Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN * 2)
    for (let i = firstIndex; i < lastIndex; i++) {
      const item = items[i]
      const rowEl = document.createElement('div')
      rowEl.setAttribute('role', 'row')
      rowEl.style.position = 'absolute'
      rowEl.style.top = `${i * ROW_HEIGHT}px`
      rowEl.style.left = '0'
      rowEl.style.right = '0'
      rowEl.style.display = 'flex'
      rowEl.style.gap = 'var(--space-sm)'
      if (item.kind === 'group') {
        rowEl.classList.add('selected-group', 'label')
        rowEl.dataset.group = item.group
        const name = span(item.group, ['truncate'])
        name.title = item.group
        rowEl.appendChild(name)
        rowEl.appendChild(span(item.count === 1 ? '1 parameter' : `${item.count} parameters`, ['tabular-nums']))
      } else {
        rowEl.classList.add('param-row')
        rowEl.tabIndex = 0
        rowEl.dataset.selectedParameter = item.name
        const name = span(item.name, ['body', 'truncate'])
        name.title = item.name
        rowEl.appendChild(name)
        if (item.detail !== '') {
          const detail = span(item.detail, ['label', 'truncate'])
          detail.title = item.title
          rowEl.appendChild(detail)
        }
        const picked = item.name
        rowEl.addEventListener('click', (event) => opts.onPick(picked, event))
        rowEl.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            opts.onPick(picked, event)
          }
        })
      }
      rowsHost.appendChild(rowEl)
    }
  }

  function drawTitle(heading: string, count: string | null): void {
    const title = document.createElement('div')
    title.classList.add('params-selected-title')
    const headingEl = span(heading, ['body'])
    headingEl.style.fontWeight = '600'
    title.appendChild(headingEl)
    if (count !== null) title.appendChild(span(count, ['label', 'tabular-nums']))
    host.appendChild(title)
  }

  function drawNotes(notes: readonly string[]): void {
    for (const note of notes) {
      const line = document.createElement('div')
      line.classList.add('label', 'link-reach')
      line.textContent = note
      host.appendChild(line)
    }
  }

  function drawGrid(items: Item[], columns: string[]): void {
    const grid = document.createElement('div')
    grid.setAttribute('role', 'grid')
    grid.setAttribute('aria-label', 'Selected parameters')
    const header = document.createElement('div')
    header.classList.add('param-header')
    header.setAttribute('role', 'row')
    for (const text of columns) header.appendChild(span(text, ['label']))
    grid.appendChild(header)

    const scrollPane = document.createElement('div')
    scrollPane.classList.add('scroll-pane')
    scrollPane.style.position = 'relative'
    makeFocusable(scrollPane, 'Selected parameters')
    const spacer = document.createElement('div')
    spacer.style.position = 'relative'
    spacer.style.height = `${items.length * ROW_HEIGHT}px`
    const rowsHost = document.createElement('div')
    spacer.appendChild(rowsHost)
    scrollPane.appendChild(spacer)
    grid.appendChild(scrollPane)
    host.appendChild(grid)

    scrollPane.addEventListener('scroll', () => {
      if (!disposed && !opts.isHidden()) drawRows(scrollPane, rowsHost, items)
    })
    drawRows(scrollPane, rowsHost, items)
  }

  function refresh(): void {
    if (disposed) return
    host.textContent = ''
    const { pars, cells } = opts.store.get()
    const found = matchingAnswer(pars, cells)

    if (found !== null && found.pars.length === 0) {
      // A cell nothing sets: the reason is the section, never an empty heading (D-07).
      if (found.reasons.pars === null && found.parNotes.length === 0) {
        host.style.display = 'none'
        return
      }
      host.style.display = ''
      drawTitle(found.reasons.pars ?? `no parameter listed for ${cellsText(found.cells)} on layer ${found.layer}`, null)
      drawNotes(found.parNotes)
      return
    }

    if (found === null && pars.size === 0) {
      host.style.display = 'none'
      return
    }
    host.style.display = ''

    if (found !== null) {
      const shown = found.pars.length
      drawTitle(
        `Parameters that set ${cellsText(found.cells)} on layer ${found.layer}`,
        found.parsTotal > shown ? `${shown} of ${found.parsTotal} shown` : shown === 1 ? '1 parameter' : `${shown} parameters`,
      )
      drawNotes(found.parNotes)
      const groups = grouped(found.pars, (p) => p.pargp ?? opts.pargpOf(p.parnme) ?? NO_GROUP)
      drawGrid(
        flatten(groups, (p) => ({ kind: 'par', name: p.parnme, ...parDetail(p) })),
        ['Parameter', 'On the clicked cells'],
      )
      return
    }

    drawTitle('Selected parameters', pars.size === 1 ? '1 selected' : `${pars.size} selected`)
    const groups = grouped([...pars], (name) => opts.pargpOf(name) ?? NOT_IN_TABLE)
    drawGrid(
      flatten(groups, (name) => ({ kind: 'par', name, detail: '', title: '' })),
      ['Parameter'],
    )
  }

  refresh()

  return {
    refresh,
    dispose() {
      disposed = true
      host.textContent = ''
    },
  }
}
