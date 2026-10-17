// The drawable-group picker and the unmapped-group disclosure (D-07). The
// picker lists only groups that place on at least one cell; every group
// that does not is still named, behind a count and a disclosure rather
// than hundreds of dead inline entries on a 99%-unmapped run.

import { makeFocusable, renderNotice } from './chrome'

export interface UnmappedGroup {
  group: string
  /** The recorded placement note, shown verbatim when Phase 3 left one --
   *  `null` falls back to the "no placement rule matched" copy. */
  note: string | null
}

export type GroupPickerState =
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'none-drawable'; unmapped: UnmappedGroup[] }
  | { kind: 'ready'; drawable: string[]; interpolated: string[]; unmapped: UnmappedGroup[]; selected: string }

export interface GroupPickerOptions {
  state: GroupPickerState
  onGroupChange: (group: string) => void
}

function renderUnmappedRows(el: HTMLElement, unmapped: UnmappedGroup[]): void {
  for (const entry of unmapped) {
    const row = document.createElement('div')
    row.classList.add('label', 'truncate')
    const text = entry.note ?? `${entry.group} — no placement rule matched`
    row.textContent = text
    row.title = entry.note ?? entry.group
    el.appendChild(row)
  }
}

// A column, not a row: the picker is a short stack of two controls, so it does not
// cover the map the way a row would. The gap is what keeps their texts apart.
function stackWithGap(el: HTMLElement): void {
  el.style.display = 'flex'
  el.style.flexDirection = 'column'
  el.style.gap = 'var(--space-sm)'
}

/**
 * Renders the picker into `el` for whichever of the four states apply.
 * `failed` renders nothing at all -- the map's own designed state already
 * names the failure, and a picker offering groups it cannot draw is worse
 * than no picker.
 */
export function renderGroupPicker(el: HTMLElement, opts: GroupPickerOptions): void {
  el.textContent = ''

  if (opts.state.kind === 'failed') {
    return
  }

  el.classList.add('floating')

  if (opts.state.kind === 'loading') {
    const select = document.createElement('select')
    select.setAttribute('aria-label', 'Parameter group')
    select.disabled = true
    el.appendChild(select)
    return
  }

  if (opts.state.kind === 'none-drawable') {
    stackWithGap(el)
    const noticeHost = document.createElement('div')
    renderNotice(noticeHost, {
      title: 'No parameter group can be drawn on this map',
      detail:
        'Every group in this run failed to place on the grid. The unmapped list below names each one and the rule that was tried.',
      tone: 'info',
    })
    el.appendChild(noticeHost)

    const list = document.createElement('div')
    list.classList.add('scroll-pane', 'unmapped-list')
    makeFocusable(list, 'Unmapped groups')
    renderUnmappedRows(list, opts.state.unmapped)
    el.appendChild(list)
    return
  }

  // ready
  stackWithGap(el)
  const select = document.createElement('select')
  select.setAttribute('aria-label', 'Parameter group')
  for (const group of opts.state.drawable) {
    const option = document.createElement('option')
    option.setAttribute('value', group)
    option.textContent = opts.state.interpolated.includes(group) ? `${group} · interpolated` : group
    option.title = group
    select.appendChild(option)
  }
  select.value = opts.state.selected
  select.addEventListener('change', () => {
    opts.onGroupChange(select.value)
  })
  el.appendChild(select)

  const unmapped = opts.state.unmapped
  if (unmapped.length === 0) {
    return
  }

  const toggle = document.createElement('button')
  toggle.type = 'button'
  toggle.setAttribute('aria-expanded', 'false')
  toggle.textContent = unmapped.length === 1 ? '1 group unmapped' : `${unmapped.length} groups unmapped`
  el.appendChild(toggle)

  const list = document.createElement('div')
  list.style.display = 'none'
  list.classList.add('scroll-pane', 'unmapped-list')
  makeFocusable(list, 'Unmapped groups')
  renderUnmappedRows(list, unmapped)
  el.appendChild(list)

  toggle.addEventListener('click', () => {
    const expanded = toggle.getAttribute('aria-expanded') === 'true'
    toggle.setAttribute('aria-expanded', String(!expanded))
    list.style.display = expanded ? 'none' : ''
  })
}
