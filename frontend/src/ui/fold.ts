// A fold button for a floating card over the map. Folded, a card shrinks to one line that still
// names it; the legend instead keeps its ramp and hides its text lines. The folded state is a
// per-viewer convenience kept in localStorage, and everything renders the same without it.

export type FoldMode = 'card' | 'lines'

export interface FoldOptions {
  /** One per card; the storage key is `pesto.fold.<key>`. */
  key: string
  /** Names the card on the button and starts the folded line. */
  name: string
  /** Used only when the viewer never chose; a stored choice wins. */
  startFolded?: boolean
  /** 'card' hides the whole body when folded; 'lines' keeps the body and hides its text lines. */
  mode?: FoldMode
}

export interface FoldHandle {
  /** The card itself: place this where the card goes. */
  el: HTMLElement
  /** Render the card's content into this. */
  body: HTMLElement
  folded(): boolean
  /** The part of the folded line after the name, such as the basemap's image; null for the name alone. */
  setSummary(detail: string | null): void
}

const STORAGE_PREFIX = 'pesto.fold.'

/** Below this map height in CSS px the controls card starts folded. */
export const SHORT_MAP_HEIGHT = 640

/** A zero height means the map has no layout yet, which says nothing about its size. */
export function isShortMap(height: number): boolean {
  return height > 0 && height < SHORT_MAP_HEIGHT
}

function readStored(key: string): boolean | null {
  try {
    const value = localStorage.getItem(STORAGE_PREFIX + key)
    return value === 'folded' ? true : value === 'open' ? false : null
  } catch {
    return null
  }
}

function writeStored(key: string, folded: boolean): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + key, folded ? 'folded' : 'open')
  } catch {
    // The choice then lasts for this page only.
  }
}

export function renderFold(opts: FoldOptions): FoldHandle {
  const mode = opts.mode ?? 'card'
  const el = document.createElement('div')
  el.classList.add('fold-card', 'floating')
  el.setAttribute('data-fold', opts.key)
  el.setAttribute('data-fold-mode', mode)

  const summary = document.createElement('div')
  summary.classList.add('fold-summary', 'label', 'truncate')

  const button = document.createElement('button')
  button.type = 'button'
  button.classList.add('fold-button')
  button.setAttribute('aria-label', opts.name)

  const body = document.createElement('div')
  body.classList.add('fold-body')
  body.id = `fold-body-${opts.key}`
  button.setAttribute('aria-controls', body.id)

  el.append(summary, button, body)

  let folded = readStored(opts.key) ?? opts.startFolded === true

  function paint(): void {
    el.setAttribute('data-folded', String(folded))
    button.setAttribute('aria-expanded', String(!folded))
    button.title = folded ? `Show ${opts.name.toLowerCase()}` : `Fold ${opts.name.toLowerCase()} to one line`
  }

  function setSummary(detail: string | null): void {
    // The legend's own lines name it, so its folded line stays empty.
    if (mode === 'lines') return
    const text = detail === null || detail === '' ? opts.name : `${opts.name}: ${detail}`
    summary.textContent = text
    summary.title = text
  }

  button.addEventListener('click', () => {
    folded = !folded
    writeStored(opts.key, folded)
    paint()
  })

  setSummary(null)
  paint()

  return { el, body, folded: () => folded, setSummary }
}
