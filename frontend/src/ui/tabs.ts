// The right panel's tab bar (D-08 to D-10): a tablist of buttons over one
// tabpanel per tab. Every panel stays in the DOM; only the chosen one lacks
// the `hidden` attribute, so a hidden view keeps its state and scroll
// position. It follows the ARIA tab pattern (one tab in the tab order,
// arrow keys, Home and End). It never touches the shared selection.

export interface TabSpec {
  id: string
  label: string
  /** Runs after the tab's panel is unhidden, so the view can measure its real size. */
  onShow?: () => void
  /** Runs just before the tab's panel is hidden, while its layout can still be read. */
  onHide?: () => void
}

export interface TabsOptions {
  tabs: TabSpec[]
  initial: string
  /** Called for a choice the user makes (click or key), not for select(). */
  onSelect: (id: string) => void
}

export interface TabsHandle {
  /** Moves to a tab without calling onSelect. An unknown id is ignored. */
  select(id: string): void
  current(): string
  panel(id: string): HTMLElement
  /** Shows ` · {count}` after the tab's label with `title`; zero or null shows no count. An unknown id is ignored. */
  setCount(id: string, count: number | null, title: string): void
}

const TAB_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'Home', 'End'])

/**
 * Renders the tab bar and the panels into `host`, clearing it first. The
 * `initial` tab is shown without calling its onShow, since nothing has been
 * put in the panels yet.
 */
export function renderTabs(host: HTMLElement, opts: TabsOptions): TabsHandle {
  host.textContent = ''
  host.classList.add('tabs')

  const tablist = document.createElement('div')
  tablist.classList.add('tabs-bar')
  tablist.setAttribute('role', 'tablist')
  tablist.setAttribute('aria-label', 'Panels')
  host.appendChild(tablist)

  const buttons = new Map<string, HTMLButtonElement>()
  const counts = new Map<string, { el: HTMLSpanElement; gap: Text }>()
  const panels = new Map<string, HTMLElement>()
  const ids = opts.tabs.map((tab) => tab.id)
  let currentId = ids.includes(opts.initial) ? opts.initial : ids[0]

  for (const spec of opts.tabs) {
    const button = document.createElement('button')
    button.type = 'button'
    button.classList.add('tab', 'label')
    button.id = `tab-${spec.id}`
    button.setAttribute('role', 'tab')
    button.setAttribute('aria-controls', `panel-${spec.id}`)
    const name = document.createElement('span')
    name.classList.add('tab-name')
    name.textContent = spec.label
    // Not accent: the count is a fact, and accent marks only the selected tab's underline.
    const count = document.createElement('span')
    count.classList.add('tab-count', 'tabular-nums')
    button.appendChild(name)
    button.appendChild(count)
    // A real space between the parts, present only with a count, so an empty tab reads just its label.
    counts.set(spec.id, { el: count, gap: document.createTextNode(' ') })
    button.addEventListener('click', () => choose(spec.id))
    tablist.appendChild(button)
    buttons.set(spec.id, button)
  }

  for (const spec of opts.tabs) {
    const panel = document.createElement('div')
    panel.classList.add('tabs-panel')
    panel.id = `panel-${spec.id}`
    panel.setAttribute('role', 'tabpanel')
    panel.setAttribute('aria-labelledby', `tab-${spec.id}`)
    host.appendChild(panel)
    panels.set(spec.id, panel)
  }

  function paint(): void {
    for (const id of ids) {
      const active = id === currentId
      const button = buttons.get(id)!
      button.setAttribute('aria-selected', active ? 'true' : 'false')
      button.tabIndex = active ? 0 : -1
      panels.get(id)!.hidden = !active
    }
  }

  function move(id: string): boolean {
    if (id === currentId || !ids.includes(id)) return false
    const leaving = opts.tabs.find((tab) => tab.id === currentId)!
    const entering = opts.tabs.find((tab) => tab.id === id)!
    leaving.onHide?.()
    currentId = id
    paint()
    entering.onShow?.()
    return true
  }

  function choose(id: string): void {
    if (move(id)) opts.onSelect(id)
  }

  tablist.addEventListener('keydown', (event) => {
    if (!TAB_KEYS.has(event.key)) return
    event.preventDefault()
    const at = ids.indexOf(currentId)
    let next = at
    if (event.key === 'ArrowRight') next = (at + 1) % ids.length
    else if (event.key === 'ArrowLeft') next = (at - 1 + ids.length) % ids.length
    else if (event.key === 'Home') next = 0
    else next = ids.length - 1
    choose(ids[next])
    buttons.get(ids[next])!.focus()
  })

  paint()

  return {
    select(id) {
      move(id)
    },
    current: () => currentId,
    panel(id) {
      const panel = panels.get(id)
      if (!panel) throw new Error(`no tab panel named ${id}`)
      return panel
    },
    setCount(id, count, title) {
      const parts = counts.get(id)
      if (!parts) return
      const { el, gap } = parts
      if (count === null || !(count > 0)) {
        gap.remove()
        el.textContent = ''
        el.removeAttribute('title')
        return
      }
      if (!gap.isConnected) el.before(gap)
      el.textContent = `· ${count}`
      el.title = title
    },
  }
}
