import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, fsList, fsOpen, fsRoots, type OpenResult } from '../src/data/client'
import { createFakeDocument, FakeElement, FakeEvent, settle } from './support/dom'

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }
}

describe('the typed picker wrappers', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('fsList maps the wire snake_case shape to camelCase', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(200, [
          { id: 'a', name: 'alpha', is_run: true, reason: null },
          { id: 'b', name: 'beta', is_run: false, reason: 'no control file found' },
        ]),
      ),
    )

    const entries = await fsList('x')

    expect(entries).toEqual([
      { id: 'a', name: 'alpha', isRun: true, reason: null },
      { id: 'b', name: 'beta', isRun: false, reason: 'no control file found' },
    ])
  })

  it('fsOpen rejects a 404 problem body with status and title carried through', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(404, { type: 'about:blank', title: 'that folder is no longer available', status: 404 }),
      ),
    )

    await expect(fsOpen('stale')).rejects.toMatchObject({
      problem: { status: 404, title: 'that folder is no longer available' },
    })
    await expect(fsOpen('stale')).rejects.toBeInstanceOf(ApiError)
  })

  it('fsRoots rejects with a readable message when the body is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON at position 0')
        },
      })),
    )

    let caught: unknown
    try {
      await fsRoots()
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    const message = (caught as Error).message
    expect(message).toMatch(/could not be read/)
    expect(message).not.toMatch(/Unexpected token|JSON at position/)
  })

  it('every request carries the session header', async () => {
    const fetchStub = vi.fn(async (_route: string, _init?: RequestInit) => jsonResponse(200, []))
    vi.stubGlobal('fetch', fetchStub)

    await fsRoots()
    await fsList('x')
    await fsOpen('x').catch(() => undefined)

    for (const call of fetchStub.mock.calls) {
      const init = call[1] as { headers?: Record<string, string> } | undefined
      expect(init?.headers?.['X-Pesto-Token']).toBeDefined()
    }
  })
})

// A small fixture filesystem: a "Home" root holding an empty directory, a
// run directory, an unreadable child, and a "ghost" entry the listing
// shows but that the server has since forgotten -- the shape a stale or
// forged id takes.
interface FixtureNode {
  id: string
  name: string
  is_run: boolean
  reason: string | null
  children?: FixtureNode[]
}

const emptyDir: FixtureNode = { id: 'empty', name: 'EmptyDir', is_run: false, reason: null, children: [] }
const runDir: FixtureNode = { id: 'run', name: 'RunDir', is_run: true, reason: null, children: [] }
const badDir: FixtureNode = {
  id: 'bad',
  name: 'NoPermission',
  is_run: false,
  reason: 'cannot be read: permission denied',
}
const ghost: FixtureNode = { id: 'ghost', name: 'GhostRun', is_run: false, reason: null }
const home: FixtureNode = {
  id: 'home',
  name: 'Home',
  is_run: false,
  reason: null,
  children: [emptyDir, runDir, badDir, ghost],
}

function toWire(node: FixtureNode) {
  return { id: node.id, name: node.name, is_run: node.is_run, reason: node.reason }
}

function buildFetchStub() {
  const byId = new Map<string, FixtureNode>()
  const register = (node: FixtureNode): void => {
    byId.set(node.id, node)
    node.children?.forEach(register)
  }
  register(home)
  // "ghost" is listed as a child of Home but deliberately never registered
  // under its own id -- the same lookup-miss shape a stale server-side id
  // takes after a restart (05-03-SUMMARY.md).
  byId.delete('ghost')

  return vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://localhost')

    if (url.pathname === '/api/fs/roots') {
      return jsonResponse(200, [toWire(home)])
    }

    if (url.pathname === '/api/fs/list') {
      const id = url.searchParams.get('id')
      const node = id ? byId.get(id) : undefined
      if (!node) {
        return jsonResponse(404, {
          type: 'about:blank',
          title: 'that folder is no longer available',
          status: 404,
        })
      }
      return jsonResponse(200, (node.children ?? []).map(toWire))
    }

    if (url.pathname === '/api/fs/open' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { id: string }
      const node = byId.get(body.id)
      if (!node) {
        return jsonResponse(404, {
          type: 'about:blank',
          title: 'that folder is no longer available',
          status: 404,
        })
      }
      return jsonResponse(200, { is_run: node.is_run, case: node.is_run ? 'demo_case' : null })
    }

    throw new Error(`unhandled request in test fixture: ${url.pathname}`)
  })
}

