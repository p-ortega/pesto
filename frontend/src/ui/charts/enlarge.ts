// One chart at a time shown large over the map. The chart's own frame is moved
// into the panel, not copied, so its data, hover and brush keep working; a
// note takes its place in the side panel until it is put back.

export interface EnlargeOptions {
  title: string
  /** The element that holds the chart and its controls. It is moved, then put back on close. */
  frame: HTMLElement
  /** What the side panel says where the chart was. */
  placeholder?: string
  /** Called after the frame has moved either way, so the chart draws at its new size. */
  onResize(): void
  /** Called once, however the panel closes. */
  onClose?(): void
  /** False when a chart is put back up after a rebuild, so focus stays where the user left it. */
  focus?: boolean
}

export interface EnlargeHandle {
  close(): void
  setTitle(text: string): void
}

const PLACEHOLDER = 'This chart is shown enlarged over the map.'

let current: EnlargeHandle | null = null

/** Closes the enlarged chart, if one is open. */
export function closeEnlarged(): void {
  current?.close()
}

export function enlargeChart(opts: EnlargeOptions): EnlargeHandle {
  current?.close()
  const { frame } = opts
  const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null

  const overlay = document.createElement('div')
  overlay.classList.add('chart-enlarged')
  const panel = document.createElement('div')
  panel.classList.add('chart-enlarged-panel')
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-label', `Enlarged chart: ${opts.title}`)
  const head = document.createElement('div')
  head.classList.add('chart-enlarged-head')
  const title = document.createElement('div')
  title.classList.add('heading', 'wrap-note')
  title.textContent = opts.title
  const closeButton = document.createElement('button')
  closeButton.type = 'button'
  closeButton.textContent = 'Close'
  closeButton.title = 'Put the chart back in the side panel (Escape)'
  head.append(title, closeButton)
  const body = document.createElement('div')
  body.classList.add('chart-enlarged-body')
  panel.append(head, body)
  overlay.appendChild(panel)

  const note = document.createElement('div')
  note.classList.add('chart-enlarged-placeholder')
  const noteText = document.createElement('span')
  noteText.classList.add('label', 'wrap-note')
  noteText.textContent = opts.placeholder ?? PLACEHOLDER
  const back = document.createElement('button')
  back.type = 'button'
  back.textContent = 'Bring back'
  back.title = 'Close the enlarged chart and show it here again'
  note.append(noteText, back)

  // In-panel heights are inline; while enlarged the panel's own layout sizes each chart box.
  const boxes = [...frame.querySelectorAll<HTMLElement>('.chart-box')]
  const heights = boxes.map((box) => box.style.height)
  for (const box of boxes) box.style.height = ''

  frame.parentNode?.replaceChild(note, frame)
  body.appendChild(frame)
  // The map's own box, so the side panel stays in reach; the page only when no map is mounted.
  const region = document.querySelector<HTMLElement>('.map-area')
  if (region === null) overlay.classList.add('chart-enlarged-page')
  ;(region ?? document.body).appendChild(overlay)

  let closed = false

  function close(): void {
    if (closed) return
    closed = true
    document.removeEventListener('keydown', onKey, true)
    boxes.forEach((box, i) => {
      box.style.height = heights[i]
    })
    // A chart rebuilt while enlarged has dropped the note; its old frame is then just let go.
    if (note.parentNode !== null) note.parentNode.replaceChild(frame, note)
    else frame.remove()
    const hadFocus = overlay.contains(document.activeElement)
    overlay.remove()
    if (current === handle) current = null
    opts.onResize()
    opts.onClose?.()
    if (hadFocus && returnFocus !== null && returnFocus.isConnected) returnFocus.focus()
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    close()
  }

  // Capture, so Escape closes the enlarged chart before the map acts on it.
  document.addEventListener('keydown', onKey, true)
  closeButton.addEventListener('click', close)
  back.addEventListener('click', close)

  const handle: EnlargeHandle = {
    close,
    setTitle(text) {
      title.textContent = text
      panel.setAttribute('aria-label', `Enlarged chart: ${text}`)
    },
  }
  current = handle
  opts.onResize()
  if (opts.focus !== false) closeButton.focus()
  return handle
}
