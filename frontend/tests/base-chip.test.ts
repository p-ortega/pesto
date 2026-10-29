// @vitest-environment jsdom
//
// The Select base button: what it asks for, what it writes to the selection, and the reason line
// it shows when the shown iteration has no base.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BaseResult } from '../src/data/reals'
import { emptySelection } from '../src/state/rules'
import { createSelectionStore, type SelectionStore } from '../src/state/selection'
import { renderBaseChip, type BaseChipHandle } from '../src/ui/base-chip'

function makeStore(over: Partial<ReturnType<typeof emptySelection>> = {}): SelectionStore {
  return createSelectionStore({ initial: { ...emptySelection('run', 2), ...over }, schedule: () => {} })
}

function named(iteration: number, name = 'base', note: string | null = null): BaseResult {
  return { ok: true, answer: { iteration, name, note, reason: null } }
}

function absent(iteration: number, reason: string): BaseResult {
  return { ok: true, answer: { iteration, name: null, note: null, reason } }
}

interface Deferred {
  resolve: (r: BaseResult) => void
  reject: (e: unknown) => void
}

interface Mounted {
  store: SelectionStore
  chip: BaseChipHandle
  button: HTMLButtonElement
  loadBase: ReturnType<typeof vi.fn>
  origins: string[][]
}

function mount(
  answer: (iteration: number) => Promise<BaseResult>,
  over: Partial<ReturnType<typeof emptySelection>> = {},
): Mounted {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const store = makeStore(over)
  const origins: string[][] = []
  store.subscribe(
    (s) => s.reals,
    (_next, _prev, o) => origins.push([...o]),
  )
  const loadBase = vi.fn(answer)
  const chip = renderBaseChip(host, { store, loadBase })
  return { store, chip, button: host.querySelector('button.chip.base-chip') as HTMLButtonElement, loadBase, origins }
}

const HINT =
  'Select the base realization: it draws bold and the others dim. Click again to select all. Shift-click adds base to the selection.'

function reasonLine(): HTMLElement {
  return document.getElementById('base-chip-reason') as HTMLElement
}

function reasonShown(): string | null {
  const line = reasonLine()
  return line.style.display === 'none' ? null : line.textContent
}

function click(m: Mounted, keys: { shiftKey?: boolean; altKey?: boolean } = {}): void {
  m.button.dispatchEvent(new MouseEvent('click', { bubbles: true, ...keys }))
  m.store.flush()
}

function realsOf(store: SelectionStore): string[] | 'all' {
  const reals = store.get().reals
  return reals === 'all' ? 'all' : [...reals].sort()
}

afterEach(() => {
  document.body.textContent = ''
})

