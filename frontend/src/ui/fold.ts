// A fold button for a floating card over the map, or for a section of a side panel. Folded, a card
// shrinks to one line that still names it; the legend instead keeps its ramp and hides its text
// lines. The folded state is a per-viewer convenience kept in localStorage, and everything renders
// the same without it.

export type FoldMode = 'card' | 'lines'

/** 'card' floats over the map; 'panel' is a section of a side panel, with a slot for controls on its title line. */
export type FoldSurface = 'card' | 'panel'

export interface FoldOptions {
  /** One per card; the storage key is `pesto.fold.<key>`. */
  key: string
  /** Names the card on the button and starts the folded line. */
  name: string
  /** Used only when the viewer never chose; a stored choice wins. */
  startFolded?: boolean
  /** 'card' hides the whole body when folded; 'lines' keeps the body and hides its text lines. */
  mode?: FoldMode
  /** Told after the viewer clicks the fold button, with the new state; setFolded does not call it. */
  onUserToggle?: (folded: boolean) => void
  /** Defaults to 'card'. */
  surface?: FoldSurface
}

export interface SetFoldedOptions {
  /** False folds or opens without storing it as the viewer's choice. Defaults to true. */
  remember?: boolean
}

export interface FoldHandle {
  /** The card itself: place this where the card goes. */
  el: HTMLElement
  /** Render the card's content into this. */
  body: HTMLElement
  folded(): boolean
  /** Folds or opens the card from code, stored as the viewer's choice unless `remember` is false. */
  setFolded(folded: boolean, options?: SetFoldedOptions): void
  /** True once the viewer's choice is known: one was stored, or the card was clicked or folded with remember. */
  chosen(): boolean
  /** The part of the folded line after the name, such as the basemap's image; null for the name alone. */
  setSummary(detail: string | null): void
}

/** A panel section's fold: setSummary sets the whole title line, open or folded. */
export interface PanelFoldHandle extends FoldHandle {
  /** The title line's slot for controls, before the fold button. */
  actions: HTMLElement
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

export function renderFold(opts: FoldOptions & { surface: 'panel' }): PanelFoldHandle
export function renderFold(opts: FoldOptions): FoldHandle
export function renderFold(opts: FoldOptions): FoldHandle | PanelFoldHandle {
  const mode = opts.mode ?? 'card'
  const panel = opts.surface === 'panel'
  const el = document.createElement('div')
  el.classList.add('fold-card', panel ? 'fold-section' : 'floating')
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

  const actions = panel ? document.createElement('div') : null
  if (actions !== null) {
    actions.classList.add('fold-actions')
    el.append(summary, actions, button, body)
  } else {
    el.append(summary, button, body)
  }

  const stored = readStored(opts.key)
  let folded = stored ?? opts.startFolded === true
  let chosen = stored !== null
  let detail: string | null = null

  // Open, the line is the card's title; folded, it also says what the card holds. The legend's
  // own lines name what it draws, so it never takes a detail. A panel section's line is its live title.
  function paintSummary(): void {
    const shown = detail === '' ? null : detail
    const text = panel ? (shown ?? opts.name) : !folded || mode === 'lines' || shown === null ? opts.name : `${opts.name}: ${shown}`
    summary.textContent = text
    summary.title = text
  }

  function paint(): void {
    el.setAttribute('data-folded', String(folded))
    button.setAttribute('aria-expanded', String(!folded))
    button.title = folded ? `Show ${opts.name.toLowerCase()}` : `Fold ${opts.name.toLowerCase()} to one line`
    paintSummary()
  }

  function setSummary(next: string | null): void {
    detail = next
    paintSummary()
  }

  function setFolded(next: boolean, options: SetFoldedOptions = {}): void {
    const remember = options.remember ?? true
    folded = next
    if (remember) {
      writeStored(opts.key, folded)
      chosen = true
    }
    paint()
  }

  button.addEventListener('click', () => {
    setFolded(!folded)
    opts.onUserToggle?.(folded)
  })

  paint()

  const handle: FoldHandle = { el, body, folded: () => folded, setFolded, chosen: () => chosen, setSummary }
  return actions === null ? handle : { ...handle, actions }
}

/** One card of a stack the overflow rules may fold. */
export type StackCard = Pick<FoldHandle, 'folded' | 'setFolded' | 'chosen'>

/**
 * The viewer just opened `opened`: while the stack is too tall, fold the other open cards, the
 * lowest first, each stored as the viewer's choice (LD-3). Returns the cards it folded.
 */
export function foldOthersToFit(opened: StackCard, cards: readonly StackCard[], overflows: () => boolean): StackCard[] {
  const folded: StackCard[] = []
  for (let i = cards.length - 1; i >= 0 && overflows(); i--) {
    const card = cards[i]
    if (card === opened || card.folded()) continue
    card.setFolded(true)
    folded.push(card)
  }
  return folded
}

export interface SettleGrowthOptions {
  /** A card this pass must not fold, such as the one the viewer opened last. */
  keep?: StackCard | null
  /** Called once between the two passes, and only while the stack still does not fit. */
  between?: () => void
}

/**
 * The stack grew on its own, or this is the first look: while it is too tall, fold quietly from
 * the bottom the open cards the viewer never chose, then call `between`, then the chosen ones.
 * Never the first card or `keep`. Nothing is stored and nothing opens, so it cannot loop.
 */
export function settleGrowth(
  cards: readonly StackCard[],
  overflows: () => boolean,
  options: SettleGrowthOptions = {},
): StackCard[] {
  const folded: StackCard[] = []
  const pass = (chosenToo: boolean): void => {
    for (let i = cards.length - 1; i >= 1 && overflows(); i--) {
      const card = cards[i]
      if (card === options.keep || card.folded() || (!chosenToo && card.chosen())) continue
      card.setFolded(true, { remember: false })
      folded.push(card)
    }
  }
  pass(false)
  if (overflows()) options.between?.()
  pass(true)
  return folded
}
