// The two map overlay toggles (D-22, D-23): each shows its hatch swatch and either its count or
// why it is off. They report clicks and draw nothing; the map view hatches. Every word reaches
// the DOM through textContent.

export type OverlayKind = 'atBounds' | 'conflict'

export type OverlayStatus =
  | { kind: 'loading' }
  | { kind: 'off'; reason: string }
  | { kind: 'shown'; label: string; title: string }
  // Data is there but another drawing hides it; the count stays and the user's choice is kept (D-14).
  | { kind: 'suppressed'; reason: string; label: string; title: string }

export interface OverlayControlsOptions {
  /** Told only when the user clicks an enabled toggle; setStatus never calls it. */
  onToggle(kind: OverlayKind, on: boolean): void
  /** Told after every repaint, so a folded line can follow what the toggles say. */
  onChange?(): void
}

export interface OverlayControlsHandle {
  el: HTMLElement
  setStatus(kind: OverlayKind, status: OverlayStatus): void
  /** True only while the toggle shows data and the user has not turned it off. */
  isOn(kind: OverlayKind): boolean
  /** Both toggles in one line, for the folded card. */
  summary(): string
  dispose(): void
}

const NAME: Record<OverlayKind, string> = { atBounds: '45° at bounds', conflict: '135° conflict' }
const SWATCH: Record<OverlayKind, string> = { atBounds: 'at-bounds', conflict: 'conflict' }

interface Toggle {
  button: HTMLButtonElement
  count: HTMLSpanElement
  reason: HTMLSpanElement
  status: OverlayStatus
  // The user's choice, kept while data stays available or suppressed and reset by a stretch with none.
  wanted: boolean
}

export function renderOverlayControls(host: HTMLElement, opts: OverlayControlsOptions): OverlayControlsHandle {
  host.textContent = ''
  const el = document.createElement('div')
  el.classList.add('overlay-controls')
  el.setAttribute('role', 'group')
  el.setAttribute('aria-label', 'Overlays')
  host.appendChild(el)

  let disposed = false
  const toggles = {} as Record<OverlayKind, Toggle>

  function paint(kind: OverlayKind): void {
    const t = toggles[kind]
    const { status } = t
    t.button.disabled = status.kind !== 'shown'
    t.button.setAttribute('aria-pressed', String(status.kind === 'shown' && t.wanted))
    if (status.kind === 'shown') {
      t.count.textContent = status.label
      t.reason.textContent = ''
      t.reason.hidden = true
      t.button.title = status.title
    } else if (status.kind === 'suppressed') {
      t.count.textContent = status.label
      t.reason.textContent = status.reason
      t.reason.hidden = false
      t.button.title = status.title
    } else if (status.kind === 'off') {
      t.count.textContent = NAME[kind]
      t.reason.textContent = status.reason
      t.reason.hidden = false
      t.button.title = status.reason
    } else {
      t.count.textContent = NAME[kind]
      t.reason.textContent = 'reading…'
      t.reason.hidden = false
      t.button.title = `${NAME[kind]}: reading…`
    }
    opts.onChange?.()
  }

  function summaryOf(kind: OverlayKind): string {
    const t = toggles[kind]
    const { status } = t
    if (status.kind === 'shown') return t.wanted ? status.label : `${status.label} (turned off)`
    if (status.kind === 'suppressed') return `${status.label} (${status.reason})`
    if (status.kind === 'off') return `${NAME[kind]}: ${status.reason}`
    return `${NAME[kind]}: reading…`
  }

  for (const kind of ['atBounds', 'conflict'] as const) {
    const button = document.createElement('button')
    button.type = 'button'
    button.classList.add('overlay-toggle')
    button.setAttribute('data-overlay', kind)
    const swatch = document.createElement('span')
    swatch.classList.add('hatch-swatch', SWATCH[kind])
    swatch.setAttribute('aria-hidden', 'true')
    const count = document.createElement('span')
    count.classList.add('overlay-count')
    const reason = document.createElement('span')
    reason.classList.add('overlay-reason')
    button.appendChild(swatch)
    button.appendChild(count)
    button.appendChild(reason)
    el.appendChild(button)
    toggles[kind] = { button, count, reason, status: { kind: 'loading' }, wanted: true }
    button.addEventListener('click', () => {
      const t = toggles[kind]
      if (disposed || t.status.kind !== 'shown') return
      t.wanted = !t.wanted
      paint(kind)
      opts.onToggle(kind, t.wanted)
    })
    paint(kind)
  }

  return {
    el,
    setStatus(kind, status) {
      if (disposed) return
      const t = toggles[kind]
      if (status.kind === 'off') t.wanted = true
      t.status = status
      paint(kind)
    },
    isOn(kind) {
      const t = toggles[kind]
      return !disposed && t.status.kind === 'shown' && t.wanted
    },
    summary() {
      return (['atBounds', 'conflict'] as const).map(summaryOf).join(' · ')
    },
    dispose() {
      disposed = true
      host.textContent = ''
    },
  }
}