describe('the base chip', () => {
  it('asks for the shown iteration and is disabled while it loads', () => {
    const m = mount(() => new Promise<BaseResult>(() => {}))

    expect(m.loadBase).toHaveBeenCalledWith(2)
    expect(m.button.textContent).toBe('Select base')
    expect(m.button.disabled).toBe(true)
    expect(m.button.title).toBe("reading the base realization's name")
    expect(reasonShown()).toBe("ℹ reading the base realization's name")
    expect(m.button.getAttribute('aria-describedby')).toBe('base-chip-reason')
  })

  it('reads Select base with the tooltip and no reason line once the name is known', async () => {
    const m = mount(async (k) => named(k))
    await vi.waitFor(() => expect(m.button.disabled).toBe(false))

    expect(m.button.textContent).toBe('Select base')
    expect(m.button.title).toBe(HINT)
    expect(reasonShown()).toBeNull()
    expect(m.button.hasAttribute('aria-describedby')).toBe(false)
    expect(m.chip.el.classList.contains('base-select')).toBe(true)
    expect(m.chip.el.contains(m.button)).toBe(true)
  })

  it('selects base on a plain click, with origin header, and restores all on a second', async () => {
    const m = mount(async (k) => named(k))
    await vi.waitFor(() => expect(m.button.disabled).toBe(false))
    expect(m.button.getAttribute('aria-pressed')).toBe('false')

    click(m)
    expect(realsOf(m.store)).toEqual(['base'])
    expect(m.origins.at(-1)).toEqual(['header'])
    expect(m.button.getAttribute('aria-pressed')).toBe('true')

    click(m)
    expect(realsOf(m.store)).toBe('all')
    expect(m.origins.at(-1)).toEqual(['header'])
    expect(m.button.getAttribute('aria-pressed')).toBe('false')
  })

  it('adds base to a named set on shift-click', async () => {
    const m = mount(async (k) => named(k), { reals: new Set(['r2']) })
    await vi.waitFor(() => expect(m.button.disabled).toBe(false))

    click(m, { shiftKey: true })
    expect(realsOf(m.store)).toEqual(['base', 'r2'])
    expect(m.button.getAttribute('aria-pressed')).toBe('false')
  })

  it('starts a named set holding base on shift-click from all realizations', async () => {
    const m = mount(async (k) => named(k))
    await vi.waitFor(() => expect(m.button.disabled).toBe(false))

    click(m, { shiftKey: true })
    expect(realsOf(m.store)).toEqual(['base'])
  })

  it('replaces a named set with base on a plain click', async () => {
    const m = mount(async (k) => named(k), { reals: new Set(['r2', 'r7']) })
    await vi.waitFor(() => expect(m.button.disabled).toBe(false))

    click(m)
    expect(realsOf(m.store)).toEqual(['base'])
  })

  it('follows a selection another view wrote', async () => {
    const m = mount(async (k) => named(k))
    await vi.waitFor(() => expect(m.button.disabled).toBe(false))

    m.store.set({ reals: new Set(['base']) }, 'obs')
    m.store.flush()
    expect(m.button.getAttribute('aria-pressed')).toBe('true')
  })

  it('says so for an iteration with no base, and keeps the selection', async () => {
    const m = mount(async (k) => (k === 5 ? absent(5, 'iteration 5 has no realization named base') : named(k)))
    await vi.waitFor(() => expect(m.button.disabled).toBe(false))
    click(m)
    const writes = m.origins.length

    m.chip.setIteration(5)
    await vi.waitFor(() => expect(reasonShown()).toBe('ℹ iteration 5 has no realization named base'))
    expect(m.button.textContent).toBe('Select base')
    expect(m.button.disabled).toBe(true)
    expect(m.button.title).toBe('iteration 5 has no realization named base')
    expect(m.button.getAttribute('aria-describedby')).toBe('base-chip-reason')

    click(m)
    expect(realsOf(m.store)).toEqual(['base'])
    expect(m.origins.length).toBe(writes)
  })

  it('puts the note about how base was matched in its title', async () => {
    const m = mount(async (k) => named(k, 'base', 'base matched after trimming spaces from " base "'))
    await vi.waitFor(() => expect(m.button.disabled).toBe(false))

    expect(m.button.title).toBe(`${HINT}\nbase matched after trimming spaces from " base "`)
  })

  it('says the iteration has no base realization when the server gave no reason', async () => {
    const m = mount(async (k) => ({ ok: true, answer: { iteration: k, name: null, note: null, reason: null } }))
    await vi.waitFor(() => expect(reasonShown()).toBe('ℹ iteration 2 has no base realization'))

    expect(m.button.title).toBe('iteration 2 has no base realization')
  })

  it('shows base unknown, disabled, with the reason, when the answer was refused', async () => {
    const m = mount(async (k) => ({ ok: false, iteration: k, reason: 'reals/2: the ensemble could not be read' }))
    await vi.waitFor(() => expect(reasonShown()).toBe('ℹ base unknown: reals/2: the ensemble could not be read'))

    expect(m.button.textContent).toBe('Select base')
    expect(m.button.disabled).toBe(true)
    expect(m.button.title).toBe('base unknown: reals/2: the ensemble could not be read')
  })

  it('shows base unknown with the error when the request failed', async () => {
    const m = mount(async () => {
      throw new Error('the server did not answer')
    })
    await vi.waitFor(() => expect(reasonShown()).toBe('ℹ base unknown: the server did not answer'))

    expect(m.button.title).toBe('base unknown: the server did not answer')
  })

  it('never draws an answer for an iteration that is no longer shown', async () => {
    const pending = new Map<number, Deferred>()
    const m = mount(
      (k) =>
        new Promise<BaseResult>((resolve, reject) => {
          pending.set(k, { resolve, reject })
        }),
    )
    m.chip.setIteration(5)
    pending.get(5)!.resolve(named(5, 'base'))
    await vi.waitFor(() => expect(m.button.disabled).toBe(false))

    pending.get(2)!.resolve(absent(2, 'iteration 2 has no base'))
    await Promise.resolve()
    await Promise.resolve()
    expect(m.button.textContent).toBe('Select base')
    expect(m.button.disabled).toBe(false)
    expect(reasonShown()).toBeNull()
  })

  it('puts a realization name in as text, never as markup', async () => {
    const m = mount(async (k) => named(k, '<img src=x onerror=alert(1)>', '<b>note</b>'))
    await vi.waitFor(() => expect(m.button.disabled).toBe(false))
    click(m)

    expect(realsOf(m.store)).toEqual(['<img src=x onerror=alert(1)>'])
    expect(document.querySelector('img')).toBeNull()
    expect(document.querySelector('b')).toBeNull()
  })

  it('puts a refusal reason in the reason line as text, never as markup', async () => {
    const m = mount(async (k) => ({ ok: false, iteration: k, reason: '<img src=x onerror=alert(1)>' }))
    await vi.waitFor(() => expect(m.button.disabled).toBe(true))
    await vi.waitFor(() => expect(reasonShown()).toBe('ℹ base unknown: <img src=x onerror=alert(1)>'))

    expect(document.querySelector('img')).toBeNull()
  })

  it('stops following the selection and leaves the page once disposed', async () => {
    const m = mount(async (k) => named(k))
    await vi.waitFor(() => expect(m.button.disabled).toBe(false))
    m.chip.dispose()

    expect(m.button.isConnected).toBe(false)
    expect(m.chip.el.isConnected).toBe(false)
    m.store.set({ reals: new Set(['base']) }, 'obs')
    m.store.flush()
    expect(m.button.getAttribute('aria-pressed')).toBe('false')
  })
})
