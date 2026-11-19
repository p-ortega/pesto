// The small controls a chart carries above it: a named row of either-or
// buttons, an on/off button, and the Enlarge button. All are real buttons with
// aria-pressed and a tooltip, so they work from the keyboard.

export interface SwitchOption<T extends string> {
  value: T
  text: string
  title: string
  /** Why this choice cannot be made here. The button stays focusable so the reason can be read. */
  refused?: string | null
}

export interface SwitchOptions<T extends string> {
  /** A stable name for the control, used to put focus back after its chart is rebuilt. */
  key: string
  label: string
  ariaLabel: string
  options: SwitchOption<T>[]
  value: T
  onPick(value: T): void
}

export interface SwitchHandle<T extends string> {
  el: HTMLElement
  set(value: T): void
}

export function chartToolbar(): HTMLDivElement {
  const el = document.createElement('div')
  el.classList.add('chart-toolbar')
  return el
}

export function chartName(text: string): HTMLElement {
  const el = document.createElement('span')
  el.classList.add('label', 'chart-name')
  el.textContent = text
  return el
}

export function chartSwitch<T extends string>(opts: SwitchOptions<T>): SwitchHandle<T> {
  const el = document.createElement('div')
  el.classList.add('chart-switch')
  el.setAttribute('role', 'group')
  el.setAttribute('aria-label', opts.ariaLabel)
  const label = document.createElement('span')
  label.classList.add('label')
  label.textContent = `${opts.label}:`
  el.appendChild(label)
  const buttons = new Map<T, HTMLButtonElement>()
  const set = (value: T): void => {
    for (const [v, button] of buttons) button.setAttribute('aria-pressed', String(v === value))
  }
  for (const option of opts.options) {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = option.text
    button.dataset.control = `${opts.key}:${option.value}`
    const refused = option.refused ?? null
    button.title = refused ?? option.title
    if (refused !== null) button.setAttribute('aria-disabled', 'true')
    button.addEventListener('click', () => {
      if (refused !== null) return
      set(option.value)
      opts.onPick(option.value)
    })
    buttons.set(option.value, button)
    el.appendChild(button)
  }
  set(opts.value)
  return { el, set }
}

export function chartToggle(opts: {
  key: string
  text: string
  title: string
  pressed: boolean
  onToggle(pressed: boolean): void
}): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = opts.text
  button.title = opts.title
  button.dataset.control = opts.key
  button.setAttribute('aria-pressed', String(opts.pressed))
  button.addEventListener('click', () => {
    const next = button.getAttribute('aria-pressed') !== 'true'
    button.setAttribute('aria-pressed', String(next))
    opts.onToggle(next)
  })
  return button
}

export const ENLARGE_TEXT = 'Enlarge'

export function enlargeButton(onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.classList.add('chart-enlarge-button')
  button.textContent = ENLARGE_TEXT
  button.title = 'Show this chart large over the map'
  button.dataset.control = 'enlarge'
  button.addEventListener('click', onClick)
  return button
}

/** The control that has focus inside `root`, by its key, so focus can be put back after a rebuild. */
export function focusedControl(root: HTMLElement): string | null {
  const active = document.activeElement
  if (!(active instanceof HTMLElement) || !root.contains(active)) return null
  return active.dataset.control ?? null
}

export function refocusControl(root: HTMLElement, key: string | null): void {
  if (key === null) return
  for (const el of root.querySelectorAll<HTMLElement>('[data-control]')) {
    if (el.dataset.control === key) {
      el.focus()
      return
    }
  }
}
