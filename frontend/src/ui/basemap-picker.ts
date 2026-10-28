// The in-map file picker for a basemap: opens on the run folder, can go back to Start and browse
// anywhere the run picker can, and holds only opaque ids and display names (D-16, D-33).

import { fsRoots } from '../data/client'
import { basemapStart, listImages, type Answer, type BasemapFolder, type ImageEntry, type ImageListing } from '../data/basemap'
import { LatestWins } from '../data/latest-wins'

export interface BasemapPickerOptions {
  onPick(file: { id: string; name: string }): void
  /** Called once when the user cancels; not called after a pick or a close() from the caller. */
  onClose(): void
}

export interface BasemapPickerHandle {
  close(): void
}

interface Crumb {
  id: string | null
  name: string
}

interface Level {
  entries: ImageEntry[]
  skipped: ImageListing['skipped'] | null
}

const KIND_LABEL: Record<ImageEntry['kind'], string> = {
  folder: 'folder',
  png: 'PNG',
  jpeg: 'JPEG',
  tiff: 'TIFF',
  link: 'link',
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many
}

export function skippedLines(skipped: ImageListing['skipped']): string[] {
  const lines: string[] = []
  const { otherFiles, notChecked, unreadable } = skipped
  if (otherFiles > 0) {
    lines.push(
      `${otherFiles} ${plural(otherFiles, 'other file is not shown: it is', 'other files are not shown: they are')} not PNG, JPEG or TIFF`,
    )
  }
  if (notChecked > 0) {
    lines.push(
      `${notChecked} ${plural(notChecked, 'file was', 'files were')} not checked: the folder holds more than pesto reads at once`,
    )
  }
  if (unreadable > 0) {
    lines.push(`${unreadable} ${plural(unreadable, 'file', 'files')} could not be read`)
  }
  return lines
}

function canPick(entry: ImageEntry): boolean {
  return entry.reason === null && (entry.kind === 'png' || entry.kind === 'jpeg')
}

function canEnter(entry: ImageEntry): boolean {
  return entry.reason === null && entry.kind === 'folder'
}

async function readRoots(): Promise<Answer<{ level: Level }>> {
  try {
    const roots = await fsRoots()
    return {
      ok: true,
      level: {
        entries: roots.map((r) => ({ id: r.id, name: r.name, kind: 'folder' as const, note: null, reason: r.reason })),
        skipped: null,
      },
    }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error), code: null }
  }
}

async function readFolder(id: string, signal: AbortSignal): Promise<Answer<{ level: Level }>> {
  const result = await listImages(id, { signal })
  return result.ok ? { ok: true, level: { entries: result.listing.entries, skipped: result.listing.skipped } } : result
}

