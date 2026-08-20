// The choosing-a-directory screen (SERVE-03's user-facing half): a list of
// starting places, click-to-descend navigation, PEST runs marked, and an
// open action that hands the caller the run it opened -- all driven by
// opaque ids from fsRoots/fsList/fsOpen. Nothing here ever reads or
// renders a real filesystem location; the DirEntry type has no field to
// hold one.

import { ApiError, fsList, fsOpen, fsRoots, type DirEntry, type OpenResult } from '../data/client'
import { renderHeader, renderNotice, renderStatusBar } from './chrome'
import { currentTheme, setTheme, type ThemeChoice } from './theme'

interface Crumb {
  id: string | null
  name: string
}

const OPEN_ACTION_REASON =
  'no control file and matching parameter ensemble were found beside each other'

export function mountPicker(root: HTMLElement, opts: { onOpened: (result: OpenResult) => void }): void {
  root.textContent = ''

  const header = document.createElement('div')
  const crumbBar = document.createElement('div')
  const noticeArea = document.createElement('div')
  const list = document.createElement('ul')
  const statusBar = document.createElement('div')

  root.appendChild(header)
  root.appendChild(crumbBar)
  root.appendChild(noticeArea)
  root.appendChild(list)
  root.appendChild(statusBar)

  const levelCache = new Map<string | null, DirEntry[]>()
  const crumbs: Crumb[] = [{ id: null, name: 'Start' }]

  function paintHeader(): void {
    renderHeader(header, {
      title: 'Choose a run directory',
      themeChoice: currentTheme(),
      onThemeChange: (choice: ThemeChoice) => {
        setTheme(choice)
        paintHeader()
      },
    })
  }

  function paintCrumbs(): void {
    crumbBar.textContent = ''
    crumbs.forEach((crumb, index) => {
      const button = document.createElement('button')
      button.textContent = crumb.name
      button.addEventListener('click', () => {
        void goToCrumb(index)
      })
      crumbBar.appendChild(button)
    })
  }

  // A refused id (404), an unreadable directory (403, with the server's
  // own detail) and any other failure each get their own wording -- the
  // three shapes this screen's navigation can actually fail with.
  function showFetchError(error: unknown): void {
    if (error instanceof ApiError && error.problem.status === 404) {
      renderNotice(noticeArea, { title: error.problem.title, tone: 'serious' })
      return
    }
    if (error instanceof ApiError) {
      renderNotice(noticeArea, { title: error.problem.title, detail: error.problem.detail, tone: 'serious' })
      return
    }
    renderNotice(noticeArea, { title: 'that folder could not be reached', tone: 'critical' })
  }

  async function fetchLevel(id: string | null): Promise<DirEntry[]> {
    const cached = levelCache.get(id)
    if (cached) {
      return cached
    }
    const entries = id === null ? await fsRoots() : await fsList(id)
    levelCache.set(id, entries)
    return entries
  }

  // Returns whether the level rendered. On failure `list` is left exactly
  // as it was -- the last good level stays visible beside the notice.
  async function load(id: string | null): Promise<boolean> {
    let entries: DirEntry[]
    try {
      entries = await fetchLevel(id)
    } catch (error) {
      showFetchError(error)
      return false
    }

    noticeArea.textContent = ''

    if (entries.length === 0) {
      list.textContent = ''
      renderNotice(noticeArea, { title: 'this directory holds no subdirectories', tone: 'info' })
      renderStatusBar(statusBar, { entries: 0 })
      return true
    }

    renderEntries(entries)
    renderStatusBar(statusBar, { entries: entries.length })
    return true
  }

  async function navigateTo(entry: DirEntry): Promise<void> {
    const ok = await load(entry.id)
    if (ok) {
      crumbs.push({ id: entry.id, name: entry.name })
      paintCrumbs()
    }
  }

  async function goToCrumb(index: number): Promise<void> {
    const target = crumbs[index]
    const ok = await load(target.id)
    if (ok) {
      crumbs.length = index + 1
      paintCrumbs()
    }
  }

  function goToParent(): void {
    if (crumbs.length > 1) {
      void goToCrumb(crumbs.length - 2)
    }
  }

  function openRun(entry: DirEntry): void {
    fsOpen(entry.id)
      .then((result) => opts.onOpened(result))
      .catch((error: unknown) => showFetchError(error))
  }

  function renderEntries(entries: DirEntry[]): void {
    list.textContent = ''

    for (const entry of entries) {
      const item = document.createElement('li')
      const nameButton = document.createElement('button')

      if (entry.isRun) {
        const marker = document.createElement('span')
        marker.textContent = '● run'
        nameButton.appendChild(marker)
      }

      const nameText = document.createElement('span')
      nameText.textContent = entry.name
      nameButton.appendChild(nameText)
      item.appendChild(nameButton)

      // An entry the server could not read stays visible with its reason
      // -- omitting it would make an unreadable folder indistinguishable
      // from one that is simply not there.
      if (entry.reason) {
        nameButton.disabled = true
        const reasonEl = document.createElement('span')
        reasonEl.textContent = entry.reason
        item.appendChild(reasonEl)
        list.appendChild(item)
        continue
      }

      nameButton.style.outline = 'none'
      nameButton.addEventListener('focus', () => {
        nameButton.style.outline = '2px solid var(--accent)'
      })
      nameButton.addEventListener('blur', () => {
        nameButton.style.outline = 'none'
      })

      const activate = (): void => {
        void navigateTo(entry)
      }
      nameButton.addEventListener('click', activate)
      nameButton.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          activate()
        }
      })

      const openButton = document.createElement('button')
      openButton.textContent = 'Open'
      if (entry.isRun) {
        openButton.addEventListener('click', () => {
          openRun(entry)
        })
      } else {
        openButton.disabled = true
        const reasonEl = document.createElement('span')
        reasonEl.textContent = OPEN_ACTION_REASON
        item.appendChild(reasonEl)
      }
      item.appendChild(openButton)

      list.appendChild(item)
    }
  }

  list.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      goToParent()
    }
  })

  paintHeader()
  paintCrumbs()
  void load(null)
}