function collectButtons(el: FakeElement): FakeElement[] {
  const result: FakeElement[] = []
  for (const child of el.children) {
    if (child.tagName === 'BUTTON') {
      result.push(child)
    }
    result.push(...collectButtons(child))
  }
  return result
}

function collectAll(el: FakeElement): FakeElement[] {
  const result: FakeElement[] = [el]
  for (const child of el.children) {
    result.push(...collectAll(child))
  }
  return result
}

const PATH_PATTERN = /(^|\s)(\/[\w.-]+){2,}/
const WINDOWS_PATH_PATTERN = /[A-Za-z]:\\/

describe('mountPicker', () => {
  let doc: ReturnType<typeof createFakeDocument>
  let root: FakeElement

  beforeEach(() => {
    doc = createFakeDocument()
    root = doc.createElement('div')
    vi.stubGlobal('document', doc)
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined })
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  async function mount(onOpened: (result: OpenResult) => void = () => undefined) {
    const fetchStub = buildFetchStub()
    vi.stubGlobal('fetch', fetchStub)
    const { mountPicker } = await import('../src/ui/dir-picker')
    mountPicker(root as unknown as HTMLElement, { onOpened })
    await settle()
    return fetchStub
  }

  it('renders the starting places from fsRoots as a list', async () => {
    await mount()
    const buttons = collectButtons(root)
    const names = buttons.map((button) => button.textContent)
    expect(names.some((name) => name.includes('Home'))).toBe(true)
  })

  it('clicking an entry replaces the list with its children and pushes a breadcrumb', async () => {
    const fetchStub = await mount()
    const homeButton = collectButtons(root).find((b) => b.textContent.includes('Home'))!
    homeButton.dispatchEvent(new FakeEvent('click'))
    await settle()

    const names = collectButtons(root).map((b) => b.textContent)
    expect(names.some((n) => n.includes('EmptyDir'))).toBe(true)
    expect(names.some((n) => n.includes('RunDir'))).toBe(true)
    expect(fetchStub).toHaveBeenCalledTimes(2)
  })

  it('a breadcrumb navigates back without re-fetching a level already held', async () => {
    const fetchStub = await mount()
    const homeButton = collectButtons(root).find((b) => b.textContent.includes('Home'))!
    homeButton.dispatchEvent(new FakeEvent('click'))
    await settle()
    const callsAfterDescend = fetchStub.mock.calls.length

    const crumbButtons = collectButtons(root).filter((b) =>
      ['Start', 'Home'].includes(b.textContent),
    )
    const startCrumb = crumbButtons.find((b) => b.textContent === 'Start')!
    startCrumb.dispatchEvent(new FakeEvent('click'))
    await settle()

    expect(fetchStub.mock.calls.length).toBe(callsAfterDescend)
    expect(collectButtons(root).some((b) => b.textContent.includes('Home'))).toBe(true)
  })

  it('an entry marked as a run carries a visible marker distinct from its name', async () => {
    await mount()
    collectButtons(root).find((b) => b.textContent.includes('Home'))!.dispatchEvent(new FakeEvent('click'))
    await settle()

    const runButton = collectButtons(root).find((b) => b.textContent.includes('RunDir'))!
    const emptyButton = collectButtons(root).find((b) => b.textContent.includes('EmptyDir'))!
    expect(runButton.textContent).not.toBe('RunDir')
    expect(emptyButton.textContent).toBe('EmptyDir')
  })

  it('only a run entry offers the open action; others are disabled with a reason', async () => {
    await mount()
    collectButtons(root).find((b) => b.textContent.includes('Home'))!.dispatchEvent(new FakeEvent('click'))
    await settle()

    const allButtons = collectButtons(root)
    const openButtons = allButtons.filter((b) => b.textContent === 'Open')
    // One Open button per navigable child (EmptyDir, RunDir, GhostRun) --
    // NoPermission carries a reason and gets no Open button of its own.
    expect(openButtons.length).toBe(3)
    const enabledOpen = openButtons.filter((b) => !b.disabled)
    expect(enabledOpen.length).toBe(1)
  })

  it('activating the open action calls fsOpen and emits the result', async () => {
    let received: OpenResult | undefined
    await mount((result) => {
      received = result
    })
    collectButtons(root).find((b) => b.textContent.includes('Home'))!.dispatchEvent(new FakeEvent('click'))
    await settle()

    const openButtons = collectButtons(root).filter((b) => b.textContent === 'Open')
    const enabledOpen = openButtons.find((b) => !b.disabled)!
    enabledOpen.dispatchEvent(new FakeEvent('click'))
    await settle()

    expect(received).toEqual({ isRun: true, case: 'demo_case' })
  })

  it('an entry carrying a reason renders it and is not clickable', async () => {
    await mount()
    collectButtons(root).find((b) => b.textContent.includes('Home'))!.dispatchEvent(new FakeEvent('click'))
    await settle()

    const badButton = collectButtons(root).find((b) => b.textContent.includes('NoPermission'))!
    expect(badButton.disabled).toBe(true)
    const item = badButton.parentNode!
    expect(item.textContent).toContain('permission denied')
  })

  it('an empty directory renders a notice and no entries', async () => {
    await mount()
    collectButtons(root).find((b) => b.textContent.includes('Home'))!.dispatchEvent(new FakeEvent('click'))
    await settle()
    collectButtons(root).find((b) => b.textContent.includes('EmptyDir'))!.dispatchEvent(new FakeEvent('click'))
    await settle()

    const all = collectAll(root)
    const hasMessage = all.some((el) => el.textContent.includes('no subdirectories'))
    expect(hasMessage).toBe(true)
  })

  it('a refused navigation renders a notice and keeps the last good level visible', async () => {
    await mount()
    collectButtons(root).find((b) => b.textContent.includes('Home'))!.dispatchEvent(new FakeEvent('click'))
    await settle()
    const beforeCount = collectButtons(root).length

    collectButtons(root).find((b) => b.textContent.includes('GhostRun'))!.dispatchEvent(new FakeEvent('click'))
    await settle()

    const all = collectAll(root)
    expect(all.some((el) => el.textContent.includes('that folder is no longer available'))).toBe(true)
    expect(collectButtons(root).length).toBe(beforeCount)
  })

  it('Enter on a focused entry navigates into it', async () => {
    const fetchStub = await mount()
    const homeButton = collectButtons(root).find((b) => b.textContent.includes('Home'))!
    homeButton.dispatchEvent(new FakeEvent('keydown', { key: 'Enter' }))
    await settle()

    expect(fetchStub.mock.calls.length).toBe(2)
    expect(collectButtons(root).some((b) => b.textContent.includes('RunDir'))).toBe(true)
  })

  it('Escape on the list returns to the parent level without a re-fetch', async () => {
    const fetchStub = await mount()
    collectButtons(root).find((b) => b.textContent.includes('Home'))!.dispatchEvent(new FakeEvent('click'))
    await settle()
    const callsAtChildLevel = fetchStub.mock.calls.length

    const list = root.children.find((el) => el.tagName === 'UL')!
    list.dispatchEvent(new FakeEvent('keydown', { key: 'Escape' }))
    await settle()

    expect(fetchStub.mock.calls.length).toBe(callsAtChildLevel)
    expect(collectButtons(root).some((b) => b.textContent.includes('Home'))).toBe(true)
  })

  it('a focused entry gets a visible outline using the accent token, cleared on blur', async () => {
    await mount()
    const homeButton = collectButtons(root).find((b) => b.textContent.includes('Home'))!
    homeButton.dispatchEvent(new FakeEvent('focus'))
    expect(homeButton.style.outline).toContain('var(--accent)')
    homeButton.dispatchEvent(new FakeEvent('blur'))
    expect(homeButton.style.outline).toBe('none')
  })

  it('no rendered text or attribute value anywhere in the screen contains a filesystem path', async () => {
    await mount()
    collectButtons(root).find((b) => b.textContent.includes('Home'))!.dispatchEvent(new FakeEvent('click'))
    await settle()

    for (const el of collectAll(root)) {
      expect(PATH_PATTERN.test(el.textContent)).toBe(false)
      expect(WINDOWS_PATH_PATTERN.test(el.textContent)).toBe(false)
      for (const value of el.attributes.values()) {
        expect(PATH_PATTERN.test(value)).toBe(false)
        expect(WINDOWS_PATH_PATTERN.test(value)).toBe(false)
      }
    }
  })
})