export function openBasemapPicker(host: HTMLElement, opts: BasemapPickerOptions): BasemapPickerHandle {
  const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null

  const overlay = document.createElement('div')
  overlay.classList.add('basemap-picker')
  const panel = document.createElement('div')
  panel.classList.add('basemap-picker-panel')
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-modal', 'true')
  panel.setAttribute('aria-label', 'Choose a basemap image')
  const crumbBar = document.createElement('div')
  crumbBar.classList.add('basemap-picker-crumbs')
  crumbBar.setAttribute('aria-label', 'Folders above this one')
  const status = document.createElement('div')
  status.classList.add('basemap-picker-status')
  status.setAttribute('role', 'status')
  const list = document.createElement('ul')
  list.classList.add('scroll-pane', 'basemap-picker-list')
  const skippedArea = document.createElement('div')
  skippedArea.classList.add('basemap-picker-skipped')
  const actions = document.createElement('div')
  actions.classList.add('basemap-picker-actions')
  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.textContent = 'Cancel'
  actions.appendChild(cancel)
  panel.append(crumbBar, status, list, skippedArea, actions)
  overlay.appendChild(panel)
  host.appendChild(overlay)

  const cache = new Map<string | null, Level>()
  const nav = new LatestWins<Answer<{ level: Level }>>()
  const startSlot = new LatestWins<Answer<{ folder: BasemapFolder }>>()
  let crumbs: Crumb[] = [{ id: null, name: 'Start' }]
  let closed = false

  function setStatus(text: string, tone: 'quiet' | 'refused'): void {
    status.textContent = text
    status.classList.toggle('refused', tone === 'refused')
  }

  function paintCrumbs(): void {
    crumbBar.textContent = ''
    crumbs.forEach((crumb, index) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = crumb.name
      if (index === crumbs.length - 1) button.setAttribute('aria-current', 'location')
      button.addEventListener('click', () => {
        void show(crumb.id, crumbs.slice(0, index + 1))
      })
      crumbBar.appendChild(button)
    })
  }

  function rowFor(entry: ImageEntry): HTMLLIElement {
    const item = document.createElement('li')
    const button = document.createElement('button')
    button.type = 'button'
    button.classList.add('basemap-picker-row')
    button.setAttribute('data-kind', entry.kind)
    const head = document.createElement('span')
    head.classList.add('basemap-picker-row-head')
    const kind = document.createElement('span')
    kind.classList.add('basemap-picker-kind')
    kind.textContent = KIND_LABEL[entry.kind]
    const name = document.createElement('span')
    name.classList.add('basemap-picker-name', 'truncate')
    name.textContent = entry.name
    name.title = entry.name
    head.append(kind, name)
    button.appendChild(head)
    if (entry.note !== null) {
      const note = document.createElement('span')
      note.classList.add('basemap-picker-note')
      note.textContent = entry.note
      button.appendChild(note)
    }
    if (entry.reason !== null) {
      const reason = document.createElement('span')
      reason.classList.add('basemap-picker-reason')
      reason.textContent = entry.reason
      button.appendChild(reason)
    }
    if (canEnter(entry)) {
      button.addEventListener('click', () => {
        void show(entry.id, [...crumbs, { id: entry.id, name: entry.name }])
      })
    } else if (canPick(entry)) {
      button.addEventListener('click', () => {
        if (closed) return
        teardown()
        opts.onPick({ id: entry.id, name: entry.name })
      })
    } else {
      button.disabled = true
    }
    item.appendChild(button)
    return item
  }

  function paintLevel(level: Level): void {
    list.textContent = ''
    for (const entry of level.entries) list.appendChild(rowFor(entry))
    skippedArea.textContent = ''
    for (const line of level.skipped ? skippedLines(level.skipped) : []) {
      const el = document.createElement('div')
      el.textContent = line
      skippedArea.appendChild(el)
    }
    if (level.entries.length === 0) setStatus('this folder holds no folders or image files', 'quiet')
    else setStatus('', 'quiet')
    const first = list.querySelector<HTMLButtonElement>('button:not(:disabled)')
    ;(first ?? cancel).focus()
  }

  // A refused level leaves the last good one on screen beside the reason, as the run picker does.
  async function show(id: string | null, crumbsAfter: Crumb[]): Promise<void> {
    if (closed) return
    startSlot.cancel()
    const cached = cache.get(id)
    if (cached) {
      nav.cancel()
      crumbs = crumbsAfter
      paintCrumbs()
      paintLevel(cached)
      return
    }
    setStatus('reading…', 'quiet')
    const result = await nav.run(JSON.stringify(id), (signal) => (id === null ? readRoots() : readFolder(id, signal)))
    if (closed || result.stale) return
    if (!result.value.ok) {
      setStatus(result.value.reason, 'refused')
      return
    }
    cache.set(id, result.value.level)
    crumbs = crumbsAfter
    paintCrumbs()
    paintLevel(result.value.level)
  }

  async function begin(): Promise<void> {
    paintCrumbs()
    setStatus('reading…', 'quiet')
    cancel.focus()
    const start = await startSlot.run('start', (signal) => basemapStart({ signal }))
    if (closed || start.stale) return
    if (!start.value.ok) {
      setStatus(start.value.reason, 'refused')
      return
    }
    const folder = start.value.folder
    await show(folder.id, [{ id: null, name: 'Start' }, { id: folder.id, name: folder.name }])
  }

  function focusables(): HTMLElement[] {
    return Array.from(panel.querySelectorAll<HTMLElement>('button:not(:disabled)'))
  }

  overlay.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      dismiss()
      return
    }
    if (event.key !== 'Tab') return
    // A modal dialog keeps Tab inside itself while it is open.
    const all = focusables()
    if (all.length === 0) return
    const first = all[0]
    const last = all[all.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  })

  cancel.addEventListener('click', () => dismiss())

  function teardown(): void {
    closed = true
    nav.cancel()
    startSlot.cancel()
    overlay.remove()
    if (returnFocus && returnFocus.isConnected) returnFocus.focus()
  }

  function dismiss(): void {
    if (closed) return
    teardown()
    opts.onClose()
  }

  void begin()

  return {
    close() {
      if (!closed) teardown()
    },
  }
}
