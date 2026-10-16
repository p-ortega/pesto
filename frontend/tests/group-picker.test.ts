// @vitest-environment jsdom
//
// D-07's drawable-group picker and the unmapped disclosure: only groups
// that place on at least one cell are offered, the rest are counted and
// named behind a disclosure, and the picker itself is absent when the
// parameter table or the join could not be read.

import { describe, expect, it, vi } from 'vitest'
import { renderGroupPicker, type GroupPickerState } from '../src/ui/group-picker'

function mount(): HTMLElement {
  const el = document.createElement('div')
  document.body.appendChild(el)
  return el
}

describe('renderGroupPicker', () => {
  it('lists only drawable groups, with no disclosure when nothing is unmapped', () => {
    const el = mount()
    const state: GroupPickerState = { kind: 'ready', interpolated: [], drawable: ['G1', 'G2'], unmapped: [], selected: 'G1' }
    renderGroupPicker(el, { state, onGroupChange: vi.fn() })

    const select = el.querySelector('select[aria-label="Parameter group"]') as HTMLSelectElement
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['G1', 'G2'])
    expect(select.value).toBe('G1')
    expect(el.querySelector('button')).toBeNull()
  })

  it('lets Tab reach the unmapped list, so a keyboard user can scroll it', () => {
    const el = mount()
    renderGroupPicker(el, {
      state: { kind: 'ready', interpolated: [], drawable: ['G1'], unmapped: [{ group: 'G3', note: null }], selected: 'G1' },
      onGroupChange: vi.fn(),
    })
    const list = el.querySelector('.unmapped-list') as HTMLElement
    expect(list.tabIndex).toBe(0)
    expect(list.getAttribute('aria-label')).toBe('Unmapped groups')
  })

  it('reads "1 group unmapped" at one and "{N} groups unmapped" above one', () => {
    const oneEl = mount()
    renderGroupPicker(oneEl, {
      state: { kind: 'ready', interpolated: [], drawable: ['G1'], unmapped: [{ group: 'G3', note: null }], selected: 'G1' },
      onGroupChange: vi.fn(),
    })
    expect(oneEl.querySelector('button')?.textContent).toBe('1 group unmapped')

    const manyEl = mount()
    renderGroupPicker(manyEl, {
      state: {
        kind: 'ready', interpolated: [],
        drawable: ['G1'],
        unmapped: [
          { group: 'G3', note: null },
          { group: 'G4', note: null },
        ],
        selected: 'G1',
      },
      onGroupChange: vi.fn(),
    })
    expect(manyEl.querySelector('button')?.textContent).toBe('2 groups unmapped')
  })

  it('opening the disclosure shows a recorded note verbatim, and the fallback copy when there is none', () => {
    const el = mount()
    renderGroupPicker(el, {
      state: {
        kind: 'ready', interpolated: [],
        drawable: ['G1'],
        unmapped: [
          { group: 'obs_prior', note: "group 'obs_prior' carries idx0, which looks like placement data" },
          { group: 'G5', note: null },
        ],
        selected: 'G1',
      },
      onGroupChange: vi.fn(),
    })

    const toggle = el.querySelector('button') as HTMLButtonElement
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    toggle.click()
    expect(toggle.getAttribute('aria-expanded')).toBe('true')

    expect(el.textContent).toContain("group 'obs_prior' carries idx0, which looks like placement data")
    expect(el.textContent).toContain('G5 — no placement rule matched')
  })

  it('a run where every group is unmapped renders the exact notice with the unmapped list below it', () => {
    const el = mount()
    const state: GroupPickerState = {
      kind: 'none-drawable',
      unmapped: [
        { group: 'G1', note: null },
        { group: 'G2', note: null },
      ],
    }
    renderGroupPicker(el, { state, onGroupChange: vi.fn() })

    expect(el.textContent).toContain('No parameter group can be drawn on this map')
    expect(el.textContent).toContain('G1 — no placement rule matched')
    expect(el.textContent).toContain('G2 — no placement rule matched')
    expect(el.querySelector('select')).toBeNull()
  })

  it('is disabled until the parameter table and the permutation have landed', () => {
    const el = mount()
    renderGroupPicker(el, { state: { kind: 'loading' }, onGroupChange: vi.fn() })

    const select = el.querySelector('select[aria-label="Parameter group"]') as HTMLSelectElement
    expect(select.disabled).toBe(true)
    expect(select.options.length).toBe(0)
  })

  it('is not rendered at all when the parameter table or the join could not be read', () => {
    const el = mount()
    el.textContent = 'stale content'
    renderGroupPicker(el, { state: { kind: 'failed' }, onGroupChange: vi.fn() })

    expect(el.textContent).toBe('')
    expect(el.children.length).toBe(0)
  })

  it('truncates a long group name and carries the full name in a title', () => {
    const el = mount()
    const longName = 'g'.repeat(120)
    renderGroupPicker(el, {
      state: { kind: 'ready', interpolated: [], drawable: [longName], unmapped: [{ group: longName, note: null }], selected: longName },
      onGroupChange: vi.fn(),
    })

    const option = el.querySelector('option') as HTMLOptionElement
    expect(option.title).toBe(longName)

    el.querySelector('button')!.dispatchEvent(new Event('click'))
    const row = el.querySelector('.truncate') as HTMLElement
    expect(row.classList.contains('truncate')).toBe(true)
    expect(row.title).toBe(longName)
  })

  it('renders through textContent alone, never innerHTML, for a group name carrying markup', () => {
    const el = mount()
    const name = '<img src=x onerror=alert(1)>'
    renderGroupPicker(el, {
      state: { kind: 'ready', interpolated: [], drawable: [name], unmapped: [], selected: name },
      onGroupChange: vi.fn(),
    })

    expect(el.querySelector('img')).toBeNull()
    expect(el.querySelector('option')?.textContent).toBe(name)
  })

  it('calls onGroupChange with the newly selected group', () => {
    const el = mount()
    const onGroupChange = vi.fn()
    renderGroupPicker(el, {
      state: { kind: 'ready', interpolated: [], drawable: ['G1', 'G2'], unmapped: [], selected: 'G1' },
      onGroupChange,
    })

    const select = el.querySelector('select') as HTMLSelectElement
    select.value = 'G2'
    select.dispatchEvent(new Event('change'))

    expect(onGroupChange).toHaveBeenCalledWith('G2')
  })

  it('marks an interpolated group in its option text and keeps the plain group as the value', () => {
    const el = document.createElement('div')
    renderGroupPicker(el, {
      state: { kind: 'ready', interpolated: ['G2'], drawable: ['G1', 'G2'], unmapped: [], selected: 'G1' },
      onGroupChange: vi.fn(),
    })
    const select = el.querySelector('select') as HTMLSelectElement
    expect(Array.from(select.options).map((o) => [o.value, o.textContent])).toEqual([
      ['G1', 'G1'],
      ['G2', 'G2 · interpolated'],
    ])
  })
})
