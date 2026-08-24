// The draggable divider between the map and the Params panel (D-09/D-11):
// a 1px visible line with an 8px hit area (style.css's own `.divider`
// rule, plan 05.1-01), dragged with pointer events. The split moves on
// every pointer move; the new fraction is written exactly once, on
// pointerup -- never on every move, which would turn one drag into
// hundreds of writes (T-5.1-06).

const MIN_FRACTION = 0.1
const MAX_FRACTION = 0.9

export interface DividerOptions {
  /** The flex container the drag position is measured against (`.map-frame`). */
  container: HTMLElement
  /** The element to the divider's left -- the map area. Its flex-grow
   *  tracks the fraction. */
  before: HTMLElement
  /** The element to the divider's right -- the Params panel. Gets the
   *  remaining flex-grow. */
  after: HTMLElement
  /** The fraction to apply immediately at mount -- whatever `readViewState`
   *  returned, default or recorded. */
  initialFraction: number
  /** Called once, on pointerup, with the settled fraction. Persistence is
   *  the caller's job; this module never fetches. */
  onCommit: (fraction: number) => void
}

function clampFraction(fraction: number): number {
  return Math.min(MAX_FRACTION, Math.max(MIN_FRACTION, fraction))
}

function applySplit(before: HTMLElement, after: HTMLElement, fraction: number): void {
  before.style.flex = `${fraction} 1 0%`
  after.style.flex = `${1 - fraction} 1 0%`
}

function fractionFromClientX(container: HTMLElement, clientX: number): number {
  const rect = container.getBoundingClientRect()
  if (rect.width <= 0) return 0.5
  return clampFraction((clientX - rect.left) / rect.width)
}

/**
 * Renders the divider into `el` and wires pointer-drag resizing. The
 * visible line, the 8px hit area and `cursor: col-resize` all come from
 * the `.divider` class in `style.css` -- this module adds only behaviour
 * and the accessible name the class itself carries no text for.
 */
export function renderDivider(el: HTMLElement, opts: DividerOptions): void {
  el.textContent = ''
  el.classList.add('divider')
  el.setAttribute('role', 'separator')
  el.setAttribute('aria-orientation', 'vertical')
  el.setAttribute('aria-label', 'Resize panel')
  el.tabIndex = 0

  let fraction = clampFraction(opts.initialFraction)
  applySplit(opts.before, opts.after, fraction)

  let dragging = false

  el.addEventListener('pointerdown', (event) => {
    dragging = true
    if (typeof el.setPointerCapture === 'function') {
      el.setPointerCapture(event.pointerId)
    }
  })

  el.addEventListener('pointermove', (event) => {
    if (!dragging) return
    fraction = fractionFromClientX(opts.container, event.clientX)
    applySplit(opts.before, opts.after, fraction)
  })

  function endDrag(event: PointerEvent): void {
    if (!dragging) return
    dragging = false
    if (typeof el.releasePointerCapture === 'function') {
      el.releasePointerCapture(event.pointerId)
    }
    opts.onCommit(fraction)
  }

  el.addEventListener('pointerup', endDrag)
  el.addEventListener('pointercancel', endDrag)

  // Arrow-key nudge (MAP-11): a keyboard user can resize without a pointer
  // at all, in 2% steps, committing on every press exactly like a drag end.
  el.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    fraction = clampFraction(fraction + (event.key === 'ArrowRight' ? 0.02 : -0.02))
    applySplit(opts.before, opts.after, fraction)
    opts.onCommit(fraction)
  })
}
