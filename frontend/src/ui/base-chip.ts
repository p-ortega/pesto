// The Select base button in the Obs heading row (D-18, D-19, LD-6). An iteration with no base says
// why under the button and leaves the selection alone; names and reasons go in as text only.

import { LatestWins } from '../data/latest-wins'
import type { BaseResult } from '../data/reals'
import { modeOf } from '../state/modifiers'
import { clearReals, selectReals } from '../state/rules'
import type { SelectionStore } from '../state/selection'
import { paintNote } from './note-line'

export interface BaseChipOptions {
  store: SelectionStore
  loadBase: (iteration: number) => Promise<BaseResult>
  /** The iteration shown when the chip mounts; the store's iteration when absent. */
  iteration?: number
}

export interface BaseChipHandle {
  /** The button with its reason line under it. */
  el: HTMLElement
  setIteration(k: number): void
  dispose(): void
}

// Kept as 'header' after the move, so no store subscriber that reads origins changes.
const ORIGIN = 'header'
// Its own word, not BASE_STYLE.label: the plot legends and the map's realization label still say base.
const BUTTON_LABEL = 'Select base'
const LOADING_REASON = "reading the base realization's name"
const HINT =
  'Select the base realization: it draws bold and the others dim. Click again to select all. Shift-click adds base to the selection.'
const REASON_ID = 'base-chip-reason'

type ChipState =
  | { kind: 'loading' }
  | { kind: 'named'; name: string; note: string | null }
  | { kind: 'absent'; iteration: number; reason: string }
  | { kind: 'unknown'; reason: string }

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function reasonOf(state: Exclude<ChipState, { kind: 'named' }>): string {
  if (state.kind === 'loading') return LOADING_REASON
  if (state.kind === 'absent') return state.reason
  return `base unknown: ${state.reason}`
}

export function renderBaseChip(host: HTMLElement, opts: BaseChipOptions): BaseChipHandle {
  const { store } = opts
  const wrapper = document.createElement('div')
  wrapper.classList.add('base-select')
  const el = document.createElement('button')
  el.type = 'button'
  el.classList.add('chip', 'base-chip')
  el.textContent = BUTTON_LABEL
  const reasonLine = document.createElement('div')
  reasonLine.id = REASON_ID
  reasonLine.classList.add('label', 'wrap-note', 'base-select-reason')
  wrapper.appendChild(el)
  wrapper.appendChild(reasonLine)
  host.appendChild(wrapper)

  const slot = new LatestWins<BaseResult>()
  let iteration = opts.iteration ?? store.get().iteration
  let state: ChipState = { kind: 'loading' }
  let disposed = false

  function isPressed(name: string): boolean {
    const reals = store.get().reals
    return reals !== 'all' && reals.size === 1 && reals.has(name)
  }

  function paint(): void {
    if (state.kind === 'named') {
      el.disabled = false
      el.title = state.note ? `${HINT}\n${state.note}` : HINT
      el.setAttribute('aria-pressed', String(isPressed(state.name)))
      el.removeAttribute('aria-describedby')
      paintNote(reasonLine, null)
      return
    }
    const reason = reasonOf(state)
    el.disabled = true
    el.setAttribute('aria-pressed', 'false')
    el.title = reason
    el.setAttribute('aria-describedby', REASON_ID)
    paintNote(reasonLine, { kind: 'reason', text: reason })
  }

  function settle(result: BaseResult): ChipState {
    if (!result.ok) return { kind: 'unknown', reason: result.reason }
    const { answer } = result
    if (answer.name === null) {
      return { kind: 'absent', iteration: answer.iteration, reason: answer.reason ?? `iteration ${answer.iteration} has no base realization` }
    }
    return { kind: 'named', name: answer.name, note: answer.note }
  }

  function load(): void {
    const asked = iteration
    state = { kind: 'loading' }
    paint()
    slot.run(`${store.get().runId}:${asked}`, () => opts.loadBase(asked)).then(
      (result) => {
        if (result.stale || disposed) return
        state = settle(result.value)
        paint()
      },
      (error: unknown) => {
        if (disposed) return
        state = { kind: 'unknown', reason: describeError(error) }
        paint()
      },
    )
  }

  function onClick(event: MouseEvent): void {
    if (state.kind !== 'named' || el.disabled) return
    const name = state.name
    const s = store.get()
    const mode = modeOf(event)
    const next =
      mode !== 'replace' ? selectReals(s, [name], mode) : isPressed(name) ? clearReals(s) : selectReals(s, [name], 'replace')
    store.set({ reals: next.reals }, ORIGIN)
    paint()
  }

  el.addEventListener('click', onClick)
  const unsubscribeReals = store.subscribe(
    (s) => s.reals,
    () => paint(),
  )
  const unsubscribeRun = store.subscribe(
    (s) => s.runId,
    () => load(),
  )
  load()

  return {
    el: wrapper,
    setIteration(k: number) {
      if (k === iteration && state.kind !== 'unknown') return
      iteration = k
      load()
    },
    dispose() {
      disposed = true
      slot.cancel()
      unsubscribeReals()
      unsubscribeRun()
      el.removeEventListener('click', onClick)
      wrapper.remove()
    },
  }
}
